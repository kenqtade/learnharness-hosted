/**
 * THE DURABLE TURN MARKER (hosted fork, 2026-11-14) — "a teacher turn is
 * running SOMEWHERE", in one small record per chat.
 *
 * WHY: on a serverless host every request can land on a different instance,
 * and the turn liveness registry (src/server/turn-liveness.ts) is process
 * memory. So a learner's reconnect — or a deadline-paused turn that
 * CONTINUES in a fresh invocation — looked idle to the instance that served
 * the reconnect: `turnInFlight` was false and the reattach stream answered
 * "turn-settled" while the teacher was still working. This marker is the
 * durable half: the instance that OWNS the turn writes it (and renews it
 * every 20 s), every other instance reads it.
 *
 * THE SEAM: the record is written through the storage seam (src/store/vfs.ts)
 * exactly like the job records (src/store/jobs.ts) — so on a hosted
 * deployment it reaches Convex and the other instances see it (the seam's
 * debounced flusher + waitUntil carry the write out). User scope applies
 * automatically: the path lives under the data dir, so a member's marker
 * lands in that member's own data space.
 *
 * THE MARKER IS NOT A LEASE: it says "a turn is running", not "this
 * instance owns it". It is cleared when the turn ends, and it is IGNORED
 * once its heartbeat is older than the staleness window (60 s) — an
 * instance that was killed leaves a stale marker behind, never a live one.
 *
 * The hop counts the continuation runs of ONE learner input (the paused
 * turn's hand-over: hop 0 = the learner's own input, hop 1 = its first
 * continuation). It is informational — no response shape depends on it.
 */

import * as fs from "./vfs.ts";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

/** How old a marker's heartbeat may be before it stops counting as live. */
export const TURN_MARKER_TTL_MS = 60_000;

/** The durable marker of one chat's turn. */
export interface TurnMarker {
	/** When this marker was (re)written — epoch ms. */
	startedAt: number;
	/** When the owning instance last renewed it — epoch ms. */
	heartbeatAt: number;
	/** The continuation run this turn is (0 = the learner's own input). */
	hop: number;
	/** True while the turn hands over to another run (a paused turn). */
	continuing: boolean;
}

/** The markers (data/turns). Not in config.ts PATHS (orchestrator-owned). */
const TURNS_DIR = path.join(/* turbopackIgnore: true */ PATHS.data, "turns");

function markerFile(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(/* turbopackIgnore: true */ TURNS_DIR, `${chatId}.json`);
}

function write(chatId: string, marker: TurnMarker): void {
	fs.mkdirSync(TURNS_DIR, { recursive: true });
	writeFileAtomicSync(markerFile(chatId), JSON.stringify(marker), { allowInPlaceFallback: true });
}

/** The chat's marker, or null when there is none (or it is unreadable). */
export function readTurnMarker(chatId: string): TurnMarker | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ markerFile(chatId), "utf-8")) as Partial<TurnMarker> | null;
		if (!parsed || typeof parsed.heartbeatAt !== "number") return null;
		return {
			startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : parsed.heartbeatAt,
			heartbeatAt: parsed.heartbeatAt,
			hop: typeof parsed.hop === "number" ? parsed.hop : 0,
			continuing: parsed.continuing === true,
		};
	} catch {
		return null;
	}
}

/**
 * Write the chat's marker. A fresh marker starts now; the hop is kept from
 * the previous marker unless the caller names one (the continuation's hand-
 * over names the next hop), so a hand-over does not lose the count.
 * `continuing` is the caller's explicit claim: "this turn hands over to
 * another run" — the ending turn keeps such a marker, and the
 * continuation's own beginTurn overwrites it.
 */
export function markTurn(chatId: string, options: { hop?: number; continuing?: boolean } = {}): void {
	const now = Date.now();
	const previous = readTurnMarker(chatId);
	write(chatId, {
		startedAt: now,
		heartbeatAt: now,
		hop: options.hop ?? previous?.hop ?? 0,
		continuing: options.continuing === true,
	});
}

/**
 * Renew the marker's heartbeat. It NEVER creates a marker: a heartbeat that
 * arrives after the turn ended would resurrect a settled turn.
 */
export function heartbeatTurn(chatId: string): void {
	const previous = readTurnMarker(chatId);
	if (!previous) return;
	write(chatId, { ...previous, heartbeatAt: Date.now() });
}

/** Remove the chat's marker — the turn is over. A missing marker is fine. */
export function clearTurn(chatId: string): void {
	try {
		fs.unlinkSync(markerFile(chatId));
		removeLeftoverTemps(markerFile(chatId));
	} catch {
		/* never existed, or already gone */
	}
}
