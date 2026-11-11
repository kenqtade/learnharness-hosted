/** THE HOSTED PLUGIN GATE (merge of upstream v0.6.0). Plugins are trusted
 * local code — Coding Questions runs tests with the server's permissions —
 * so a hosted (multi-account, serverless) server keeps the platform off
 * unless the operator opts in. The storage-seam allowlist for the plugin
 * record stores depends on this. */
import "./helpers/isolated-data-dir.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { disabledPluginHost, PLUGINS_OFF_MESSAGE, pluginsAllowed } from "../src/server/plugins.ts";
import { createPluginTransport } from "../src/server/plugin-transport.ts";

describe("hosted plugin gate", () => {
	it("off on hosted, on locally, LH_PLUGINS overrides both ways", () => {
		assert.equal(pluginsAllowed({ LH_PROFILE: "hosted" }), false);
		assert.equal(pluginsAllowed({}), true);
		assert.equal(pluginsAllowed({ LH_PROFILE: "local" }), true);
		assert.equal(pluginsAllowed({ LH_PROFILE: "hosted", LH_PLUGINS: "1" }), true);
		assert.equal(pluginsAllowed({ LH_PLUGINS: "0" }), false);
	});
	it("the disabled host: an empty catalog, every action refused with 503 (unavailable)", async () => {
		const transport = createPluginTransport({ getHost: async () => disabledPluginHost, directory: "" });
		const list = await transport.list();
		assert.equal(list.status, 200);
		assert.deepEqual(await list.json(), { plugins: [], directory: "", conflicts: [] });
		const enable = await transport.setEnabled("coding-questions", new Request("http://x", { method: "PUT", body: JSON.stringify({ enabled: true }) }));
		assert.equal(enable.status, 503);
		assert.equal(((await enable.json()) as { error: string }).error, PLUGINS_OFF_MESSAGE);
		const call = await transport.call("coding-questions", new Request("http://x", { method: "POST", body: JSON.stringify({ operation: "run-tests", input: {} }) }));
		assert.equal(call.status, 503);
	});
});
