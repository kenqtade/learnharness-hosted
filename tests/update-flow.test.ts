/** Hosted auto-update flow on the multi-user line: platform-space status,
 *  following the triggered Vercel rebuild, opportunistic checks, the
 *  public version probe and the route access rules. No network: every
 *  fetch is a fake. */
import { ISOLATED_DATA_DIR } from "./helpers/isolated-data-dir.ts";
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
	readUpdateStatus,
	runUpdateCheck,
	refreshBuildState,
	currentUpdateStatus,
	runUpdateCheckOnce,
	runningBuildId,
	runningVersion,
	CHECK_EVERY_MS,
} from "../src/server/upstream-update.ts";
import { PLATFORM_ROOT } from "../src/store/vfs.ts";
import { routeAccess } from "../src/server/accounts.ts";
import { GET as versionGET } from "../app/api/version/route.ts";

const STATUS = path.join(PLATFORM_ROOT, "update-status.json");
const T0 = Date.parse("2026-11-10T12:00:00Z");
const ON = { LH_AUTO_UPDATE: "1", LH_VERCEL_TOKEN: "tok", VERCEL_DEPLOYMENT_ID: "dpl_live", VERCEL_TEAM_ID: "team_x" };

function bump(v: string): string {
	const [a, b, c] = v.split(".").map(Number);
	return `${a}.${b}.${(c ?? 0) + 1}`;
}
const NEXT = bump(runningVersion());

type Call = { url: string; method: string };
function fakeFetch(routes: { release?: string; deployState?: string; deployId?: string }) {
	const calls: Call[] = [];
	const f = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push({ url, method });
		if (url.includes("api.github.com")) {
			return Response.json({ tag_name: `v${routes.release ?? runningVersion()}`, html_url: "https://x", published_at: "2026-11-10" });
		}
		if (url.startsWith("https://api.vercel.com/v13/deployments?")) {
			return Response.json({ url: "lh-new.vercel.app", id: routes.deployId ?? "dpl_new" });
		}
		if (url.startsWith("https://api.vercel.com/v13/deployments/")) {
			return Response.json({ readyState: routes.deployState ?? "BUILDING" });
		}
		return new Response("unexpected", { status: 500 });
	}) as typeof fetch;
	return { f, calls };
}

beforeEach(() => fs.rmSync(STATUS, { force: true }));

describe("status lives in the platform space", () => {
	it("is written under PLATFORM_ROOT (readable by every account), not the data dir", async () => {
		assert.ok(PLATFORM_ROOT.startsWith(ISOLATED_DATA_DIR));
		const { f } = fakeFetch({});
		await runUpdateCheck({ fetch: f, env: ON, now: () => T0 });
		assert.ok(fs.existsSync(STATUS), "status file in the platform space");
		assert.equal(fs.existsSync(path.join(PLATFORM_ROOT.replace(/-platform$/, ""), "update-status.json")), false);
		assert.equal(JSON.parse(fs.readFileSync(STATUS, "utf-8")).buildId, undefined, "per-instance build id is never stored");
	});
});

describe("following the triggered rebuild", () => {
	it("records the Vercel deployment id and starts in building", async () => {
		const { f, calls } = fakeFetch({ release: NEXT });
		const s = await runUpdateCheck({ fetch: f, env: ON, now: () => T0 });
		assert.equal(s.state, "update-triggered");
		assert.equal(s.lastAttempt?.deploymentId, "dpl_new");
		assert.equal(s.lastAttempt?.buildState, "building");
		assert.equal(calls.filter((c) => c.method === "POST").length, 1);
	});

	it("a failed build (merge refused / gates / build error) becomes update-failed and keeps the old version", async () => {
		await runUpdateCheck({ fetch: fakeFetch({ release: NEXT }).f, env: ON, now: () => T0 });
		const s = await refreshBuildState({ fetch: fakeFetch({ deployState: "ERROR" }).f, env: ON });
		assert.equal(s.state, "update-failed");
		assert.match(s.message ?? "", /stays live/);
		assert.equal(readUpdateStatus({ env: ON }).state, "update-failed", "persisted");
		// the 24 h guard keeps it failed, without a second rebuild
		const again = fakeFetch({ release: NEXT });
		const s2 = await runUpdateCheck({ fetch: again.f, env: ON, now: () => T0 + 60_000 });
		assert.equal(s2.state, "update-failed");
		assert.equal(again.calls.filter((c) => c.method === "POST").length, 0);
	});

	it("a ready build says so; once this deployment runs that version it reads up to date", async () => {
		await runUpdateCheck({ fetch: fakeFetch({ release: NEXT }).f, env: ON, now: () => T0 });
		const ready = await refreshBuildState({ fetch: fakeFetch({ deployState: "READY" }).f, env: ON });
		assert.equal(ready.lastAttempt?.buildState, "ready");
		assert.match(ready.message ?? "", /Refresh/);
		// simulate the new deployment: same stored record, newer running version
		const stored = JSON.parse(fs.readFileSync(STATUS, "utf-8"));
		fs.writeFileSync(STATUS, JSON.stringify({ ...stored, latest: runningVersion() }));
		assert.equal(readUpdateStatus({ env: ON }).state, "up-to-date");
	});

	it("never calls Vercel without a token or a recorded deployment", async () => {
		const { f, calls } = fakeFetch({});
		await refreshBuildState({ fetch: f, env: { LH_AUTO_UPDATE: "1" } });
		assert.equal(calls.length, 0);
	});
});

describe("opportunistic checks (the daily cron is not the only trigger)", () => {
	it("a status read runs the check when the last one is stale, and not when fresh", async () => {
		const first = fakeFetch({});
		const s = await currentUpdateStatus({ fetch: first.f, env: ON, now: () => T0 });
		assert.equal(first.calls.filter((c) => c.url.includes("github")).length, 1);
		assert.equal(s.state, "up-to-date");
		assert.equal(s.buildId, "dpl_live");
		const fresh = fakeFetch({});
		await currentUpdateStatus({ fetch: fresh.f, env: ON, now: () => T0 + CHECK_EVERY_MS - 1 });
		assert.equal(fresh.calls.length, 0);
		const stale = fakeFetch({});
		await currentUpdateStatus({ fetch: stale.f, env: ON, now: () => T0 + CHECK_EVERY_MS + 1 });
		assert.equal(stale.calls.filter((c) => c.url.includes("github")).length, 1);
	});

	it("concurrent checks share one run", async () => {
		const { f, calls } = fakeFetch({});
		await Promise.all([1, 2, 3].map(() => runUpdateCheckOnce({ fetch: f, env: ON, now: () => T0 })));
		assert.equal(calls.filter((c) => c.url.includes("github")).length, 1);
	});

	it("does nothing while auto-update is off", async () => {
		const { f, calls } = fakeFetch({});
		const s = await currentUpdateStatus({ fetch: f, env: {}, now: () => T0 });
		assert.equal(s.state, "disabled");
		assert.equal(calls.length, 0);
	});
});

describe("build id + version probe", () => {
	it("build id: baked LH_BUILD_ID, else the Vercel deployment, else dev", () => {
		assert.equal(runningBuildId({ LH_BUILD_ID: "b1", VERCEL_DEPLOYMENT_ID: "d" }), "b1");
		assert.equal(runningBuildId({ VERCEL_DEPLOYMENT_ID: "d" }), "d");
		assert.equal(runningBuildId({}), "dev");
	});
	it("GET /api/version answers version + build id, uncached", async () => {
		const res = versionGET();
		assert.equal(res.headers.get("cache-control"), "no-store");
		const body = (await res.json()) as { version: string; buildId: string };
		assert.equal(body.version, runningVersion());
		assert.equal(typeof body.buildId, "string");
	});
});

describe("route access in platform mode", () => {
	it("cron + version public; status for every account; checking is owner-only", () => {
		assert.equal(routeAccess("GET", "/api/cron/update"), "public");
		assert.equal(routeAccess("GET", "/api/version"), "public");
		assert.equal(routeAccess("GET", "/api/update"), "user");
		assert.equal(routeAccess("POST", "/api/update"), "owner");
		assert.equal(routeAccess("post", "/api/update/"), "owner");
	});
});
