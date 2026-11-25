import test, { mock } from "node:test";
import assert from "node:assert/strict";

// RENDER: keepAlive() pings the service's own URL while work is in flight,
// so the free instance is not spun down mid-turn, and stops when idle.
test("keepAlive pings RENDER_EXTERNAL_URL only while work is in flight", async () => {
	const saved = { ...process.env };
	delete process.env.VERCEL;
	process.env.RENDER_EXTERNAL_URL = "https://lh.example.onrender.com/";
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response("ok"); }) as typeof fetch;
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const { keepAlive, keepAliveInFlight } = await import("../src/server/keep-alive.ts");
		let finish!: () => void;
		const work = keepAlive(new Promise<void>((resolve) => { finish = resolve; }));
		assert.equal(keepAliveInFlight(), 1);
		mock.timers.tick(4 * 60_000);
		mock.timers.tick(4 * 60_000);
		assert.deepEqual(calls, ["https://lh.example.onrender.com/api/version", "https://lh.example.onrender.com/api/version"]);
		finish();
		await work;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(keepAliveInFlight(), 0);
		mock.timers.tick(10 * 60_000);
		assert.equal(calls.length, 2, "no pings once idle");
	} finally {
		mock.timers.reset();
		globalThis.fetch = realFetch;
		process.env = saved;
	}
});

test("keepAlive does nothing extra off Render", async () => {
	const saved = { ...process.env };
	delete process.env.VERCEL; delete process.env.RENDER_EXTERNAL_URL; delete process.env.LH_AWAKE_PING_URL;
	try {
		const { keepAlive, keepAliveInFlight } = await import("../src/server/keep-alive.ts");
		await keepAlive(Promise.resolve(1));
		assert.equal(keepAliveInFlight(), 0);
	} finally { process.env = saved; }
});
