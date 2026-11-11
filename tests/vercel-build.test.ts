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

function build(mergeExit: number, env: Record<string, string> = { LH_AUTO_UPDATE: "1", VERCEL: "1" }, opts: { tscFails?: boolean; lockFlag?: boolean; marker?: boolean } = {}) {
	// The repo root is a SUBDIRECTORY: the restore path wipes and re-extracts
	// the root, so the stubs and the call log must live outside it.
	const t = fs.mkdtempSync(path.join(os.tmpdir(), "vbuild-"));
	const root = path.join(t, "repo");
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.mkdirSync(path.join(t, "bin"));
	fs.writeFileSync(path.join(root, "source.txt"), "ours\n");
	fs.copyFileSync(SCRIPT, path.join(root, "scripts", "vercel-build.sh"));
	if (opts.lockFlag) fs.writeFileSync(path.join(root, ".lock-regenerated"), "1\n");
	const stub = (name: string, body: string) => fs.writeFileSync(path.join(t, "bin", name), `#!/bin/sh\necho "${name} $*" >> "${t}/calls"\n${body}\n`, { mode: 0o755 });
	// The merge stub rewrites our source (as a real merge does) and, for a
	// failed merge, leaves the blocked-update marker like upstream-merge.mjs.
	stub("node", `if [ "$1" = "scripts/upstream-merge.mjs" ]; then
  [ ${mergeExit} -eq 0 ] && echo merged > source.txt
  ${opts.marker ? `echo '{"release":"v9.9.9","reason":"Merge conflicts: a.ts"}' > .upstream-blocked.json` : ":"}
  exit ${mergeExit}
fi
exit 0`);
	stub("npm", "exit 0");
	stub("npx", opts.tscFails ? `case "$*" in *tsc*) exit 1;; esac; exit 0` : "exit 0");
	const r = spawnSync("bash", [path.join(root, "scripts", "vercel-build.sh")], {
		encoding: "utf-8",
		env: { PATH: `${path.join(t, "bin")}:/usr/bin:/bin`, TMPDIR: t, ...env } as unknown as NodeJS.ProcessEnv,
	});
	const calls = fs.existsSync(path.join(t, "calls")) ? fs.readFileSync(path.join(t, "calls"), "utf-8") : "";
	const source = fs.readFileSync(path.join(root, "source.txt"), "utf-8").trim();
	const marker = fs.existsSync(path.join(root, ".upstream-blocked.json")) ? fs.readFileSync(path.join(root, ".upstream-blocked.json"), "utf-8") : null;
	fs.rmSync(t, { recursive: true, force: true });
	return { status: r.status, out: r.stdout + r.stderr, calls, source, marker };
}

describe("scripts/vercel-build.sh", () => {
	it("auto-update off: plain build, no merge", () => {
		const r = build(0, {});
		assert.equal(r.status, 0, r.out);
		assert.doesNotMatch(r.calls, /^node scripts\/upstream-merge/m);
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
		const order = ["npm ci --include=dev", "npx tsx --test tests/storage-seam.test.ts", "npx tsc --noEmit", "npx next build"].map((c) => r.calls.indexOf(c));
		assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]!), r.calls);
	});
	it("merged with a regenerated lock: npm install instead of npm ci", () => {
		const r = build(0, undefined, { lockFlag: true });
		assert.equal(r.status, 0, r.out);
		assert.match(r.calls, /^npm install/m);
		assert.doesNotMatch(r.calls, /npm ci/);
	});
	it("merged but does not type-check: restores OUR tree and builds the current code", () => {
		const r = build(0, undefined, { tscFails: true });
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /does not type-check — building the CURRENT code/);
		assert.equal(r.source, "ours", "the merged tree was rolled back");
		assert.match(r.calls, /npm ci --include=dev[\s\S]*npm ci --include=dev/, "our packages are reinstalled, dev tooling included");
		assert.ok(r.calls.indexOf("npx next build") > r.calls.indexOf("npx tsc --noEmit"), r.calls);
	});
	it("merge conflict (exit 11): builds the current code and keeps the blocked-update marker", () => {
		const r = build(11, undefined, { marker: true });
		assert.equal(r.status, 0, r.out);
		// (the additive, --no-save serverless-Chromium install is not a reinstall)
		assert.doesNotMatch(r.calls, /^npm (ci|install)(?! --no-save)/m, "the tree was never touched: no reinstall (Vercel's install stays)");
		assert.match(r.calls, /^npx next build$/m);
		assert.equal(r.source, "ours");
		assert.match(r.marker ?? "", /"release":"v9\.9\.9".*Merge conflicts: a\.ts/);
	});
	it("an unexpected merge-script failure (exit 1) still ships the current code", () => {
		const r = build(1);
		assert.equal(r.status, 0, r.out);
		assert.match(r.calls, /^npx next build$/m);
		assert.equal(r.source, "ours");
	});
	it("a clean run removes a stale marker from an earlier build", () => {
		const r = build(10);
		assert.equal(r.marker, null);
	});
});
