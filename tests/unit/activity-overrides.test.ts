// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect, afterEach } from 'bun:test';
import {
	parseActivityOverride,
	getActivityOverrides,
	applyActivityOverrides
} from '../../src/lib/server/activity-overrides';

const VARS = ['COLLECT_CONTAINER_ACTIVITY', 'COLLECT_SYSTEM_METRICS', 'COLLECT_CONTAINER_METRICS'] as const;
const saved: Record<string, string | undefined> = {};
for (const v of VARS) saved[v] = process.env[v];

afterEach(() => {
	for (const v of VARS) {
		if (saved[v] === undefined) delete process.env[v];
		else process.env[v] = saved[v];
	}
});

function clearAll() {
	for (const v of VARS) delete process.env[v];
}

describe('parseActivityOverride', () => {
	test('truthy values', () => {
		expect(parseActivityOverride('true')).toBe(true);
		expect(parseActivityOverride(' TRUE ')).toBe(true);
		expect(parseActivityOverride('1')).toBe(true);
	});
	test('falsy values', () => {
		expect(parseActivityOverride('false')).toBe(false);
		expect(parseActivityOverride('0')).toBe(false);
	});
	test('unset/empty means no override', () => {
		expect(parseActivityOverride(undefined)).toBeNull();
		expect(parseActivityOverride('')).toBeNull();
	});
	test('garbage is invalid', () => {
		expect(parseActivityOverride('yes')).toBe('invalid');
	});
});

describe('getActivityOverrides', () => {
	test('only the set variable is forced', () => {
		clearAll();
		process.env.COLLECT_SYSTEM_METRICS = 'false';
		expect(getActivityOverrides()).toEqual({
			collectActivity: null,
			collectMetrics: false,
			collectContainerMetrics: null
		});
	});
	test('invalid value is ignored', () => {
		clearAll();
		process.env.COLLECT_CONTAINER_ACTIVITY = 'maybe';
		expect(getActivityOverrides().collectActivity).toBeNull();
	});
});

describe('applyActivityOverrides', () => {
	test('overrides only forced fields and preserves the rest', () => {
		clearAll();
		process.env.COLLECT_SYSTEM_METRICS = '0';
		process.env.COLLECT_CONTAINER_METRICS = '1';
		const out = applyActivityOverrides({
			collectActivity: true,
			collectMetrics: true,
			collectContainerMetrics: false,
			name: 'x'
		});
		expect(out).toEqual({
			collectActivity: true,
			collectMetrics: false,
			collectContainerMetrics: true,
			name: 'x'
		});
	});
});
