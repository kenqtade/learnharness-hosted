// HOSTED FORK (2026-11): a plugin whose frontend import fails once (another
// serverless instance still activating it → 409) must still come up, because a
// browser caches the failed import for that URL.
import assert from "node:assert/strict";
import { it } from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import type { PluginInfo } from "../src/core/plugins.ts";

const info: PluginInfo = { id: "fixture", origin: "community", enabled: true, status: "active", revision: "r1", manifest: {
	apiVersion: 1, id: "fixture", name: "Fixture", version: "1.0.0", minAppVersion: "0.4.1", main: "main.js",
} };

it("retries a failed frontend import with a fresh URL, then activates", async () => {
	const urls: string[] = [];
	let activated = 0;
	const manager = new PluginFrontendManager({
		fetch: async () => Response.json({ plugins: [], directory: "/tmp/plugins" }), pathname: () => "/", navigate() {},
		importModule: async (url: string) => {
			urls.push(url);
			if (urls.length === 1) throw new TypeError(`Failed to fetch dynamically imported module: ${url}`);
			return { activate() { activated++; } };
		},
	});
	manager.reconcile([info]);
	for (let i = 0; i < 40 && !activated; i++) await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(activated, 1);
	assert.equal(urls.length, 2);
	assert.notEqual(urls[0], urls[1], "the retry must not reuse the URL the browser cached as failed");
	assert.equal(manager.getSnapshot().plugins[0]!.error, undefined);
	await manager.dispose();
});
