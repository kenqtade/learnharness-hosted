/**
 * Server-side turn liveness: which chats currently have a teacher turn in
 * flight. The missing half of "sessions keep running in the background" —
 * together with the write-ahead persist in chat-handler, a returning client
 * can tell "the teacher is mid-turn — don't resurrect, don't start anything"
 * apart from "the record IS current".
 *
 * Lives on globalThis, NOT a module-level Map: Next dev compiles each route
 * as its own entry, so a module-level singleton is a DIFFERENT instance in
 * the page render, GET /api/chats/[id], and POST /api/chat — the page would
 * read an empty registry while the chat route holds the live turn (the bug:
 * returning mid-turn showed the 409 banner instead of the busy state).
 * globalThis spans module instances within the process; it is the standard
 * Next.js singleton channel (same reason Prisma clients live there).
 *
 * Still ephemeral BY DESIGN: a process restart clears it, so there are no
 * stale flags to clean up — a crashed turn recovers via the write-ahead
 * record + mount continuation on the next visit. The TTL is a leak guard for
 * teacher turns whose onFinish never fires. Preparation owners are pinned
 * until their callback settles: expiring an executing grader would admit a
 * second writer. Handoff restores the teacher TTL with a fresh timestamp.
 *
 * THE DURABLE HALF (hosted fork, 2026-11-14): on a serverless host the
 * process registry is not enough — every request can land on a different
 * instance, so a reconnect (or a deadline-paused turn that CONTINUES in a
 * fresh invocation) found an idle server while the teacher was working. The
 * owning instance therefore leaves a DURABLE MARKER behind
 * (src/store/turn-markers.ts), renewed every 20 s while the turn runs, and
 * every instance can read it (isTurnRunningAnywhere). The marker is a
 * liveness aid, never a lock: the 409 gate still uses the process registry
 * alone, exactly as before.
 */

import { emit } from "../core/events.ts";
import { clearTurnFailure } from "./turn-runs.ts";
import { clearTurn, heartbeatTurn, markTurn, readTurnMarker, TURN_MARKER_TTL_MS } from "../store/turn-markers.ts";
import { convexMode } from "../store/vfs.ts";
import { storeReady } from "../store/ready.ts";

interface TurnOwner {
	token: object;
	preparing: boolean;
}

interface LhGlobal {
	__lhTurnRegistry?: Map<string, number>;
	__lhTurnOwners?: Map<string, TurnOwner>;
	__lhTurnHeartbeats?: Map<string, ReturnType<typeof setInterval>>;
}

function registry(): Map<string, number> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnRegistry ??= new Map<string, number>());
}

function owners(): Map<string, TurnOwner> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnOwners ??= new Map<string, TurnOwner>());
}

function heartbeats(): Map<string, ReturnType<typeof setInterval>> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnHeartbeats ??= new Map<string, ReturnType<typeof setInterval>>());
}

const inFlight = registry();
const MAX_TURN_MS = 30 * 60_000;
/** How often the durable marker is renewed while a turn runs. */
const HEARTBEAT_MS = 20_000;

/**
 * HOSTED (the durable marker is a cross-instance channel). The Convex seam
 * is what actually carries a marker between instances; the Vercel wall is
 * the deployment that has instances at all. Off-hosted the marker is still
 * written (it is one small record) but never READ — the desktop keeps the
 * exact behaviour it had before this wave.
 */
export function hostedTurnMarkers(env: Record<string, string | undefined> = process.env): boolean {
	return convexMode || env.VERCEL === "1";
}

/** The marker write must never break a turn: a failed write only costs the
 *  cross-instance liveness, never the turn itself. */
function safeWrite(chatId: string, write: () => void): void {
	try {
		write();
	} catch (err) {
		console.error(`[turn ${chatId}] turn marker write failed:`, err);
	}
}

/** Renew the durable marker's heartbeat while the turn runs. */
function startHeartbeat(chatId: string): void {
	stopHeartbeat(chatId);
	const timer = setInterval(() => safeWrite(chatId, () => heartbeatTurn(chatId)), HEARTBEAT_MS);
	(timer as { unref?: () => void }).unref?.();
	heartbeats().set(chatId, timer);
}

function stopHeartbeat(chatId: string): void {
	const timer = heartbeats().get(chatId);
	if (!timer) return;
	clearInterval(timer);
	heartbeats().delete(chatId);
}

/**
 * Mark a turn as starting. Returns false if one is already running for the
 * chat — the caller rejects the request (only one turn may own a chat).
 * Announces "turn-started" AFTER the registry write: a listener that reads
 * isTurnRunning or fetches the record sees consistent truth. The rejected
 * double-begin (the 409 path) stays silent — no turn began. A private
 * preparation owner pins the entry until handoff; ordinary callers keep
 * the existing TTL behavior and need not pass an owner.
 */
export function beginTurn(chatId: string, preparationOwner?: object): boolean {
	if (isTurnRunning(chatId)) return false;
	clearTurnFailure(chatId);
	if (preparationOwner) owners().set(chatId, { token: preparationOwner, preparing: true });
	else owners().delete(chatId);
	inFlight.set(chatId, Date.now());
	// The durable half: other instances must see this turn (the registry
	// above is process memory only).
	safeWrite(chatId, () => markTurn(chatId, { continuing: false }));
	startHeartbeat(chatId);
	emit("turn-started", { chatId });
	return true;
}

/**
 * Mark the chat's turn as finished after normal settlement, or after the
 * failure notice has been retained by settlement cleanup. A subsequent
 * fetch reads durable truth, never a promise that an unsaved reply landed.
 * Emits only when an entry was actually present: a
 * defensive no-op endTurn must not fire a spurious settle. Passing an
 * owner fences cleanup against a newer turn; omitted retains the original
 * unconditional end API for ordinary turns.
 *
 * THE DURABLE MARKER: a turn that HANDS OVER to a continuation (a paused
 * turn, whose next run starts in a fresh invocation) keeps its marker — the
 * chat is still busy. The continuation's own beginTurn overwrites it. Every
 * other ending clears it, so a settled chat is settled everywhere.
 */
export function endTurn(chatId: string, owner?: object): void {
	if (owner && owners().get(chatId)?.token !== owner) return;
	owners().delete(chatId);
	stopHeartbeat(chatId);
	const marker = readTurnMarker(chatId);
	if (marker?.continuing) {
		// The turn hands over: keep the marker (the continuation overwrites it).
	} else safeWrite(chatId, () => clearTurn(chatId));
	if (inFlight.delete(chatId)) emit("turn-settled", { chatId });
}

/** Private ownership fence for preparation and its handed-off teacher. */
export function isTurnOwner(chatId: string, owner: object): boolean {
	return isTurnRunning(chatId) && owners().get(chatId)?.token === owner;
}

/** Transfer the pinned preparation to the ordinary teacher TTL, without
 * ending/restarting the turn or emitting another lifecycle event. */
export function handoffTurn(chatId: string, owner: object): boolean {
	if (!isTurnOwner(chatId, owner)) return false;
	owners().get(chatId)!.preparing = false;
	inFlight.set(chatId, Date.now());
	return true;
}

/** True while the chat's turn is in flight; lazily evicts stale entries.
 * The eviction path is DELIBERATELY event-free: it is a leak guard for a
 * turn whose onFinish never fired (itself pathological), it runs lazily
 * from a read, and emitting from a read is a side-effect smell. Silence
 * here is a choice, not an oversight. */
export function isTurnRunning(chatId: string): boolean {
	const since = inFlight.get(chatId);
	if (since === undefined) return false;
	if (!owners().get(chatId)?.preparing && Date.now() - since > MAX_TURN_MS) {
		inFlight.delete(chatId);
		owners().delete(chatId);
		return false;
	}
	return true;
}

/**
 * A turn running on ANOTHER instance: a durable marker whose heartbeat is
 * younger than the staleness window. Hosted only — off-hosted the marker
 * never leaves the process that wrote it, so "somewhere else" does not
 * exist and the desktop keeps its old behaviour.
 *
 * The read REFRESHES the store first (a forced Convex sync), so it sees a
 * state that is seconds old, not the copy this instance happened to load
 * when it booted.
 */
export async function isTurnRunningRemotely(chatId: string): Promise<boolean> {
	if (!hostedTurnMarkers()) return false;
	try {
		await storeReady(true);
	} catch (err) {
		// The seam is unreachable: fall back to this instance's own truth
		// (false — the local registry was already checked by the caller).
		console.error(`[turn ${chatId}] turn marker refresh failed:`, err);
		return false;
	}
	const marker = readTurnMarker(chatId);
	if (!marker) return false;
	return Date.now() - marker.heartbeatAt < TURN_MARKER_TTL_MS;
}

/**
 * The chat's turn is running — on THIS instance or on another one. This is
 * the liveness the client half reads (`turnInFlight`): on a hosted
 * deployment the answer must be true while the teacher works, no matter
 * which instance the browser's request landed on.
 */
export async function isTurnRunningAnywhere(chatId: string): Promise<boolean> {
	if (isTurnRunning(chatId)) return true;
	return isTurnRunningRemotely(chatId);
}
