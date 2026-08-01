import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const SQLITE_MIGRATION = resolve(
	new URL('../drizzle/0010_apply_commit_changes.sql', import.meta.url).pathname
);
const PG_MIGRATION = resolve(
	new URL('../drizzle-pg/0010_apply_commit_changes.sql', import.meta.url).pathname
);

const COLUMNS_REQUIRED_BY_MIGRATION = `
CREATE TABLE git_repositories (
	id INTEGER PRIMARY KEY,
	name TEXT,
	auto_update INTEGER DEFAULT 0,
	auto_update_schedule TEXT,
	auto_update_cron TEXT,
	webhook_enabled INTEGER DEFAULT 0,
	webhook_secret TEXT
);
CREATE TABLE git_stacks (
	id INTEGER PRIMARY KEY,
	repository_id INTEGER,
	stack_name TEXT,
	auto_update INTEGER DEFAULT 0,
	auto_update_schedule TEXT,
	auto_update_cron TEXT,
	webhook_enabled INTEGER DEFAULT 0,
	webhook_secret TEXT,
	force_redeploy INTEGER DEFAULT 0
);
CREATE TABLE stack_sources (
	id INTEGER PRIMARY KEY
);
`;

interface SeedStack {
	id: number;
	repositoryId: number;
	autoUpdate: boolean;
	schedule: string | null;
	cron: string | null;
	webhookEnabled?: boolean;
	webhookSecret?: string | null;
}

interface SeedRepo {
	id: number;
	autoUpdate?: boolean;
	webhookEnabled?: boolean;
}

function runMigration(
	repos: SeedRepo[],
	stacks: SeedStack[]
): { repoRows: Array<Record<string, unknown>>; stackRows: Array<Record<string, unknown>>; stackColumns: string[] } {
	const db = new Database(':memory:');
	db.exec(COLUMNS_REQUIRED_BY_MIGRATION);

	for (const repo of repos) {
		db.prepare(
			'INSERT INTO git_repositories (id, name, auto_update, webhook_enabled) VALUES (?, ?, ?, ?)'
		).run(repo.id, `repo-${repo.id}`, repo.autoUpdate ? 1 : 0, repo.webhookEnabled ? 1 : 0);
	}
	for (const stack of stacks) {
		db.prepare(
			`INSERT INTO git_stacks
				(id, repository_id, stack_name, auto_update, auto_update_schedule, auto_update_cron, webhook_enabled, webhook_secret, force_redeploy)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
		).run(
			stack.id,
			stack.repositoryId,
			`stack-${stack.id}`,
			stack.autoUpdate ? 1 : 0,
			stack.schedule,
			stack.cron,
			stack.webhookEnabled ? 1 : 0,
			stack.webhookSecret ?? null
		);
	}

	const sql = readFileSync(SQLITE_MIGRATION, 'utf8');
	for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
		db.exec(statement);
	}

	const repoRows = db.prepare(
		'SELECT id, auto_update, auto_update_schedule, auto_update_cron, webhook_enabled, webhook_secret FROM git_repositories ORDER BY id'
	).all() as Array<Record<string, unknown>>;
	const stackRows = db.prepare(
		'SELECT id, repository_id, force_redeploy FROM git_stacks ORDER BY id'
	).all() as Array<Record<string, unknown>>;
	const stackColumns = (db.prepare("PRAGMA table_info('git_stacks')").all() as Array<{ name: string }>)
		.map((c) => c.name);

	return { repoRows, stackRows, stackColumns };
}

function repoById(rows: Array<Record<string, unknown>>, id: number): Record<string, unknown> {
	const row = rows.find((r) => r.id === id);
	assert.ok(row, `expected repository ${id} to exist`);
	return row;
}

describe('migration 0010 (apply_commit_changes)', () => {
	it('promotes the most frequent stack schedule to the repository', () => {
		const { repoRows } = runMigration(
			[{ id: 1 }],
			[
				{ id: 1, repositoryId: 1, autoUpdate: true, schedule: 'custom', cron: '0 3 * * 0' }, // weekly
				{ id: 2, repositoryId: 1, autoUpdate: true, schedule: 'custom', cron: '0 * * * *' }, // hourly
				{ id: 3, repositoryId: 1, autoUpdate: true, schedule: 'daily', cron: '0 3 * * *' } // daily
			]
		);

		assert.equal(repoById(repoRows, 1).auto_update, 1);
		assert.equal(repoById(repoRows, 1).auto_update_cron, '0 * * * *');
	});

	it('prefers a sub-hourly schedule over hourly, daily and weekly', () => {
		const { repoRows } = runMigration(
			[{ id: 1 }],
			[
				{ id: 1, repositoryId: 1, autoUpdate: true, schedule: 'daily', cron: '0 3 * * *' },
				{ id: 2, repositoryId: 1, autoUpdate: true, schedule: 'custom', cron: '*/5 * * * *' },
				{ id: 3, repositoryId: 1, autoUpdate: true, schedule: 'custom', cron: '0 * * * *' }
			]
		);

		assert.equal(repoById(repoRows, 1).auto_update_cron, '*/5 * * * *');
	});

	it('breaks ties on equal-frequency schedules by the lowest stack id', () => {
		const { repoRows } = runMigration(
			[{ id: 1 }],
			[
				{ id: 9, repositoryId: 1, autoUpdate: true, schedule: 'custom', cron: '0 3 * * 0' },
				{ id: 2, repositoryId: 1, autoUpdate: true, schedule: 'custom', cron: '0 3 * * 0' }
			]
		);

		assert.equal(repoById(repoRows, 1).auto_update_schedule, 'custom');
		assert.equal(repoById(repoRows, 1).auto_update_cron, '0 3 * * 0');
	});

	it('leaves repositories that already have auto_update enabled untouched', () => {
		const { repoRows } = runMigration(
			[{ id: 3, autoUpdate: true }],
			[
				{ id: 6, repositoryId: 3, autoUpdate: true, schedule: 'custom', cron: '0 * * * *' }
			]
		);

		const repo = repoById(repoRows, 3);
		assert.equal(repo.auto_update, 1);
		assert.equal(repo.auto_update_schedule, null);
		assert.equal(repo.auto_update_cron, null);
	});

	it('ignores stacks with scheduled sync disabled', () => {
		const { repoRows } = runMigration(
			[{ id: 1 }],
			[
				{ id: 1, repositoryId: 1, autoUpdate: false, schedule: 'daily', cron: '0 3 * * *' }
			]
		);

		assert.equal(repoById(repoRows, 1).auto_update, 0);
		assert.equal(repoById(repoRows, 1).auto_update_cron, null);
	});

	it('backfills force_redeploy only for stacks with a webhook enabled', () => {
		const { stackRows } = runMigration(
			[{ id: 1 }],
			[
				{ id: 1, repositoryId: 1, autoUpdate: false, schedule: null, cron: null, webhookEnabled: true, webhookSecret: 'secret-a' },
				{ id: 2, repositoryId: 1, autoUpdate: false, schedule: null, cron: null, webhookEnabled: false }
			]
		);

		const stack1 = stackRows.find((s) => s.id === 1);
		const stack2 = stackRows.find((s) => s.id === 2);
		assert.equal(stack1?.force_redeploy, 1);
		assert.equal(stack2?.force_redeploy, 0);
	});

	it('enables the repository webhook and promotes the lowest-id stack secret', () => {
		const { repoRows } = runMigration(
			[{ id: 1 }],
			[
				{ id: 9, repositoryId: 1, autoUpdate: false, schedule: null, cron: null, webhookEnabled: true, webhookSecret: 'secret-b' },
				{ id: 2, repositoryId: 1, autoUpdate: false, schedule: null, cron: null, webhookEnabled: true, webhookSecret: 'secret-a' }
			]
		);

		const repo = repoById(repoRows, 1);
		assert.equal(repo.webhook_enabled, 1);
		assert.equal(repo.webhook_secret, 'secret-a');
	});

	it('does not enable the repository webhook when no stack has a secret', () => {
		const { repoRows } = runMigration(
			[{ id: 1 }],
			[
				{ id: 1, repositoryId: 1, autoUpdate: false, schedule: null, cron: null, webhookEnabled: true, webhookSecret: null }
			]
		);

		const repo = repoById(repoRows, 1);
		assert.equal(repo.webhook_enabled, 0);
		assert.equal(repo.webhook_secret, null);
	});

	it('leaves repositories that already have a webhook enabled untouched', () => {
		const { repoRows } = runMigration(
			[{ id: 2, webhookEnabled: true }],
			[
				{ id: 5, repositoryId: 2, autoUpdate: false, schedule: null, cron: null, webhookEnabled: true, webhookSecret: 'stack-secret' }
			]
		);

		const repo = repoById(repoRows, 2);
		assert.equal(repo.webhook_enabled, 1);
		assert.equal(repo.webhook_secret, null);
	});

	it('does not promote webhooks from stacks in repos with no webhook-enabled stacks', () => {
		const { repoRows } = runMigration(
			[{ id: 1 }],
			[
				{ id: 1, repositoryId: 1, autoUpdate: false, schedule: null, cron: null, webhookEnabled: false, webhookSecret: 'secret-a' }
			]
		);

		const repo = repoById(repoRows, 1);
		assert.equal(repo.webhook_enabled, 0);
		assert.equal(repo.webhook_secret, null);
	});

	it('is additive: keeps the stack-level auto_update columns for downgrade compatibility', () => {
		const { stackColumns } = runMigration([{ id: 1 }], []);

		for (const column of ['auto_update', 'auto_update_schedule', 'auto_update_cron', 'compose_paths']) {
			assert.ok(stackColumns.includes(column), `expected git_stacks to keep column "${column}"`);
		}
	});

	it('adds compose_paths to stack_sources', () => {
		const db = new Database(':memory:');
		db.exec(COLUMNS_REQUIRED_BY_MIGRATION);
		const sql = readFileSync(SQLITE_MIGRATION, 'utf8');
		for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
			db.exec(statement);
		}

		const columns = (db.prepare("PRAGMA table_info('stack_sources')").all() as Array<{ name: string }>)
			.map((c) => c.name);
		assert.ok(columns.includes('compose_paths'));
	});
});

describe('migration 0010 file guards', () => {
	for (const [name, path] of [
		['sqlite', SQLITE_MIGRATION],
		['postgres', PG_MIGRATION]
	] as const) {
		it(`(${name}) never drops the stack-level auto_update columns`, () => {
			const sql = readFileSync(path, 'utf8');
			assert.ok(
				!/DROP COLUMN\s+"?auto_update/.test(sql),
				'migration must stay additive (no DROP COLUMN on auto_update)'
			);
		});

		it(`(${name}) backfills force_redeploy for webhook-enabled stacks`, () => {
			const sql = readFileSync(path, 'utf8');
			assert.match(sql, /force_redeploy/);
			assert.match(sql, /webhook_enabled/);
		});

		it(`(${name}) promotes the stack webhook secret to the repository`, () => {
			const sql = readFileSync(path, 'utf8');
			assert.match(sql, /webhook_secret/);
			assert.match(sql, /webhook_enabled[`"]?\s*=\s*(1|true)/);
		});

		it(`(${name}) ranks schedules by frequency when promoting them`, () => {
			const sql = readFileSync(path, 'utf8');
			assert.match(sql, /ORDER BY[\s\S]*CASE/);
			assert.match(sql, /LIMIT 1/);
		});
	}
});
