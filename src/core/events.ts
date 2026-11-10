/**
 * THE EVENT BUS (push-architecture slice 1, owner ruling 2026-10-02: go
 * directly to the endgame — notify → fetch, no standing polls).
 *
 * One bus, every layer: server emits turn lifecycle here, the store
 * adapters emit job/chat mutations, the agent layer's background
 * registries (extraction) emit activity changes — and
 * GET /api/events turns every emission into an SSE frame for any open
 * window. The events carry the FACT, never the data: consumers fetch
 * truth on receipt (push the poke, pull the data), so payloads stay
 * tiny, schemaless, and idempotent — a reconnect heals by refetching.
 *
 * WHY globalThis (the turn-liveness discipline, same rationale): Next
 * dev compiles each route as its own module entry, so a module-level
 * singleton is a DIFFERENT instance in the page render, the events
 * route, and every emitter's entry — they would each hold a private
 * listener set and nothing would propagate. globalThis spans module
 * instances within the process; it is the standard Next singleton
 * channel (see src/server/turn-liveness.ts for the original incident).
 *
 * Pure core by law: no React, no IO, no imports — the one layer that
 * server, store, and agent may all depend on.
 */

/** The full event vocabulary — fixed from day one (slice plan, 2026-10-02). */
export interface ServerEvents {
	/** A teach turn began server-side (beginTurn) — client-initiated sends,
	 *  wake turns, other-tab turns: every origin rides the same event. */
	"turn-started": { chatId: string };
	/** A turn settled (endTurn — AFTER persistTurn, so any fetch triggered
	 *  by this event reads a durable record; ordering is guaranteed in
	 *  chat-handler's onFinish). */
	"turn-settled": { chatId: string };
	/** A job record changed (dispatch, progress, settle, abort, recovery).
	 *  chatId when known — consumers that own one chat filter on it. */
	"jobs-changed": { chatId?: string };
	/** An extraction run changed phase (activity dock). */
	"activity-changed": Record<string, never>;
	/** The session list changed (create, delete, title). */
	"chats-changed": Record<string, never>;
	/** Source inventory, display names, or organizational folders changed. */
	"sources-changed": Record<string, never>;
	/** Web subscription state changed. No account or credential data on the bus. */
	"subscriptions-changed": Record<string, never>;
	/** A chat's record changed WITHOUT a turn (the silent dismissal write).
	 *  Same notify-then-fetch contract as the turn events: open views of
	 *  the chat refetch and adopt the durable record. */
	"record-changed": { chatId: string };
	/** A compaction started/finished for the chat (owner round 14,
	 *  2026-10-05). running=true is the SEND GATE: while a compaction is
	 *  in flight the server structurally refuses model interaction for
	 *  the chat; the client mirrors it by disabling the composer/dock
	 *  submit. */
	"compaction-changed": { chatId: string; running: boolean };
}

export type ServerEventType = keyof ServerEvents;

/** The vocabulary's runtime names — the client wires one listener per
 *  name (types are erased; this list is the single source of truth for
 *  what the SSE channel can carry). */
export const SERVER_EVENT_TYPES = [
	"turn-started",
	"turn-settled",
	"jobs-changed",
	"activity-changed",
	"chats-changed",
	"sources-changed",
	"subscriptions-changed",
	"record-changed",
	"compaction-changed",
] as const satisfies readonly ServerEventType[];

/** One notification: the type discriminates the payload. */
export type ServerEvent<K extends ServerEventType = ServerEventType> = {
	type: K;
} & ServerEvents[K];

export type ServerEventListener = (event: ServerEvent) => void;

interface LhEventsGlobal {
	__lhEventBus?: Set<ScopedListener>;
	__lhEventScope?: () => string | null;
}

interface ScopedListener {
	fn: ServerEventListener;
	scope: string | null;
}

/** The shared listener set — globalThis-backed so every Next module entry
 *  (and every layer) sees ONE bus. Ephemeral by design: a process restart
 *  drops the listeners with their connections; emitters never queue. */
function listeners(): Set<ScopedListener> {
	const g = globalThis as typeof globalThis & LhEventsGlobal;
	return (g.__lhEventBus ??= new Set());
}

/** PLATFORM MODE (multi-user branch): who an event belongs to. The server
 *  installs a resolver returning the current data space ("owner" or a user
 *  id); a listener captures it when it subscribes and an emission records
 *  it, and a listener only hears its own space. With no resolver (single
 *  user, tests) or a null scope every listener hears everything — exactly
 *  the original bus. Kept on globalThis for the same reason as the bus. */
export function setEventScope(resolve: (() => string | null) | undefined): void {
	(globalThis as typeof globalThis & LhEventsGlobal).__lhEventScope = resolve;
}
function scopeNow(): string | null {
	return (globalThis as typeof globalThis & LhEventsGlobal).__lhEventScope?.() ?? null;
}

/** Listen. Returns the unsubscribe function — the SSE route's cancel and
 *  any test cleanup call it; a dropped listener leaks nothing. */
export function subscribe(listener: ServerEventListener): () => void {
	const set = listeners();
	const entry: ScopedListener = { fn: listener, scope: scopeNow() };
	set.add(entry);
	return () => set.delete(entry);
}

/** Notify every listener. Zero subscribers is a no-op (no window open —
 *  the emission was for the stores' own bookkeeping anyway). One
 *  listener throwing must never break the others or the emitter: each
 *  call is isolated, the failure logged, the loop continues. */
export function emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void {
	const scope = scopeNow();
	// Snapshot: a listener that unsubscribes (or subscribes) mid-emit must
	// not mutate the set under iteration.
	for (const { fn, scope: own } of [...listeners()]) {
		if (own !== null && scope !== null && own !== scope) continue;
		try {
			fn({ type, ...payload } as ServerEvent);
		} catch (err) {
			console.error(`[events] listener failed on ${type}:`, err);
		}
	}
}
