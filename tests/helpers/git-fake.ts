import { mock } from 'bun:test';

/**
 * Shared registration point for faking `src/lib/server/git.ts`.
 *
 * Same constraints as db-fake.ts: mock.module() replaces a module WHOLESALE for
 * the entire test process, and the first resolution freezes its export set. Two
 * files mocking git.ts with different shapes would clobber each other, so every
 * export any test needs is pre-declared here as a call-time dispatcher. Add the
 * name to KNOWN_EXPORTS and call registerGitFake(); never add a separate
 * mock.module() for git.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/** Every git.ts export any test file fakes, across the whole suite. */
const KNOWN_EXPORTS = ['finalizeDeletionSync', 'notifyGitSync'] as const;

const impls: Record<string, AnyFn> = {};

export function registerGitFake(name: (typeof KNOWN_EXPORTS)[number], fn: AnyFn): void {
	impls[name] = fn;
}

function dispatcher(name: string): AnyFn {
	return (...args: unknown[]) => {
		const impl = impls[name];
		if (!impl) {
			throw new Error(
				`git-fake: '${name}' was called but no test file has registered an implementation for it yet ` +
					`(registerGitFake('${name}', ...) must run before the test that calls it)`
			);
		}
		return impl(...args);
	};
}

const moduleShape: Record<string, AnyFn> = {};
for (const name of KNOWN_EXPORTS) {
	moduleShape[name] = dispatcher(name);
}

mock.module('$lib/server/git', () => moduleShape);
