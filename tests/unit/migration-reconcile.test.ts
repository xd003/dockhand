// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect, afterEach } from 'bun:test';
// @ts-expect-error -- bun:sqlite is a runtime built-in with no types installed
import { Database } from 'bun:sqlite';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
	applyUnrecordedMigrations,
	readJournalMigrations,
	sqliteMigrationExecutor,
	syncMigrationTimestamps,
	type JournalMigration
} from '../../src/lib/server/db/migration-reconcile';

const SQLITE_FOLDER = join(import.meta.dir, '../../drizzle');
const PG_FOLDER = join(import.meta.dir, '../../drizzle-pg');

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface JournalEntry { tag: string; when: number }

/** Copy of the real SQLite migrations folder with its journal entries rewritten. */
function migrationsWith(edit: (entries: JournalEntry[]) => JournalEntry[]): string {
	const dir = mkdtempSync(join(tmpdir(), 'dh-migrations-'));
	tmpDirs.push(dir);
	cpSync(SQLITE_FOLDER, dir, { recursive: true });
	const journalPath = join(dir, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
	journal.entries = edit(journal.entries);
	writeFileSync(journalPath, JSON.stringify(journal));
	return dir;
}

function columns(client: Database, table: string): string[] {
	return client.prepare(`PRAGMA table_info(${table})`).all().map((c: { name: string }) => c.name);
}

function createdAt(client: Database): Map<string, number> {
	const rows = client.prepare('SELECT hash, created_at FROM __drizzle_migrations').all() as { hash: string; created_at: number }[];
	return new Map(rows.map((r) => [r.hash, Number(r.created_at)]));
}

/** What startup does on an existing database. */
async function reconcile(client: Database, folder: string) {
	const migrations = readJournalMigrations(folder);
	const executor = sqliteMigrationExecutor(client);
	const restamped = await syncMigrationTimestamps(migrations, executor);
	const applied = await applyUnrecordedMigrations(migrations, executor);
	return { restamped, applied };
}

describe('hash-tracked migrations (real SQLite migrations)', () => {
	test('a re-stamped applied migration is not re-run, now or by a later plain Drizzle migrate()', async () => {
		const client = new Database(':memory:');
		const db = drizzle(client);
		const current = readJournalMigrations(SQLITE_FOLDER);
		const last = current[current.length - 1];
		// The database applied every migration while the newest one still had an old `when`.
		migrate(db, { migrationsFolder: migrationsWith((entries) => entries.map((e) => (e.tag === last.tag ? { ...e, when: 1 } : e))) });

		expect(await reconcile(client, SQLITE_FOLDER)).toEqual({ restamped: [last.tag], applied: [] });
		expect(createdAt(client).get(last.hash)).toBe(last.when);
		// Without the sync, Drizzle's watermark would re-run it ("duplicate column").
		expect(() => migrate(db, { migrationsFolder: SQLITE_FOLDER })).not.toThrow();
	});

	test('applies an unrecorded migration whose `when` is older than an applied one', async () => {
		const client = new Database(':memory:');
		const db = drizzle(client);
		const current = readJournalMigrations(SQLITE_FOLDER);
		const skipped = current[current.length - 2];
		// A later entry (newer `when`) was applied first, e.g. a fork migration that reached
		// the database before an upstream one placed ahead of it in the journal.
		migrate(db, { migrationsFolder: migrationsWith((entries) => entries.filter((e) => e.tag !== skipped.tag)) });
		migrate(db, { migrationsFolder: SQLITE_FOLDER });
		expect(createdAt(client).has(skipped.hash)).toBe(false);

		expect(await reconcile(client, SQLITE_FOLDER)).toEqual({ restamped: [], applied: [skipped.tag] });
		expect(new Set(createdAt(client).keys())).toEqual(new Set(current.map((m) => m.hash)));
		expect(await reconcile(client, SQLITE_FOLDER)).toEqual({ restamped: [], applied: [] });
	});

	test('a fresh database migrated by Drizzle needs nothing more', async () => {
		const client = new Database(':memory:');
		migrate(drizzle(client), { migrationsFolder: SQLITE_FOLDER });
		expect(await reconcile(client, SQLITE_FOLDER)).toEqual({ restamped: [], applied: [] });
	});

	test('a failing migration rolls back and is not recorded', async () => {
		const client = new Database(':memory:');
		client.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
		client.exec('CREATE TABLE t (a integer)');
		const migrations: JournalMigration[] = [
			{ tag: 'b', when: 1, hash: 'hb', statements: ['ALTER TABLE t ADD b integer', 'ALTER TABLE missing ADD c integer'] }
		];
		await expect(applyUnrecordedMigrations(migrations, sqliteMigrationExecutor(client))).rejects.toThrow();
		expect(columns(client, 't')).toEqual(['a']);
		expect(client.prepare('SELECT hash FROM __drizzle_migrations').all()).toEqual([]);
	});
});

describe('migration journals', () => {
	// Upstream still runs plain Drizzle, so a migration only upstreams cleanly when its
	// `when` is newer than every entry before it.
	for (const [name, folder] of [['drizzle', SQLITE_FOLDER], ['drizzle-pg', PG_FOLDER]] as const) {
		test(`${name}: every migration has a \`when\` newer than every earlier entry`, () => {
			const whens = readJournalMigrations(folder).map((m) => m.when);
			expect(whens).toEqual([...whens].sort((a, b) => a - b));
			expect(new Set(whens).size).toBe(whens.length);
		});
	}

	test('SQLite and PostgreSQL journals list the same migrations', () => {
		const pgTags = readJournalMigrations(PG_FOLDER).map((x) => x.tag);
		expect(pgTags).toEqual(readJournalMigrations(SQLITE_FOLDER).map((x) => x.tag));
	});
});
