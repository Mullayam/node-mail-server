import { mkdir, readdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { Logging } from "../../lib/logs";

export interface TrackedMessage {
	id: string;
	sender: string;
	recipients: string[];
	createdAt: number;
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 200;
const ID_PATTERN = /^[0-9a-f-]{36}$/i;

export class BounceRegistry {
	private readonly ready: Promise<unknown>;
	private readonly sweeper: NodeJS.Timeout;
	private sweeping = false;

	constructor(
		private readonly dir: string,
		private readonly ttlMs: () => number,
	) {
		this.ready = mkdir(dir, { recursive: true });
		this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
		this.sweeper.unref();
	}

	async track(message: Omit<TrackedMessage, "createdAt">): Promise<void> {
		await this.ready;
		await writeFile(
			this.path(message.id),
			JSON.stringify({ ...message, createdAt: Date.now() }),
		);
	}

	async get(id: string): Promise<TrackedMessage | undefined> {
		if (!ID_PATTERN.test(id)) return undefined;
		try {
			const message = JSON.parse(
				await readFile(this.path(id.toLowerCase()), "utf8"),
			) as TrackedMessage;
			return Date.now() - message.createdAt <= this.ttlMs()
				? message
				: undefined;
		} catch {
			return undefined;
		}
	}

	close(): void {
		clearInterval(this.sweeper);
	}

	private async sweep(): Promise<void> {
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			const files = await readdir(this.dir);
			const cutoff = Date.now() - this.ttlMs();
			for (let i = 0; i < files.length; i += SWEEP_BATCH) {
				await Promise.all(
					files.slice(i, i + SWEEP_BATCH).map(async (file) => {
						const path = join(this.dir, file);
						const info = await stat(path).catch(() => null);
						if (info && info.mtimeMs < cutoff)
							await unlink(path).catch(() => undefined);
					}),
				);
			}
		} catch (error) {
			Logging.dev(`Bounce tracking sweep failed: ${error}`, "error");
		} finally {
			this.sweeping = false;
		}
	}

	private path(id: string): string {
		return join(this.dir, `${id}.json`);
	}
}
