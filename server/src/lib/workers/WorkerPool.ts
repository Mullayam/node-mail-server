import { extname } from "path";
import { Worker } from "worker_threads";
import { smtpReply } from "../../config/smtpMessages";

interface SerializedError {
	message: string;
	code?: string;
	responseCode?: number;
}

interface PendingTask {
	id: number;
	type: string;
	payload: unknown;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
}

interface PoolWorker {
	worker: Worker;
	tasks: Map<number, PendingTask>;
	completed: number;
}

export interface WorkerPoolOptions {
	size: number;
	maxTasksPerWorker: number;
	maxQueue: number;
	taskTimeoutMs: number;
}

const MAX_STARTUP_FAILURES = 3;

const deserializeError = (error?: SerializedError): Error =>
	Object.assign(new Error(error?.message ?? "Mail worker task failed"), {
		code: error?.code,
		...(typeof error?.responseCode === "number"
			? { responseCode: error.responseCode }
			: {}),
	});

export class WorkerPool {
	private readonly workers: PoolWorker[] = [];
	private queue: PendingTask[] = [];
	private queueHead = 0;
	private nextId = 1;
	private startupFailures = 0;
	private closed = false;
	broken: Error | null = null;

	constructor(
		private readonly file: string,
		private readonly options: WorkerPoolOptions,
	) {}

	run<T>(type: string, payload: unknown): Promise<T> {
		if (this.broken) return Promise.reject(this.broken);
		if (
			this.closed ||
			this.queue.length - this.queueHead >= this.options.maxQueue
		) {
			return Promise.reject(smtpReply("SERVER_BUSY").toError());
		}
		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				id: this.nextId++,
				type,
				payload,
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			this.dispatch();
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		this.rejectQueued(smtpReply("SERVER_BUSY").toError());
		const workers = this.workers.splice(0);
		for (const entry of workers)
			this.rejectTasks(entry, smtpReply("SERVER_BUSY").toError());
		await Promise.all(workers.map((entry) => entry.worker.terminate()));
	}

	private dispatch(): void {
		while (this.queueHead < this.queue.length && !this.broken) {
			const entry = this.pickWorker();
			if (!entry) break;
			const task = this.queue[this.queueHead++];
			this.start(entry, task);
		}
		if (this.queueHead === this.queue.length) {
			this.queue = [];
			this.queueHead = 0;
		} else if (
			this.queueHead > 1024 &&
			this.queueHead * 2 > this.queue.length
		) {
			this.queue = this.queue.slice(this.queueHead);
			this.queueHead = 0;
		}
	}

	private pickWorker(): PoolWorker | undefined {
		let best: PoolWorker | undefined;
		for (const entry of this.workers) {
			if (
				entry.tasks.size < this.options.maxTasksPerWorker &&
				(!best || entry.tasks.size < best.tasks.size)
			) {
				best = entry;
			}
		}
		if (best && best.tasks.size === 0) return best;
		if (this.workers.length < this.options.size) return this.spawn();
		return best;
	}

	private spawn(): PoolWorker {
		const runsTypeScript =
			extname(this.file) === ".ts" && !process.versions.bun;
		const worker = new Worker(this.file, {
			execArgv: runsTypeScript
				? ["--require", "ts-node/register/transpile-only"]
				: undefined,
		});
		worker.unref();
		const entry: PoolWorker = { worker, tasks: new Map(), completed: 0 };

		worker.on(
			"message",
			(message: {
				id: number;
				ok: boolean;
				result?: unknown;
				error?: SerializedError;
			}) => {
				const task = entry.tasks.get(message.id);
				if (!task) return;
				entry.tasks.delete(message.id);
				entry.completed++;
				this.startupFailures = 0;
				clearTimeout(task.timer);
				if (message.ok) task.resolve(message.result);
				else task.reject(deserializeError(message.error));
				this.dispatch();
			},
		);
		worker.on("error", (error) => this.retire(entry, error));
		worker.on("exit", (code) =>
			this.retire(entry, new Error(`Mail worker exited with code ${code}`)),
		);

		this.workers.push(entry);
		return entry;
	}

	private start(entry: PoolWorker, task: PendingTask): void {
		task.timer = setTimeout(() => {
			this.retire(
				entry,
				new Error(
					`Mail worker task ${task.type} timed out after ${this.options.taskTimeoutMs} ms`,
				),
			);
		}, this.options.taskTimeoutMs);
		task.timer.unref();
		entry.tasks.set(task.id, task);
		entry.worker.postMessage({
			id: task.id,
			type: task.type,
			payload: task.payload,
		});
	}

	private retire(entry: PoolWorker, error: Error): void {
		const index = this.workers.indexOf(entry);
		if (index === -1) return;
		this.workers.splice(index, 1);
		entry.worker.removeAllListeners();
		entry.worker.on("error", () => undefined);
		void entry.worker.terminate();
		this.rejectTasks(entry, error);

		if (
			entry.completed === 0 &&
			++this.startupFailures >= MAX_STARTUP_FAILURES &&
			!this.closed
		) {
			this.broken = new Error(
				`Mail workers keep failing to start: ${error.message}`,
			);
			this.rejectQueued(this.broken);
			return;
		}
		this.dispatch();
	}

	private rejectTasks(entry: PoolWorker, error: Error): void {
		for (const task of entry.tasks.values()) {
			clearTimeout(task.timer);
			task.reject(error);
		}
		entry.tasks.clear();
	}

	private rejectQueued(error: Error): void {
		for (let i = this.queueHead; i < this.queue.length; i++)
			this.queue[i].reject(error);
		this.queue = [];
		this.queueHead = 0;
	}
}
