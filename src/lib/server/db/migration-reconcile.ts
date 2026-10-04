/**
 * Tracks applied migrations by hash instead of Drizzle's timestamp watermark.
 *
 * Drizzle's migrate() runs only journal entries whose `when` is newer than the newest
 * `created_at` in __drizzle_migrations. Every fork migration is a future upstream PR, so
 * its journal entry gets renumbered and re-stamped (a `when` newer than upstream's latest)
 * whenever it is rebased or upstreamed. Under the watermark that either skips a migration
 * (an entry older than one already applied) or re-runs one (an applied entry re-stamped
 * newer than the watermark, failing with "duplicate column").
 *
 * On an existing database Dockhand therefore:
 * 1. syncs `created_at` of every applied migration (matched by hash) to its journal
 *    `when`, so Drizzle's own migrate(), and an upstream build later, sees a consistent
 *    watermark and never re-runs an applied migration;
 * 2. applies every unrecorded migration in journal order, whatever its `when`, recording
 *    it the same way Drizzle does.
 * A fresh database still goes through Drizzle's migrate().
 *
 * Only `idx`, tag and `when` of an applied migration may change; editing its SQL changes
 * its hash and makes it pending again.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Sql, TransactionSql } from 'postgres';

export interface JournalMigration {
	tag: string;
	/** Journal `when`; also stored as created_at, like Drizzle. */
	when: number;
	/** sha256 of the .sql file, identical to Drizzle's hash. */
	hash: string;
	/** Statements split on Drizzle's statement-breakpoint marker. */
	statements: string[];
}

export interface MigrationExecutor {
	/** created_at of every recorded migration, keyed by hash. */
	recorded(): Promise<Map<string, number>>;
	setCreatedAt(hash: string, when: number): Promise<void>;
	/** Run the statements and insert (hash, when) into __drizzle_migrations atomically. */
	apply(migration: JournalMigration): Promise<void>;
}

export function readJournalMigrations(migrationsFolder: string): JournalMigration[] {
	const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf-8')) as {
		entries: { tag: string }[];
	};
	return readMigrationFiles({ migrationsFolder }).map((m, i) => ({
		tag: journal.entries[i].tag,
		when: m.folderMillis,
		hash: m.hash,
		statements: m.sql.filter((s) => s.trim() !== '')
	}));
}

/** Aligns created_at of applied migrations with their journal `when`; returns the re-stamped tags. */
export async function syncMigrationTimestamps(
	migrations: JournalMigration[],
	executor: MigrationExecutor
): Promise<string[]> {
	const recorded = await executor.recorded();
	const restamped: string[] = [];
	for (const m of migrations) {
		const createdAt = recorded.get(m.hash);
		if (createdAt === undefined || createdAt === m.when) continue;
		await executor.setCreatedAt(m.hash, m.when);
		restamped.push(m.tag);
	}
	return restamped;
}

/** Applies every unrecorded migration in journal order; returns the applied tags. */
export async function applyUnrecordedMigrations(
	migrations: JournalMigration[],
	executor: MigrationExecutor
): Promise<string[]> {
	const recorded = await executor.recorded();
	const applied: string[] = [];
	for (const m of migrations) {
		if (recorded.has(m.hash)) continue;
		await executor.apply(m);
		recorded.set(m.hash, m.when);
		applied.push(m.tag);
	}
	return applied;
}

/** better-sqlite3 / bun:sqlite style client (prepare/exec/transaction). */
export function sqliteMigrationExecutor(client: {
	prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
	exec(sql: string): unknown;
	transaction<T>(fn: () => T): () => T;
}): MigrationExecutor {
	return {
		async recorded() {
			const rows = client.prepare('SELECT hash, created_at FROM __drizzle_migrations').all() as { hash: string; created_at: number | string }[];
			return new Map(rows.map((r) => [r.hash, Number(r.created_at)]));
		},
		async setCreatedAt(hash, when) {
			client.prepare('UPDATE __drizzle_migrations SET created_at = ? WHERE hash = ?').run(when, hash);
		},
		async apply(m) {
			client.transaction(() => {
				for (const stmt of m.statements) client.exec(stmt);
				client.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(m.hash, m.when);
			})();
		}
	};
}

/** postgres-js client; Drizzle keeps its table in the `drizzle` schema. */
export function postgresMigrationExecutor(client: Sql): MigrationExecutor {
	return {
		async recorded() {
			const rows = await client<{ hash: string; created_at: number | string }[]>`SELECT hash, created_at FROM drizzle.__drizzle_migrations`;
			return new Map(rows.map((r) => [r.hash, Number(r.created_at)]));
		},
		async setCreatedAt(hash, when) {
			await client`UPDATE drizzle.__drizzle_migrations SET created_at = ${when} WHERE hash = ${hash}`;
		},
		async apply(m) {
			await client.begin(async (tx: TransactionSql) => {
				for (const stmt of m.statements) await tx.unsafe(stmt);
				await tx.unsafe('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [m.hash, m.when]);
			});
		}
	};
}
