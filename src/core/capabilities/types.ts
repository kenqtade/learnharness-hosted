/**
 * THE CAPABILITY SWITCHBOARD — types (portability wave, 2026-11-03).
 *
 * Every external thing this app depends on (a model, a search engine, a
 * page reader, a browser, speech-to-text, the store, the turn runtime) is
 * an *ordered chain of providers*, not a hardcoded choice. The rules are
 * lifted verbatim from src/core/search.ts, which already did this for
 * search and stated them first:
 *
 *  - NO factory default: a capability is live only because a provider in
 *    its chain resolved.
 *  - NOTHING silently falls back: a fallback that fires is reported
 *    (`fallbackUsed`), never hidden.
 *  - When the chain is empty, the feature reports itself HONESTLY
 *    unavailable and the tool layer says so.
 *
 * Pure types + one pure resolver: no React, no IO, no imports. That is what
 * lets the same commit run on a laptop (searxng, webspeech, local chrome)
 * and on Netlify (tavily, deepgram, hosted browser) with only config
 * differing. See learnharness-capabilities.md and
 * learnharness-portability-plan.md.
 */

/** Every external dependency class the app has. */
export type CapabilityKind =
	/** teaching, practice, extraction, sub-agents */
	| "llm"
	/** web research */
	| "search"
	/** fetch + extract one page */
	| "reader"
	/** JS-rendered pages, demos, screenshots */
	| "browser"
	/** dictation */
	| "stt"
	/** chats, graph, settings */
	| "store"
	/** where a turn executes */
	| "runtime";

export const CAPABILITY_KINDS: readonly CapabilityKind[] = [
	"llm",
	"search",
	"reader",
	"browser",
	"stt",
	"store",
	"runtime",
] as const;

/** How a provider is delivered — purely descriptive (UI labels, docs). */
export type ProviderKind = "hosted" | "local" | "browser" | "subscription";

/**
 * What a provider needs before it can be live. An empty/absent
 * `requires` means "live iff it is first in the chain".
 */
export interface ProviderRequirements {
	/** Environment variables that must be present and non-empty. */
	env?: string[];
	/** Needs a user-supplied endpoint (base URL) to be configured. */
	endpoint?: boolean;
	/** Needs an executable on the machine (`chrome`, `claude`, …). */
	binary?: string;
	/** Needs a secure context (https or localhost) — e.g. Web Speech. */
	secureContext?: boolean;
	/**
	 * The app's OWN admission check decides (server/keys.ts
	 * providerKeyPresent: subscriptions, Claude Code, custom endpoint, BYOK
	 * keys). The switchboard never re-derives those rules — it asks.
	 */
	appGate?: boolean;
	/** An explicit opt-in switch: env `name` must equal `value` (e.g.
	 *  LH_RUNTIME=pi-durable). Presence alone is not enough. */
	switch?: { name: string; value: string };
}

/** One provider's declaration: what it is and what it needs. */
export interface ProviderDeclaration {
	/** Stable id, e.g. "tavily" | "searxng" | "webspeech". */
	id: string;
	kind: CapabilityKind;
	label: string;
	/** How it is delivered (descriptive). */
	delivery: ProviderKind;
	requires?: ProviderRequirements;
	/** Where the adapter lives, for the Settings "why" line. */
	implementation?: string;
	/**
	 * True while the adapter is declared but not built. A pending provider is
	 * NEVER reported live, even when its key is present — claiming "ready"
	 * for code that does not exist would be exactly the silent lie the
	 * switchboard forbids.
	 */
	pending?: boolean;
}

/** One entry in a capability's ordered chain. */
export interface CapabilityChainEntry {
	provider: string;
	/** Non-secret, provider-specific configuration (URL, model id, …). */
	config?: Record<string, unknown>;
}

/**
 * A capability's configuration: the ordered chain. First live provider
 * wins; the rest are explicit, reported fallbacks.
 */
export interface CapabilityConfig {
	chain: CapabilityChainEntry[];
	/**
	 * Advisory only — it never overrides the chain order. Present so the UI
	 * can explain intent ("prefer things on this machine").
	 */
	mode?: "hosted-first" | "local-first" | "cheapest";
}

/** Per-capability configuration for a deployment profile. */
export type CapabilityConfigs = Partial<Record<CapabilityKind, CapabilityConfig>>;

/** The outcome of probing one provider. */
export interface ProviderStatus {
	available: boolean;
	/** One line, human-readable and safe to show in Settings. */
	reason: string;
	/** Optional extra (latency, model count, version). */
	detail?: string;
}

/** A provider that was tried, and what happened. */
export interface CheckedProvider {
	provider: string;
	status: ProviderStatus;
}

/** The resolved state of one capability. */
export interface CapabilityState {
	kind: CapabilityKind;
	/** The provider the app will actually use, or null when unavailable. */
	active: string | null;
	/** The headline status (active provider's, or the failure reason). */
	status: ProviderStatus;
	/** Every provider tried, in chain order — the "why" for the UI. */
	checked: CheckedProvider[];
	/** True when anything other than the first chain entry resolved. */
	fallbackUsed: boolean;
}

/**
 * What the resolver is allowed to look at. Deliberately dumb data so the
 * resolver stays pure and unit-testable: presence flags only, never secrets.
 */
export interface ResolverEnvironment {
	/** Env var name → value-or-undefined (values are never printed). */
	env: Record<string, string | undefined>;
	/** Binaries known to exist on this host (e.g. `chrome`). */
	binaries?: readonly string[];
	/** Provider ids whose endpoint is configured and reachable. */
	endpointsUp?: readonly string[];
	/** True when the page is served over https or from localhost. */
	secureContext?: boolean;
	/** Provider ids whose app admission gate currently passes. */
	gatesPassed?: readonly string[];
}

/** The whole switchboard's view, for `GET /api/capabilities`. */
export interface CapabilityReport {
	profile: string;
	states: CapabilityState[];
}
