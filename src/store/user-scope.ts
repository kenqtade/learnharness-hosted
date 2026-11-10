/**
 * WHO IS THIS REQUEST FOR (branch feat/multi-user).
 *
 * The platform mode (`LH_MULTI_USER=1`) gives every account its own data
 * space: chats, graph, settings, jobs, prompt overrides. The stores keep
 * their synchronous file API; the storage seam (vfs.ts) reads the current
 * user from here and maps each data path into that user's space.
 *
 * The scope rides an AsyncLocalStorage, so everything a request starts —
 * the agent turn, background jobs, extraction, compaction, the debounced
 * Convex flush — keeps writing into the same user's space after the
 * response has gone.
 *
 * - The OWNER keeps the original (legacy) data space, so a single-user
 *   install that turns the platform on keeps all of its data.
 * - CREDENTIALS ARE PER ACCOUNT (owner ruling 2026-11-10): each account
 *   has its own auth file (API keys, custom endpoint key) in its own space,
 *   keys are never mirrored into the shared process env, deployment env
 *   keys are ignored, and work outside any account scope holds no keys.
 *   Only the server machine's own logins (subscriptions, Claude Code CLI,
 *   AWS/gcloud files) stay with the owner.
 * - Without LH_MULTI_USER nothing here is ever consulted.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const multiUser = process.env.LH_MULTI_USER === "1";

export type Role = "owner" | "member";

export interface ScopeUser {
	id: string;
	role: Role;
}

const storage = new AsyncLocalStorage<ScopeUser>();

/** Run `fn` (and everything it starts) as `user`. */
export function runAsUser<T>(user: ScopeUser, fn: () => T): T {
	return storage.run(user, fn);
}

/** Bind the rest of the current async flow to `user` — for server
 *  components, which cannot wrap their render in a callback. */
export function enterUser(user: ScopeUser): void {
	storage.enterWith(user);
}

/** The user this code runs for, or null outside any request scope
 *  (boot work, tests, single-user mode). */
export function currentUser(): ScopeUser | null {
	return storage.getStore() ?? null;
}

/** The data space for a user: null = the legacy space (owner / no scope). */
export function dataSpaceOf(user: ScopeUser | null): string | null {
	if (!multiUser || !user || user.role === "owner") return null;
	return user.id;
}

/** User ids become path segments — never let one escape its folder. */
export function safeUserId(id: string): boolean {
	return /^[a-z0-9_-]{6,64}$/i.test(id);
}
