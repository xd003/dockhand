import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const SQLITE_MIGRATION = resolve(new URL('../drizzle/0019_linked_stack_files.sql', import.meta.url).pathname);
const PG_MIGRATION = resolve(new URL('../drizzle-pg/0019_linked_stack_files.sql', import.meta.url).pathname);

function applySql(db: Database, path: string) {
	for (const statement of readFileSync(path, 'utf8').split('--> statement-breakpoint').map((sql) => sql.trim()).filter(Boolean)) {
		db.exec(statement);
	}
}

	describe('migration 0019 (linked stack files)', () => {
	it('adds linked metadata to the current SQLite schema', () => {
		const db = new Database(':memory:');
		db.exec('CREATE TABLE stack_sources (id INTEGER PRIMARY KEY);');
		applySql(db, SQLITE_MIGRATION);

		const sourceColumns = (db.prepare("PRAGMA table_info('stack_sources')").all() as Array<{ name: string }>).map((column) => column.name);
		assert.ok(sourceColumns.includes('linked_files'));
	});

	for (const [name, path] of [['sqlite', SQLITE_MIGRATION], ['postgres', PG_MIGRATION]] as const) {
		it(`(${name}) only adds linked metadata`, () => {
			const sql = readFileSync(path, 'utf8');
			assert.match(sql, /linked_files/);
			assert.doesNotMatch(sql, /DROP TABLE\s+[`"]?stack_sources/i);
			assert.doesNotMatch(sql, /DROP COLUMN/i);
		});
	}
});
