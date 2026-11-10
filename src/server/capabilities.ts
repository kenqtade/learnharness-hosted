/**
 * Server-side composition for the capability switchboard (portability wave,
 * 2026-11-03).
 *
 * The ONLY place that turns environment presence into a report. It reads
 * env vars by NAME (never prints values), stats candidate binaries, and
 * asks the store which endpoints are configured. Adapters are NOT built
 * here yet — this wave's job is to tell the truth about what is live.
 */

import { existsSync } from "node:fs";
import { PATHS } from "../../config.ts";
import { CAPABILITY_KINDS, type CapabilityReport, type ResolverEnvironment } from "../core/capabilities/types.ts";
import {
	LLM_KEY_PROVIDERS,
	PROVIDERS,
	PROFILE_CHAINS,
	gatedLlmDeclaration,
	llmChain,
	type ProfileName,
} from "../core/capabilities/providers.ts";
import type { CapabilityKind, CapabilityState } from "../core/capabilities/types.ts";
import { resolveCapability } from "../core/capabilities/resolve.ts";
import { initAuthEnv, providerKeyPresent } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** Candidate Chrome locations the headless sub-agent already knows about. */
const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

function chromePresent(): boolean {
	return CHROME_CANDIDATES.some((candidate) => candidate !== undefined && existsSync(candidate));
}

/** Which deployment profile this process believes it is (ordering only). */
export function activeProfile(): ProfileName {
	const raw = process.env.LH_PROFILE?.trim();
	return raw === "hosted" ? "hosted" : "local";
}

/** The provider of the model the user picked for teaching (strong slot). */
function pickedModelProvider(): string | null {
	return effectiveSettings().models.strong?.provider ?? null;
}

/**
 * Presence-only picture of the environment. `endpointsUp` is filled from
 * settings later (searxng URL, ollama URL); today it stays empty so those
 * providers report "endpoint not configured" honestly.
 */
function resolverEnvironment(picked: string | null): ResolverEnvironment {
	// Keys saved in Settings live in auth.json; initAuthEnv() mirrors them
	// into process.env (honouring LH_IGNORE_ENV_KEYS and real-env shadowing),
	// so a key added mid-session shows up here without a restart.
	initAuthEnv();
	const candidates = new Set([...Object.keys(LLM_KEY_PROVIDERS), ...(picked ? [picked] : [])]);
	return {
		env: process.env as Record<string, string | undefined>,
		binaries: chromePresent() ? ["chrome"] : [],
		endpointsUp: [],
		secureContext: process.env.LH_SECURE_CONTEXT === "1",
		// Ask the app's own admission gate — never re-derive its rules.
		gatesPassed: [...candidates].filter((id) => providerKeyPresent(id)),
	};
}

function resolveOne(kind: CapabilityKind, profile: ProfileName, env: ResolverEnvironment, picked: string | null): CapabilityState {
	if (kind !== "llm") return resolveCapability(kind, PROFILE_CHAINS[profile][kind], PROVIDERS, env);

	const declarations = picked ? { ...PROVIDERS, [picked]: gatedLlmDeclaration(picked) } : PROVIDERS;
	const state = resolveCapability("llm", { chain: llmChain(profile, picked) }, declarations, env);
	if (picked) {
		if (!state.status.available) {
			state.status = { available: false, reason: `picked model's provider (${picked}) is not connected` };
		}
		return state;
	}
	// Keys exist but no model is picked: a turn would be refused (503
	// models_not_configured), so the capability is NOT live — say why.
	if (state.active) {
		const label = declarations[state.active]?.label ?? state.active;
		return {
			...state,
			active: null,
			fallbackUsed: false,
			status: { available: false, reason: `${label} key present — pick a model in Settings` },
		};
	}
	return state;
}

/** The whole switchboard, for GET /api/capabilities. */
export function capabilityReport(): CapabilityReport {
	const profile = activeProfile();
	const picked = pickedModelProvider();
	const env = resolverEnvironment(picked);
	return { profile, states: CAPABILITY_KINDS.map((kind) => resolveOne(kind, profile, env, picked)) };
}

/** One capability's resolved state — the seam adapters will consume. */
export function capability(kind: CapabilityKind): CapabilityState {
	const picked = pickedModelProvider();
	return resolveOne(kind, activeProfile(), resolverEnvironment(picked), picked);
}

/** Where the data directory lives — surfaced so Settings can show it. */
export const dataDirectory = PATHS.data;
