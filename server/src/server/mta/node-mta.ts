import type { MxRecord } from "dns";
import dns from "dns/promises";
import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import { CACHE, DELIVERY_ERROR, DSN_STATUS } from "../../config/constants";
import { env } from "../../config/env";
import { TtlCache } from "../../lib/helpers/TtlCache";
import { mailWorkers } from "../../lib/workers";
import { DNSChecker } from "../config/DnsChecker";
import {
	deliveryResult,
	type SmtpFailure,
	sendThroughTransport,
} from "./delivery";
import type {
	DeliveryResult,
	DsnOptions,
	RawMailOptions,
	RelayOptions,
} from "./types";

export type {
	DeliveryResult,
	DsnOptions,
	RawMailOptions,
	RelayOptions,
} from "./types";

const { getPolicy, validateMx } = require("mailauth/lib/mta-sts");

export interface DkimOptions {
	domainName: string;
	keySelector: string;
	privateKey: string;
}

export interface SendMailOptions {
	from: string;
	to: string[];
	subject: string;
	text?: string;
	html?: string;
	attachments?: Mail.Attachment[];
	dkim?: DkimOptions;
	dsn?: DsnOptions;
	headers?: Record<string, string>;
}

interface MxTarget {
	host: string;
	port: number;
}

type MxLookup =
	| { target: MxTarget }
	| { error: { temporary: boolean; status: string; message: string } };

interface StsPolicy {
	id: string | false;
	mode: "enforce" | "testing" | "none";
	mx?: string[];
	expires?: string;
	error?: unknown;
}

const NOT_FOUND_CODES = new Set(["ENODATA", "ENOTFOUND"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export class NodeMailerMTA {
	private mxCache = new TtlCache<string, MxTarget>(
		CACHE.MAX_ENTRIES,
		CACHE.MX_TTL_MS,
	);
	private stsCache = new TtlCache<string, StsPolicy>(
		CACHE.MAX_ENTRIES,
		CACHE.STS_FALLBACK_TTL_MS,
	);
	private static readonly PORTS = [25, 587, 465];

	/**
	 * Compose an RFC5322 message once using streamTransport (with optional DKIM),
	 * then deliver in parallel across domains via DNS-based MX lookup.
	 * All recipients on the same domain share a single TCP connection.
	 */
	async sendMail(options: SendMailOptions): Promise<DeliveryResult[]> {
		const raw = await this.composeRfcMessage(options);
		return this.deliverRaw({
			from: options.from,
			to: options.to,
			raw,
			dsn: options.dsn,
		});
	}

	async deliverRaw({
		from,
		to,
		raw,
		dsn,
	}: RawMailOptions): Promise<DeliveryResult[]> {
		const settled = await Promise.all(
			[...this.groupByDomain(to)].map(async ([domain, recipients]) => {
				if (!domain) {
					return deliveryResult.failAll(
						recipients,
						false,
						DELIVERY_ERROR.INVALID_RECIPIENT,
						DSN_STATUS.BAD_ADDRESS,
					);
				}
				const lookup = await this.resolveMx(domain);
				if ("error" in lookup) {
					const { temporary, message, status } = lookup.error;
					return deliveryResult.failAll(recipients, temporary, message, status);
				}
				return this.deliverToDomain(domain, lookup.target, {
					from,
					to: recipients,
					raw,
					dsn,
				});
			}),
		);
		return settled.flat();
	}

	/**
	 * Send mail through a relay/smarthost (e.g. external SMTP service) with DKIM + DSN support.
	 */
	async sendViaRelay(
		relayHost: string,
		relayPort: number,
		options: SendMailOptions & Pick<RelayOptions, "auth" | "tls">,
	): Promise<DeliveryResult[]> {
		const raw = await this.composeRfcMessage(options);
		return this.relayRaw(
			{
				host: relayHost,
				port: relayPort,
				auth: options.auth,
				tls: options.tls,
			},
			{ from: options.from, to: options.to, raw, dsn: options.dsn },
		);
	}

	async relayRaw(
		relay: RelayOptions,
		mail: RawMailOptions,
	): Promise<DeliveryResult[]> {
		const transporter = nodemailer.createTransport({
			host: relay.host,
			port: relay.port,
			secure: relay.port === 465,
			auth: relay.auth,
			tls: {
				rejectUnauthorized: !LOOPBACK_HOSTS.has(relay.host),
				...relay.tls,
			},
		});
		try {
			return await sendThroughTransport(
				transporter,
				relay.host,
				mail,
				"relayed",
			);
		} finally {
			transporter.close();
		}
	}

	signRaw(
		raw: Buffer,
		dkim: DkimOptions,
		envelope: { from: string; to: string[] },
	): Promise<Buffer> {
		return mailWorkers.dkimSign({ raw, dkim, envelope });
	}

	/**
	 * Compose an RFC5322-compliant message using nodemailer's streamTransport.
	 * DKIM signing is applied during composition if configured.
	 */
	private async composeRfcMessage(options: SendMailOptions): Promise<Buffer> {
		const streamTransporter = nodemailer.createTransport({
			streamTransport: true,
			buffer: true,
		});

		const mailOptions: Mail.Options = {
			from: options.from,
			to: options.to.join(", "),
			subject: options.subject,
			text: options.text,
			html: options.html,
			attachments: options.attachments,
			headers: options.headers,
		};

		try {
			const info = await streamTransporter.sendMail(mailOptions);
			const raw = info.message as Buffer;
			return options.dkim
				? this.signRaw(raw, options.dkim, {
						from: options.from,
						to: options.to,
					})
				: raw;
		} finally {
			streamTransporter.close();
		}
	}

	private async deliverToDomain(
		domain: string,
		mx: MxTarget,
		mail: RawMailOptions,
	): Promise<DeliveryResult[]> {
		const policy = await this.getStsPolicy(domain);
		const enforce = policy.mode === "enforce";
		if (enforce && !validateMx(mx.host, policy).valid) {
			return deliveryResult.failAll(
				mail.to,
				true,
				DELIVERY_ERROR.STS_MX_MISMATCH(mx.host, domain),
				DSN_STATUS.STS_MX_MISMATCH,
				mx.host,
			);
		}

		const transporter = nodemailer.createTransport({
			host: mx.host,
			port: mx.port,
			secure: mx.port === 465,
			requireTLS: enforce,
			name: env.server.outgoingHost,
			tls: {
				rejectUnauthorized: enforce,
				minVersion: enforce ? "TLSv1.2" : undefined,
			},
		});
		try {
			return await sendThroughTransport(transporter, mx.host, mail);
		} finally {
			transporter.close();
		}
	}

	private async resolveMx(domain: string): Promise<MxLookup> {
		const cached = this.mxCache.get(domain);
		if (cached) return { target: cached };

		let records: MxRecord[];
		try {
			records = await dns.resolveMx(domain);
		} catch (error) {
			const code = (error as SmtpFailure)?.code ?? String(error);
			const permanent = NOT_FOUND_CODES.has(code);
			return {
				error: {
					temporary: !permanent,
					status: permanent ? DSN_STATUS.NO_MX : DSN_STATUS.DNS_FAILURE,
					message: permanent
						? DELIVERY_ERROR.NO_MX(domain)
						: DELIVERY_ERROR.MX_LOOKUP_FAILED(domain, code),
				},
			};
		}

		records.sort((a, b) => a.priority - b.priority);
		if (
			!records.length ||
			(records.length === 1 && ["", "."].includes(records[0].exchange))
		) {
			return {
				error: {
					temporary: false,
					status: DSN_STATUS.NULL_MX,
					message: DELIVERY_ERROR.NULL_MX(domain),
				},
			};
		}

		for (const mx of records) {
			const portResults = await Promise.allSettled(
				NodeMailerMTA.PORTS.map(async (port) => {
					const ok = await DNSChecker.tryConnect(mx.exchange, port);
					if (!ok) throw new Error("unreachable");
					return port;
				}),
			);
			const firstOpen = portResults.find(
				(r): r is PromiseFulfilledResult<number> => r.status === "fulfilled",
			);
			if (firstOpen) {
				const target = { host: mx.exchange, port: firstOpen.value };
				this.mxCache.set(domain, target);
				return { target };
			}
		}

		return {
			error: {
				temporary: true,
				status: DSN_STATUS.MX_UNREACHABLE,
				message: DELIVERY_ERROR.MX_UNREACHABLE(domain),
			},
		};
	}

	private async getStsPolicy(domain: string): Promise<StsPolicy> {
		const cached = this.stsCache.get(domain);
		if (cached) return cached;

		const { policy } = (await getPolicy(domain).catch((error: unknown) => ({
			policy: { id: false, mode: "none", error },
		}))) as { policy: StsPolicy };
		const expiresAt = policy.expires
			? new Date(policy.expires).getTime()
			: Number.NaN;
		const ttl = policy.error
			? CACHE.STS_ERROR_TTL_MS
			: Number.isFinite(expiresAt)
				? Math.max(expiresAt - Date.now(), 60_000)
				: CACHE.STS_FALLBACK_TTL_MS;
		this.stsCache.set(domain, policy, ttl);
		return policy;
	}

	private groupByDomain(recipients: string[]): Map<string, string[]> {
		const groups = new Map<string, string[]>();
		for (const email of recipients) {
			const domain = (email.split("@")[1] || "").toLowerCase();
			const list = groups.get(domain);
			if (list) list.push(email);
			else groups.set(domain, [email]);
		}
		return groups;
	}
}
