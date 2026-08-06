/**
 * Transition lock guard for git-related API routes.
 *
 * While a git repository mode transition is running (state !== 'idle'), every
 * git-mutating endpoint returns 409 Conflict so the state machine can never be
 * raced by concurrent writes (F9/N5).
 */

import { json } from '@sveltejs/kit';
import { getGitModeTransition } from './db';

/**
 * Verify a RequestEvent is not mid-transition. Returns a 409 Response when
 * locked, otherwise null (caller proceeds).
 */
export async function assertNotTransitioning(): Promise<Response | null> {
	const transition = await getGitModeTransition();
	if (transition && transition.state !== 'idle') {
		return json({ error: 'Git repository mode transition in progress' }, { status: 409 });
	}
	return null;
}
