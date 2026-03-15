import nodemailer from "nodemailer";
import Mail from "nodemailer/lib/mailer";
import { DNSChecker } from "../config/DnsChecker";

export interface DkimOptions {
	domainName: string;
	keySelector: string;
	privateKey: string;
}

export interface DsnOptions {
	notify?: ("SUCCESS" | "FAILURE" | "DELAY" | "NEVER")[];
	/** true = return headers only (HDRS), false = return full message (FULL) */
	returnHeaders?: boolean;
	envid?: string;
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

export interface DeliveryResult {
	success: boolean;
	recipient: string;
	response?: string;
	error?: string;
	dsn?: {
		status: string;
		action: "delivered" | "failed" | "delayed" | "relayed" | "expanded";
		diagnosticCode?: string;
		remoteMta?: string;
		finalRecipient: string;
	};
}

interface CachedMx {
	host: string;
	port: number;
	expiresAt: number;
}

const MX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CONNECT_TIMEOUT_MS = 5000;

export class NodeMailerMTA {
	private mxCache = new Map<string, CachedMx>();
	private static readonly PORTS = [25, 587, 465];

	/**
	 * Compose an RFC5322 message once using streamTransport (with optional DKIM),
	 * then deliver in parallel across domains via DNS-based MX lookup.
	 * All recipients on the same domain share a single TCP connection.
	 */
	async sendMail(options: SendMailOptions): Promise<DeliveryResult[]> {
		const grouped = this.groupByDomain(options.to);
		const domains = Object.keys(grouped);

		// Compose the RFC message once (not per domain)
		const rawMessage = await this.composeRfcMessage(options);

		// Resolve all MX servers in parallel
		const mxEntries = await Promise.all(
			domains.map(async (domain) => ({
				domain,
				mx: await this.resolveMx(domain),
			})),
		);

		// Deliver to all domains in parallel
		const deliveryPromises = mxEntries.map(({ domain, mx }) => {
			const recipients = grouped[domain];
			if (!mx) {
				return Promise.resolve(
					recipients.map((recipient): DeliveryResult => ({
						success: false,
						recipient,
						error: `No reachable MX server found for domain ${domain}`,
						dsn: {
							status: "5.1.2",
							action: "failed",
							diagnosticCode: "No MX records or servers unreachable",
							finalRecipient: recipient,
						},
					})),
				);
			}
			return this.deliverToDomain(mx, rawMessage, options.from, recipients, options.dsn)
				.catch((error: Error) =>
					recipients.map((recipient): DeliveryResult => ({
						success: false,
						recipient,
						error: error.message,
						dsn: {
							status: "4.0.0",
							action: "failed",
							diagnosticCode: error.message,
							finalRecipient: recipient,
						},
					})),
				);
		});

		const settled = await Promise.all(deliveryPromises);
		return settled.flat();
	}

	/**
	 * Send mail through a relay/smarthost (e.g. external SMTP service) with DKIM + DSN support.
	 */
	async sendViaRelay(
		relayHost: string,
		relayPort: number,
		options: SendMailOptions & { auth?: { user: string; pass: string } },
	): Promise<DeliveryResult[]> {
		const rawMessage = await this.composeRfcMessage(options);
		const transporter = nodemailer.createTransport({
			host: relayHost,
			port: relayPort,
			secure: relayPort === 465,
			auth: options.auth,
			tls: { rejectUnauthorized: false },
		});

		const envelope: Record<string, any> = {
			from: options.from,
			to: options.to,
		};
		if (options.dsn) {
			envelope.dsn = {
				ret: options.dsn.returnHeaders ? "HDRS" : "FULL",
				envid: options.dsn.envid || `${Date.now()}`,
				notify: options.dsn.notify || ["FAILURE", "DELAY"],
				orcpt: options.to.map((r) => `rfc822;${r}`),
			};
		}

		const results: DeliveryResult[] = [];
		try {
			const info = await transporter.sendMail({ envelope, raw: rawMessage });
			for (const recipient of options.to) {
				const accepted = info.accepted?.includes(recipient);
				results.push({
					success: !!accepted,
					recipient,
					response: info.response,
					dsn: {
						status: accepted ? "2.0.0" : "5.0.0",
						action: accepted ? "delivered" : "failed",
						remoteMta: relayHost,
						finalRecipient: recipient,
						diagnosticCode: info.response,
					},
				});
			}
		} catch (error: any) {
			for (const recipient of options.to) {
				results.push({
					success: false,
					recipient,
					error: error.message,
					dsn: {
						status: "4.0.0",
						action: "failed",
						remoteMta: relayHost,
						finalRecipient: recipient,
						diagnosticCode: error.message,
					},
				});
			}
		} finally {
			transporter.close();
		}

		return results;
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

		if (options.dkim) {
			mailOptions.dkim = {
				domainName: options.dkim.domainName,
				keySelector: options.dkim.keySelector,
				privateKey: options.dkim.privateKey,
			};
		}

		try {
			const info = await streamTransporter.sendMail(mailOptions);
			return info.message as Buffer;
		} finally {
			streamTransporter.close();
		}
	}

	/**
	 * Deliver a pre-composed raw message to all recipients on one domain
	 * using a single TCP connection with DSN support.
	 */
	private async deliverToDomain(
		mxServer: { host: string; port: number },
		rawMessage: Buffer,
		from: string,
		recipients: string[],
		dsnOptions?: DsnOptions,
	): Promise<DeliveryResult[]> {
		const transporter = nodemailer.createTransport({
			host: mxServer.host,
			port: mxServer.port,
			secure: mxServer.port === 465,
			tls: { rejectUnauthorized: false },
		});

		const envelope: Record<string, any> = {
			from,
			to: recipients,
		};

		if (dsnOptions) {
			envelope.dsn = {
				ret: dsnOptions.returnHeaders ? "HDRS" : "FULL",
				envid: dsnOptions.envid || `${Date.now()}`,
				notify: dsnOptions.notify || ["FAILURE", "DELAY"],
				orcpt: recipients.map((r) => `rfc822;${r}`),
			};
		}

		const results: DeliveryResult[] = [];
		try {
			const info = await transporter.sendMail({ envelope, raw: rawMessage });
			for (const recipient of recipients) {
				const accepted = info.accepted?.includes(recipient);
				const rejected = info.rejected?.includes(recipient);
				results.push({
					success: !!accepted && !rejected,
					recipient,
					response: info.response,
					dsn: {
						status: accepted ? "2.0.0" : "5.0.0",
						action: accepted ? "delivered" : "failed",
						remoteMta: mxServer.host,
						finalRecipient: recipient,
						diagnosticCode: info.response,
					},
				});
			}
		} catch (error: any) {
			for (const recipient of recipients) {
				results.push({
					success: false,
					recipient,
					error: error.message,
					dsn: {
						status: "4.0.0",
						action: "failed",
						remoteMta: mxServer.host,
						finalRecipient: recipient,
						diagnosticCode: error.message,
					},
				});
			}
		} finally {
			transporter.close();
		}

		return results;
	}

	/**
	 * Resolve the best reachable MX server + port for a domain.
	 * Uses TTL-based cache to avoid repeated DNS lookups.
	 * Probes all ports on each MX host in parallel for lower latency.
	 */
	private async resolveMx(domain: string): Promise<{ host: string; port: number } | null> {
		const cached = this.mxCache.get(domain);
		if (cached && cached.expiresAt > Date.now()) {
			return { host: cached.host, port: cached.port };
		}
		// Evict stale entry
		if (cached) this.mxCache.delete(domain);

		const mxResult = await DNSChecker.getMXRecords(domain);
		if (!mxResult) return null;

		// Try each MX host (priority-sorted), probe all ports in parallel per host
		for (const mx of mxResult.records) {
			const portResults = await Promise.allSettled(
				NodeMailerMTA.PORTS.map(async (port) => {
					const ok = await DNSChecker.tryConnect(mx.exchange, port);
					if (!ok) throw new Error("unreachable");
					return port;
				}),
			);
			const firstOpen = portResults.find((r) => r.status === "fulfilled") as
				| PromiseFulfilledResult<number>
				| undefined;
			if (firstOpen) {
				const result = { host: mx.exchange, port: firstOpen.value };
				this.mxCache.set(domain, { ...result, expiresAt: Date.now() + MX_CACHE_TTL_MS });
				return result;
			}
		}

		return null;
	}

	private groupByDomain(recipients: string[]): Record<string, string[]> {
		const groups: Record<string, string[]> = {};
		for (const email of recipients) {
			const domain = email.split("@")[1];
			if (!groups[domain]) groups[domain] = [];
			groups[domain].push(email);
		}
		return groups;
	}
}
