import "dotenv/config";
import { hostname } from "os";
import { join } from "path";
import {
	CONFIG_ERROR,
	DEFAULTS,
	OUTBOUND_DRIVER,
	type OutboundDriverName,
	RELAY_TLS_MODE,
	type RelayTlsMode,
} from "./constants";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const raw = (name: string): string | undefined => {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
};

const text = (name: string, fallback: string): string => raw(name) ?? fallback;

const optional = (name: string): string | undefined => raw(name);

const pem = (name: string): string | undefined =>
	raw(name)?.replace(/\\n/g, "\n");

const number = (name: string, fallback: number): number => {
	const value = raw(name);
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed))
		throw new Error(CONFIG_ERROR.INVALID_NUMBER(name, value));
	return parsed;
};

const optionalNumber = (name: string): number | undefined =>
	raw(name) === undefined ? undefined : number(name, 0);

const flag = (name: string, fallback: boolean): boolean => {
	const value = raw(name)?.toLowerCase();
	if (value === undefined) return fallback;
	if (["true", "1", "yes", "on"].includes(value)) return true;
	if (["false", "0", "no", "off"].includes(value)) return false;
	throw new Error(CONFIG_ERROR.INVALID_ENUM(name, value, ["true", "false"]));
};

const oneOf = <T extends string>(
	name: string,
	allowed: readonly T[],
	fallback: T,
): T => {
	const value = raw(name)?.toLowerCase();
	if (value === undefined) return fallback;
	if (!allowed.includes(value as T))
		throw new Error(CONFIG_ERROR.INVALID_ENUM(name, value, allowed));
	return value as T;
};

const incomingHost = text("INCOMING_MAIL_HOST", hostname());
const relayHost = optional("OUTBOUND_RELAY_HOST");
const configDir = join(process.cwd(), DEFAULTS.CONFIG_DIR);

export const env = {
	server: {
		incomingHost,
		outgoingHost: text("OUTGOING_MAIL_HOST", incomingHost),
		serverIp: optional("MAIL_SERVER_IP"),
		maxEmailsPerMinute: number(
			"MAX_EMAILS_PER_MINUTE",
			DEFAULTS.MAX_EMAILS_PER_MINUTE,
		),
	},
	tls: {
		privateKeyPath: optional("TLS_PRIVATE_KEY_PATH"),
		certificatePath: optional("TLS_CERTFICATE_PATH"),
	},
	dkim: {
		privateKey: pem("DKIM_PRIVATE_KEY"),
		selector: text("DKIM_SELECTOR", DEFAULTS.DKIM_SELECTOR),
	},
	pgp: {
		privateKey: pem("PGP_PRIVATE_KEY"),
		publicKey: pem("PGP_PUBLIC_KEY"),
		revocationCertificate: pem("PGP_REVOCATION_CERTIFICATE"),
		passphrase: text("PGP_PASSPHRASE", ""),
	},
	arc: {
		privateKeyPath: optional("ARC_PRIVATE_KEY_PATH"),
		signingDomain: optional("ARC_SIGNING_DOMAIN"),
		selector: text("ARC_SELECTOR", DEFAULTS.ARC_SELECTOR),
	},
	paths: {
		spoolDir: text("MAIL_SPOOL_DIR", join(process.cwd(), DEFAULTS.SPOOL_DIR)),
		mailConfig: text(
			"MAIL_CONFIG_PATH",
			join(configDir, DEFAULTS.MAIL_CONFIG_FILE),
		),
		smtpMessages: text(
			"SMTP_MESSAGES_PATH",
			join(configDir, DEFAULTS.SMTP_MESSAGES_FILE),
		),
	},
	outbound: {
		driver: oneOf<OutboundDriverName>(
			"OUTBOUND_DRIVER",
			Object.values(OUTBOUND_DRIVER),
			relayHost ? OUTBOUND_DRIVER.RELAY : OUTBOUND_DRIVER.DIRECT,
		),
		relay: {
			host: relayHost,
			port: number("OUTBOUND_RELAY_PORT", DEFAULTS.RELAY_PORT),
			user: optional("OUTBOUND_RELAY_USER"),
			pass: text("OUTBOUND_RELAY_PASS", ""),
			caPath: optional("OUTBOUND_RELAY_CA_PATH"),
			tlsMode: oneOf<RelayTlsMode>(
				"OUTBOUND_RELAY_TLS",
				Object.values(RELAY_TLS_MODE),
				relayHost && LOOPBACK_HOSTS.has(relayHost)
					? RELAY_TLS_MODE.INSECURE
					: RELAY_TLS_MODE.VERIFY,
			),
			maxConnections: number(
				"OUTBOUND_RELAY_MAX_CONNECTIONS",
				DEFAULTS.RELAY_MAX_CONNECTIONS,
			),
		},
		kumo: {
			url: text("KUMO_HTTP_URL", DEFAULTS.KUMO_HTTP_URL),
			user: optional("KUMO_HTTP_USER"),
			pass: optional("KUMO_HTTP_PASS"),
			timeoutMs: number("KUMO_HTTP_TIMEOUT_MS", DEFAULTS.KUMO_HTTP_TIMEOUT_MS),
			staticContent: flag("KUMO_HTTP_STATIC_CONTENT", true),
		},
		go: {
			url: text("GO_MTA_URL", DEFAULTS.GO_MTA_URL),
			token: optional("GO_MTA_TOKEN"),
			timeoutMs: number("GO_MTA_TIMEOUT_MS", DEFAULTS.GO_MTA_TIMEOUT_MS),
		},
	},
	bounce: {
		domain: optional("BOUNCE_DOMAIN")?.toLowerCase(),
		smtpHost: text("BOUNCE_SMTP_HOST", DEFAULTS.LISTEN_HOST),
		smtpPort: number("BOUNCE_SMTP_PORT", DEFAULTS.BOUNCE_SMTP_PORT),
		httpHost: text("BOUNCE_HTTP_HOST", DEFAULTS.LISTEN_HOST),
		httpPort: number("BOUNCE_HTTP_PORT", DEFAULTS.BOUNCE_HTTP_PORT),
		webhookToken: optional("BOUNCE_WEBHOOK_TOKEN"),
		eventsWebhookUrl: optional("BOUNCE_EVENTS_WEBHOOK_URL"),
		eventsWebhookToken: optional("BOUNCE_EVENTS_WEBHOOK_TOKEN"),
	},
	api: {
		host: text("MAIL_API_HOST", DEFAULTS.LISTEN_HOST),
		port: number("MAIL_API_PORT", DEFAULTS.API_PORT),
		token: optional("MAIL_API_TOKEN"),
	},
	imap: {
		// Unset: incoming mail is not stored. Set to the IMAP server (for example "imap").
		lmtpHost: optional("IMAP_LMTP_HOST"),
		lmtpPort: number("IMAP_LMTP_PORT", DEFAULTS.IMAP_LMTP_PORT),
		timeoutMs: number("IMAP_LMTP_TIMEOUT_MS", DEFAULTS.IMAP_LMTP_TIMEOUT_MS),
	},
	workers: {
		count: optionalNumber("MAIL_WORKERS"),
		concurrency: number("MAIL_WORKER_CONCURRENCY", DEFAULTS.WORKER_CONCURRENCY),
		maxQueue: number("MAIL_WORKER_MAX_QUEUE", DEFAULTS.WORKER_MAX_QUEUE),
		timeoutMs: number("MAIL_WORKER_TIMEOUT_MS", DEFAULTS.WORKER_TIMEOUT_MS),
	},
	setup: {
		domainName: optional("DOMAIN_NAME"),
	},
} as const;

export type Env = typeof env;
