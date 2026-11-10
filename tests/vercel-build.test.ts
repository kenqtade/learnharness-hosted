/** THE VERCEL BUILD HOOK's branching (auto-update wave). Runs the real
 * scripts/vercel-build.sh with stub `node`/`npx`/`npm` on PATH, so each
 * merge outcome is checked without a real build. Guards the `set -e` trap
 * where "nothing newer" (exit 10) used to abort every routine deploy. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "vercel-build.sh");

function build(mergeExit: number, env: Record<string, string> = { LH_AUTO_UPDATE: "1", VERCEL: "1" }, opts: { tscFails?: boolean; lockFlag?: boolean } = {}) {
	const t = fs.mkdtempSync(path.join(os.tmpdir(), "vbuild-"));
	fs.mkdirSync(path.join(t, "scripts"));
	fs.mkdirSync(path.join(t, "bin"));
	fs.copyFileSync(SCRIPT, path.join(t, "scripts", "vercel-build.sh"));
	if (opts.lockFlag) fs.writeFileSync(path.join(t, ".lock-regenerated"), "1\n");
	const stub = (name: string, body: string) => fs.writeFileSync(path.join(t, "bin", name), `#!/bin/sh\necho "${name} $*" >> "${t}/calls"\n${body}\n`, { mode: 0o755 });
	stub("node", `exit ${mergeExit}`);
	stub("npm", "exit 0");
	stub("npx", opts.tscFails ? `case "$*" in *tsc*) exit 1;; esac; exit 0` : "exit 0");
	const r = spawnSync("bash", [path.join(t, "scripts", "vercel-build.sh")], {
		encoding: "utf-8",
		env: { PATH: `${path.join(t, "bin")}:/usr/bin:/bin`, ...env },
	});
	const calls = fs.existsSync(path.join(t, "calls")) ? fs.readFileSync(path.join(t, "calls"), "utf-8") : "";
	fs.rmSync(t, { recursive: true, force: true });
	return { status: r.status, out: r.stdout + r.stderr, calls };
}

describe("scripts/vercel-build.sh", () => {
	it("auto-update off: plain build, no merge", () => {
		const r = build(0, {});
		assert.equal(r.status, 0, r.out);
		assert.doesNotMatch(r.calls, /^node /m);
		assert.match(r.calls, /^npx next build$/m);
	});
	it("nothing newer (exit 10): still builds (the set -e trap)", () => {
		const r = build(10);
		assert.equal(r.status, 0, r.out);
		assert.match(r.calls, /^npx next build$/m);
		assert.doesNotMatch(r.calls, /npm ci/);
	});
	it("merged: npm ci, seam gate, tsc, then build, in that order", () => {
		const r = build(0);
		assert.equal(r.status, 0, r.out);
		const order = ["npm ci", "npx tsx --test tests/storage-seam.test.ts", "npx tsc --noEmit", "npx next build"].map((c) => r.calls.indexOf(c));
		assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]!), r.calls);
	});
	it("merged with a regenerated lock: npm install instead of npm ci", () => {
		const r = build(0, undefined, { lockFlag: true });
		assert.equal(r.status, 0, r.out);
		assert.match(r.calls, /^npm install/m);
		assert.doesNotMatch(r.calls, /npm ci/);
	});
	it("merged but does not type-check: refuses to ship (no build)", () => {
		const r = build(0, undefined, { tscFails: true });
		assert.equal(r.status, 1);
		assert.match(r.out, /refusing to ship/);
		assert.doesNotMatch(r.calls, /next build/);
	});
	it("merge conflict (exit 2): fails without building, old deployment stays live", () => {
		const r = build(2);
		assert.equal(r.status, 1);
		assert.doesNotMatch(r.calls, /next build/);
	});
});
