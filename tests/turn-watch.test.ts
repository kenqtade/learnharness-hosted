/**
 * THE REMOTE-TURN DECISIONS (reliability wave, 2026-11): the pure seams of
 * the multi-instance turn — what one reading of the server's liveness truth
 * means for a chat view, and what a returning tab does.
 *
 * The wiring lives in components/chat.tsx (the watch, the tab-return
 * handler); these decisions are pinned here so the wiring stays mechanical.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	REMOTE_TURN_POLL_MS,
	decideRemoteTurn,
	decideTabReturn,
} from "../src/core/turn-watch.ts";

describe("decideRemoteTurn — the watch's decision for one record reading", () => {
	it("a turn on another instance keeps the view busy and the watch running", () => {
		assert.equal(decideRemoteTurn({ turnInFlight: true, localStream: false }), "watch");
	});

	it("no turn anywhere settles the busy state", () => {
		assert.equal(decideRemoteTurn({ turnInFlight: false, localStream: false }), "settle");
	});

	it("a server that does not report liveness settles (the harmless degradation)", () => {
		assert.equal(decideRemoteTurn({ turnInFlight: undefined, localStream: false }), "settle");
	});

	it("our own stream owns the view — the busy state is never touched", () => {
		assert.equal(decideRemoteTurn({ turnInFlight: true, localStream: true }), "hold");
		assert.equal(decideRemoteTurn({ turnInFlight: false, localStream: true }), "hold");
	});
});

describe("decideTabReturn — what a returning tab does", () => {
	it("a running turn is attached to (live rendering when the server can)", () => {
		assert.equal(decideTabReturn({ turnInFlight: true, localStream: false }), "attach");
	});

	it("no running turn adopts the record — a reply that finished while the tab was away appears", () => {
		assert.equal(decideTabReturn({ turnInFlight: false, localStream: false }), "sync");
		assert.equal(decideTabReturn({ turnInFlight: undefined, localStream: false }), "sync");
	});

	it("our own stream owns the view — the return is inert", () => {
		assert.equal(decideTabReturn({ turnInFlight: true, localStream: true }), "hold");
		assert.equal(decideTabReturn({ turnInFlight: false, localStream: true }), "hold");
	});
});

describe("the watch cadence", () => {
	it("re-reads the record every 4 s", () => {
		assert.equal(REMOTE_TURN_POLL_MS, 4000);
	});
});
