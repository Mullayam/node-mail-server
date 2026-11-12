import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "fs/promises";
import { join } from "path";
import {
	DELIVERY_ERROR,
	DSN_STATUS,
	MAIL_LIMITS,
} from "../../config/constants";
import { RawMessage } from "../../lib/helpers/RawMessage";
import { Logging } from "../../lib/logs";
import type { SuppressionList } from "../../services/bounce/SuppressionList";
import { deliveryResult } from "./delivery";
import type { DeliveryResult, DsnOptions, OutboundDriver } from "./types";

export interface QueuedJob {
	id: string;
	from: string;
	sender: string;
	recipients: string[];
	dsn?: DsnOptions;
	attempts: number;
	createdAt: number;
	nextAttemptAt: number;
	lastError?: string;
}

export interface EnqueueInput {
	id?: string;
	from: string;
	sender?: string;
	recipients: string[];
	raw: Buffer;
	dsn?: DsnOptions;
}

export interface QueueFailureEvent {
	job: QueuedJob;
	results: DeliveryResult[];
	originalHeaders: string;
}

export interface QueueSettings {
	maxConcurrent: number;
	maxAgeMs: number;
	retryDelaysMs: number[];
	suppressionEnabled: boolean;
}

export interface OutboundQueueOptions {
	spoolDir: string;
	suppression?: SuppressionList | null;
	settings: () => QueueSettings;
}

const isValidJob = (job: Partial<QueuedJob>): job is QueuedJob =>
	typeof job.id === "string" &&
	Array.isArray(job.recipients) &&
	typeof job.from === "string";

export class OutboundQueue extends EventEmitter {
	private readonly jobs = new Map<string, QueuedJob>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly ready = new Set<string>();
	private readonly loaded: Promise<void>;
	private readonly idleWaiters: (() => void)[] = [];
	private active = 0;
	private closing = false;

	constructor(
		private readonly driver: OutboundDriver,
		private readonly options: OutboundQueueOptions,
	) {
		super();
		this.loaded = this.load().catch((error) =>
			Logging.dev(
				`Outbound queue failed to load spool ${options.spoolDir}: ${error}`,
				"error",
			),
		);
	}

	get driverName(): string {
		return this.driver.name;
	}

	get size(): number {
		return this.jobs.size;
	}

	async enqueue(input: EnqueueInput): Promise<string> {
		await this.loaded;
		const now = Date.now();
		const job: QueuedJob = {
			id: input.id ?? randomUUID(),
			from: input.from,
			sender: input.sender ?? input.from,
			recipients: input.recipients,
			dsn: input.dsn,
			attempts: 0,
			createdAt: now,
			nextAttemptAt: now,
		};
		await this.writeAtomic(this.rawPath(job.id), input.raw);
		await this.saveJob(job);
		this.jobs.set(job.id, job);
		if (!this.closing) this.markReady(job.id);
		return job.id;
	}

	async close(): Promise<void> {
		this.closing = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.ready.clear();
		if (this.active > 0) {
			await Promise.race([
				new Promise<void>((resolve) => this.idleWaiters.push(resolve)),
				new Promise<void>((resolve) =>
					setTimeout(resolve, MAIL_LIMITS.QUEUE_CLOSE_TIMEOUT_MS).unref(),
				),
			]);
		}
		await this.driver.close();
	}

	private async load(): Promise<void> {
		const dir = this.options.spoolDir;
		await mkdir(dir, { recursive: true });
		const files = await readdir(dir);
		for (const file of files.filter((f) => f.endsWith(".json"))) {
			try {
				const job = JSON.parse(
					await readFile(join(dir, file), "utf8"),
				) as Partial<QueuedJob>;
				if (!isValidJob(job)) continue;
				job.sender ??= job.from;
				this.jobs.set(job.id, job);
				this.schedule(job);
			} catch (error) {
				Logging.dev(
					`Skipping unreadable queue file ${file}: ${error}`,
					"error",
				);
			}
		}
		const orphans = files.filter(
			(f) =>
				f.endsWith(".tmp") ||
				(f.endsWith(".eml") && !this.jobs.has(f.slice(0, -4))),
		);
		await Promise.all(
			orphans.map((f) => unlink(join(dir, f)).catch(() => undefined)),
		);
		if (this.jobs.size)
			Logging.dev(
				`Outbound queue restored ${this.jobs.size} message(s) from ${dir}`,
			);
	}

	private schedule(job: QueuedJob): void {
		if (this.closing) return;
		const timer = setTimeout(
			() => {
				this.timers.delete(job.id);
				this.markReady(job.id);
			},
			Math.max(0, job.nextAttemptAt - Date.now()),
		);
		timer.unref();
		this.timers.set(job.id, timer);
	}

	private markReady(id: string): void {
		this.ready.add(id);
		this.pump();
	}

	private pump(): void {
		while (
			!this.closing &&
			this.active < this.options.settings().maxConcurrent &&
			this.ready.size > 0
		) {
			const next = this.ready.values().next();
			if (next.done) break;
			this.ready.delete(next.value);
			const job = this.jobs.get(next.value);
			if (!job) continue;
			this.active++;
			this.attempt(job)
				.catch((error) =>
					Logging.dev(`Outbound queue error for ${job.id}: ${error}`, "error"),
				)
				.finally(() => {
					this.active--;
					if (this.active === 0)
						this.idleWaiters.splice(0).forEach((resolve) => {
							resolve();
						});
					this.pump();
				});
		}
	}

	private async attempt(job: QueuedJob): Promise<void> {
		let raw: Buffer;
		try {
			raw = await readFile(this.rawPath(job.id));
		} catch (error) {
			Logging.dev(
				`Dropping queued message ${job.id}, spool file is missing: ${error}`,
				"error",
			);
			return this.remove(job.id);
		}

		const { allowed, suppressed } = await this.splitSuppressed(job.recipients);
		const delivered = allowed.length
			? await this.driver
					.send({ from: job.from, to: allowed, raw, dsn: job.dsn })
					.catch((error: Error) =>
						deliveryResult.failAll(
							allowed,
							true,
							error.message,
							DSN_STATUS.HANDOFF_FAILED,
							this.driver.name,
						),
					)
			: [];
		const results = [...suppressed, ...delivered];

		const deferred: DeliveryResult[] = [];
		const failed: DeliveryResult[] = [];
		for (const result of results) {
			if (result.success) {
				Logging.dev(
					`Delivered ${job.id} to ${result.recipient} via ${this.driver.name} (${result.dsn?.remoteMta})`,
				);
			} else if (result.temporary) {
				deferred.push(result);
			} else {
				failed.push(result);
				Logging.dev(
					`Permanent failure ${job.id} to ${result.recipient}: ${result.error}`,
					"error",
				);
			}
		}

		job.attempts++;
		const settings = this.options.settings();
		const expired =
			deferred.length > 0 && Date.now() - job.createdAt >= settings.maxAgeMs;
		if (expired) {
			const hours = Math.round(settings.maxAgeMs / 3_600_000);
			for (const result of deferred) {
				Logging.dev(
					`Giving up on ${job.id} to ${result.recipient} after ${job.attempts} attempts: ${result.error}`,
					"error",
				);
				failed.push(
					deliveryResult.failure(
						result.recipient,
						false,
						`${DELIVERY_ERROR.EXPIRED(hours)}. Last error: ${result.error}`,
						DSN_STATUS.EXPIRED,
						result.dsn?.remoteMta,
					),
				);
			}
		}

		if (failed.length) {
			const originalHeaders = RawMessage.headers(
				raw,
				MAIL_LIMITS.MAX_ORIGINAL_HEADERS_BYTES,
			);
			this.emit("failed", {
				job: { ...job },
				results: failed,
				originalHeaders,
			} satisfies QueueFailureEvent);
		}

		if (!deferred.length || expired) return this.remove(job.id);

		job.recipients = deferred.map((r) => r.recipient);
		job.lastError = deferred[0].error;
		job.nextAttemptAt =
			Date.now() +
			settings.retryDelaysMs[
				Math.min(job.attempts - 1, settings.retryDelaysMs.length - 1)
			];
		await this.saveJob(job);
		Logging.dev(
			`Deferred ${job.id} for ${job.recipients.join(", ")} until ${new Date(job.nextAttemptAt).toISOString()}: ${job.lastError}`,
			"notice",
		);
		this.schedule(job);
	}

	private async splitSuppressed(
		recipients: string[],
	): Promise<{ allowed: string[]; suppressed: DeliveryResult[] }> {
		const list = this.options.settings().suppressionEnabled
			? this.options.suppression
			: null;
		if (!list) return { allowed: recipients, suppressed: [] };
		await list.ready();
		const allowed: string[] = [];
		const suppressed: DeliveryResult[] = [];
		for (const recipient of recipients) {
			const entry = list.check(recipient);
			if (!entry) allowed.push(recipient);
			else {
				const until = new Date(entry.expiresAt).toISOString();
				suppressed.push(
					deliveryResult.failure(
						recipient,
						false,
						DELIVERY_ERROR.SUPPRESSED(until),
						DSN_STATUS.SUPPRESSED,
					),
				);
			}
		}
		return { allowed, suppressed };
	}

	private async remove(id: string): Promise<void> {
		this.jobs.delete(id);
		this.ready.delete(id);
		clearTimeout(this.timers.get(id));
		this.timers.delete(id);
		await Promise.all(
			[this.rawPath(id), this.jobPath(id)].map((p) =>
				unlink(p).catch(() => undefined),
			),
		);
	}

	private saveJob(job: QueuedJob): Promise<void> {
		return this.writeAtomic(this.jobPath(job.id), JSON.stringify(job));
	}

	private async writeAtomic(
		path: string,
		data: string | Buffer,
	): Promise<void> {
		await writeFile(`${path}.tmp`, data);
		await rename(`${path}.tmp`, path);
	}

	private rawPath(id: string): string {
		return join(this.options.spoolDir, `${id}.eml`);
	}

	private jobPath(id: string): string {
		return join(this.options.spoolDir, `${id}.json`);
	}
}
