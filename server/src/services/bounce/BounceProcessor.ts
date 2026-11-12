import {
	BOUNCE_SOURCE,
	BOUNCE_TYPE,
	type BounceSource,
	type BounceType,
	DSN_STATUS,
	KUMO_ADDRESS_FAILURE_CLASSIFICATIONS,
	KUMO_EVENT_BOUNCE_TYPE,
	MAIL_LIMITS,
} from "../../config/constants";
import { env } from "../../config/env";
import { mailConfig } from "../../config/mailConfig";
import { Logging } from "../../lib/logs";
import { mailWorkers } from "../../lib/workers";
import type { DsnRecipient } from "../../lib/workers/mailTasks";
import type {
	OutboundQueue,
	QueueFailureEvent,
} from "../../server/mta/OutboundQueue";
import type { BounceRegistry } from "./BounceRegistry";
import { buildDsn, type DsnRecipientReport } from "./DsnBuilder";
import type { SuppressionList } from "./SuppressionList";

export interface BounceEvent {
	source: BounceSource;
	type: BounceType;
	recipient: string;
	status: string;
	action: string;
	verified: boolean;
	originalSender?: string;
	queueId?: string;
	diagnostic?: string;
	remoteMta?: string;
	receivedAt: string;
}

export interface KumoLogRecord {
	type?: string;
	id?: string;
	sender?: string;
	recipient?: string;
	queue?: string;
	bounce_classification?: string;
	response?: {
		code?: number;
		enhanced_code?: {
			class?: number;
			subject?: number;
			detail?: number;
		} | null;
		content?: string;
	};
	peer_address?: { name?: string; addr?: string } | null;
	feedback_report?: unknown;
}

export interface BounceProcessorOptions {
	queue: OutboundQueue;
	registry: BounceRegistry;
	suppression: SuppressionList | null;
}

const VERP_LOCAL_PART = /^bounce\+([0-9a-f-]{36})$/i;
const ADDRESS_FAILURE_CLASSIFICATIONS = new Set<string>(
	KUMO_ADDRESS_FAILURE_CLASSIFICATIONS,
);

const isAddressFailure = (status: string) =>
	/^5\.1\.\d+$/.test(status) || status === "5.2.1";
const isNullOrDaemon = (address?: string) =>
	!address || /^(mailer-daemon|postmaster)@/i.test(address);
const verpIdOf = (address?: string) =>
	VERP_LOCAL_PART.exec((address ?? "").split("@")[0])?.[1];
const actionOf = (type: BounceType) =>
	type === BOUNCE_TYPE.SOFT
		? "delayed"
		: type === BOUNCE_TYPE.COMPLAINT
			? "complaint"
			: "failed";

export class BounceProcessor {
	private webhooksInFlight = 0;

	constructor(private readonly options: BounceProcessorOptions) {
		options.queue.on("failed", (event: QueueFailureEvent) => {
			this.handleQueueFailure(event).catch((error) =>
				Logging.dev(
					`Bounce handling for queue failure failed: ${error}`,
					"error",
				),
			);
		});
	}

	get bounceDomain(): string | undefined {
		return env.bounce.domain;
	}

	get suppression(): SuppressionList | null {
		return this.options.suppression;
	}

	isBounceAddress(address: string): boolean {
		const domain = env.bounce.domain;
		return Boolean(domain) && address.toLowerCase().endsWith(`@${domain}`);
	}

	async prepareReturnPath(
		queueId: string,
		sender: string,
		recipients: string[],
	): Promise<string> {
		const domain = env.bounce.domain;
		if (!domain || isNullOrDaemon(sender)) return sender;
		await this.options.registry.track({ id: queueId, sender, recipients });
		return `bounce+${queueId}@${domain}`;
	}

	async handleIncomingBounce(raw: Buffer, recipients: string[]): Promise<void> {
		const parsed = await mailWorkers.parseDsn({
			raw,
			maxHeaderBytes: MAIL_LIMITS.MAX_ORIGINAL_HEADERS_BYTES,
		});
		const verpId = recipients.map(verpIdOf).find(Boolean);
		const tracked = verpId
			? await this.options.registry.get(verpId)
			: undefined;
		const queueId = verpId ?? parsed.queueId;

		if (parsed.kind === "auto-reply") {
			Logging.dev(
				`Ignoring auto-reply sent to bounce address for ${queueId ?? "unknown message"}`,
			);
			return;
		}
		if (!parsed.recipients.length) {
			Logging.dev(
				`Bounce for ${queueId ?? "unknown message"} has no delivery status report, subject: ${parsed.subject ?? ""}`,
				"notice",
			);
			return;
		}

		const events = parsed.recipients
			.map((r) =>
				this.eventFromDsn(r, parsed.kind === "feedback", {
					queueId,
					tracked: tracked?.sender,
				}),
			)
			.filter((event): event is BounceEvent => event !== null);
		for (const event of events) this.record(event);

		const failures = events.filter((e) => e.type === BOUNCE_TYPE.HARD);
		if (tracked && failures.length) {
			await this.notifySender(
				tracked.sender,
				failures.map(toReport),
				queueId,
				parsed.originalHeaders,
			);
		}
	}

	async handleKumoEvent(record: KumoLogRecord): Promise<void> {
		const type = record.type ? KUMO_EVENT_BOUNCE_TYPE[record.type] : undefined;
		if (!type || !record.recipient) return;

		const verpId = verpIdOf(record.sender);
		const tracked = verpId
			? await this.options.registry.get(verpId)
			: undefined;
		const originalSender =
			tracked?.sender ?? (verpId ? undefined : record.sender);
		const code = record.response?.code;
		const enhanced = record.response?.enhanced_code;
		const status = enhanced
			? `${enhanced.class}.${enhanced.subject}.${enhanced.detail}`
			: code && code >= 500
				? DSN_STATUS.PERMANENT
				: DSN_STATUS.TEMPORARY;
		const addressFailure = ADDRESS_FAILURE_CLASSIFICATIONS.has(
			record.bounce_classification ?? "",
		);

		const event: BounceEvent = {
			source: BOUNCE_SOURCE.KUMO,
			type,
			recipient: record.recipient,
			status:
				addressFailure && !isAddressFailure(status)
					? DSN_STATUS.SUPPRESSED
					: status,
			action: actionOf(type),
			verified: true,
			originalSender,
			queueId: verpId ?? record.id,
			diagnostic:
				[code, record.response?.content].filter(Boolean).join(" ") ||
				record.bounce_classification,
			remoteMta:
				record.peer_address?.name || record.peer_address?.addr || undefined,
			receivedAt: new Date().toISOString(),
		};
		this.record(event);

		if (type === BOUNCE_TYPE.HARD && originalSender) {
			await this.notifySender(originalSender, [toReport(event)], event.queueId);
		}
	}

	private async handleQueueFailure({
		job,
		results,
		originalHeaders,
	}: QueueFailureEvent): Promise<void> {
		const events = results.map(
			(r): BounceEvent => ({
				source: BOUNCE_SOURCE.QUEUE,
				type: BOUNCE_TYPE.HARD,
				recipient: r.recipient,
				status: r.dsn?.status ?? DSN_STATUS.PERMANENT,
				action: actionOf(BOUNCE_TYPE.HARD),
				verified: Boolean(r.dsn?.remoteMta),
				originalSender: job.sender,
				queueId: job.id,
				diagnostic: r.error,
				remoteMta: r.dsn?.remoteMta,
				receivedAt: new Date().toISOString(),
			}),
		);
		for (const event of events) this.record(event);
		await this.notifySender(
			job.sender,
			events.map(toReport),
			job.id,
			originalHeaders,
			new Date(job.createdAt),
		);
	}

	private eventFromDsn(
		dsn: DsnRecipient,
		complaint: boolean,
		context: { queueId?: string; tracked?: string },
	): BounceEvent | null {
		const type: BounceType | null = complaint
			? BOUNCE_TYPE.COMPLAINT
			: dsn.action === "failed"
				? BOUNCE_TYPE.HARD
				: dsn.action === "delayed"
					? BOUNCE_TYPE.SOFT
					: null;
		if (!type) return null;
		return {
			source: BOUNCE_SOURCE.SMTP,
			type,
			recipient: dsn.recipient,
			status: dsn.status,
			action: dsn.action,
			verified: Boolean(context.tracked),
			originalSender: context.tracked,
			queueId: context.queueId,
			diagnostic: dsn.diagnostic,
			remoteMta: dsn.remoteMta,
			receivedAt: new Date().toISOString(),
		};
	}

	private record(event: BounceEvent): void {
		Logging.dev(
			`Bounce (${event.source}/${event.type}) ${event.recipient} ${event.status} ${event.diagnostic ?? ""} queue=${event.queueId ?? "-"}`,
			event.type === BOUNCE_TYPE.SOFT ? "notice" : "error",
		);

		const suppression = this.options.suppression;
		const enabled = mailConfig.get().bounces.suppression.enabled;
		if (
			suppression &&
			enabled &&
			event.verified &&
			!suppression.check(event.recipient)
		) {
			if (event.type === BOUNCE_TYPE.COMPLAINT) {
				suppression.add(
					event.recipient,
					"complaint",
					event.status,
					event.diagnostic ?? "",
				);
			} else if (
				event.type === BOUNCE_TYPE.HARD &&
				isAddressFailure(event.status)
			) {
				suppression.add(
					event.recipient,
					"hard-bounce",
					event.status,
					event.diagnostic ?? "",
				);
			}
		}

		this.postWebhook(event);
	}

	private async notifySender(
		sender: string | undefined,
		recipients: DsnRecipientReport[],
		queueId?: string,
		originalHeaders?: string,
		arrivalDate?: Date,
	): Promise<void> {
		if (
			!mailConfig.get().bounces.notifySender ||
			!sender ||
			isNullOrDaemon(sender) ||
			this.isBounceAddress(sender)
		) {
			return;
		}
		const raw = buildDsn({
			reportingMta: env.server.outgoingHost,
			originalSender: sender,
			recipients,
			queueId,
			originalHeaders,
			arrivalDate,
		});
		const id = await this.options.queue.enqueue({
			from: "",
			sender: "",
			recipients: [sender],
			raw,
		});
		Logging.dev(
			`Bounce notification ${id} queued for ${sender} about ${queueId ?? "unknown message"}`,
		);
	}

	private postWebhook(event: BounceEvent): void {
		const url = env.bounce.eventsWebhookUrl;
		if (!url) return;
		if (this.webhooksInFlight >= MAIL_LIMITS.MAX_WEBHOOKS_IN_FLIGHT) {
			Logging.dev(
				`Dropping bounce webhook for ${event.recipient}, ${MAIL_LIMITS.MAX_WEBHOOKS_IN_FLIGHT} requests already in flight`,
				"error",
			);
			return;
		}
		const token = env.bounce.eventsWebhookToken;
		this.webhooksInFlight++;
		fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(MAIL_LIMITS.WEBHOOK_TIMEOUT_MS),
		})
			.then(async (response) => {
				await response.body?.cancel();
				if (!response.ok)
					Logging.dev(
						`Bounce webhook returned HTTP ${response.status}`,
						"error",
					);
			})
			.catch((error) =>
				Logging.dev(
					`Bounce webhook failed: ${(error as Error).message}`,
					"error",
				),
			)
			.finally(() => {
				this.webhooksInFlight--;
			});
	}
}

const toReport = (event: BounceEvent): DsnRecipientReport => ({
	recipient: event.recipient,
	action: event.type === BOUNCE_TYPE.SOFT ? "delayed" : "failed",
	status: event.status,
	diagnostic: event.diagnostic,
	remoteMta: event.remoteMta,
});
