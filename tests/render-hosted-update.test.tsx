/** Hosted (web) update UI on the multi-user line: Settings → General rows
 *  for owner vs member, and the refresh banner. Fake fetch, no network. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
process.env.LH_BUILD_ID = "build-A"; // the build this "page" was loaded from

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });

const { UpdateSettings, hostedStatusText, HOSTED_OFF_OWNER, HOSTED_OFF_MEMBER } = await import("../components/settings/update-settings.tsx");
const { default: DeployRefreshBanner, isNewerBuild, hasUnsentText } = await import("../components/deploy-refresh-banner.tsx");
const { fetchMe } = await import("../components/account/use-me.ts");
const { setTurnBusy, anyTurnBusy } = await import("../components/turn-busy.ts");

const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);
const props = { autoUpdate: true, onAutoUpdateChange: () => {}, version: "0.5.0", homepage: "https://github.com/amosblomqvist/learnharness" };

type Who = "owner" | "member" | "single";
function serve(who: Who, update: Record<string, unknown>, live = { version: "0.5.0", buildId: "build-A" }) {
	const posts: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "POST") posts.push(url);
		if (url === "/api/auth/me") {
			return Response.json(who === "single" ? { multiUser: false } : { multiUser: true, user: { id: "u", username: who, name: who, role: who, createdAt: "" } });
		}
		if (url === "/api/update") return Response.json(update);
		if (url === "/api/version") return Response.json(live);
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	void fetchMe(true);
	return { posts };
}

async function mount(element: React.ReactElement) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(element); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	return host;
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); }); host.remove();
	}
	globalThis.fetch = originalFetch;
});

const UP = { enabled: true, current: "0.5.0", latest: "0.5.0", state: "up-to-date", checkedAt: new Date().toISOString(), buildId: "build-A" };

describe("hosted update rows", () => {
	it("owner: status, last checked, Check for updates now (POSTs), automatic updates On", async () => {
		const { posts } = serve("owner", UP);
		const host = await mount(<UpdateSettings {...props} />);
		assert.equal(q(host, "update-status")!.textContent, "Up to date — 0.5.0 is the latest release.");
		assert.ok(q(host, "update-checked-at"));
		assert.ok(q(host, "hosted-auto-on"));
		assert.equal(q(host, "row-auto-update"), null, "no desktop toggle on the web");
		await act(async () => { q(host, "update-check")!.click(); await new Promise((r) => setTimeout(r, 10)); });
		assert.deepEqual(posts, ["/api/update"]);
		assert.equal((q(host, "update-check") as HTMLButtonElement).disabled, false, "busy state resets");
	});

	it("member: same facts, no check button, managed-by-owner note", async () => {
		serve("member", UP);
		const host = await mount(<UpdateSettings {...props} />);
		assert.ok(q(host, "update-status"));
		assert.equal(q(host, "update-check"), null);
		assert.match(host.textContent ?? "", /Managed by the owner/);
	});

	it("single-user hosted server: the one user manages updates", async () => {
		serve("single", UP);
		const host = await mount(<UpdateSettings {...props} />);
		assert.ok(q(host, "update-check"));
	});

	it("auto-update off: owner gets the instruction, members a plain fact, nobody a button", async () => {
		serve("owner", { enabled: false, current: "0.5.0", state: "disabled" });
		let host = await mount(<UpdateSettings {...props} />);
		assert.equal(q(host, "update-status")!.textContent, HOSTED_OFF_OWNER);
		assert.equal(q(host, "update-check"), null);
		serve("member", { enabled: false, current: "0.5.0", state: "disabled" });
		host = await mount(<UpdateSettings {...props} />);
		assert.equal(q(host, "update-status")!.textContent, HOSTED_OFF_MEMBER);
	});

	it("a newer live build shows Refresh in Settings too", async () => {
		serve("member", UP, { version: "0.5.1", buildId: "build-B" });
		const host = await mount(<UpdateSettings {...props} />);
		assert.ok(q(host, "update-refresh"));
		assert.match(q(host, "update-live")!.textContent ?? "", /0\.5\.1 is live/);
	});

	it("status copy: updating / failed (owner details vs member summary) / error", () => {
		const base = { enabled: true, current: "0.5.0", latest: "0.5.1" } as const;
		assert.match(hostedStatusText({ ...base, state: "update-triggered" })!, /^Updating to 0\.5\.1/);
		const failed = { ...base, state: "update-failed" as const, message: "did not pass its safety checks… Vercel build logs." };
		assert.match(hostedStatusText(failed, true)!, /Vercel build logs/);
		assert.doesNotMatch(hostedStatusText(failed, false)!, /Vercel/);
		assert.doesNotMatch(hostedStatusText({ ...base, state: "error", message: "GitHub 403 secret" }, false)!, /GitHub/);
	});
});

describe("refresh banner", () => {
	it("hidden while the live build matches this page", async () => {
		serve("member", UP);
		const host = await mount(<DeployRefreshBanner />);
		assert.equal(q(host, "refresh-banner"), null);
	});
	it("appears when a newer deployment is live", async () => {
		serve("member", UP, { version: "0.5.1", buildId: "build-B" });
		const host = await mount(<DeployRefreshBanner />);
		assert.ok(q(host, "refresh-banner"));
		assert.match(q(host, "refresh-banner")!.textContent ?? "", /\(0\.5\.1\)/);
		assert.ok(q(host, "refresh-banner-reload"));
	});
	it("build comparison ignores dev builds", () => {
		assert.equal(isNewerBuild({ buildId: "b" }, "a"), true);
		assert.equal(isNewerBuild({ buildId: "a" }, "a"), false);
		assert.equal(isNewerBuild({ buildId: "dev" }, "a"), false);
		assert.equal(isNewerBuild({ buildId: "b" }, "dev"), false);
		assert.equal(isNewerBuild(null, "a"), false);
	});
	it("unsent text blocks a background auto-reload", () => {
		const { document: d } = parseHTML("<html><body><textarea></textarea></body></html>");
		assert.equal(hasUnsentText(d as unknown as Document), false);
		(d.querySelector("textarea") as unknown as HTMLTextAreaElement).value = "half a question";
		assert.equal(hasUnsentText(d as unknown as Document), true);
	});
	it("a hidden tab with a turn in flight never reloads itself (the busy ledger)", async () => {
		// THE REFRESH MUST NEVER KILL A TURN (reliability wave, 2026-11): a
		// background tab reloads itself when a newer build is live — but not
		// while a turn is in flight: the reload would drop the window's only
		// attachment to that turn.
		const savedVisibility = Object.getOwnPropertyDescriptor(dom.document, "visibilityState");
		const savedLocation = Object.getOwnPropertyDescriptor(dom.window, "location");
		let reloads = 0;
		Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "hidden" });
		Object.defineProperty(dom.window, "location", { configurable: true, value: { reload: () => { reloads++; } } });
		try {
			setTurnBusy("chat-1", true);
			assert.equal(anyTurnBusy(), true, "the ledger knows the turn is running");
			serve("member", UP, { version: "0.5.1", buildId: "build-B" });
			await mount(<DeployRefreshBanner />);
			assert.equal(reloads, 0, "a hidden tab with a turn in flight never reloads itself");
			// The turn ends: the next visibilitychange re-checks the ledger.
			setTurnBusy("chat-1", false);
			assert.equal(anyTurnBusy(), false);
			await act(async () => { dom.document.dispatchEvent(new dom.window.Event("visibilitychange")); });
			assert.equal(reloads, 1, "the reload happens once the turn is gone");
		} finally {
			setTurnBusy("chat-1", false);
			if (savedVisibility) Object.defineProperty(dom.document, "visibilityState", savedVisibility);
			if (savedLocation) Object.defineProperty(dom.window, "location", savedLocation);
		}
	});
});
