import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
	type Api,
	type CacheRetention,
	type Model,
	type Models,
	type MutableModels,
	type OpenAICompletionsCompat,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { lazyApi, lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import type { ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { createClaudeCodeProvider } from "./claude-code/provider.ts";
import { streamClaudeCode } from "./claude-code/stream.ts";
import { nativeSubscriptionId, nativeSubscriptionModel } from "./subscription-bridge.ts";
import { nativeSubscriptionStream } from "./subscription-stream.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/archive/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The initially resolved (config-or-settings, CLAMPED) thinking level.
	 *  Custom streams re-resolve the original preference per operation. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

type Collection = ReturnType<typeof createModels>;
/** One pi-ai collection per credential scope (see configureModelsScope).
 *  Single-user installs only ever use "default". */
const collections = new Map<string, Collection>();
const MAX_COLLECTIONS = 200;
let scopeKey: () => string = () => "default";
/** How pi-ai reads a credential env var — injected by the server keys seam
 *  (the agent layer never imports stores). Default: the process env. */
let authEnv: (name: string) => string | undefined = (name) => process.env[name];

/** PLATFORM MODE seam: the server supplies the credential lookup, which
 *  reads the REQUESTING account's own keys (never a shared env). */
export function configureAuthEnv(fn: (name: string) => string | undefined, opts: { ambientAllowed?: () => boolean } = {}): void {
	authEnv = fn;
	ambientAllowed = opts.ambientAllowed ?? (() => true);
}
/** Machine-level credential files (AWS profile, gcloud ADC) belong to
 *  whoever runs the server; platform mode lets only the owner use them. */
let ambientAllowed: () => boolean = () => true;
/** PLATFORM MODE seam: which collection serves the current request. Each
 *  account gets its own collection, so per-account provider wiring (a
 *  custom endpoint and its key) can never leak into another account's
 *  request, even while both are in flight. */
export function configureModelsScope(fn: () => string): void {
	scopeKey = fn;
}
/** A credential env var as the CURRENT request should see it. */
export function credentialFor(name: string): string | undefined {
	const value = authEnv(name);
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
interface ProviderSource {
	sync(models: MutableModels): void;
	isCustom(id: string): boolean;
}
let providerSource: ProviderSource | undefined;

/** Configuration IO is injected by the server; the agent never imports stores. */
export function configureProviderSource(source: ProviderSource): void {
	// Server module re-evaluation can replace the source while this collection
	// survives. Retire only the previous source's routes, not built-ins.
	if (providerSource) {
		for (const collection of collections.values()) {
			for (const provider of collection.getProviders()) {
				if (providerSource.isCustom(provider.id)) collection.deleteProvider(provider.id);
			}
		}
	}
	providerSource = source;
}

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	const key = scopeKey();
	let collection = collections.get(key);
	if (!collection) {
		if (collections.size >= MAX_COLLECTIONS) collections.delete(collections.keys().next().value!);
		collection = createModels({
			identity: APP_IDENTITY,
			// Every credential lookup goes through the injected seam, read at
			// REQUEST time (inside the caller's account scope).
			authContext: { env: async (name) => credentialFor(name), fileExists: ambientFileExists },
		});
		collections.set(key, collection);
		for (const provider of builtinProviders()) {
			// Keep the native Bedrock implementation reachable by standalone tracing.
			// Pi's default Node-only loader hides this import from bundlers. Only
			// replace its lazy forwarding; preserve the native factory's auth/catalog.
			collection.setProvider(provider.id === "amazon-bedrock"
				? { ...provider, ...lazyApi(() => import("@earendil-works/pi-ai/api/bedrock-converse-stream")) }
				: provider);
		}
		collection.setProvider(createClaudeCodeProvider(streamClaudeCode));
	}
	providerSource?.sync(collection);
	return collection;
}

/** pi-ai's ambient-credential probe (AWS profile, gcloud ADC files) —
 *  same behavior as its default auth context. */
async function ambientFileExists(file: string): Promise<boolean> {
	if (!ambientAllowed()) return false;
	try {
		const { access } = await import("node:fs/promises");
		const { homedir } = await import("node:os");
		await access(file.startsWith("~") ? homedir() + file.slice(1) : file);
		return true;
	} catch {
		return false;
	}
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return credentialFor("OPENROUTER_API_KEY");
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** Serverless request limits (convex-store branch). A host that kills the
 *  function at a hard wall (Vercel: 300 s) must make a silent model FAIL
 *  before the wall, or the turn dies with no message saved at all. Opt-in
 *  via env so local/desktop keep pi-ai's defaults: LH_MODEL_TIMEOUT_MS
 *  (connect/idle timeout per attempt) and LH_MODEL_MAX_RETRIES. Explicit
 *  caller options still win (spread after). */
export function hostedRequestLimits(env: Record<string, string | undefined> = process.env): { timeoutMs?: number; maxRetries?: number } {
	const out: { timeoutMs?: number; maxRetries?: number } = {};
	const timeout = Number(env.LH_MODEL_TIMEOUT_MS);
	if (Number.isFinite(timeout) && timeout > 0) out.timeoutMs = timeout;
	const retries = env.LH_MODEL_MAX_RETRIES;
	if (retries !== undefined && retries !== "" && Number.isInteger(Number(retries)) && Number(retries) >= 0) out.maxRetries = Number(retries);
	// A walled host (Vercel) with a per-attempt timeout but no explicit retry
	// count: one retry, not the SDK's two. Three hung attempts at the timeout
	// (3 × 60 s) used most of a 270 s turn on a single stuck request; a turn
	// that still runs out continues in a fresh run (turn continuation).
	else if (env.VERCEL && out.timeoutMs !== undefined) out.maxRetries = 1;
	return out;
}

/** The optional knobs of piEngineForSpec — what the CALLER decides about
 *  the engine it builds. Default: nothing changes (the tutor's chat engine
 *  never sets any of them). */
export interface PiEngineOptions {
	/** JOB makers only (the background job path): keep a slow reasoning
	 *  provider inside the job's budget —
	 *   a) REASONING CONTROL: the engine's thinking level must reach the
	 *      request. NVIDIA's catalog ships supportsReasoningEffort: false and
	 *      no thinking format, so pi-ai drops the level (the slot's "medium")
	 *      before the request is built and the model reasons UNCAPPED;
	 *   b) a TOKEN CAP: maxTokens = min(model.maxTokens, JOB_MAX_TOKENS), so
	 *      a runaway reasoning phase cannot eat the whole job budget.
	 *  A caller's own maxTokens still wins. */
	jobLimits?: boolean;
}

/** The job path's response ceiling (2026-11): a maker's answer is a brief,
 *  an SVG or a demo — 32k tokens is generous. The model's own maximum
 *  (131k–384k on NVIDIA) is what let one reasoning phase run for minutes. */
const JOB_MAX_TOKENS = 32_000;

/** NVIDIA's catalog ships supportsReasoningEffort: false and no thinking
 *  format, so pi-ai sends NO reasoning control: the engine's thinking level
 *  is dropped before the request is built and the model reasons uncapped.
 *  A model copy that re-enables the effort lets pi-ai send the level as
 *  reasoning_effort (pi-ai maps the levels itself — openai-completions.js).
 *  Providers with their own thinking format (deepseek) keep it: pi-ai maps
 *  those levels through the format, not through reasoning_effort. */
function withReasoningEffort(model: Model<Api>): Model<Api> {
	if (model.provider !== "nvidia") return model;
	if (!model.reasoning) return model;
	// nvidia models speak the openai-completions dialect.
	const compat = model.compat as OpenAICompletionsCompat | undefined;
	if (compat?.thinkingFormat) return model;
	return { ...model, compat: { ...compat, supportsReasoningEffort: true } };
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle, cacheRetention?: () => CacheRetention | undefined, opts: PiEngineOptions = {}): PiEngine {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	const registeredModel = spec.provider === "chatgpt" ? chatGPTModel(spec.id) : nativeId ? nativeSubscriptionModel(spec.provider, spec.id) : models.getModel(spec.provider, spec.id);
	const custom = providerSource?.isCustom(spec.provider) ?? false;
	// Custom endpoint owners authorize image attempts independently of sparse
	// discovery metadata. Never promote the registered/catalog capabilities.
	const permitImages = (value: Model<Api>): Model<Api> => ({ ...value, input: ["text", "image"] });
	const registered = custom && registeredModel ? permitImages(registeredModel) : registeredModel;
	if (!registered) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	// The JOB path's model copy: the reasoning control (NVIDIA) rides the
	// model itself — the engine's level only reaches the request through it.
	const model = opts.jobLimits ? withReasoningEffort(registered) : registered;
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const thinkingPreference = spec.thinkingLevel;
	const level = thinkingPreference
		? clampThinkingLevel(model, thinkingPreference)
		: defaultThinkingLevel(model);
	// A lesson's agent loop can stay alive through many tool calls. Remember
	// only that this is a custom route, never its configuration for that run.
	return {
		model,
		level,
		// The agent loop forwards state.thinkingLevel as `reasoning` (undefined
		// = off on pi-ai's scale). Built-ins keep the factory clamp; custom
		// requests re-resolve thinking against their current metadata below.
		streamFn: (requestModel, context, options) => {
			// Read the slot preference for every operation, not just engine creation.
			// Unset adds NOTHING: native defaults/env and explicit caller options survive.
			const retention = cacheRetention?.();
			const requestOptions = {
				...hostedRequestLimits(),
				...options,
				// The job path's token cap — a caller's own maxTokens wins.
				...(opts.jobLimits ? { maxTokens: options?.maxTokens ?? Math.min(model.maxTokens, JOB_MAX_TOKENS) } : {}),
				...(retention !== undefined ? { cacheRetention: retention } : {}),
				reasoning: level === "off" ? undefined : level,
			};
			if (custom) {
				// Revalidate before EVERY upstream model operation, including later
				// tool-loop steps. Resolve thinking from the ORIGINAL preference (or
				// existing default order), not a previous metadata snapshot's clamp.
				// Pi retains the setup of an operation already in flight.
				const current = piModels();
				const currentModel = current.getModel(spec.provider, spec.id);
				if (!currentModel) return lazyStream(requestModel, async () => { throw new Error("The selected custom model is unavailable."); });
				const currentLevel = thinkingPreference
					? clampThinkingLevel(currentModel, thinkingPreference)
					: defaultThinkingLevel(currentModel);
				return current.streamSimple(withReasoningEffort(permitImages(currentModel)), context, { ...requestOptions, reasoning: currentLevel === "off" ? undefined : currentLevel });
			}
			const purpose = typeof background === "function" ? background : () => background;
			const stream = spec.provider === "chatgpt" ? chatGPTStream(purpose, lifecycle) : nativeId ? nativeSubscriptionStream(models.getProvider(nativeId)!, purpose, lifecycle) : models.streamSimple.bind(models);
			return stream(requestModel, context, requestOptions);
		},
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
