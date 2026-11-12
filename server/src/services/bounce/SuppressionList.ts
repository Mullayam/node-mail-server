import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import { Logging } from "../../lib/logs";

export type SuppressionReason = "hard-bounce" | "complaint";

export interface SuppressionEntry {
	reason: SuppressionReason;
	status: string;
	detail: string;
	createdAt: number;
	expiresAt: number;
}

const SAVE_DELAY_MS = 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export class SuppressionList {
	private readonly entries = new Map<string, SuppressionEntry>();
	private readonly loaded: Promise<void>;
	private readonly sweeper: NodeJS.Timeout;
	private saveTimer?: NodeJS.Timeout;
	private saving: Promise<void> = Promise.resolve();

	constructor(
		private readonly file: string,
		private readonly ttlMs: () => number,
	) {
		this.loaded = this.load();
		this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
		this.sweeper.unref();
	}

	ready(): Promise<void> {
		return this.loaded;
	}

	check(email: string): SuppressionEntry | undefined {
		const key = email.toLowerCase();
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt > Date.now()) return entry;
		this.entries.delete(key);
		this.scheduleSave();
		return undefined;
	}

	add(
		email: string,
		reason: SuppressionReason,
		status: string,
		detail: string,
	): SuppressionEntry {
		const now = Date.now();
		const entry = {
			reason,
			status,
			detail,
			createdAt: now,
			expiresAt: now + this.ttlMs(),
		};
		this.entries.set(email.toLowerCase(), entry);
		this.scheduleSave();
		return entry;
	}

	remove(email: string): boolean {
		const removed = this.entries.delete(email.toLowerCase());
		if (removed) this.scheduleSave();
		return removed;
	}

	async flush(): Promise<void> {
		clearInterval(this.sweeper);
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
			await this.save();
		}
		await this.saving;
	}

	private async load(): Promise<void> {
		try {
			const data = JSON.parse(await readFile(this.file, "utf8")) as Record<
				string,
				SuppressionEntry
			>;
			const now = Date.now();
			for (const [email, entry] of Object.entries(data)) {
				if (entry.expiresAt > now) this.entries.set(email, entry);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				Logging.dev(
					`Cannot read suppression list ${this.file}: ${error}`,
					"error",
				);
			}
		}
	}

	private sweep(): void {
		const now = Date.now();
		let changed = false;
		for (const [email, entry] of this.entries) {
			if (entry.expiresAt <= now) {
				this.entries.delete(email);
				changed = true;
			}
		}
		if (changed) this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.save();
		}, SAVE_DELAY_MS);
		this.saveTimer.unref();
	}

	private save(): Promise<void> {
		this.saving = this.saving
			.then(async () => {
				await mkdir(dirname(this.file), { recursive: true });
				await writeFile(
					`${this.file}.tmp`,
					JSON.stringify(Object.fromEntries(this.entries)),
				);
				await rename(`${this.file}.tmp`, this.file);
			})
			.catch((error) =>
				Logging.dev(
					`Cannot save suppression list ${this.file}: ${error}`,
					"error",
				),
			);
		return this.saving;
	}
}
