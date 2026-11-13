import {
	openSqlite,
	type SqlDatabase,
	type SqlStatement,
	transaction,
} from "../lib/sqlite";

export interface StrikePolicy {
	temporaryBlockMinutes: number[];
	strikeResetHours: number;
}

export interface IpBlock {
	ip: string;
	strikes: number;
	blockedUntil: number;
	permanent: boolean;
	reason: string;
	firstSeen: number;
	lastStrike: number;
}

export type BlockState =
	| { kind: "none" }
	| { kind: "temporary"; until: number; strikes: number }
	| { kind: "permanent"; strikes: number };

interface Row {
	ip: string;
	strikes: number;
	blocked_until: number;
	permanent: number;
	reason: string;
	first_seen: number;
	last_strike: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ip_blocks (
	ip            TEXT    NOT NULL PRIMARY KEY,
	strikes       INTEGER NOT NULL,
	blocked_until INTEGER NOT NULL,
	permanent     INTEGER NOT NULL DEFAULT 0,
	reason        TEXT    NOT NULL,
	first_seen    INTEGER NOT NULL,
	last_strike   INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ip_blocks_expiry ON ip_blocks (permanent, last_strike);
`;

const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

const toBlock = (r: Row): IpBlock => ({
	ip: r.ip,
	strikes: r.strikes,
	blockedUntil: r.blocked_until,
	permanent: r.permanent === 1,
	reason: r.reason,
	firstSeen: r.first_seen,
	lastStrike: r.last_strike,
});

export class IpBlockStore {
	private readonly db: SqlDatabase;
	private readonly select: SqlStatement;
	private readonly upsert: SqlStatement;
	private readonly remove: SqlStatement;
	private readonly listAll: SqlStatement;
	private readonly expire: SqlStatement;

	constructor(path: string) {
		this.db = openSqlite(path);
		this.db.exec(SCHEMA);
		this.select = this.db.prepare(`SELECT * FROM ip_blocks WHERE ip = ?`);
		this.upsert = this.db.prepare(
			`INSERT INTO ip_blocks (ip, strikes, blocked_until, permanent, reason, first_seen, last_strike)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (ip) DO UPDATE SET strikes = excluded.strikes, blocked_until = excluded.blocked_until,
			   permanent = excluded.permanent, reason = excluded.reason, last_strike = excluded.last_strike`,
		);
		this.remove = this.db.prepare(`DELETE FROM ip_blocks WHERE ip = ?`);
		this.listAll = this.db.prepare(
			`SELECT * FROM ip_blocks ORDER BY permanent DESC, last_strike DESC`,
		);
		this.expire = this.db.prepare(
			`DELETE FROM ip_blocks WHERE permanent = 0 AND last_strike < ? AND blocked_until < ?`,
		);
	}

	state(ip: string, now = Date.now()): BlockState {
		const row = this.select.get(ip) as Row | undefined;
		if (!row) return { kind: "none" };
		if (row.permanent === 1) return { kind: "permanent", strikes: row.strikes };
		if (row.blocked_until > now)
			return {
				kind: "temporary",
				until: row.blocked_until,
				strikes: row.strikes,
			};
		return { kind: "none" };
	}

	strike(
		ip: string,
		reason: string,
		policy: StrikePolicy,
		now = Date.now(),
	): BlockState {
		return transaction(this.db, () => {
			const row = this.select.get(ip) as Row | undefined;
			if (row?.permanent === 1)
				return { kind: "permanent", strikes: row.strikes };
			const recent =
				row && now - row.last_strike <= policy.strikeResetHours * HOUR_MS;
			const strikes = (recent ? row.strikes : 0) + 1;
			const minutes = policy.temporaryBlockMinutes[strikes - 1];
			const permanent = minutes === undefined;
			const until = permanent ? 0 : now + minutes * MINUTE_MS;
			this.upsert.run(
				ip,
				strikes,
				until,
				permanent ? 1 : 0,
				reason,
				row?.first_seen ?? now,
				now,
			);
			return permanent
				? { kind: "permanent", strikes }
				: { kind: "temporary", until, strikes };
		});
	}

	block(ip: string, reason: string, now = Date.now()): void {
		transaction(this.db, () => {
			const row = this.select.get(ip) as Row | undefined;
			this.upsert.run(
				ip,
				row?.strikes ?? 0,
				0,
				1,
				reason,
				row?.first_seen ?? now,
				now,
			);
		});
	}

	unblock(ip: string): boolean {
		return Number(this.remove.run(ip).changes) > 0;
	}

	get(ip: string): IpBlock | undefined {
		const row = this.select.get(ip) as Row | undefined;
		return row && toBlock(row);
	}

	list(): IpBlock[] {
		return (this.listAll.all() as Row[]).map(toBlock);
	}

	prune(strikeResetHours: number, now = Date.now()): number {
		return Number(
			this.expire.run(now - strikeResetHours * HOUR_MS, now).changes,
		);
	}

	close(): void {
		for (const s of [
			this.select,
			this.upsert,
			this.remove,
			this.listAll,
			this.expire,
		])
			s.finalize?.();
		this.db.close();
	}
}
