import { join } from "path";
import { env } from "../../config/env";
import { mailConfig } from "../../config/mailConfig";
import { Logging } from "../../lib/logs";
import { BounceProcessor } from "../../services/bounce/BounceProcessor";
import { BounceRegistry } from "../../services/bounce/BounceRegistry";
import { SuppressionList } from "../../services/bounce/SuppressionList";
import { ImapOutbox } from "../../services/ImapOutbox";
import { createOutboundDriver } from "./drivers";
import { NodeMailerMTA } from "./node-mta";
import { OutboundQueue, type QueueSettledEvent } from "./OutboundQueue";
import type { OutboundDriver } from "./types";

export interface MailRuntime {
	mta: NodeMailerMTA;
	driver: OutboundDriver;
	queue: OutboundQueue;
	suppression: SuppressionList;
	registry: BounceRegistry;
	bounces: BounceProcessor;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

let runtime: MailRuntime | undefined;

function createMailRuntime(): MailRuntime {
	const spoolDir = env.paths.spoolDir;
	const mta = new NodeMailerMTA();
	const driver = createOutboundDriver(mta);
	const suppression = new SuppressionList(
		join(spoolDir, "suppression.json"),
		() => mailConfig.get().bounces.suppression.days * DAY_MS,
	);
	const queue = new OutboundQueue(driver, {
		spoolDir: join(spoolDir, "queue"),
		suppression,
		settings: () => {
			const { queue: settings, bounces } = mailConfig.get();
			return {
				maxConcurrent: settings.maxConcurrent,
				maxAgeMs: settings.maxAgeHours * HOUR_MS,
				retryDelaysMs: settings.retryDelaysMinutes.map(
					(minutes) => minutes * MINUTE_MS,
				),
				suppressionEnabled: bounces.suppression.enabled,
			};
		},
	});
	const registry = new BounceRegistry(
		join(spoolDir, "tracking"),
		() => mailConfig.get().bounces.trackingDays * DAY_MS,
	);
	const bounces = new BounceProcessor({ queue, registry, suppression });
	queue.on("settled", (event: QueueSettledEvent) =>
		ImapOutbox.settled(event).catch((error) =>
			Logging.dev(
				`Outbox update failed for ${event.job.id}: ${error}`,
				"error",
			),
		),
	);
	Logging.dev(`Outbound driver: ${driver.name}, spool: ${spoolDir}`);
	return { mta, driver, queue, suppression, registry, bounces };
}

export function getMailRuntime(): MailRuntime {
	runtime ??= createMailRuntime();
	return runtime;
}

export async function closeMailRuntime(): Promise<void> {
	if (!runtime) return;
	const current = runtime;
	runtime = undefined;
	await current.queue.close();
	await current.suppression.flush();
	current.registry.close();
}
