import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqlValue = string | number | bigint | null;

export interface SqlStatement {
	get(...params: SqlValue[]): unknown;
	all(...params: SqlValue[]): unknown[];
	run(...params: SqlValue[]): { changes: number | bigint };
	finalize?(): void;
}

export interface SqlDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqlStatement;
	close(): void;
}

export function openSqlite(path: string): SqlDatabase {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db: SqlDatabase = process.versions.bun
		? new (require("bun:sqlite").Database)(path)
		: new (require("node:sqlite").DatabaseSync)(path);
	db.exec(
		"PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;",
	);
	return db;
}

export function transaction<T>(db: SqlDatabase, fn: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
