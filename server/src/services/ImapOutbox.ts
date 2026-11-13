import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULTS, HEADER } from "../config/constants";
import { mailConfig } from "../config/mailConfig";
import { RawMessage } from "../lib/helpers/RawMessage";
import { Logging } from "../lib/logs";
import type { QueueSettledEvent } from "../server/mta/OutboundQueue";
import { ImapDelivery } from "./ImapDelivery";

type Stage = "queued" | "sent";
type Outcome = "stored" | "no-mailbox" | "failed";

const pending = new Map<string, Promise<Outcome>>();

const enabled = (): boolean =>
	ImapDelivery.enabled && mailConfig.get().outgoing.imapOutbox.enabled;

const outboxHeader = HEADER.OUTBOX.toLowerCase();

async function store(
	owner: string,
	raw: Buffer,
	stage: Stage,
): Promise<Outcome> {
	const copy = RawMessage.prependHeaders(
		RawMessage.stripHeaders(raw, (name) => name.toLowerCase() === outboxHeader),
		`${HEADER.OUTBOX}: ${stage}\r\n`,
	);
	try {
		const result = await ImapDelivery.deliver(copy, owner, [owner]);
		if (result.delivered.length) return "stored";
		const failure = result.failed[0];
		if (failure?.permanent && failure.code === 550) return "no-mailbox";
		Logging.dev(
			`Outbox: ${stage} copy for ${owner} not stored (${failure?.code}): ${failure?.message}`,
			"notice",
		);
	} catch (error) {
		Logging.dev(
			`Outbox: ${stage} copy for ${owner} not stored: ${error}`,
			"notice",
		);
	}
	return "failed";
}

export const ImapOutbox = {
	queued(queueId: string, owner: string | undefined, raw: Buffer): void {
		if (!owner || !enabled()) return;
		pending.set(queueId, store(owner, raw, "queued"));
	},

	async settled({ job, raw, delivered }: QueueSettledEvent): Promise<void> {
		const queued = pending.get(job.id);
		pending.delete(job.id);
		if (!job.outboxOwner || !enabled()) return;
		if ((await queued) === "no-mailbox") return;
		if (!delivered) {
			Logging.dev(
				`Outbox: ${job.id} was not delivered to anyone, it stays in ${job.outboxOwner}'s Outbox`,
				"notice",
			);
			return;
		}
		const wait = job.createdAt + DEFAULTS.OUTBOX_SENT_GRACE_MS - Date.now();
		if (wait > 0) await sleep(wait);
		await store(job.outboxOwner, raw, "sent");
	},
};
