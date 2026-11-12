import { type FSWatcher, existsSync, watch } from "fs";
import { readFile } from "fs/promises";
import { basename, dirname } from "path";
import { Logging } from "../lib/logs";
import { CONFIG_ERROR, MAIL_LIMITS } from "./constants";

type Validator<T> = (value: T) => string[];

interface JsonConfigOptions<T> {
	name: string;
	path: string;
	defaults: T;
	freeformPaths?: readonly string[];
	validate?: Validator<T>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (value: unknown): string =>
	Array.isArray(value)
		? "an array"
		: value === null
			? "a number or null"
			: `a ${typeof value}`;

function merge(
	defaults: unknown,
	override: unknown,
	path: string,
	freeform: Set<string>,
	errors: string[],
): unknown {
	if (override === undefined) return defaults;

	if (freeform.has(path)) {
		if (
			!isPlainObject(override) ||
			Object.values(override).some((v) => typeof v !== "string")
		) {
			errors.push(CONFIG_ERROR.WRONG_TYPE(path, "an object of text values"));
			return defaults;
		}
		return override;
	}

	if (Array.isArray(defaults)) {
		const itemType = defaults.length ? typeof defaults[0] : undefined;
		if (
			!Array.isArray(override) ||
			(itemType && override.some((item) => typeof item !== itemType))
		) {
			errors.push(
				CONFIG_ERROR.WRONG_TYPE(
					path,
					itemType ? `an array of ${itemType}s` : "an array",
				),
			);
			return defaults;
		}
		return override;
	}

	if (isPlainObject(defaults)) {
		if (!isPlainObject(override)) {
			errors.push(CONFIG_ERROR.WRONG_TYPE(path, "an object"));
			return defaults;
		}
		for (const key of Object.keys(override)) {
			if (!(key in defaults))
				errors.push(CONFIG_ERROR.UNKNOWN_KEY(path ? `${path}.${key}` : key));
		}
		return Object.fromEntries(
			Object.entries(defaults).map(([key, value]) => [
				key,
				merge(
					value,
					override[key],
					path ? `${path}.${key}` : key,
					freeform,
					errors,
				),
			]),
		);
	}

	if (defaults === null) {
		if (override !== null && typeof override !== "number")
			errors.push(CONFIG_ERROR.WRONG_TYPE(path, "a number or null"));
		return override;
	}

	if (typeof override !== typeof defaults) {
		errors.push(CONFIG_ERROR.WRONG_TYPE(path, describe(defaults)));
		return defaults;
	}
	return override;
}

const deepFreeze = <T>(value: T): T => {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
};

export class JsonConfig<T> {
	private current: T;
	private watcher?: FSWatcher;
	private reloadTimer?: NodeJS.Timeout;
	private readonly listeners = new Set<(value: T) => void>();

	constructor(private readonly options: JsonConfigOptions<T>) {
		this.current = deepFreeze(structuredClone(options.defaults));
	}

	get value(): T {
		return this.current;
	}

	onChange(listener: (value: T) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async load(): Promise<void> {
		const { name, path } = this.options;
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				Logging.dev(
					`${name}: ${path} not found, using built-in defaults`,
					"notice",
				);
				return;
			}
			Logging.dev(
				`${name}: cannot read ${path}: ${(error as Error).message}`,
				"error",
			);
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			Logging.dev(
				`${name}: ${path} is not valid JSON (${(error as Error).message}), keeping the previous settings`,
				"error",
			);
			return;
		}

		const errors: string[] = [];
		const merged = merge(
			this.options.defaults,
			parsed,
			"",
			new Set(this.options.freeformPaths ?? []),
			errors,
		) as T;
		errors.push(...(this.options.validate?.(merged) ?? []));
		if (errors.length) {
			for (const error of errors) Logging.dev(`${name}: ${error}`, "error");
			Logging.dev(
				`${name}: ${path} has ${errors.length} problem(s), keeping the previous settings`,
				"error",
			);
			return;
		}

		this.current = deepFreeze(merged);
		Logging.dev(`${name}: loaded ${path}`);
		for (const listener of this.listeners) listener(this.current);
	}

	watch(): void {
		const { path } = this.options;
		const dir = dirname(path);
		if (this.watcher || !existsSync(dir)) return;
		const file = basename(path);
		this.watcher = watch(dir, { persistent: false }, (_event, changed) => {
			if (changed && changed !== file) return;
			clearTimeout(this.reloadTimer);
			this.reloadTimer = setTimeout(
				() => void this.load(),
				MAIL_LIMITS.CONFIG_RELOAD_DEBOUNCE_MS,
			);
			this.reloadTimer.unref();
		});
		this.watcher.on("error", (error) =>
			Logging.dev(
				`${this.options.name}: stopped watching ${path}: ${error}`,
				"error",
			),
		);
	}

	close(): void {
		clearTimeout(this.reloadTimer);
		this.watcher?.close();
		this.watcher = undefined;
	}
}
