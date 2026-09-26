import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

it('existing stack sources remain pending until explicitly migrated', () => {
	const db = new Database(':memory:');
	db.exec('CREATE TABLE stack_sources (id INTEGER PRIMARY KEY, stack_name TEXT NOT NULL)');
	db.exec("INSERT INTO stack_sources (stack_name) VALUES ('existing')");
	db.exec(readFileSync(new URL('../drizzle/0020_hawser_file_location.sql', import.meta.url), 'utf8'));
	const location = (name: string) => {
		const row = db.query<{ file_location: string }, [string]>('SELECT file_location FROM stack_sources WHERE stack_name = ?').get(name);
		assert.ok(row);
		return row.file_location;
	};
	assert.equal(location('existing'), 'dockhand');
	db.exec("INSERT INTO stack_sources (stack_name) VALUES ('new')");
	assert.equal(location('new'), 'dockhand');
	db.exec("UPDATE stack_sources SET file_location = 'hawser' WHERE stack_name = 'existing'");
	assert.equal(location('existing'), 'hawser');
	db.close();
});
