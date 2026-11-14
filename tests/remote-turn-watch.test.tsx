/**
 * THE REMOTE-TURN WATCH AND THE TAB RETURN (reliability wave, 2026-11):
 * a turn that runs on ANOTHER server instance must keep the chat view busy
 * until it is over, and a tab that comes back must pick up a turn that
 * started (or finished) while it was away.
 *
 * The production Chat component is mounted against a fake server (the
 * plugin-chrome fixture): the server's truth is a mutable `turnInFlight`
 * flag, exactly as the hosted server reports it (GET /api/chats/:id and
 * GET /api/jobs). No network, no provider, no store.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Chat } from "../components/chat.tsx";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

/** The server's liveness truth — mutable, so a test can end the turn. */
interface ServerTruth {
	turnInFlight: boolean;
	messages: LhMessage[];
}

const SETTLED_STREAM = 'data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n';

async function mountChat(server: ServerTruth) {
	const calls: string[] = [];
	// The chat view measures its flanks (ResizeObserver) and reads the URL
	// hash on mount — the fixture DOM has neither.
	const savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
	const fixture = await mountPluginChrome(
		{ activate() {} },
		<Chat chatId="one" title="Fixture" initialMessages={server.messages} />,
		{
			pathname: "/chat/one",
			prepareDom(dom) {
				// The fixture DOM has no visibility API: a visible document is
				// the faithful stand-in (the watch pauses only when EXPLICITLY
				// hidden).
				Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
				Object.defineProperty(dom.window, "location", { configurable: true, value: new URL("http://fixture/chat/one") });
				// The dock measures itself with the Web Animations API.
				Object.defineProperty(dom.window.HTMLElement.prototype, "getAnimations", { configurable: true, value: () => [] });
			},
			fetch: async (input) => {
				const url = String(input);
				calls.push(url);
				if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
				if (url === "/api/settings") return Response.json({});
				if (url === "/api/chats/one/side-chats") return Response.json({ threads: [] });
				if (url === "/api/jobs?chatId=one") return Response.json({ jobs: [], turnInFlight: server.turnInFlight });
				if (url === "/api/chats/one") return Response.json({ id: "one", messages: server.messages, turnInFlight: server.turnInFlight });
				if (url === "/api/chats/one/stream") {
					// Today's server: no running turn on THIS instance — the
					// settled terminal (the remote turn is invisible to it).
					return new Response(SETTLED_STREAM, { headers: { "Content-Type": "text/event-stream" } });
				}
				throw new Error(`Unexpected fixture request: ${url}`);
			},
		},
	);
	return {
		fixture,
		calls,
		restore() {
			if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver);
			else Reflect.deleteProperty(globalThis, "ResizeObserver");
		},
	};
}

const busy = (fixture: Awaited<ReturnType<typeof mountChat>>["fixture"]) =>
	!!fixture.document.querySelector('[data-testid="braille-spinner"]');

const settle = async (ms: number) => {
	await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
};

describe("the remote-turn watch (a turn on another instance)", () => {
	it("keeps the view busy while the record says a turn runs, and ends it when the turn is gone", async () => {
		const server: ServerTruth = { turnInFlight: true, messages: [newUserMessage("teach me")] };
		const { fixture, restore } = await mountChat(server);
		try {
			await settle(50);
			assert.equal(busy(fixture), true, "the record says a turn runs somewhere — the view stays busy");
			// The turn ends on the other instance: the watch notices and the
			// busy state ends with it.
			server.turnInFlight = false;
			await settle(4500);
			assert.equal(busy(fixture), false, "the watch ends the busy state when the turn is gone");
		} finally {
			await fixture.close();
			restore();
		}
	});

	it("a server that never reports a remote turn leaves the view idle", async () => {
		const server: ServerTruth = { turnInFlight: false, messages: [newUserMessage("teach me")] };
		const { fixture, restore } = await mountChat(server);
		try {
			await settle(50);
			assert.equal(busy(fixture), false, "no turn runs — nothing to wait for");
		} finally {
			await fixture.close();
			restore();
		}
	});
});

describe("the tab return", () => {
	it("reads the record once and attaches to a turn that started while the tab was away", async () => {
		const server: ServerTruth = { turnInFlight: false, messages: [newUserMessage("teach me")] };
		const { fixture, calls, restore } = await mountChat(server);
		try {
			await settle(50);
			assert.equal(busy(fixture), false);
			const before = calls.filter((u) => u === "/api/chats/one").length;
			// The tab was away: a turn started on another instance.
			server.turnInFlight = true;
			await act(async () => {
				fixture.document.dispatchEvent(new fixture.document.defaultView!.Event("visibilitychange"));
				await new Promise((r) => setTimeout(r, 50));
			});
			assert.ok(
				calls.filter((u) => u === "/api/chats/one").length > before,
				"the return reads the record once",
			);
			assert.ok(calls.includes("/api/chats/one/stream"), "the return attaches to the running turn");
			await settle(50);
			assert.equal(busy(fixture), true, "the attached turn keeps the view busy");
		} finally {
			await fixture.close();
			restore();
		}
	});

	it("adopts the record when no turn runs — a reply that finished while the tab was away appears", async () => {
		const server: ServerTruth = { turnInFlight: false, messages: [newUserMessage("teach me")] };
		const { fixture, calls, restore } = await mountChat(server);
		try {
			await settle(50);
			const before = calls.filter((u) => u === "/api/chats/one").length;
			// The tab was away: the turn finished (the record now carries the
			// reply), and no turn runs any more.
			server.messages = [newUserMessage("teach me"), { id: "a1", role: "assistant", content: [{ type: "text", text: "The finished reply." }], stopReason: "stop" } as unknown as LhMessage];
			await act(async () => {
				fixture.document.dispatchEvent(new fixture.document.defaultView!.Event("visibilitychange"));
				await new Promise((r) => setTimeout(r, 50));
			});
			assert.ok(calls.filter((u) => u === "/api/chats/one").length > before, "the return reads the record once");
			assert.equal(busy(fixture), false, "no turn runs — the view is idle");
			assert.match(fixture.document.body.textContent ?? "", /The finished reply\./, "the finished reply appears");
		} finally {
			await fixture.close();
			restore();
		}
	});
});

describe("the continuing notice is not an error", () => {
	it("renders a neutral status line, never the red failed-reply banner", async () => {
		// The server's deadline-pause notice, saved in the record: the turn
		// continues in a fresh run — it is NOT a failed reply.
		const notice = "This reply needed more time than one server run allows: it was paused before the 270 s limit and continues automatically in a fresh run (run 2 of at most 3). Nothing finished so far is lost.";
		const messages = [
			newUserMessage("teach me"),
			{ ...fauxAssistantMessage("Partial reply", { stopReason: "error", errorMessage: notice }), id: "failed" },
		] as unknown as LhMessage[];
		const server: ServerTruth = { turnInFlight: true, messages };
		const { fixture, restore } = await mountChat(server);
		try {
			await settle(50);
			const line = fixture.document.querySelector('[data-testid="continuing-notice"]');
			assert.ok(line, "the continuing notice renders as a status line");
			assert.equal(line!.textContent, "Still working — this reply continues in a fresh server run (run 2 of at most 3)…");
			assert.doesNotMatch(fixture.document.body.textContent ?? "", /Something went wrong/, "the notice is never the red error banner");
		} finally {
			await fixture.close();
			restore();
		}
	});
	it("once nothing runs any more, says the reply was interrupted and offers Retry (never \"still working\" forever)", async () => {
		// The server's deadline-pause notice, saved in the record: the turn
		// continues in a fresh run — it is NOT a failed reply.
		const notice = "This reply needed more time than one server run allows: it was paused before the 270 s limit and continues automatically in a fresh run (run 2 of at most 3). Nothing finished so far is lost.";
		const messages = [
			newUserMessage("teach me"),
			{ ...fauxAssistantMessage("Partial reply", { stopReason: "error", errorMessage: notice }), id: "failed" },
		] as unknown as LhMessage[];
		const server: ServerTruth = { turnInFlight: false, messages };
		const { fixture, restore } = await mountChat(server);
		try {
			await settle(50);
			const line = fixture.document.querySelector('[data-testid="continuing-notice"]');
			assert.ok(line, "the continuing notice renders as a status line");
			assert.match(line!.textContent ?? "", /^This reply was interrupted before it could finish/);
			assert.ok(fixture.document.querySelector('[data-testid="retry-failed-turn"]'), "Retry is offered");
			assert.doesNotMatch(fixture.document.body.textContent ?? "", /Something went wrong/, "the notice is never the red error banner");
		} finally {
			await fixture.close();
			restore();
		}
	});
});
