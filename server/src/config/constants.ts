export const OUTBOUND_DRIVER = {
	DIRECT: "direct",
	NODE: "node",
	GO: "go",
	RELAY: "relay",
	KUMO_HTTP: "kumo-http",
	JSON: "json",
} as const;
export type OutboundDriverName =
	(typeof OUTBOUND_DRIVER)[keyof typeof OUTBOUND_DRIVER];

export const RELAY_TLS_MODE = {
	VERIFY: "verify",
	INSECURE: "insecure",
	NONE: "none",
} as const;
export type RelayTlsMode = (typeof RELAY_TLS_MODE)[keyof typeof RELAY_TLS_MODE];

export const POLICY_ACTION = {
	ACCEPT: "accept",
	TAG: "tag",
	TEMPFAIL: "tempfail",
	REJECT: "reject",
} as const;
export type PolicyAction = (typeof POLICY_ACTION)[keyof typeof POLICY_ACTION];

export const BOUNCE_TYPE = {
	HARD: "hard",
	SOFT: "soft",
	COMPLAINT: "complaint",
} as const;
export type BounceType = (typeof BOUNCE_TYPE)[keyof typeof BOUNCE_TYPE];

export const BOUNCE_SOURCE = {
	SMTP: "smtp",
	KUMO: "kumo",
	QUEUE: "queue",
} as const;
export type BounceSource = (typeof BOUNCE_SOURCE)[keyof typeof BOUNCE_SOURCE];

export const KUMO_EVENT_BOUNCE_TYPE: Record<string, BounceType> = {
	Bounce: BOUNCE_TYPE.HARD,
	Expiration: BOUNCE_TYPE.HARD,
	OOB: BOUNCE_TYPE.HARD,
	TransientFailure: BOUNCE_TYPE.SOFT,
	Feedback: BOUNCE_TYPE.COMPLAINT,
};

export const KUMO_ADDRESS_FAILURE_CLASSIFICATIONS = [
	"InvalidRecipient",
	"BadDestinationMailbox",
	"InactiveMailbox",
] as const;

export const POLICY_FLAG = {
	REVERSE_DNS: "rdns",
	SENDER_DOMAIN: "sender-domain",
	SPF: "spf",
	DKIM: "dkim",
	DMARC: "dmarc",
} as const;

export const HEADER = {
	QUEUE_ID: "X-AE-Queue-Id",
	RECEIPT_TIME: "X-AE-Receipt-Time",
	SPAM_FLAG: "X-AE-Spam-Flag",
	POLICY_FLAGS: "X-AE-Policy-Flags",
} as const;

export const DSN_STATUS = {
	DELIVERED: "2.0.0",
	TEMPORARY: "4.0.0",
	PERMANENT: "5.0.0",
	NO_MX: "5.1.2",
	BAD_ADDRESS: "5.1.3",
	NULL_MX: "5.1.10",
	SUPPRESSED: "5.1.1",
	COMPLAINT: "5.7.1",
	MX_UNREACHABLE: "4.4.1",
	HANDOFF_FAILED: "4.4.2",
	DNS_FAILURE: "4.4.3",
	EXPIRED: "4.4.7",
	STS_MX_MISMATCH: "4.7.5",
} as const;

export const DELIVERY_ERROR = {
	INVALID_RECIPIENT: "Invalid recipient address",
	UNKNOWN: "Unknown delivery error",
	NO_MX: (domain: string) => `Domain ${domain} has no MX records`,
	NULL_MX: (domain: string) => `Domain ${domain} does not accept mail`,
	MX_LOOKUP_FAILED: (domain: string, code: string) =>
		`MX lookup failed for ${domain}: ${code}`,
	MX_UNREACHABLE: (domain: string) =>
		`No reachable MX server found for domain ${domain}`,
	STS_MX_MISMATCH: (mx: string, domain: string) =>
		`MX ${mx} is not allowed by the MTA-STS policy of ${domain}`,
	SUPPRESSED: (until: string) =>
		`Recipient is suppressed after a hard bounce or complaint until ${until}`,
	EXPIRED: (hours: number) => `Delivery time expired after ${hours} hours`,
	SERVICE_UNREACHABLE: (service: string, reason: string) =>
		`${service} is unreachable: ${reason}`,
	SERVICE_HTTP_STATUS: (service: string, status: number, body: string) =>
		`${service} returned HTTP ${status}${body ? `: ${body}` : ""}`,
	SERVICE_NO_RESULT: (service: string) =>
		`${service} returned no result for this recipient`,
	REJECTED_BY_SERVICE: (service: string, reason: string) =>
		`Rejected by ${service}: ${reason}`,
	NOT_UTF8:
		"Message is not valid UTF-8 and cannot be sent over the KumoMTA HTTP API, use the relay driver",
	PRINTED_BY_JSON_DRIVER: "Printed by the json driver, not sent",
} as const;

export const CONFIG_ERROR = {
	INVALID_ENUM: (name: string, value: string, allowed: readonly string[]) =>
		`${name}="${value}" is not valid, use one of: ${allowed.join(", ")}`,
	INVALID_NUMBER: (name: string, value: string) =>
		`${name}="${value}" is not a number`,
	MISSING_ENV: (name: string, driver: string) =>
		`${name} is required when OUTBOUND_DRIVER=${driver}`,
	WRONG_TYPE: (path: string, expected: string) => `${path} must be ${expected}`,
	UNKNOWN_KEY: (path: string) => `${path} is not a known setting`,
	INVALID_ACTION: (path: string) =>
		`${path} must be one of: ${Object.values(POLICY_ACTION).join(", ")}`,
	INVALID_REPLY_CODE: (path: string) =>
		`${path}.code must be a number between 200 and 599`,
	INVALID_REPLY_STATUS: (path: string) =>
		`${path}.status must look like 5.1.1 and match the class of the code`,
	INVALID_REPLY_MESSAGE: (path: string) =>
		`${path}.message must be a single line of text`,
	INVALID_CIDR: (path: string, value: string) =>
		`${path} has an invalid network "${value}"`,
} as const;

export const HTTP_ERROR = {
	UNAUTHORIZED: "Unauthorized",
	NOT_FOUND: "Not found",
	INVALID_BODY: "Request body must be a JSON object or array",
	PROCESSING_FAILED: "Event processing failed",
} as const;

export const MAIL_LIMITS = {
	MAX_DIAGNOSTIC_LENGTH: 500,
	MAX_ORIGINAL_HEADERS_BYTES: 16 * 1024,
	MAX_WEBHOOKS_IN_FLIGHT: 50,
	WEBHOOK_TIMEOUT_MS: 10_000,
	SHUTDOWN_TIMEOUT_MS: 30_000,
	QUEUE_CLOSE_TIMEOUT_MS: 30_000,
	CONFIG_RELOAD_DEBOUNCE_MS: 200,
} as const;

export const CACHE = {
	MAX_ENTRIES: 10_000,
	MX_TTL_MS: 5 * 60 * 1000,
	STS_FALLBACK_TTL_MS: 60 * 60 * 1000,
	STS_ERROR_TTL_MS: 5 * 60 * 1000,
	DNS_RECORDS_TTL_MS: 5 * 60 * 1000,
	REVERSE_DNS_TTL_MS: 10 * 60 * 1000,
} as const;

export const RATE_LIMIT = {
	WINDOW_MS: 60 * 1000,
	BASE_BLOCK_MS: 60 * 1000,
	MAX_BLOCK_MS: 60 * 60 * 1000,
	STRIKE_RESET_MS: 60 * 60 * 1000,
	SWEEP_INTERVAL_MS: 5 * 60 * 1000,
} as const;

export const DEFAULTS = {
	SMTP_PORT_INCOMING: 25,
	SMTP_PORT_OUTGOING: 587,
	BOUNCE_SMTP_PORT: 2525,
	BOUNCE_HTTP_PORT: 8025,
	LISTEN_HOST: "0.0.0.0",
	RELAY_PORT: 587,
	RELAY_MAX_CONNECTIONS: 5,
	KUMO_HTTP_URL: "http://127.0.0.1:8000",
	KUMO_HTTP_TIMEOUT_MS: 30_000,
	GO_MTA_URL: "http://127.0.0.1:2580",
	GO_MTA_TIMEOUT_MS: 300_000,
	DKIM_SELECTOR: "default",
	ARC_SELECTOR: "default",
	MAX_EMAILS_PER_MINUTE: 5,
	WORKER_CONCURRENCY: 4,
	WORKER_MAX_QUEUE: 1000,
	WORKER_TIMEOUT_MS: 120_000,
	CONFIG_DIR: "config",
	MAIL_CONFIG_FILE: "mail.config.json",
	SMTP_MESSAGES_FILE: "smtp-messages.json",
	SPOOL_DIR: "spool",
} as const;

export interface CheckSettings {
	enabled: boolean;
}

export interface MailConfig {
	incoming: {
		maxMessageSizeBytes: number;
		maxRecipients: number;
		trustedNetworks: string[];
		rateLimit: { enabled: boolean; maxMessagesPerMinute: number };
		recipients: { acceptedDomains: string[]; knownRecipients: string[] };
		checks: {
			disposableSender: CheckSettings;
			senderDomain: CheckSettings & { onUnroutable: PolicyAction };
			reverseDns: CheckSettings & {
				requireForwardConfirmed: boolean;
				onFail: PolicyAction;
			};
			spf: {
				onFail: PolicyAction;
				onSoftFail: PolicyAction;
				onNone: PolicyAction;
				onTempError: PolicyAction;
			};
			dkim: { onFail: PolicyAction; onNone: PolicyAction };
			dmarc: {
				onReject: PolicyAction;
				onQuarantine: PolicyAction;
				honorPercentage: boolean;
			};
		};
		arcSeal: boolean;
		pgpEncryption: boolean;
		customHeaders: { enabled: boolean; headers: Record<string, string> };
	};
	outgoing: {
		maxMessageSizeBytes: number;
		maxRecipients: number;
		rateLimit: { enabled: boolean; maxConnectionsPerMinute: number | null };
		dkimSign: boolean;
	};
	queue: {
		maxConcurrent: number;
		maxAgeHours: number;
		retryDelaysMinutes: number[];
	};
	bounces: {
		notifySender: boolean;
		suppression: { enabled: boolean; days: number };
		trackingDays: number;
		smtpServer: CheckSettings;
		httpServer: CheckSettings;
	};
}

export const POLICY_ACTION_PATHS = [
	"incoming.checks.senderDomain.onUnroutable",
	"incoming.checks.reverseDns.onFail",
	"incoming.checks.spf.onFail",
	"incoming.checks.spf.onSoftFail",
	"incoming.checks.spf.onNone",
	"incoming.checks.spf.onTempError",
	"incoming.checks.dkim.onFail",
	"incoming.checks.dkim.onNone",
	"incoming.checks.dmarc.onReject",
	"incoming.checks.dmarc.onQuarantine",
] as const;

export const FREEFORM_CONFIG_PATHS = [
	"incoming.customHeaders.headers",
] as const;

export const DEFAULT_MAIL_CONFIG: MailConfig = {
	incoming: {
		maxMessageSizeBytes: 10 * 1024 * 1024,
		maxRecipients: 100,
		trustedNetworks: ["127.0.0.0/8", "::1/128"],
		rateLimit: { enabled: true, maxMessagesPerMinute: 100 },
		recipients: { acceptedDomains: [], knownRecipients: [] },
		checks: {
			disposableSender: { enabled: true },
			senderDomain: { enabled: true, onUnroutable: POLICY_ACTION.REJECT },
			reverseDns: {
				enabled: false,
				requireForwardConfirmed: true,
				onFail: POLICY_ACTION.TAG,
			},
			spf: {
				onFail: POLICY_ACTION.TAG,
				onSoftFail: POLICY_ACTION.ACCEPT,
				onNone: POLICY_ACTION.ACCEPT,
				onTempError: POLICY_ACTION.ACCEPT,
			},
			dkim: { onFail: POLICY_ACTION.TAG, onNone: POLICY_ACTION.ACCEPT },
			dmarc: {
				onReject: POLICY_ACTION.REJECT,
				onQuarantine: POLICY_ACTION.TAG,
				honorPercentage: true,
			},
		},
		arcSeal: true,
		pgpEncryption: true,
		customHeaders: {
			enabled: true,
			headers: {
				"X-AE-Origin": "api",
				"X-AE-Send-Type": "transactional",
				"X-AE-Platform": "ae-mailer-v1",
				"X-AE-Mailer": "Enjoys-Mail-Service-EMS",
				"X-AE-Message-Channel": "email",
				"X-AE-Abuse-Report": "abuse@yourdomain",
				"X-AE-Region": "ap-south-1",
				"X-Mailer": "Airsend - Powered By Enjoys",
			},
		},
	},
	outgoing: {
		maxMessageSizeBytes: 10 * 1024 * 1024,
		maxRecipients: 100,
		rateLimit: { enabled: true, maxConnectionsPerMinute: null },
		dkimSign: true,
	},
	queue: {
		maxConcurrent: 10,
		maxAgeHours: 48,
		retryDelaysMinutes: [1, 5, 15, 30, 60, 120, 240],
	},
	bounces: {
		notifySender: true,
		suppression: { enabled: true, days: 30 },
		trackingDays: 7,
		smtpServer: { enabled: true },
		httpServer: { enabled: true },
	},
};

export interface SmtpMessageDefinition {
	code: number;
	status: string;
	message: string;
}

const msg = (
	code: number,
	status: string,
	message: string,
): SmtpMessageDefinition => ({ code, status, message });

export const DEFAULT_SMTP_MESSAGES = {
	GREETING: msg(220, "2.0.0", "NodeSMTP Server is Ready"),
	BOUNCE_GREETING: msg(220, "2.0.0", "Bounce processor ready"),
	MESSAGE_ACCEPTED: msg(250, "2.0.0", "Message accepted"),
	MESSAGE_QUEUED: msg(250, "2.0.0", "Message queued as {id}"),
	BOUNCE_ACCEPTED: msg(250, "2.0.0", "Bounce accepted"),
	SERVICE_UNAVAILABLE: msg(
		421,
		"4.3.2",
		"Service not available, closing transmission channel",
	),
	RATE_LIMITED: msg(
		421,
		"4.7.0",
		"Too many requests from {ip}, try again in {seconds} seconds",
	),
	MAILBOX_BUSY: msg(
		450,
		"4.2.1",
		"Mailbox {recipient} is temporarily unavailable, try again later",
	),
	REVERSE_DNS_TEMPFAIL: msg(
		450,
		"4.7.25",
		"Reverse DNS lookup for {ip} failed, try again later",
	),
	INTERNAL_ERROR: msg(451, "4.3.0", "Temporary server error, try again later"),
	SERVER_BUSY: msg(451, "4.3.2", "Server is busy, try again later"),
	DNS_TEMPORARY_FAILURE: msg(
		451,
		"4.4.3",
		"Temporary DNS failure for {domain}, try again later",
	),
	SENDER_DOMAIN_TEMPFAIL: msg(
		451,
		"4.1.8",
		"Sender domain {domain} cannot be verified right now, try again later",
	),
	SPF_TEMPFAIL: msg(
		451,
		"4.7.24",
		"SPF check for {domain} failed temporarily, try again later",
	),
	DKIM_TEMPFAIL: msg(
		451,
		"4.7.20",
		"DKIM check failed temporarily, try again later",
	),
	DMARC_TEMPFAIL: msg(
		451,
		"4.7.26",
		"DMARC check for {domain} failed temporarily, try again later",
	),
	INSUFFICIENT_STORAGE: msg(
		452,
		"4.3.1",
		"Insufficient system storage, try again later",
	),
	MAILBOX_FULL_TEMPORARY: msg(
		452,
		"4.2.2",
		"Mailbox {recipient} is full, try again later",
	),
	TOO_MANY_RECIPIENTS: msg(
		452,
		"4.5.3",
		"Too many recipients, the limit is {max}",
	),
	AUTH_METHOD_NOT_ALLOWED: msg(
		504,
		"5.5.4",
		"XOAUTH2 is not allowed, use PLAIN or LOGIN",
	),
	AUTH_FAILED: msg(535, "5.7.8", "Invalid username or password"),
	USER_NOT_FOUND: msg(550, "5.1.1", "User {recipient} does not exist"),
	UNKNOWN_BOUNCE_ADDRESS: msg(
		550,
		"5.1.1",
		"Unknown bounce address {recipient}",
	),
	INVALID_SENDER: msg(550, "5.1.7", "Invalid sender address"),
	DISPOSABLE_SENDER: msg(550, "5.1.7", "The email address you used is invalid"),
	SENDER_DOMAIN_UNROUTABLE: msg(
		550,
		"5.1.8",
		"Sender domain {domain} does not exist or cannot receive mail",
	),
	MAILBOX_DISABLED: msg(550, "5.2.1", "Mailbox {recipient} is disabled"),
	RELAY_DENIED: msg(550, "5.7.1", "Relaying to {recipient} is not allowed"),
	DKIM_FAILED: msg(550, "5.7.20", "No passing DKIM signature found"),
	SPF_FAILED: msg(550, "5.7.23", "SPF validation failed for {domain}"),
	REVERSE_DNS_FAILED: msg(
		550,
		"5.7.25",
		"Reverse DNS validation failed for {ip}",
	),
	DMARC_REJECT: msg(
		550,
		"5.7.26",
		"Email rejected per DMARC policy of {domain}",
	),
	MAILBOX_FULL: msg(552, "5.2.2", "Mailbox {recipient} is full"),
	MESSAGE_TOO_LARGE: msg(
		552,
		"5.3.4",
		"Message exceeds the maximum size of {maxSize} bytes",
	),
	NO_VALID_RECIPIENTS: msg(554, "5.5.1", "No valid recipients"),
} as const satisfies Record<string, SmtpMessageDefinition>;

export type SmtpMessageKey = keyof typeof DEFAULT_SMTP_MESSAGES;
