#!/usr/bin/env node
/**
 * THE PORTABILITY PROOF (portability wave, 2026-11-03).
 *
 * Boots the real app twice — once as `LH_PROFILE=local`, once as
 * `LH_PROFILE=hosted` — against a throwaway data dir and an empty key file,
 * then diffs `GET /api/capabilities`. If the same commit produces a
 * different switchboard in the two homes without a code change, the
 * portability claim is true rather than aspirational.
 *
 * It also asserts the report is secret-free: no env value it saw may appear
 * anywhere in the response body.
 *
 * Usage: node scripts/smoke-capabilities.mjs
 * Exits 0 on success; prints the two reports and the diff either way.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TIMEOUT_MS = 90_000;

/** A free port, so parallel runs never collide. */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** The secret-looking values this run plants; none may reach the report. */
const PLANTED = {
	OPENROUTER_API_KEY: "sk-or-PLANTED-SECRET-0123456789",
	DEEPGRAM_API_KEY: "dg-PLANTED-SECRET-9876543210",
	TAVILY_API_KEY: "tvly-PLANTED-SECRET-5555555555",
	DATABASE_URL: "postgres://lh:PLANTED-SECRET-pw@127.0.0.1:5432/learnharness",
};

async function bootProfile(profile, planted = PLANTED) {
	const port = await freePort();
	const home = mkdtempSync(path.join(tmpdir(), `lh-${profile}-`));
	const dataDir = path.join(home, "data");
	const authFile = path.join(home, "auth.json");
	writeFileSync(authFile, "{}\n");

	const child = spawn(process.execPath, [path.join(ROOT, ".next", "standalone", "server.js")], {
		cwd: ROOT,
		env: {
			PATH: process.env.PATH,
			HOME: home,
			TMPDIR: home,
			NODE_ENV: "production",
			PORT: String(port),
			HOSTNAME: "127.0.0.1",
			NEXT_TELEMETRY_DISABLED: "1",
			LH_PROFILE: profile,
			LH_DATA_DIR: dataDir,
			LH_AUTH_FILE: authFile,
			// Planted keys: presence is what the switchboard reads.
			...planted,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const deadline = Date.now() + TIMEOUT_MS;
	const base = `http://127.0.0.1:${port}`;

	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`server for ${profile} exited early (${child.exitCode})\n${stderr}`);
		}
		try {
			const res = await fetch(`${base}/api/capabilities`);
			if (res.ok) {
				const body = await res.text();
				return { profile, port, child, body, dataDir, json: JSON.parse(body) };
			}
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	child.kill("SIGKILL");
	throw new Error(`server for ${profile} did not become ready in time\n${stderr}`);
}

function summarise(report) {
	return report.states.map((state) => {
		const active = state.active ?? "—";
		const flag = state.fallbackUsed ? " (fallback)" : "";
		return `${state.kind.padEnd(8)} ${state.active ? active + flag : "—"}   ${state.status.reason}`;
	});
}

function chainOf(report, kind) {
	return report.states.find((state) => state.kind === kind)?.active ?? null;
}

let failures = 0;
function check(condition, message) {
	console.log(`${condition ? "ok  " : "FAIL"} ${message}`);
	if (!condition) failures++;
}

const runs = [];
try {
	for (const profile of ["local", "hosted"]) {
		const run = await bootProfile(profile);
		runs.push(run);
		console.log(`\n=== ${profile} (pid ${run.child.pid}, port ${run.port}) ===`);
		for (const line of summarise(run.json)) console.log("   " + line);
	}
} catch (error) {
	console.error(String(error));
	process.exit(1);
}

const [local, hosted] = runs;
console.log("\n=== assertions ===");

check(local.json.profile === "local", "local run reports profile=local");
check(hosted.json.profile === "hosted", "hosted run reports profile=hosted");

check(local.json.states.length === 7, "all seven capabilities are reported");

// The portability claim, stated as assertions: different homes, same commit.
check(chainOf(local.json, "store") === "fs", "store: local resolves fs");
// Until the Postgres adapter lands (portability step 5), the hosted store
// must say so — DATABASE_URL being present is NOT enough to claim ready.
const hostedStore = hosted.json.states.find((state) => state.kind === "store");
// convex-store branch: hosted = [convex, postgres]. Without LH_STORE=convex +
// CONVEX_URL + LH_CONVEX_SECRET, convex is unmet; postgres still has no adapter.
check(
	hostedStore.active === null &&
		hostedStore.checked.length === 2 &&
		/adapter not built yet/.test(hostedStore.checked[1].status.reason) &&
		!hostedStore.checked[0].status.available,
	"store: hosted refuses to claim postgres until its adapter exists, and convex until it is configured (honest)",
);
check(
	chainOf(local.json, "runtime") === "in-process",
	"runtime: local runs in-process",
);
// durable-pi branch: pi-durable heads both runtime chains but is OPT-IN —
// without LH_RUNTIME=pi-durable it reports why and the chain falls through.
const localRuntime = local.json.states.find((state) => state.kind === "runtime");
check(
	localRuntime.checked[0].provider === "pi-durable" && /set LH_RUNTIME=pi-durable/.test(localRuntime.checked[0].status.reason ?? ""),
	"runtime: pi-durable offered first, off until LH_RUNTIME=pi-durable",
);
check(
	chainOf(hosted.json, "search") === "tavily" && chainOf(local.json, "search") === "tavily",
	"search: both resolve tavily — hosted as head of chain, local only after searxng",
);
check(
	chainOf(hosted.json, "stt") === "deepgram",
	"stt: hosted resolves deepgram from the planted key",
);
check(
	JSON.stringify(local.json) !== JSON.stringify(hosted.json),
	"the two profiles produce different switchboards with no code change",
);

// The second rule: nothing silently falls back.
const hostedSearch = hosted.json.states.find((state) => state.kind === "search");
check(
	hostedSearch.checked.length === 1 && hostedSearch.fallbackUsed === false,
	"a live head-of-chain provider is not treated as a fallback",
);
const localSearch = local.json.states.find((state) => state.kind === "search");
check(
	localSearch.fallbackUsed === true && localSearch.checked[0].provider === "searxng",
	"the local fallback to tavily is REPORTED (searxng tried first), never silent",
);

// And the report must never carry a credential.
for (const run of runs) {
	const leaked = Object.values(PLANTED).some((secret) => run.body.includes(secret));
	check(!leaked, `${run.profile}: /api/capabilities leaks no key material`);
	check(run.body.includes('"available"'), `${run.profile}: report carries availability, not values`);
}

// THE REAL USER FLOW: a fresh install with no keys, the user pastes one in
// Settings → Keys, and the very next capability read reflects it — no
// restart. A third boot with nothing planted, so "before" is genuinely empty.
{
	const fresh = await bootProfile("local", {});
	runs.push(fresh);
	const base = `http://127.0.0.1:${fresh.port}`;
	const llmOf = (report) => report.states.find((state) => state.kind === "llm");
	check(llmOf(fresh.json).active === null, "settings: fresh install has no model (honest)");

	const secret = "sk-or-PLANTED-SETTINGS-KEY-424242";
	const put = await fetch(`${base}/api/keys/OPENROUTER_API_KEY`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: secret }),
	});
	check(put.ok, `settings: PUT /api/keys/OPENROUTER_API_KEY → ${put.status}`);

	const afterBody = await fetch(`${base}/api/capabilities`).then((r) => r.text());
	const llm = llmOf(JSON.parse(afterBody));
	// A key alone does not make a turn runnable — the app refuses until a
	// model is picked — so the switchboard must say exactly that.
	check(llm.active === null && /OpenRouter key present — pick a model/.test(llm.status.reason),
		"settings: key saved, no model picked → honest 'pick a model', no restart needed");

	mkdirSync(fresh.dataDir, { recursive: true });
	// Now pick a model the way Settings does (the settings record is read
	// fresh on every request) and the capability goes live.
	writeFileSync(path.join(fresh.dataDir, "settings.json"), JSON.stringify({
		version: 1,
		models: { strong: { model: { provider: "openrouter", id: "openrouter/auto" }, thinkingLevel: "medium" } },
	}));
	const picked = llmOf(await fetch(`${base}/api/capabilities`).then((r) => r.json()));
	check(picked.active === "openrouter" && picked.fallbackUsed === false,
		"settings: model picked → llm live on its own provider, not a substitute");

	// The regression the user hit: NVIDIA picked + NVIDIA key → live.
	await fetch(`${base}/api/keys/NVIDIA_API_KEY`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "nvapi-PLANTED-SETTINGS-KEY-31337" }),
	});
	writeFileSync(path.join(fresh.dataDir, "settings.json"), JSON.stringify({
		version: 1,
		models: { strong: { model: { provider: "nvidia", id: "poolside/laguna-xs-2.1" }, thinkingLevel: "medium" } },
	}));
	const nvidia = llmOf(await fetch(`${base}/api/capabilities`).then((r) => r.json()));
	check(nvidia.active === "nvidia", "regression: an NVIDIA key + NVIDIA model reports llm=nvidia");
	check(!afterBody.includes(secret), "settings: the saved key never appears in the report");
	const keys = await fetch(`${base}/api/keys`).then((r) => r.text());
	check(!keys.includes(secret), "settings: /api/keys masks the saved value");
}

for (const run of runs) run.child.kill("SIGTERM");

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — smoke-capabilities`);
process.exit(failures === 0 ? 0 : 1);
