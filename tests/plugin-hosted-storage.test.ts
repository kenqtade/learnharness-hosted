/**
 * HOSTED FORK — plugin data on the hosted (Vercel + Convex) build.
 *
 * Four seams are covered here:
 *
 *  1. THE STORAGE SEAM (src/store/vfs.ts) in Convex mode: a plugin store
 *     writes with open "wx" → write → fsync → close → rename. Convex has no
 *     file descriptors, so the seam models a virtual one that commits the
 *     buffer with the ordinary put path. A fake Convex deployment (a fetch
 *     double that speaks the real query/mutation protocol) stands in for the
 *     deployment, so the bytes really travel the seam.
 *  2. THE WORKER SERVICE: a hosted function freezes once the response is
 *     sent, so the host injects a keep-alive, and the task timeout is
 *     clamped to the function's budget.
 *  3. THE BACKEND LOADER HOOK (scripts/plugin-loader.cjs): a plugin backend's
 *     own "fs" require resolves to the seam — but only inside its package.
 *  4. THE PLUGIN SOURCES: the flashcards store adopts a newer revision that
 *     another instance wrote behind its back.
 *
 * Paths outside the data dir keep node:fs semantics: that passthrough is
 * covered here too.
 */
import "./helpers/isolated-data-dir.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Type } from "typebox";
import { PATHS } from "../config.ts";
import type { PluginTaskRecord, PluginWorkerStartOptions } from "../src/core/plugin-workers.ts";
import type { PluginTaskRecordStore } from "../src/core/ports.ts";
import { createPluginWorkerService } from "../src/agent/plugin-workers.ts";

// ─── a fake Convex deployment (the seam's HTTP client) ───────────────────

/** The deployment's state: the file table and the global version. */
const convexDeployment = { version: 0, files: new Map<string, { rev: number; data: string }>() };

const realFetch = globalThis.fetch;
globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
	const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string; args?: unknown[] };
	const args = (body.args?.[0] ?? {}) as { secret?: string; since?: number; paths?: string[]; ops?: { path: string; data?: string }[] };
	let value: unknown;
	if (body.path === "vfs:sync") {
		// The manifest only travels when the version moved.
		value = args.since === convexDeployment.version
			? { version: convexDeployment.version, files: null }
			: { version: convexDeployment.version, files: [...convexDeployment.files].map(([file, entry]) => ({ path: file, rev: entry.rev })) };
	} else if (body.path === "vfs:read") {
		value = (args.paths ?? []).filter((file) => convexDeployment.files.has(file))
			.map((file) => ({ path: file, rev: convexDeployment.files.get(file)!.rev, data: convexDeployment.files.get(file)!.data }));
	} else if (body.path === "vfs:apply") {
		const before = convexDeployment.version;
		const after = before + 1;
		const revs: Record<string, number> = {};
		for (const op of args.ops ?? []) {
			if (op.data === undefined) { convexDeployment.files.delete(op.path); revs[op.path] = -1; continue; }
			convexDeployment.files.set(op.path, { rev: after, data: op.data });
			revs[op.path] = after;
		}
		convexDeployment.version = after;
		value = { before, after, revs };
	} else throw new Error(`unexpected Convex function: ${body.path}`);
	return new Response(JSON.stringify({ status: "success", value }), { status: 200, headers: { "content-type": "application/json" } });
};

process.env.LH_STORE = "convex";
process.env.CONVEX_URL = "http://127.0.0.1:3210";
process.env.LH_CONVEX_SECRET = "hosted-fork-test";

const vfs = await import("../src/store/vfs.ts");

after(async () => {
	// Drain the seam's pending writes before the double goes away: a flush
	// after that would retry against the real network and never settle.
	await vfs.flushStore();
	globalThis.fetch = realFetch;
});

const dataFile = (...segments: string[]) => path.join(PATHS.data, ...segments);

describe("the storage seam in Convex mode", () => {
	it("routes a path under the data dir to Convex and leaves other paths on the real disk", async () => {
		const file = dataFile("plugins", "demo", "record.json");
		const descriptor = vfs.openSync(file, "wx", 0o600);
		vfs.writeFileSync(descriptor, "seam bytes", "utf8");
		vfs.fsyncSync(descriptor);
		vfs.closeSync(descriptor);
		await vfs.flushStore();
		assert.equal(vfs.readFileSync(file, "utf8"), "seam bytes");
		assert.equal(convexDeployment.files.get("data/plugins/demo/record.json")?.data, "seam bytes");
		assert.equal(fs.existsSync(file), false, "nothing was written to the instance disk");
	});

	it("writes through a virtual descriptor: open, write, fsync, close, rename", async () => {
		const directory = dataFile("plugins", "demo");
		const temporary = path.join(directory, ".record.tmp");
		const file = path.join(directory, "record.json");
		const descriptor = vfs.openSync(temporary, "wx", 0o600);
		assert.ok(descriptor >= 1_000_000, "a Convex path gets a virtual descriptor");
		vfs.writeFileSync(descriptor, "first", "utf8");
		vfs.writeFileSync(descriptor, " second", "utf8");
		vfs.fsyncSync(descriptor);
		vfs.closeSync(descriptor);
		// The temporary file is visible before the rename, and gone after it.
		assert.equal(vfs.readFileSync(temporary, "utf8"), "first second");
		vfs.renameSync(temporary, file);
		assert.equal(vfs.readFileSync(file, "utf8"), "first second");
		assert.throws(() => vfs.readFileSync(temporary, "utf8"), /ENOENT/);
		await vfs.flushStore();
		assert.equal(convexDeployment.files.get("data/plugins/demo/record.json")?.data, "first second");
		assert.equal(convexDeployment.files.has("data/plugins/demo/.record.tmp"), false, "the temporary file never reaches Convex");
	});

	it("refuses an exclusive create when the key exists", () => {
		const file = dataFile("plugins", "demo", "record.json");
		assert.throws(() => vfs.openSync(file, "wx", 0o600), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
		// A missing key is created (like node:fs) — but only once.
		const fresh = dataFile("plugins", "demo", "missing.json");
		const descriptor = vfs.openSync(fresh, "wx", 0o600);
		vfs.closeSync(descriptor);
		assert.throws(() => vfs.openSync(fresh, "wx", 0o600), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
	});

	it("probes Convex paths with synthetic stats and resolves them to themselves", () => {
		const file = dataFile("plugins", "demo", "record.json");
		const directory = dataFile("plugins", "demo");
		const stat = vfs.statSync(file);
		assert.equal(stat.isFile(), true);
		assert.equal(stat.isDirectory(), false);
		assert.equal(stat.isSymbolicLink(), false);
		assert.equal(stat.size, Buffer.byteLength("first second", "utf-8"));
		assert.equal(typeof stat.mtimeMs, "number");
		assert.equal(vfs.lstatSync(file).isFile(), true);
		assert.equal(vfs.statSync(directory).isDirectory(), true);
		assert.equal(vfs.realpathSync(file), path.resolve(file));
		assert.throws(() => vfs.statSync(dataFile("plugins", "demo", "nothing.json")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
		assert.throws(() => vfs.realpathSync(dataFile("plugins", "demo", "nothing.json")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
	});

	it("lists a Convex directory with Dirent-like entries", () => {
		const entries = vfs.readdirSync(dataFile("plugins", "demo"), { withFileTypes: true });
		const names = entries.map((entry) => entry.name);
		assert.deepEqual(names, ["missing.json", "record.json"]);
		assert.equal(entries.every((entry) => entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()), true);
	});

	it("keeps node:fs semantics for paths outside the data dir", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-seam-passthrough-"));
		const file = path.join(directory, "plain.json");
		const descriptor = vfs.openSync(file, "wx", 0o600);
		vfs.writeFileSync(descriptor, "plain", "utf8");
		vfs.fsyncSync(descriptor);
		vfs.closeSync(descriptor);
		assert.equal(fs.readFileSync(file, "utf8"), "plain");
		assert.equal(vfs.readFileSync(file, "utf8"), "plain");
		assert.equal(vfs.statSync(file).isFile(), true);
		assert.equal(vfs.realpathSync(file), fs.realpathSync(file));
		assert.deepEqual(vfs.readdirSync(directory), ["plain.json"]);
		assert.throws(() => vfs.openSync(file, "wx"), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
		fs.rmSync(directory, { recursive: true, force: true });
	});
});

describe("the plugin worker service on a hosted server", () => {
	function fakeStore(): PluginTaskRecordStore & { records: Map<string, PluginTaskRecord> } {
		const records = new Map<string, PluginTaskRecord>();
		return {
			records,
			get: (id) => records.get(id) ?? null,
			list: () => [...records.values()],
			save: (record) => { records.set(record.id, structuredClone(record)); },
		};
	}

	function options(extra: Partial<PluginWorkerStartOptions> = {}): PluginWorkerStartOptions {
		return { requestId: `request_${randomUUID()}`, input: {}, prompt: "Produce the result", model: { provider: "fixture", id: "offline" }, purpose: "background", maxTurns: 2, ...extra };
	}

	it("clamps the task timeout to the host budget and applies one when the task asked for none", async () => {
		const store = fakeStore();
		const service = createPluginWorkerService({
			store,
			engineFor: () => { throw new Error("the engine is never reached"); },
			maxTimeoutMs: 240_000,
		});
		try {
			service.register({ id: "worker", instructions: "Finish", resultSchema: Type.Unknown() });
			const clamped = service.start("worker", options({ timeoutMs: 900_000 }));
			assert.equal(store.get(clamped.id)?.timeoutMs, 240_000, "a task can ask for less time, never for more");
			const applied = service.start("worker", options());
			assert.equal(store.get(applied.id)?.timeoutMs, 240_000, "a task without a timeout gets the host budget");
			const shorter = service.start("worker", options({ timeoutMs: 1_000 }));
			assert.equal(store.get(shorter.id)?.timeoutMs, 1_000, "a shorter timeout is kept");
		} finally { await service.dispose(); }
	});

	it("leaves the timeout alone when the host has no budget", () => {
		const store = fakeStore();
		const service = createPluginWorkerService({ store, engineFor: () => { throw new Error("the engine is never reached"); } });
		try {
			service.register({ id: "worker", instructions: "Finish", resultSchema: Type.Unknown() });
			const task = service.start("worker", options({ timeoutMs: 900_000 }));
			assert.equal(store.get(task.id)?.timeoutMs, 900_000);
			const untimed = service.start("worker", options());
			assert.equal(store.get(untimed.id)?.timeoutMs, undefined);
		} finally { void service.dispose(); }
	});

	it("hands the background work to the host so the request may end", async () => {
		const store = fakeStore();
		const handed: Promise<unknown>[] = [];
		const service = createPluginWorkerService({
			store,
			engineFor: () => { throw new Error("the engine is never reached"); },
			background: (work) => { handed.push(work); },
		});
		try {
			service.register({ id: "worker", instructions: "Finish", resultSchema: Type.Unknown() });
			const task = service.start("worker", options());
			assert.equal(handed.length, 1, "the host keeps the function alive for the task");
			const work = handed[0];
			assert.ok(work !== undefined && work instanceof Promise);
			await work;
			assert.equal(store.get(task.id)?.status, "failed");
		} finally { await service.dispose(); }
	});
});

describe("the backend loader hook", () => {
	const moduleRequire = createRequire(import.meta.url);
	const loader = moduleRequire("../scripts/plugin-loader.cjs") as { load(filename: string, options?: { backendFs?: object; packageDirectory?: string }): { activate(): { fs: unknown; plain: unknown } } };

	it("gives a plugin backend the host's fs, and leaves every other module alone", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-package-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lh-outside-module-"));
		try {
			fs.writeFileSync(path.join(directory, "backend.cjs"), "exports.activate = () => ({ fs: require('node:fs'), plain: require('fs') });");
			fs.writeFileSync(path.join(outside, "other.cjs"), "module.exports = require('node:fs');");
			const provided = { marker: "the seam" };
			const backend = loader.load(path.join(directory, "backend.cjs"), { backendFs: provided, packageDirectory: directory });
			const context = backend.activate();
			assert.equal(context.fs, provided, "the backend's node:fs is the host's object");
			assert.equal(context.plain, provided, "the backend's fs is the host's object too");
			const other = createRequire(path.join(outside, "other.cjs"))(path.join(outside, "other.cjs"));
			assert.notEqual(other, provided, "a module outside the package keeps node:fs");
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("the flashcards store", () => {
	it("adopts a newer revision that another instance wrote behind its back", () => {
		const moduleRequire = createRequire(import.meta.url);
		const { openStore } = moduleRequire("../plugins/flashcards/src/store.cjs") as {
			openStore(directory: string): { get(): { revision: number; decks: { id: string }[] }; change(update: (state: { decks: { id: string; name: string; propositionIds: string[]; newLimit: number }[] }) => void): void };
		};
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-flashcards-store-"));
		try {
			const store = openStore(directory);
			store.change((state) => { state.decks.push({ id: "one", name: "One", propositionIds: [], newLimit: 20 }); });
			// Another instance writes a newer revision straight to the file.
			const file = path.join(directory, "flashcards.json");
			const written = JSON.parse(fs.readFileSync(file, "utf8"));
			written.revision += 1;
			written.decks.push({ id: "two", name: "Two", propositionIds: [], newLimit: 20 });
			fs.writeFileSync(file, JSON.stringify(written));
			const state = store.get();
			assert.equal(state.revision, written.revision, "the store adopts the newer revision");
			assert.deepEqual(state.decks.map((deck) => deck.id), ["one", "two"]);
			// A change is based on the adopted state, not on the stale one.
			store.change((next) => { next.decks.push({ id: "three", name: "Three", propositionIds: [], newLimit: 20 }); });
			const saved = JSON.parse(fs.readFileSync(file, "utf8"));
			assert.equal(saved.revision, written.revision + 1);
			assert.deepEqual(saved.decks.map((deck: { id: string }) => deck.id), ["one", "two", "three"]);
		} finally { fs.rmSync(directory, { recursive: true, force: true }); }
	});
});
