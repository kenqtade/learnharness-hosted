/**
 * The provider catalog (portability wave, 2026-11-03).
 *
 * Every provider the app can use, and what it needs. This is DECLARATION
 * only — no adapters are constructed here, because the resolver must stay
 * pure (a status check must never open a socket or read a credential).
 *
 * Present-day providers (the ones the repo already talks to) come first;
 * the local/key-free ones that make a laptop deployment possible are marked
 * as such and land with their adapters in a later step.
 */

import { AUTH_PROVIDER_KEYS } from "../auth-keys.ts";
import type { CapabilityChainEntry, CapabilityConfig, CapabilityKind, ProviderDeclaration } from "./types.ts";

export const PROVIDERS: Record<string, ProviderDeclaration> = {
	// ── llm ────────────────────────────────────────────────────────────────
	// The ~35 plain-key providers are GENERATED from core/auth-keys.ts below
	// (LLM_KEY_PROVIDERS) so this catalog can never drift from what pi-ai
	// actually reads — the first version hand-listed three and reported
	// "no model" while the user's NVIDIA key was live.
	// Local, keyless — the custom OpenAI-compatible provider already supports
	// this shape ("Keyless local servers work via a placeholder key resolved
	// at request time", src/server/custom-provider.ts).
	ollama: {
		id: "ollama",
		kind: "llm",
		label: "Ollama (local)",
		delivery: "local",
		requires: { endpoint: true },
		implementation: "src/server/custom-provider.ts",
	},

	// ── search ─────────────────────────────────────────────────────────────
	tavily: {
		id: "tavily",
		kind: "search",
		label: "Tavily",
		delivery: "hosted",
		requires: { env: ["TAVILY_API_KEY"] },
		implementation: "src/server/search.ts",
	},
	brave: {
		id: "brave",
		kind: "search",
		label: "Brave Search",
		delivery: "hosted",
		requires: { env: ["BRAVE_API_KEY"] },
		implementation: "src/server/search.ts",
	},
	searxng: {
		id: "searxng",
		kind: "search",
		label: "SearXNG (self-hosted)",
		delivery: "local",
		requires: { endpoint: true },
		implementation: "adapter pending (step 4)",
		pending: true,
	},

	// ── reader ─────────────────────────────────────────────────────────────
	"raw-fetch": {
		id: "raw-fetch",
		kind: "reader",
		label: "Direct fetch",
		delivery: "local",
		implementation: "src/agent/tools/web.ts",
	},
	jina: {
		id: "jina",
		kind: "reader",
		label: "Jina Reader",
		delivery: "hosted",
		implementation: "src/agent/tools/web.ts (fetchViaJina)",
	},

	// ── browser ────────────────────────────────────────────────────────────
	"local-chrome": {
		id: "local-chrome",
		kind: "browser",
		label: "Local Chrome",
		delivery: "local",
		requires: { binary: "chrome" },
		implementation: "src/agent/subagents/headless.ts",
	},
	browserless: {
		id: "browserless",
		kind: "browser",
		label: "Browserless",
		delivery: "hosted",
		requires: { env: ["BROWSERLESS_TOKEN"] },
		implementation: "adapter pending (step 7)",
		pending: true,
	},

	// ── stt ────────────────────────────────────────────────────────────────
	deepgram: {
		id: "deepgram",
		kind: "stt",
		label: "Deepgram",
		delivery: "hosted",
		requires: { env: ["DEEPGRAM_API_KEY"] },
		implementation: "app/api/stt/token + components/dictation.tsx",
	},
	webspeech: {
		id: "webspeech",
		kind: "stt",
		label: "Browser speech (free)",
		delivery: "browser",
		requires: { secureContext: true },
		implementation: "adapter pending (step 4)",
		pending: true,
	},

	// ── store ──────────────────────────────────────────────────────────────
	fs: {
		id: "fs",
		kind: "store",
		label: "Filesystem (data/)",
		delivery: "local",
		implementation: "src/store/*",
	},
	// convex-store branch: the same stores, persisted in Convex through the
	// fs seam (src/store/vfs.ts) — nothing on the local disk. Hosted, but
	// the local app can use it too (same protocol, same deployment).
	convex: {
		id: "convex",
		kind: "store",
		label: "Convex",
		delivery: "hosted",
		requires: { switch: { name: "LH_STORE", value: "convex" }, env: ["CONVEX_URL", "LH_CONVEX_SECRET"] },
		implementation: "src/store/vfs.ts + convex/vfs.ts",
	},
	postgres: {
		id: "postgres",
		kind: "store",
		label: "Postgres",
		delivery: "hosted",
		requires: { env: ["DATABASE_URL"] },
		implementation: "adapter pending (step 5)",
		pending: true,
	},

	// ── runtime ────────────────────────────────────────────────────────────
	// pi-durable (durable-pi branch): the turn loop runs in pi-durable's
	// Harness; every model answer and tool result is committed before it is
	// shown, so a crashed process resumes the turn. Same code both homes —
	// only the SQLite underneath differs.
	"pi-durable": {
		id: "pi-durable",
		kind: "runtime",
		label: "pi-durable (local SQLite)",
		delivery: "local",
		requires: { switch: { name: "LH_RUNTIME", value: "pi-durable" } },
		implementation: "src/server/durable/",
	},
	// Serverless hosts have no persistent disk: hosted needs libSQL (Turso).
	"pi-durable-libsql": {
		id: "pi-durable-libsql",
		kind: "runtime",
		label: "pi-durable (libSQL / Turso)",
		delivery: "hosted",
		requires: { switch: { name: "LH_RUNTIME", value: "pi-durable" }, env: ["LH_DURABLE_LIBSQL_URL"] },
		implementation: "src/server/durable/libsql.ts",
	},
	"in-process": {
		id: "in-process",
		kind: "runtime",
		label: "In-process runner",
		delivery: "local",
		implementation: "src/server/chat-handler.ts",
	},
	restate: {
		id: "restate",
		kind: "runtime",
		label: "Restate (durable)",
		delivery: "hosted",
		requires: { endpoint: true },
		implementation: "adapter pending",
		pending: true,
	},
	inngest: {
		id: "inngest",
		kind: "runtime",
		label: "Inngest (durable)",
		delivery: "hosted",
		requires: { env: ["INNGEST_EVENT_KEY"] },
		implementation: "adapter pending",
		pending: true,
	},
};

/** One declaration per BYOK model provider, straight from auth-keys.ts. */
export const LLM_KEY_PROVIDERS: Record<string, ProviderDeclaration> = Object.fromEntries(
	AUTH_PROVIDER_KEYS.map((info) => [
		info.id,
		{
			id: info.id,
			kind: "llm" as const,
			label: info.label,
			delivery: "hosted" as const,
			requires: { appGate: true },
			implementation: `pi-ai (${info.envVar})`,
		},
	]),
);
Object.assign(PROVIDERS, LLM_KEY_PROVIDERS);

/**
 * A declaration for a picked provider the catalog doesn't know by name
 * (subscriptions like chatgpt/github-copilot, claude-code, the custom
 * endpoint). The app's own gate decides; we only label it.
 */
export function gatedLlmDeclaration(id: string): ProviderDeclaration {
	return PROVIDERS[id] ?? {
		id,
		kind: "llm",
		label: id,
		delivery: "subscription",
		requires: { appGate: true },
		implementation: "server/keys.ts providerKeyPresent",
	};
}

/**
 * The llm chain, which differs from every other capability on purpose:
 * a turn runs the model the USER PICKED, never a substitute. So when a model
 * is picked the chain is exactly that provider; when none is, the chain is
 * every provider (local first when the profile is local) so the report can
 * say "you have a NVIDIA key — pick a model" instead of "nothing".
 */
export function llmChain(profile: ProfileName, picked: string | null): CapabilityChainEntry[] {
	if (picked) return [{ provider: picked }];
	const ordered = [
		...PROFILE_CHAINS[profile].llm.chain.map((entry) => entry.provider),
		...Object.keys(LLM_KEY_PROVIDERS),
	];
	return [...new Set(ordered)].map((provider) => ({ provider }));
}

/** All declarations for one capability kind. */
export function declarationsFor(kind: ProviderDeclaration["kind"]): ProviderDeclaration[] {
	return Object.values(PROVIDERS).filter((p) => p.kind === kind);
}

/**
 * The two deployment profiles, as data. These are STARTING POINTS recorded
 * in settings; the chain is editable, and the resolver never reads a profile
 * name — only the chain it produced.
 */
export type ProfileName = "local" | "hosted";

/** A profile names a chain for EVERY capability — no silent gaps. */
export type ProfileChains = Record<CapabilityKind, CapabilityConfig>;

export const PROFILE_CHAINS: Record<ProfileName, ProfileChains> = {
	local: {
		store: { chain: [{ provider: "convex" }, { provider: "fs" }] },
		runtime: { chain: [{ provider: "pi-durable" }, { provider: "in-process" }] },
		search: { chain: [{ provider: "searxng" }, { provider: "tavily" }, { provider: "brave" }] },
		reader: { chain: [{ provider: "raw-fetch" }, { provider: "jina" }] },
		stt: { chain: [{ provider: "webspeech" }, { provider: "deepgram" }] },
		browser: { chain: [{ provider: "local-chrome" }] },
		llm: {
			chain: [
				{ provider: "ollama", config: { baseUrl: "http://localhost:11434/v1" } },
				{ provider: "openrouter" },
				{ provider: "anthropic" },
			],
		},
	},
	hosted: {
		store: { chain: [{ provider: "convex" }, { provider: "postgres" }] },
		runtime: { chain: [{ provider: "pi-durable-libsql" }, { provider: "restate" }, { provider: "in-process" }] },
		search: { chain: [{ provider: "tavily" }, { provider: "brave" }] },
		reader: { chain: [{ provider: "jina" }, { provider: "raw-fetch" }] },
		stt: { chain: [{ provider: "deepgram" }] },
		browser: { chain: [{ provider: "browserless" }] },
		llm: { chain: [{ provider: "openrouter" }, { provider: "anthropic" }, { provider: "openai" }] },
	},
};
