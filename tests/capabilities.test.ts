/**
 * THE SWITCHBOARD'S GATE (portability wave, 2026-11-03).
 *
 * These tests pin the three rules the whole portability story rests on:
 *   1. no factory default — an empty chain is honestly unavailable;
 *   2. ordered chains — first live provider wins, later ones are reported
 *      fallbacks, never silent;
 *   3. presence-only probing — a requirement is checked by name, never by
 *      reading or logging a secret.
 *
 * Pure: no env mutation, no network, no filesystem.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCapability, unmetRequirement } from "../src/core/capabilities/resolve.ts";
import { LLM_KEY_PROVIDERS, PROVIDERS, PROFILE_CHAINS, llmChain } from "../src/core/capabilities/providers.ts";
import { AUTH_PROVIDER_KEYS } from "../src/core/auth-keys.ts";
import type { ProviderDeclaration, ResolverEnvironment } from "../src/core/capabilities/types.ts";

/** An environment where nothing is configured. */
const EMPTY: ResolverEnvironment = { env: {}, binaries: [], endpointsUp: [], secureContext: false };

/** An environment where the named vars are present (values are dummies). */
function withEnv(...names: string[]): ResolverEnvironment {
	const env: Record<string, string | undefined> = {};
	for (const name of names) env[name] = "present";
	return { ...EMPTY, env };
}

const declared = (over: Partial<ProviderDeclaration> = {}): ProviderDeclaration => ({
	id: "p",
	kind: "search",
	label: "P",
	delivery: "hosted",
	...over,
});

describe("unmetRequirement", () => {
	it("passes a provider with no requirements", () => {
		assert.equal(unmetRequirement(undefined, EMPTY, "p"), null);
		assert.equal(unmetRequirement({}, EMPTY, "p"), null);
	});

	it("names the first missing env var, not the value", () => {
		const reason = unmetRequirement({ env: ["TAVILY_API_KEY", "BRAVE_API_KEY"] }, EMPTY, "p");
		assert.equal(reason, "no TAVILY_API_KEY");
		assert.doesNotMatch(String(reason), /present/);
	});

	it("treats a blank env var as absent", () => {
		const env: ResolverEnvironment = { env: { TAVILY_API_KEY: "   " } };
		assert.equal(unmetRequirement({ env: ["TAVILY_API_KEY"] }, env, "p"), "no TAVILY_API_KEY");
	});

	it("requires the endpoint to be listed for endpoint providers", () => {
		assert.equal(unmetRequirement({ endpoint: true }, EMPTY, "searxng"), "endpoint not configured");
		const up: ResolverEnvironment = { ...EMPTY, endpointsUp: ["searxng"] };
		assert.equal(unmetRequirement({ endpoint: true }, up, "searxng"), null);
	});

	it("requires the binary for machine-local providers", () => {
		assert.equal(unmetRequirement({ binary: "chrome" }, EMPTY, "p"), "chrome not installed");
		const withBinary: ResolverEnvironment = { ...EMPTY, binaries: ["chrome"] };
		assert.equal(unmetRequirement({ binary: "chrome" }, withBinary, "p"), null);
	});

	it("requires a secure context for browser APIs", () => {
		assert.equal(unmetRequirement({ secureContext: true }, EMPTY, "webspeech"), "needs https or localhost");
		const secure: ResolverEnvironment = { ...EMPTY, secureContext: true };
		assert.equal(unmetRequirement({ secureContext: true }, secure, "webspeech"), null);
	});
});

describe("resolveCapability — no factory default", () => {
	it("is unavailable, with a reason, when the chain is empty", () => {
		const state = resolveCapability("search", { chain: [] }, PROVIDERS, EMPTY);
		assert.equal(state.active, null);
		assert.equal(state.status.available, false);
		assert.equal(state.status.reason, "no provider configured");
		assert.deepEqual(state.checked, []);
		assert.equal(state.fallbackUsed, false);
	});

	it("is unavailable when configured but nothing resolves", () => {
		const state = resolveCapability(
			"search",
			{ chain: [{ provider: "tavily" }, { provider: "brave" }] },
			PROVIDERS,
			EMPTY,
		);
		assert.equal(state.active, null);
		assert.equal(state.status.available, false);
		assert.equal(state.checked.length, 2);
		assert.match(state.status.reason, /none available \(tavily, brave all unmet\)/);
	});
});

describe("resolveCapability — ordered chain, reported fallback", () => {
	it("picks the first provider whose requirements are met", () => {
		const state = resolveCapability(
			"search",
			{ chain: [{ provider: "searxng" }, { provider: "tavily" }] },
			PROVIDERS,
			withEnv("TAVILY_API_KEY"),
		);
		assert.equal(state.active, "tavily");
		assert.equal(state.fallbackUsed, true, "a fallback that fires is reported, never hidden");
		assert.deepEqual(
			state.checked.map((c) => [c.provider, c.status.available]),
			[["searxng", false], ["tavily", true]],
		);
	});

	it("reports no fallback when the head of the chain is live", () => {
		const state = resolveCapability(
			"search",
			{ chain: [{ provider: "tavily" }, { provider: "brave" }] },
			PROVIDERS,
			withEnv("TAVILY_API_KEY", "BRAVE_API_KEY"),
		);
		assert.equal(state.active, "tavily");
		assert.equal(state.fallbackUsed, false);
		assert.equal(state.checked.length, 1, "later providers are not probed once one is live");
	});

	it("survives an unknown provider id in the chain instead of throwing", () => {
		const state = resolveCapability(
			"stt",
			{ chain: [{ provider: "typo-vendor" }, { provider: "deepgram" }] },
			PROVIDERS,
			withEnv("DEEPGRAM_API_KEY"),
		);
		assert.equal(state.active, "deepgram");
		assert.equal(state.checked[0]!.status.reason, 'unknown provider "typo-vendor"');
	});
});

describe("resolveCapability — pending adapters never claim ready", () => {
	it("reports a declared-but-unbuilt provider unavailable even with its key present", () => {
		const state = resolveCapability(
			"store",
			{ chain: [{ provider: "postgres" }] },
			PROVIDERS,
			withEnv("DATABASE_URL"),
		);
		assert.equal(state.active, null);
		assert.match(state.checked[0]!.status.reason, /adapter not built yet/);
	});

	it("falls through a pending provider to a built one, and says so", () => {
		const state = resolveCapability(
			"runtime",
			{ chain: [{ provider: "restate" }, { provider: "in-process" }] },
			PROVIDERS,
			{ ...EMPTY, endpointsUp: ["restate"] },
		);
		assert.equal(state.active, "in-process");
		assert.equal(state.fallbackUsed, true);
	});
});

describe("the two profiles are ordered, not hardcoded", () => {
	it("local prefers searxng then hosted search engines", () => {
		const ids = PROFILE_CHAINS.local.search.chain.map((entry) => entry.provider);
		assert.deepEqual(ids, ["searxng", "tavily", "brave"]);
	});

	it("hosted prefers tavily and never reaches for a local engine", () => {
		const ids = PROFILE_CHAINS.hosted.search.chain.map((entry) => entry.provider);
		assert.deepEqual(ids, ["tavily", "brave"]);
		assert.ok(!ids.includes("searxng"));
	});

	it("every chain entry names a declared provider of the right kind", () => {
		for (const [profile, chains] of Object.entries(PROFILE_CHAINS)) {
			for (const [kind, config] of Object.entries(chains)) {
				for (const entry of config.chain) {
					const declaration = PROVIDERS[entry.provider];
					assert.ok(declaration, `${profile}.${kind}: undeclared provider ${entry.provider}`);
					assert.equal(
						declaration.kind,
						kind,
						`${profile}.${kind}: ${entry.provider} is declared as ${declaration.kind}`,
					);
				}
			}
		}
	});
});

describe("llm — the model the user picked, never a substitute", () => {
	it("declares every BYOK provider the app supports (no hand-picked subset)", () => {
		for (const info of AUTH_PROVIDER_KEYS) {
			assert.ok(LLM_KEY_PROVIDERS[info.id], `missing llm provider ${info.id}`);
		}
		assert.ok(PROVIDERS.nvidia, "nvidia — the regression that motivated this — is declared");
	});

	it("a picked model makes the chain exactly that provider", () => {
		assert.deepEqual(llmChain("local", "nvidia"), [{ provider: "nvidia" }]);
	});

	it("with nothing picked, local tries ollama first, then every provider once", () => {
		const ids = llmChain("local", null).map((entry) => entry.provider);
		assert.equal(ids[0], "ollama");
		assert.equal(new Set(ids).size, ids.length, "no duplicates");
		assert.ok(ids.includes("nvidia"));
	});

	it("the app's own gate decides a provider is connected", () => {
		const live = resolveCapability("llm", { chain: [{ provider: "nvidia" }] }, PROVIDERS, { ...EMPTY, gatesPassed: ["nvidia"] });
		assert.equal(live.active, "nvidia");
		const dead = resolveCapability("llm", { chain: [{ provider: "nvidia" }] }, PROVIDERS, EMPTY);
		assert.equal(dead.active, null);
		assert.match(dead.checked[0]!.status.reason, /not connected/);
	});
});

describe("runtime — pi-durable is opt-in (durable-pi branch)", () => {
	const env = (vars: Record<string, string>): ResolverEnvironment => ({ env: vars });

	it("is offered first but stays off without LH_RUNTIME=pi-durable; in-process takes over", () => {
		const state = resolveCapability("runtime", PROFILE_CHAINS.local.runtime, PROVIDERS, env({}));
		assert.equal(state.active, "in-process");
		assert.equal(state.checked[0]?.provider, "pi-durable");
		assert.equal(state.checked[0]?.status.available, false);
		assert.match(String((state.checked[0]?.status as { reason?: string }).reason), /set LH_RUNTIME=pi-durable/);
	});

	it("presence is not enough — the switch must say pi-durable", () => {
		const state = resolveCapability("runtime", PROFILE_CHAINS.local.runtime, PROVIDERS, env({ LH_RUNTIME: "in-process" }));
		assert.equal(state.active, "in-process");
	});

	it("local: LH_RUNTIME=pi-durable makes it live (node:sqlite under the data dir)", () => {
		const state = resolveCapability("runtime", PROFILE_CHAINS.local.runtime, PROVIDERS, env({ LH_RUNTIME: "pi-durable" }));
		assert.equal(state.active, "pi-durable");
		assert.equal(state.fallbackUsed, false);
	});

	it("hosted: also needs LH_DURABLE_LIBSQL_URL (a serverless host has no disk)", () => {
		const off = resolveCapability("runtime", PROFILE_CHAINS.hosted.runtime, PROVIDERS, env({ LH_RUNTIME: "pi-durable" }));
		assert.notEqual(off.active, "pi-durable-libsql");
		assert.match(String((off.checked[0]?.status as { reason?: string }).reason), /no LH_DURABLE_LIBSQL_URL/);
		const on = resolveCapability("runtime", PROFILE_CHAINS.hosted.runtime, PROVIDERS, env({ LH_RUNTIME: "pi-durable", LH_DURABLE_LIBSQL_URL: "libsql://x.turso.io" }));
		assert.equal(on.active, "pi-durable-libsql");
	});
});
