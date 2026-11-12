import { readFileSync } from "fs";
import nodemailer from "nodemailer";
import {
	CONFIG_ERROR,
	DELIVERY_ERROR,
	DSN_STATUS,
	OUTBOUND_DRIVER,
	RELAY_TLS_MODE,
	type RelayTlsMode,
} from "../../../config/constants";
import { env } from "../../../config/env";
import { Logging } from "../../../lib/logs";
import {
	deliveryResult,
	type SmtpSender,
	sendThroughTransport,
} from "../delivery";
import type { NodeMailerMTA } from "../node-mta";
import type {
	DeliveryResult,
	OutboundDriver,
	RawMailOptions,
	RelayOptions,
} from "../types";

const HTTP_PERMANENT_STATUSES = new Set([400, 413, 422]);

const basicAuth = (user?: string, pass?: string): Record<string, string> =>
	user
		? {
				authorization: `Basic ${Buffer.from(`${user}:${pass ?? ""}`).toString("base64")}`,
			}
		: {};

const hostOf = (url: string) => new URL(url).host;

export class DirectDriver implements OutboundDriver {
	readonly name = OUTBOUND_DRIVER.DIRECT;

	constructor(private readonly mta: NodeMailerMTA) {}

	send(mail: RawMailOptions): Promise<DeliveryResult[]> {
		return this.mta.deliverRaw(mail);
	}

	async close(): Promise<void> {}
}

export class SmtpRelayDriver implements OutboundDriver {
	readonly name = OUTBOUND_DRIVER.RELAY;
	private readonly transporter;

	constructor(
		private readonly relay: RelayOptions & {
			tlsMode: RelayTlsMode;
			maxConnections: number;
		},
	) {
		const verify = relay.tlsMode === RELAY_TLS_MODE.VERIFY;
		this.transporter = nodemailer.createTransport({
			pool: true,
			host: relay.host,
			port: relay.port,
			secure: relay.port === 465,
			auth: relay.auth,
			maxConnections: relay.maxConnections,
			maxMessages: 100,
			ignoreTLS: relay.tlsMode === RELAY_TLS_MODE.NONE,
			requireTLS: verify,
			connectionTimeout: 30_000,
			greetingTimeout: 30_000,
			socketTimeout: 120_000,
			name: env.server.outgoingHost,
			tls: { rejectUnauthorized: verify, ...relay.tls },
		});
	}

	send(mail: RawMailOptions): Promise<DeliveryResult[]> {
		return sendThroughTransport(
			this.transporter as unknown as SmtpSender,
			this.relay.host,
			mail,
			"relayed",
		);
	}

	async close(): Promise<void> {
		this.transporter.close();
	}
}

interface KumoInjectResponse {
	success_count?: number;
	fail_count?: number;
	failed_recipients?: string[];
	errors?: string[];
}

export class KumoHttpDriver implements OutboundDriver {
	readonly name = OUTBOUND_DRIVER.KUMO_HTTP;
	private readonly endpoint: string;
	private readonly host: string;
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });

	constructor(
		private readonly options: {
			url: string;
			user?: string;
			pass?: string;
			timeoutMs: number;
		},
	) {
		this.endpoint = new URL("/api/inject/v1", options.url).toString();
		this.host = hostOf(options.url);
	}

	async send(mail: RawMailOptions): Promise<DeliveryResult[]> {
		let content: string;
		try {
			content = this.decoder.decode(mail.raw);
		} catch {
			return deliveryResult.failAll(
				mail.to,
				false,
				DELIVERY_ERROR.NOT_UTF8,
				DSN_STATUS.PERMANENT,
				this.host,
			);
		}

		let response: Response;
		try {
			response = await fetch(this.endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...basicAuth(this.options.user, this.options.pass),
				},
				body: JSON.stringify({
					envelope_sender: mail.from,
					content,
					recipients: mail.to.map((email) => ({ email })),
				}),
				signal: AbortSignal.timeout(this.options.timeoutMs),
			});
		} catch (error) {
			const reason = DELIVERY_ERROR.SERVICE_UNREACHABLE(
				"KumoMTA",
				(error as Error).message,
			);
			return deliveryResult.failAll(
				mail.to,
				true,
				reason,
				DSN_STATUS.HANDOFF_FAILED,
				this.host,
			);
		}

		const text = await response.text();
		if (!response.ok) {
			const reason = DELIVERY_ERROR.SERVICE_HTTP_STATUS(
				"KumoMTA",
				response.status,
				text.slice(0, 300),
			);
			const permanent = HTTP_PERMANENT_STATUSES.has(response.status);
			return deliveryResult.failAll(
				mail.to,
				!permanent,
				reason,
				permanent ? DSN_STATUS.PERMANENT : DSN_STATUS.HANDOFF_FAILED,
				this.host,
			);
		}

		let body: KumoInjectResponse = {};
		try {
			body = JSON.parse(text) as KumoInjectResponse;
		} catch {
			body = {};
		}
		const failed = new Set(
			(body.failed_recipients ?? []).map((r) => r.toLowerCase()),
		);
		const reason = DELIVERY_ERROR.REJECTED_BY_SERVICE(
			"KumoMTA",
			body.errors?.join("; ") || "recipient rejected",
		);
		return mail.to.map((recipient) =>
			failed.has(recipient.toLowerCase())
				? deliveryResult.failure(
						recipient,
						false,
						reason,
						DSN_STATUS.PERMANENT,
						this.host,
					)
				: deliveryResult.accepted(
						recipient,
						this.host,
						`KumoMTA accepted ${body.success_count ?? mail.to.length}`,
						"relayed",
					),
		);
	}

	async close(): Promise<void> {}
}

interface GoMtaResult {
	recipient: string;
	success: boolean;
	temporary: boolean;
	status: string;
	response: string;
	remoteMta?: string;
}

export class GoMtaDriver implements OutboundDriver {
	readonly name = OUTBOUND_DRIVER.GO;
	private readonly endpoint: string;
	private readonly host: string;

	constructor(
		private readonly options: {
			url: string;
			token?: string;
			timeoutMs: number;
		},
	) {
		this.endpoint = new URL("/v1/deliver", options.url).toString();
		this.host = hostOf(options.url);
	}

	async send(mail: RawMailOptions): Promise<DeliveryResult[]> {
		let response: Response;
		try {
			response = await fetch(this.endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.options.token
						? { authorization: `Bearer ${this.options.token}` }
						: {}),
				},
				body: JSON.stringify({
					from: mail.from,
					to: mail.to,
					raw: mail.raw.toString("base64"),
				}),
				signal: AbortSignal.timeout(this.options.timeoutMs),
			});
		} catch (error) {
			const reason = DELIVERY_ERROR.SERVICE_UNREACHABLE(
				"Go MTA",
				(error as Error).message,
			);
			return deliveryResult.failAll(
				mail.to,
				true,
				reason,
				DSN_STATUS.HANDOFF_FAILED,
				this.host,
			);
		}

		if (!response.ok) {
			const reason = DELIVERY_ERROR.SERVICE_HTTP_STATUS(
				"Go MTA",
				response.status,
				(await response.text()).slice(0, 300),
			);
			const permanent = HTTP_PERMANENT_STATUSES.has(response.status);
			return deliveryResult.failAll(
				mail.to,
				!permanent,
				reason,
				permanent ? DSN_STATUS.PERMANENT : DSN_STATUS.HANDOFF_FAILED,
				this.host,
			);
		}

		const body = (await response.json()) as { results?: GoMtaResult[] };
		const byRecipient = new Map(
			(body.results ?? []).map((r) => [r.recipient.toLowerCase(), r]),
		);
		return mail.to.map((recipient) => {
			const result = byRecipient.get(recipient.toLowerCase());
			if (!result) {
				return deliveryResult.failure(
					recipient,
					true,
					DELIVERY_ERROR.SERVICE_NO_RESULT("Go MTA"),
					DSN_STATUS.HANDOFF_FAILED,
					this.host,
				);
			}
			const remoteMta = result.remoteMta || this.host;
			return result.success
				? deliveryResult.accepted(recipient, remoteMta, result.response)
				: deliveryResult.failure(
						recipient,
						result.temporary,
						result.response,
						result.status,
						remoteMta,
					);
		});
	}

	async close(): Promise<void> {}
}

export class JsonDriver implements OutboundDriver {
	readonly name = OUTBOUND_DRIVER.JSON;
	private readonly transporter = nodemailer.createTransport({
		jsonTransport: true,
	});

	async send(mail: RawMailOptions): Promise<DeliveryResult[]> {
		const info = await this.transporter.sendMail({
			envelope: { from: mail.from, to: mail.to },
			raw: mail.raw.toString("utf8"),
		});
		const message = JSON.parse(String(info.message)) as Record<string, unknown>;
		Logging.dev(
			`[json driver] ${JSON.stringify({ envelope: info.envelope, ...message }, null, 2)}`,
		);
		return mail.to.map((recipient) =>
			deliveryResult.accepted(
				recipient,
				"json",
				DELIVERY_ERROR.PRINTED_BY_JSON_DRIVER,
				"relayed",
			),
		);
	}

	async close(): Promise<void> {
		this.transporter.close();
	}
}

export function createOutboundDriver(mta: NodeMailerMTA): OutboundDriver {
	const { driver, relay, kumo, go } = env.outbound;
	switch (driver) {
		case OUTBOUND_DRIVER.DIRECT:
		case OUTBOUND_DRIVER.NODE:
			return new DirectDriver(mta);
		case OUTBOUND_DRIVER.RELAY: {
			if (!relay.host)
				throw new Error(
					CONFIG_ERROR.MISSING_ENV("OUTBOUND_RELAY_HOST", driver),
				);
			return new SmtpRelayDriver({
				host: relay.host,
				port: relay.port,
				auth: relay.user ? { user: relay.user, pass: relay.pass } : undefined,
				tls: relay.caPath ? { ca: readFileSync(relay.caPath) } : undefined,
				tlsMode: relay.tlsMode,
				maxConnections: relay.maxConnections,
			});
		}
		case OUTBOUND_DRIVER.KUMO_HTTP:
			return new KumoHttpDriver(kumo);
		case OUTBOUND_DRIVER.GO:
			return new GoMtaDriver(go);
		case OUTBOUND_DRIVER.JSON:
			return new JsonDriver();
	}
}
