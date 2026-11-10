import "./helpers/isolated-data-dir.ts";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseVersion,
	compareVersions,
	runningVersion,
	fetchLatestRelease,
	readUpdateStatus,
	runUpdateCheck,
	triggerRedeploy,
	secretMatches,
	cronSecretMatches,
} from "../src/server/upstream-update.ts";

const originalEnv = { ...process.env };

describe("parseVersion", () => {
	it("accepts v-prefixed versions", () => {
		assert.deepEqual(parseVersion("v0.5.0"), [0, 5, 0]);
		assert.deepEqual(parseVersion("v1.0.0"), [1, 0, 0]);
		assert.deepEqual(parseVersion("v10.20.30"), [10, 20, 30]);
	});

	it("accepts version without v prefix", () => {
		assert.deepEqual(parseVersion("0.5.0"), [0, 5, 0]);
		assert.deepEqual(parseVersion("1.0.0"), [1, 0, 0]);
	});

	it("rejects invalid versions", () => {
		assert.equal(parseVersion("invalid"), null);
		assert.equal(parseVersion("v0.5"), null);
		assert.equal(parseVersion("v0.5.0.0"), null);
		assert.equal(parseVersion(""), null);
	});
});

describe("compareVersions", () => {
	it("returns 0 for equal versions", () => {
		assert.equal(compareVersions("0.5.0", "0.5.0"), 0);
		assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
	});

	it("returns -1 when first is older", () => {
		assert.equal(compareVersions("0.4.0", "0.5.0"), -1);
		assert.equal(compareVersions("v1.0.0", "v2.0.0"), -1);
	});

	it("returns 1 when first is newer", () => {
		assert.equal(compareVersions("0.5.0", "0.4.0"), 1);
		assert.equal(compareVersions("v2.0.0", "v1.0.0"), 1);
	});
});

describe("secretMatches", () => {
	it("returns true for equal strings", () => {
		assert.equal(secretMatches("test123", "test123"), true);
	});

	it("returns false for different strings", () => {
		assert.equal(secretMatches("test123", "test456"), false);
	});

	it("returns false for null/undefined", () => {
		assert.equal(secretMatches(null, "test123"), false);
		assert.equal(secretMatches(undefined, "test123"), false);
	});
});

describe("cronSecretMatches", () => {
	it("delegates to secretMatches", () => {
		assert.equal(cronSecretMatches("test123", "test123"), true);
		assert.equal(cronSecretMatches("test", "test123"), false);
	});
});

describe("fetchLatestRelease", () => {
	it("uses correct headers including Accept and User-Agent", async () => {
		let capturedHeaders: Record<string, string> = {};
		const mockFetch = async (url: string, init: RequestInit) => {
			capturedHeaders = init.headers as Record<string, string>;
			return new Response(JSON.stringify({
				tag_name: "v0.5.0",
				published_at: "2024-01-01T00:00:00.000Z",
				html_url: "https://github.com/test/test/releases/tag/v0.5.0",
			}), { status: 200 });
		};
		
		await fetchLatestRelease({
			fetch: mockFetch as typeof fetch,
			env: { LH_UPSTREAM_REPO: "test/test" },
		});
		
		assert.equal(capturedHeaders.Accept, "application/vnd.github+json");
		assert.equal(capturedHeaders["User-Agent"], "learnharness-updater");
	});

	it("throws on non-200 status", async () => {
		const mockFetch = async () => new Response(null, { status: 404 });
		let threw = false;
		try {
			await fetchLatestRelease({ fetch: mockFetch as typeof fetch });
		} catch (e) {
			threw = true;
			assert.ok((e as Error).message.includes("GitHub release lookup failed"));
		}
		assert.ok(threw, "Should have thrown");
	});

	it("throws on draft release", async () => {
		const mockFetch = async () => new Response(JSON.stringify({
			tag_name: "v0.5.0",
			draft: true,
		}), { status: 200 });
		let threw = false;
		try {
			await fetchLatestRelease({ fetch: mockFetch as typeof fetch });
		} catch (e) {
			threw = true;
			assert.ok((e as Error).message.includes("is a draft"));
		}
		assert.ok(threw, "Should have thrown");
	});

	it("throws on prerelease", async () => {
		const mockFetch = async () => new Response(JSON.stringify({
			tag_name: "v0.5.0",
			prerelease: true,
		}), { status: 200 });
		let threw = false;
		try {
			await fetchLatestRelease({ fetch: mockFetch as typeof fetch });
		} catch (e) {
			threw = true;
			assert.ok((e as Error).message.includes("is a prerelease"));
		}
		assert.ok(threw, "Should have thrown");
	});

	it("throws on invalid tag", async () => {
		const mockFetch = async () => new Response(JSON.stringify({
			tag_name: "invalid",
		}), { status: 200 });
		let threw = false;
		try {
			await fetchLatestRelease({ fetch: mockFetch as typeof fetch });
		} catch (e) {
			threw = true;
			assert.ok((e as Error).message.includes("not a valid version"));
		}
		assert.ok(threw, "Should have thrown");
	});

	it("includes Authorization header when GITHUB_TOKEN set", async () => {
		let capturedHeaders: Record<string, string> = {};
		const mockFetch = async (url: string, init: RequestInit) => {
			capturedHeaders = init.headers as Record<string, string>;
			return new Response(JSON.stringify({
				tag_name: "v0.5.0",
			}), { status: 200 });
		};
		
		await fetchLatestRelease({
			fetch: mockFetch as typeof fetch,
			env: { GITHUB_TOKEN: "secret-token" },
		});
		
		assert.equal(capturedHeaders.Authorization, "Bearer secret-token");
	});
});

describe("runUpdateCheck integration tests", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-update-test-"));
		process.env.LH_DATA_DIR = tmpDir;
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		process.env.LH_DATA_DIR = originalEnv.LH_DATA_DIR;
		process.env.LH_AUTO_UPDATE = originalEnv.LH_AUTO_UPDATE;
	});

	describe("Item 1: 24h guard uses injected now()", () => {
		it("uses the injected now() function for 24h guard calculation", async () => {
			process.env.LH_AUTO_UPDATE = "1";
			const now = () => 1_000_000_000_000;
			
			// Mock fetch to return an older version (0.0.1 < 0.4.1)
			const mockFetch = async () => new Response(JSON.stringify({
				tag_name: "v0.0.1",
				published_at: "2024-01-01T00:00:00.000Z",
				html_url: "https://github.com/test/test/releases/tag/v0.0.1",
			}), { status: 200 });
			
			const result1 = await runUpdateCheck({ 
				now, 
				fetch: mockFetch as typeof fetch,
				env: { ...process.env, LH_AUTO_UPDATE: "1" } 
			});
			assert.equal(result1.state, "up-to-date");
			assert.ok(result1.checkedAt);
		});
	});

	describe("Item 2: up-to-date message", () => {
		it("sets correct message when up-to-date", async () => {
			process.env.LH_AUTO_UPDATE = "1";
			// Mock fetch to return an older version (0.0.1 < 0.4.1)
			const mockFetch = async () => new Response(JSON.stringify({
				tag_name: "v0.0.1",
				published_at: "2024-01-01T00:00:00.000Z",
				html_url: "https://github.com/test/test/releases/tag/v0.0.1",
			}), { status: 200 });
			
			const result = await runUpdateCheck({
				now: () => 1_000_000_000_000,
				fetch: mockFetch as typeof fetch,
				env: { ...process.env, LH_AUTO_UPDATE: "1" },
			});
			assert.equal(result.state, "up-to-date");
			assert.ok(result.message?.startsWith("Up to date (latest upstream release:"));
		});
	});

	describe("Item 3: checkedAt set on fetch error", () => {
		it("sets checkedAt even when fetchLatestRelease fails", async () => {
			process.env.LH_AUTO_UPDATE = "1";
			const mockFetch = async () => {
				throw new Error("Network error");
			};
			
			const result = await runUpdateCheck({
				now: () => 1_000_000_000_000,
				fetch: mockFetch as typeof fetch,
				env: { ...process.env, LH_AUTO_UPDATE: "1" },
			});
			assert.equal(result.state, "error");
			assert.ok(result.checkedAt, "checkedAt should be set on error");
		});
	});

	describe("Item 5: readUpdateStatus returns disabled when env unset", () => {
		it("returns disabled state when LH_AUTO_UPDATE is unset, ignoring stored state", async () => {
			// First, write a "up-to-date" state manually
			const statusFile = path.join(tmpDir, "update-status.json");
			fs.mkdirSync(path.dirname(statusFile), { recursive: true });
			fs.writeFileSync(statusFile, JSON.stringify({
				enabled: true,
				current: "0.0.1",
				state: "up-to-date",
				message: "Up to date (latest upstream release: 0.0.1).",
			}, null, "\t"));
			
			// Now readUpdateStatus should return disabled regardless
			const result = readUpdateStatus({ env: {} });
			assert.equal(result.state, "disabled", "state should be disabled");
			assert.equal(result.message, "Auto-update is off (set LH_AUTO_UPDATE=1)", "message should be disabled message");
			assert.equal(result.enabled, false, "enabled should be false");
		});
	});
});

describe("triggerRedeploy non-JSON error handling", () => {
	it("handles non-JSON error body gracefully", async () => {
		const mockFetch = async () => {
			return new Response("Plain text error", { status: 500 });
		};
		
		let threw = false;
		try {
			await triggerRedeploy({
				env: { VERCEL_DEPLOYMENT_ID: "test-id", LH_VERCEL_TOKEN: "test-token" },
				fetch: mockFetch as typeof fetch,
			});
		} catch (e) {
			threw = true;
			// The error message should not be a JSON parse error
			assert.equal((e as Error).message, "Vercel deploy failed (500)");
		}
		assert.ok(threw, "Should have thrown for non-200 status");
	});

	it("throws clear message on missing token", async () => {
		let threw = false;
		try {
			await triggerRedeploy({ env: { VERCEL_DEPLOYMENT_ID: "test-id" } });
		} catch (e) {
			threw = true;
			assert.ok((e as Error).message.includes("LH_VERCEL_TOKEN is not set"));
		}
		assert.ok(threw, "Should have thrown for missing token");
	});
});