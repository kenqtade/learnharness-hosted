/**
 * HOSTED FORK — the learner file tools on a hosted deployment may read only
 * the signed-in user's uploads: never the shared container (its process
 * environment holds the deployment secrets), never another user's uploads,
 * whatever the File access preference says.
 */
import { ISOLATED_DATA_DIR } from "./helpers/isolated-data-dir.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const UPLOADS = path.join(ISOLATED_DATA_DIR, "uploads");
process.env.LH_UPLOADS_DIR = UPLOADS;

const { setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { fileAccessPolicy } = await import("../src/server/file-access.ts");
const { readTool } = await import("../src/agent/tools/read.ts");
const { lsTool } = await import("../src/agent/tools/ls.ts");
const { runAsUser } = await import("../src/store/user-scope.ts");

type ToolOut = { content?: Array<{ type: string; text?: string }> };
const text = (r: unknown) => ((r as ToolOut).content ?? []).map((c) => c.text ?? "").join("\n");
const read = async (p: string) => text(await (readTool as unknown as { execute: (id: string, a: unknown) => Promise<unknown> }).execute("t", { path: p }));
const ls = async (p?: string) => text(await (lsTool as unknown as { execute: (id: string, a: unknown) => Promise<unknown> }).execute("t", p ? { path: p } : {}));

const alice = { id: "u_alice", role: "member" as const };
const bob = { id: "u_bobby1", role: "member" as const };

describe("hosted learner filesystem (uploads only)", () => {
	const saved = { VERCEL: process.env.VERCEL, LH_PROFILE: process.env.LH_PROFILE };
	before(() => {
		process.env.VERCEL = "1";
		setFileAccessPolicy(fileAccessPolicy);
		for (const [u, body] of [[alice, "alice notes"], [bob, "bob secret notes"]] as const) {
			fs.mkdirSync(path.join(UPLOADS, u.id), { recursive: true });
			fs.writeFileSync(path.join(UPLOADS, u.id, "notes.md"), body);
		}
	});
	after(() => {
		if (saved.VERCEL === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.VERCEL;
	});

	it("refuses the container's process environment (deployment secrets)", async () => {
		await runAsUser(alice, async () => {
			await assert.rejects(read("/proc/self/environ"), /Access denied/);
			await assert.rejects(read("/proc/self/cmdline"), /Access denied/);
			await assert.rejects(read(path.resolve("package.json")), /Access denied/);
		});
	});

	it("reads the user's own upload", async () => {
		await runAsUser(alice, async () => {
			assert.match(await read(path.join(UPLOADS, alice.id, "notes.md")), /alice notes/);
		});
	});

	it("never reads another user's upload (shared warm instance)", async () => {
		await runAsUser(alice, async () => {
			await assert.rejects(read(path.join(UPLOADS, bob.id, "notes.md")), /Access denied/);
			await assert.rejects(read(`${path.join(UPLOADS, alice.id)}/../${bob.id}/notes.md`), /Access denied/);
		});
	});

	it("ls lists only the user's uploads folder as its root, and nothing above it", async () => {
		await runAsUser(bob, async () => {
			const roots = await ls();
			assert.match(roots, /u_bobby1/);
			assert.doesNotMatch(roots, /u_alice/);
			assert.match(await ls(path.join(UPLOADS, bob.id)), /notes\.md/);
			await assert.rejects(ls(UPLOADS), /Access denied/);
			await assert.rejects(ls("/"), /Access denied/);
		});
	});

	it("an open File access preference cannot widen it", async () => {
		const settingsFile = path.join(process.env.LH_DATA_DIR!, "settings.json");
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, JSON.stringify({ agent: { fileAccess: { restricted: false, folders: ["/"] } } }));
		await runAsUser(alice, async () => {
			await assert.rejects(read("/proc/self/environ"), /Access denied/);
		});
		const policy = runAsUser(alice, () => fileAccessPolicy());
		assert.equal(policy.restricted, true);
		assert.deepEqual(policy.folders, [path.join(UPLOADS, alice.id)]);
	});

	it("a signed-in user with an unsafe id gets a closed policy, not the owner folder", async () => {
		const odd = { id: "../x", role: "member" as const };
		assert.deepEqual(runAsUser(odd, () => fileAccessPolicy()), { restricted: true, folders: [] });
		await runAsUser(odd, async () => {
			await assert.rejects(read(path.join(UPLOADS, "owner", "x")), /Access denied/);
		});
	});

	it("single-user hosted (no signed-in scope) uses the owner folder", () => {
		assert.deepEqual(fileAccessPolicy().folders, [path.join(UPLOADS, "owner")]);
	});
});

describe("desktop semantics are unchanged", () => {
	it("without a hosted marker the preference decides (open by default)", () => {
		const env = { ...process.env };
		delete env.VERCEL; delete env.LH_PROFILE; delete env.LH_STORE;
		const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
			await import(${JSON.stringify(path.resolve("tests/helpers/isolated-data-dir.ts"))});
			const { fileAccessPolicy } = await import(${JSON.stringify(path.resolve("src/server/file-access.ts"))});
			console.log("__R__" + JSON.stringify(fileAccessPolicy()));
		`], { env, encoding: "utf8", timeout: 60_000 });
		const line = (r.stdout || "").split("\n").find((l) => l.startsWith("__R__"));
		assert.ok(line, r.stderr);
		assert.equal(JSON.parse(line.slice(5)).restricted, false);
	});

	it("before the server wires its provider, a hosted process is closed (not open)", () => {
		const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
			const { fileAccessPolicy } = await import(${JSON.stringify(path.resolve("src/agent/tools/file-access.ts"))});
			console.log("__R__" + JSON.stringify(fileAccessPolicy()));
		`], { env: { ...process.env, VERCEL: "1" }, encoding: "utf8", timeout: 60_000 });
		const line = (r.stdout || "").split("\n").find((l) => l.startsWith("__R__"));
		assert.ok(line, r.stderr);
		assert.deepEqual(JSON.parse(line.slice(5)), { restricted: true, folders: [] });
	});
});
