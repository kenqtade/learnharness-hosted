/**
 * THE DURABLE TURN MARKER (hosted fork, 2026-11-14) — the liveness that
 * crosses serverless instances.
 *
 * Pinned here:
 *  - the marker lifecycle: begin → marked, the heartbeat renews it, end →
 *    cleared, and a turn that HANDS OVER to a continuation keeps it;
 *  - isTurnRunningAnywhere: local, remote, stale — and the hosted gate (a
 *    desktop deployment must not see a remote turn at all);
 *  - the reattach stream of a turn running elsewhere: it ends with EXACTLY
 *    the settled terminal when the marker clears, and at the hard cap.
 *
 * Isolation: a temp data dir (the store's own seam), no network, injected
 * intervals so the waiting paths run in milliseconds.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-turn-markers-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
// The hosted gate (src/server/turn-liveness.ts): the durable marker is a
// cross-instance channel, so it is only READ on a hosted deployment.
process.env.VERCEL = "1";

const { PATHS } = await import("../config.ts");
const { readTurnMarker, markTurn, heartbeatTurn, clearTurn } = await import("../src/store/turn-markers.ts");
const { beginTurn, endTurn, isTurnRunning, isTurnRunningAnywhere, isTurnRunningRemotely } = await import("../src/server/turn-liveness.ts");
const { remoteTurnResponse } = await import("../src/server/turn-stream.ts");
const { settledTurnResponse } = await import("../src/server/turn-runs.ts");

after(() => {
	fs.rmSync(directory, { recursive: true, force: true });
});

/** The marker file, written the way ANOTHER instance writes it (through the
 *  store's own path) — the shape a remote turn leaves behind. */
function writeRemoteMarker(chatId: string, heartbeatAt: number): void {
	const dir = path.join(PATHS.data, "turns");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${chatId}.json`), JSON.stringify({ startedAt: heartbeatAt, heartbeatAt, hop: 0, continuing: false }));
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) out += decoder.decode(value, { stream: true });
	}
	return out;
}

describe("durable turn marker", () => {
	it("begin marks the chat, the heartbeat renews it, end clears it", async () => {
		const id = "chat_marker_lifecycle";
		assert.equal(readTurnMarker(id), null, "no marker before the turn");
		assert.equal(beginTurn(id), true);
		const marked = readTurnMarker(id);
		assert.ok(marked, "beginTurn leaves a durable marker behind");
		assert.equal(marked.continuing, false);
		assert.equal(marked.hop, 0);
		assert.ok(fs.existsSync(path.join(PATHS.data, "turns", `${id}.json`)), "the marker is a store record (the Convex seam carries it)");
		await new Promise((r) => setTimeout(r, 15));
		heartbeatTurn(id);
		const renewed = readTurnMarker(id)!;
		assert.ok(renewed.heartbeatAt > marked.heartbeatAt, "the heartbeat renewed the marker");
		assert.equal(renewed.startedAt, marked.startedAt, "the renewal keeps the turn's start");
		endTurn(id);
		assert.equal(readTurnMarker(id), null, "the settled turn leaves no marker");
		assert.equal(isTurnRunning(id), false);
	});

	it("the running turn renews its own marker while it runs", (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
		const id = "chat_marker_heartbeat";
		beginTurn(id);
		const before = readTurnMarker(id)!.heartbeatAt;
		t.mock.timers.tick(20_000);
		const after = readTurnMarker(id)!.heartbeatAt;
		assert.ok(after > before, "the 20 s heartbeat renewed the marker");
		endTurn(id);
		assert.equal(readTurnMarker(id), null);
		t.mock.timers.reset();
	});

	it("a turn that hands over to a continuation keeps its marker", () => {
		const id = "chat_marker_continuing";
		beginTurn(id);
		markTurn(id, { continuing: true, hop: 1 });
		endTurn(id);
		const kept = readTurnMarker(id);
		assert.ok(kept, "the ending turn keeps the continuing marker");
		assert.equal(kept.continuing, true);
		assert.equal(kept.hop, 1);
		// The continuation's own beginTurn takes the marker over.
		beginTurn(id);
		const taken = readTurnMarker(id)!;
		assert.equal(taken.continuing, false, "the continuation is a turn of its own");
		assert.equal(taken.hop, 1, "the hop survives the hand-over");
		endTurn(id);
		assert.equal(readTurnMarker(id), null, "the last run clears the marker");
	});

	it("a heartbeat never resurrects a settled turn", () => {
		const id = "chat_marker_no_resurrect";
		beginTurn(id);
		endTurn(id);
		heartbeatTurn(id);
		assert.equal(readTurnMarker(id), null, "no marker is created after the turn ended");
	});
});

describe("isTurnRunningAnywhere", () => {
	it("sees a local turn, a remote turn, and ignores a stale one", async () => {
		const id = "chat_anywhere";
		assert.equal(await isTurnRunningAnywhere(id), false, "idle");
		assert.equal(beginTurn(id), true);
		assert.equal(await isTurnRunningAnywhere(id), true, "the local registry");
		endTurn(id);
		writeRemoteMarker(id, Date.now());
		assert.equal(await isTurnRunningAnywhere(id), true, "another instance's live turn");
		writeRemoteMarker(id, Date.now() - 61_000);
		assert.equal(await isTurnRunningAnywhere(id), false, "a marker older than 60 s is stale");
		assert.equal(await isTurnRunningRemotely(id), false);
	});

	it("off a hosted deployment the remote marker is not read (the desktop is unchanged)", async () => {
		const id = "chat_anywhere_desktop";
		writeRemoteMarker(id, Date.now());
		const hosted = process.env.VERCEL;
		delete process.env.VERCEL;
		try {
			assert.equal(await isTurnRunningAnywhere(id), false, "no remote liveness off a host");
			assert.equal(await isTurnRunningRemotely(id), false);
		} finally {
			if (hosted !== undefined) process.env.VERCEL = hosted;
		}
		clearTurn(id);
	});
});

describe("the remote reattach stream", () => {
	it("ends with the settled terminal when the marker clears", async () => {
		const id = "chat_remote_stream";
		writeRemoteMarker(id, Date.now());
		const response = remoteTurnResponse(id, null, { pollMs: 20, commentMs: 10, capMs: 10_000 });
		setTimeout(() => clearTurn(id), 60);
		const body = await readAll(response.body!.getReader());
		assert.ok(body.includes(": waiting\n\n"), "the keep-alive comment rides the wire");
		assert.ok(body.endsWith(await settledTurnResponse(id).text()), "the terminal is exactly the settled one");
	});

	it("ends with the settled terminal at the hard cap", async () => {
		const id = "chat_remote_cap";
		writeRemoteMarker(id, Date.now());
		const response = remoteTurnResponse(id, null, { pollMs: 20, commentMs: 10, capMs: 60 });
		const body = await readAll(response.body!.getReader());
		assert.ok(body.endsWith(await settledTurnResponse(id).text()), "the cap ends with the same terminal");
	});

	it("closes cleanly when the request aborts", async () => {
		const id = "chat_remote_abort";
		writeRemoteMarker(id, Date.now());
		const abort = new AbortController();
		const response = remoteTurnResponse(id, abort.signal, { pollMs: 20, commentMs: 10, capMs: 10_000 });
		abort.abort();
		const body = await readAll(response.body!.getReader());
		assert.doesNotMatch(body, /turn-settled/, "an aborted request gets no terminal");
	});
});
