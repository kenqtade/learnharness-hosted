import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedRequestLimits } from "../src/agent/models.ts";

test("hosted request limits are opt-in: no env → pi-ai defaults untouched", () => {
	assert.deepEqual(hostedRequestLimits({}), {});
});

test("LH_MODEL_TIMEOUT_MS / LH_MODEL_MAX_RETRIES map to pi-ai timeoutMs / maxRetries", () => {
	assert.deepEqual(hostedRequestLimits({ LH_MODEL_TIMEOUT_MS: "120000", LH_MODEL_MAX_RETRIES: "1" }), { timeoutMs: 120000, maxRetries: 1 });
	assert.deepEqual(hostedRequestLimits({ LH_MODEL_MAX_RETRIES: "0" }), { maxRetries: 0 });
});

test("garbage values are ignored rather than passed through", () => {
	assert.deepEqual(hostedRequestLimits({ LH_MODEL_TIMEOUT_MS: "soon", LH_MODEL_MAX_RETRIES: "-1" }), {});
	assert.deepEqual(hostedRequestLimits({ LH_MODEL_TIMEOUT_MS: "0", LH_MODEL_MAX_RETRIES: "1.5" }), {});
	assert.deepEqual(hostedRequestLimits({ LH_MODEL_TIMEOUT_MS: "", LH_MODEL_MAX_RETRIES: "" }), {});
});
