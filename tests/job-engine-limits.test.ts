/**
 * Job-engine limits (2026-11): the background MAKERS' engines carry
 * reasoning control and a token cap, so a slow reasoning provider (NVIDIA)
 * cannot spend the whole job budget reasoning.
 *
 * NVIDIA's catalog ships compat.supportsReasoningEffort: false and no
 * thinking format: pi-ai drops the engine's thinking level before the
 * request is built, so the slot's "medium" never arrives and the model
 * reasons uncapped (max_tokens = the model's own maximum, 131k–384k). The
 * job path's engines (chat-handler → resolveJobEngine) opt into the limits.
 *
 * Offline: the request body is captured at the provider boundary
 * (onPayload) — no network, no real credentials.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";

// Isolation first: no ambient credentials, no network, a private data dir.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-engine-limits-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = {
	PATH: originalEnv.PATH,
	HOME: directory,
	NODE_ENV: "test",
	NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT,
	LH_DATA_DIR: directory,
	LH_AUTH_FILE: path.join(directory, "auth.json"),
	NVIDIA_API_KEY: "fixture",
	OPENROUTER_API_KEY: "fixture",
};
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
const { piEngineForSpec } = await import("../src/agent/models.ts");
after(() => {
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(directory, { recursive: true, force: true });
});

const context = normalizeContext({ systemPrompt: "Stable instructions", messages: [{ role: "user", content: "offline", timestamp: 1 }] });

/** The request body the engine WOULD send (captured before the fetch). */
async function payload(engine: ReturnType<typeof piEngineForSpec>, options: SimpleStreamOptions = {}): Promise<Record<string, unknown>> {
	let captured: unknown;
	const result = await engine.streamFn(engine.model, context, {
		...options,
		onPayload: (value) => { captured = value; throw new Error("CLOSED: captured payload"); },
	}).result();
	assert.ok(captured, result.errorMessage);
	return captured as Record<string, unknown>;
}

const NVIDIA_REASONING = { provider: "nvidia", id: "z-ai/glm-5.3-flash" } as const;

describe("job engines: reasoning control + token cap", () => {
	it("without the flag the nvidia request is unchanged — no reasoning_effort, the model's own maximum", async () => {
		const engine = piEngineForSpec({ ...NVIDIA_REASONING, thinkingLevel: "medium" });
		const body = await payload(engine);
		assert.equal(body.reasoning_effort, undefined, "NVIDIA drops the level before the request is built");
		assert.equal(body.max_tokens, 131_072, "the model reasons against its own maximum");
	});

	it("with jobLimits the nvidia request carries reasoning_effort and a capped max_tokens", async () => {
		const engine = piEngineForSpec({ ...NVIDIA_REASONING, thinkingLevel: "medium" }, true, undefined, undefined, { jobLimits: true });
		const body = await payload(engine);
		assert.equal(body.reasoning_effort, "medium", "the engine's level reaches the request");
		assert.equal(body.max_tokens, 32_000, "the response is capped inside the job budget");
	});

	it("a model with its own thinking format keeps it — the patch never overrides pi-ai's mapping", async () => {
		// NVIDIA's deepseek ships thinkingFormat "deepseek" (low/medium map to
		// null): pi-ai maps the levels through the format, so the job path
		// leaves the request alone — only the token cap applies.
		const engine = piEngineForSpec({ provider: "nvidia", id: "deepseek-ai/deepseek-v4.1-flash", thinkingLevel: "medium" }, true, undefined, undefined, { jobLimits: true });
		const body = await payload(engine);
		assert.equal(body.reasoning_effort, undefined, "the format's own mapping is untouched");
		assert.deepEqual(body.thinking, { type: "enabled" }, "pi-ai's deepseek handling still applies");
		assert.equal(body.max_tokens, 32_000, "the token cap still holds");
	});

	it("a caller's own maxTokens still wins over the job cap", async () => {
		const engine = piEngineForSpec({ ...NVIDIA_REASONING, thinkingLevel: "low" }, true, undefined, undefined, { jobLimits: true });
		const body = await payload(engine, { maxTokens: 4096 });
		assert.equal(body.max_tokens, 4096);
		assert.equal(body.reasoning_effort, "low");
	});

	it("other providers keep their own reasoning handling but still get the token cap", async () => {
		const engine = piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "high" }, true, undefined, undefined, { jobLimits: true });
		const body = await payload(engine);
		assert.deepEqual(body.reasoning, { effort: "high" }, "openrouter keeps its own reasoning format");
		assert.equal(body.max_completion_tokens, 32_000, "openrouter's own max-token field carries the cap");
	});

	it("a non-reasoning nvidia model is not patched and keeps its own maximum", async () => {
		const engine = piEngineForSpec({ provider: "nvidia", id: "meta/llama-3.2-11b-vision-instruct" }, true, undefined, undefined, { jobLimits: true });
		const body = await payload(engine);
		assert.equal(body.reasoning_effort, undefined, "nothing to control on a non-reasoning model");
		assert.equal(body.max_tokens, 4096, "the model's own maximum is below the cap");
	});
});
