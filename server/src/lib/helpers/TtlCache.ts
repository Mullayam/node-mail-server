export class TtlCache<K, V> {
	private readonly store = new Map<K, { value: V; expiresAt: number }>();

	constructor(
		private readonly maxEntries: number,
		private readonly defaultTtlMs: number,
	) {}

	get(key: K): V | undefined {
		const entry = this.store.get(key);
		if (!entry) return undefined;
		this.store.delete(key);
		if (entry.expiresAt <= Date.now()) return undefined;
		this.store.set(key, entry);
		return entry.value;
	}

	set(key: K, value: V, ttlMs: number = this.defaultTtlMs): void {
		this.store.delete(key);
		this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
		if (this.store.size > this.maxEntries) {
			const oldest = this.store.keys().next();
			if (!oldest.done) this.store.delete(oldest.value);
		}
	}

	get size(): number {
		return this.store.size;
	}
}
