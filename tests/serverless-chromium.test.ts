/** THE HOSTED SERVERLESS-CHROMIUM PATH (Vercel / Lambda).
 *
 *  A hosted function has neither the app's own Electron helper nor a system
 *  Chrome, so every demo failed its mandatory browser verification (and the
 *  visual maker's preflight refused too). The hosted line therefore installs
 *  @sparticuz/chromium for the build only (scripts/vercel-build.sh, never a
 *  package.json dependency) and runs demos in it
 *  (src/agent/subagents/headless.ts).
 *
 *  Covered here:
 *   1. the pure gate (serverlessChromiumWanted) — its whole truth table;
 *   2. a desktop child process (NO serverless env): the module imports cleanly
 *      and the desktop semantics of unavailableReason() are unchanged;
 *   3. next.config.ts: the file-tracing includes carry the package ONLY on
 *      Vercel (desktop builds ship nothing extra);
 *   4. scripts/vercel-build.sh: the install runs BEFORE every `next build` on
 *      every merge outcome, and it is never a fatal step.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { serverlessChromiumWanted } from "../src/agent/subagents/headless.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const SCRIPT = path.join(REPO_ROOT, "scripts", "vercel-build.sh");
const CHROMIUM_PACKAGE_DIR = path.join(REPO_ROOT, "node_modules", "@sparticuz", "chromium");

/** A desktop env: none of the serverless markers may leak into a child. */
const DESKTOP_ENV = (() => {
	const env = { ...process.env } as Record<string, string | undefined>;
	delete env.VERCEL;
	delete env.AWS_LAMBDA_FUNCTION_NAME;
	delete env.LH_SERVERLESS_CHROMIUM;
	return env;
})();

/** Run a TS snippet in a fresh child (tsx loader), returning its result line. */
function runChild(script: string, env: Record<string, string | undefined> = {}): { status: number | null; out: string; result: unknown } {
	const r = spawnSync(process.execPath, ["--import", TSX_LOADER, "--input-type=module", "--eval", script], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
		timeout: 120_000,
		env: { ...DESKTOP_ENV, ...env } as NodeJS.ProcessEnv,
	});
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	const line = out.split("\n").find((l) => l.startsWith("__RESULT__"));
	assert.ok(line, `child produced no result line (status ${r.status}):\n${out}`);
	return { status: r.status, out, result: JSON.parse(line.slice("__RESULT__".length)) };
}

describe("serverlessChromiumWanted (the pure host gate)", () => {
	const LINUX = "linux";
	const cases: Array<{ label: string; env: Record<string, string | undefined>; platform: string; want: boolean }> = [
		// The hosted hosts.
		{ label: "linux + VERCEL=1", env: { VERCEL: "1" }, platform: LINUX, want: true },
		{ label: "linux + AWS_LAMBDA_FUNCTION_NAME", env: { AWS_LAMBDA_FUNCTION_NAME: "learnharness" }, platform: LINUX, want: true },
		{ label: "linux + VERCEL=1 + Lambda", env: { VERCEL: "1", AWS_LAMBDA_FUNCTION_NAME: "learnharness" }, platform: LINUX, want: true },
		// The operator's explicit switch.
		{ label: "linux + LH_SERVERLESS_CHROMIUM=1 (forced, no host marker)", env: { LH_SERVERLESS_CHROMIUM: "1" }, platform: LINUX, want: true },
		{ label: "linux + LH_SERVERLESS_CHROMIUM=1 + VERCEL=1", env: { LH_SERVERLESS_CHROMIUM: "1", VERCEL: "1" }, platform: LINUX, want: true },
		{ label: "linux + LH_SERVERLESS_CHROMIUM=0 + VERCEL=1 (disabled)", env: { LH_SERVERLESS_CHROMIUM: "0", VERCEL: "1" }, platform: LINUX, want: false },
		{ label: "linux + LH_SERVERLESS_CHROMIUM=0 + Lambda (disabled)", env: { LH_SERVERLESS_CHROMIUM: "0", AWS_LAMBDA_FUNCTION_NAME: "learnharness" }, platform: LINUX, want: false },
		// A desktop machine: never, not even with the force flag.
		{ label: "darwin + LH_SERVERLESS_CHROMIUM=1", env: { LH_SERVERLESS_CHROMIUM: "1" }, platform: "darwin", want: false },
		{ label: "darwin + VERCEL=1", env: { VERCEL: "1" }, platform: "darwin", want: false },
		{ label: "darwin + LH_SERVERLESS_CHROMIUM=1 + VERCEL=1", env: { LH_SERVERLESS_CHROMIUM: "1", VERCEL: "1" }, platform: "darwin", want: false },
		{ label: "win32 + LH_SERVERLESS_CHROMIUM=1", env: { LH_SERVERLESS_CHROMIUM: "1" }, platform: "win32", want: false },
		{ label: "win32 + VERCEL=1", env: { VERCEL: "1" }, platform: "win32", want: false },
		{ label: "win32 + LH_SERVERLESS_CHROMIUM=1 + VERCEL=1", env: { LH_SERVERLESS_CHROMIUM: "1", VERCEL: "1" }, platform: "win32", want: false },
		// A plain Linux box: the desktop chain (helper → system Chrome) applies.
		{ label: "linux, no marker", env: {}, platform: LINUX, want: false },
		{ label: "linux + VERCEL=0", env: { VERCEL: "0" }, platform: LINUX, want: false },
	];

	for (const c of cases) {
		it(`${c.label} → ${c.want}`, () => {
			assert.equal(serverlessChromiumWanted(c.env, c.platform), c.want);
		});
	}

	it("the platform defaults to this process's platform", () => {
		assert.equal(serverlessChromiumWanted({ VERCEL: "1" }), process.platform === "linux");
		assert.equal(serverlessChromiumWanted({ LH_SERVERLESS_CHROMIUM: "1" }), process.platform === "linux");
	});
});

describe("desktop semantics (no serverless env)", () => {
	it("the module imports cleanly and the desktop chain is unchanged", () => {
		const { status, out, result } = runChild(`
			const m = await import(${JSON.stringify(path.join(REPO_ROOT, "src", "agent", "subagents", "headless.ts"))});
			const reason = m.realHeadless.unavailableReason();
			console.log("__RESULT__" + JSON.stringify({
				wanted: m.serverlessChromiumWanted(process.env),
				reason: reason === null ? null : String(reason),
				helper: m.browserServiceBinary() !== null,
				chrome: m.resolveChromeExecutablePath() !== null,
			}));
		`);
		assert.equal(status, 0, `the headless module must import cleanly:\n${out}`);
		const r = result as { wanted: boolean; reason: string | null; helper: boolean; chrome: boolean };
		assert.equal(r.wanted, false, "a desktop process must not want the serverless Chromium");
		// unavailableReason() depends only on the helper / system Chrome, never
		// on the serverless package (which is not installed here).
		assert.ok(r.reason === null || typeof r.reason === "string", r.reason);
		if (r.helper || r.chrome) {
			assert.equal(r.reason, null, "a resolvable helper/Chrome means no reason to complain");
		} else {
			assert.match(r.reason ?? "", /No render engine available/);
		}
	});
});

describe("next.config.ts (the hosted file tracing)", () => {
	// Scoped since b3a7740: the Chromium closure rides ONLY on the route that
	// runs jobs (/api/internal/run) — on "*" it pushed every function past
	// the Hobby limits.
	const includesFor = (env: Record<string, string | undefined>, route = "*") => {
		const { status, out, result } = runChild(`
			const m = await import(${JSON.stringify(path.join(REPO_ROOT, "next.config.ts"))});
			const includes = m.default.outputFileTracingIncludes?.[${JSON.stringify(route)}] ?? [];
			console.log("__RESULT__" + JSON.stringify(includes));
		`, env);
		assert.equal(status, 0, `next.config.ts must import cleanly:\n${out}`);
		return result as string[];
	};

	it("without VERCEL the '*' includes carry no @sparticuz entry", () => {
		const includes = includesFor({});
		assert.ok(Array.isArray(includes) && includes.length > 0, "the '*' include list must exist");
		assert.deepEqual(includes.filter((entry) => entry.includes("@sparticuz")), [], "desktop builds must not ship the serverless Chromium");
	});

	it("with VERCEL=1 only the job route carries the package and its dependency closure", (t) => {
		if (!fs.existsSync(CHROMIUM_PACKAGE_DIR)) {
			t.skip("@sparticuz/chromium is not installed (the build installs it with --no-save)");
			return;
		}
		const includes = includesFor({ VERCEL: "1" }, "/api/internal/run");
		assert.ok(includes.includes("node_modules/@sparticuz/chromium/**/*"), includes.join(", "));
		assert.ok(includes.includes("node_modules/tar-fs/**/*"), includes.join(", "));
		const everywhere = includesFor({ VERCEL: "1" });
		assert.deepEqual(everywhere.filter((entry) => entry.includes("@sparticuz")), [], "the closure must stay off the '*' functions");
	});

	it("without VERCEL no route carries the serverless Chromium", () => {
		assert.deepEqual(includesFor({}, "/api/internal/run"), []);
	});
});

describe("scripts/vercel-build.sh (the hosted build hook)", () => {
	/** The stub harness of tests/vercel-build.test.ts: the real script runs
	 *  with stub node/npx/npm on PATH, so every merge outcome is checked
	 *  without a real build. The stubs and the call log live OUTSIDE the repo
	 *  root: the restore path wipes and re-extracts that root. */
	function build(mergeExit: number, env: Record<string, string> = { LH_AUTO_UPDATE: "1", VERCEL: "1" }, opts: { chromiumInstallFails?: boolean } = {}) {
		const t = fs.mkdtempSync(path.join(os.tmpdir(), "vbuild-sc-"));
		const root = path.join(t, "repo");
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		fs.mkdirSync(path.join(t, "bin"));
		fs.writeFileSync(path.join(root, "source.txt"), "ours\n");
		fs.copyFileSync(SCRIPT, path.join(root, "scripts", "vercel-build.sh"));
		const stub = (name: string, body: string) => fs.writeFileSync(path.join(t, "bin", name), `#!/bin/sh\necho "${name} $*" >> "${t}/calls"\n${body}\n`, { mode: 0o755 });
		stub("node", `if [ "$1" = "scripts/upstream-merge.mjs" ]; then
  [ ${mergeExit} -eq 0 ] && echo merged > source.txt
  exit ${mergeExit}
fi
exit 0`);
		// The serverless-Chromium install may fail (it is non-fatal by design).
		stub("npm", opts.chromiumInstallFails ? `case "$*" in
  *@sparticuz/chromium*) exit 1;;
esac
exit 0` : "exit 0");
		stub("npx", "exit 0");
		const r = spawnSync("bash", [path.join(root, "scripts", "vercel-build.sh")], {
			encoding: "utf-8",
			env: { PATH: `${path.join(t, "bin")}:/usr/bin:/bin`, TMPDIR: t, ...env } as unknown as NodeJS.ProcessEnv,
		});
		const calls = fs.existsSync(path.join(t, "calls")) ? fs.readFileSync(path.join(t, "calls"), "utf-8") : "";
		fs.rmSync(t, { recursive: true, force: true });
		return { status: r.status, out: r.stdout + r.stderr, calls };
	}

	const INSTALL = /^npm install --no-save .*@sparticuz\/chromium@/m;
	const BUILD = /^npx next build$/m;
	const lineIndexes = (calls: string, re: RegExp) => {
		const out: number[] = [];
		calls.split("\n").forEach((line, i) => { if (re.test(line)) out.push(i); });
		return out;
	};

	/** Every `npx next build` must be preceded by the serverless install. */
	function assertInstalledBeforeEveryBuild(calls: string) {
		const installs = lineIndexes(calls, INSTALL);
		const builds = lineIndexes(calls, BUILD);
		assert.ok(builds.length >= 1, `no next build ran:\n${calls}`);
		assert.ok(installs.length >= 1, `the serverless Chromium was never installed:\n${calls}`);
		for (const build of builds) {
			assert.ok(installs.some((i) => i < build), `the install must come BEFORE every next build:\n${calls}`);
		}
	}

	it("nothing newer (exit 10): the install runs before the build", () => {
		const r = build(10);
		assert.equal(r.status, 0, r.out);
		assertInstalledBeforeEveryBuild(r.calls);
		assert.match(r.calls, /@sparticuz\/chromium@\d+\.\d+\.\d+/, "the version is pinned");
	});

	it("merged (exit 0): the install runs before the build (and after the merged install)", () => {
		const r = build(0);
		assert.equal(r.status, 0, r.out);
		assertInstalledBeforeEveryBuild(r.calls);
		const reinstall = r.calls.indexOf("npm ci --include=dev");
		const install = r.calls.search(INSTALL);
		assert.ok(reinstall >= 0 && install > reinstall, `the merged tree is installed first:\n${r.calls}`);
	});

	it("merge conflict (exit 11): the install runs before the build of the current code", () => {
		const r = build(11);
		assert.equal(r.status, 0, r.out);
		assertInstalledBeforeEveryBuild(r.calls);
	});

	it("without VERCEL the install is skipped (desktop/local builds ship nothing extra)", () => {
		const r = build(10, { LH_AUTO_UPDATE: "1" });
		assert.equal(r.status, 0, r.out);
		assert.doesNotMatch(r.calls, INSTALL, "no serverless Chromium outside Vercel");
		assert.match(r.calls, BUILD, "the build still runs");
	});

	it("a failing install is not fatal: the build still ships", () => {
		const r = build(10, undefined, { chromiumInstallFails: true });
		assert.equal(r.status, 0, r.out);
		assert.match(r.calls, INSTALL, "the install was attempted");
		assert.match(r.calls, BUILD, "the build still ran");
		assert.match(r.out, /WARNING: serverless Chromium failed to install/);
	});

	it("a failing install is not fatal on the merged path either", () => {
		const r = build(0, undefined, { chromiumInstallFails: true });
		assert.equal(r.status, 0, r.out);
		assert.match(r.calls, INSTALL, "the install was attempted");
		assert.match(r.calls, BUILD, "the build still ran");
		assert.match(r.out, /WARNING: serverless Chromium failed to install/);
	});
});
