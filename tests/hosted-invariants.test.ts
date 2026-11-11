/** HOSTED-FORK INVARIANTS — an auto-update gate (scripts/vercel-build.sh runs
 * this on every merged upstream release, next to storage-seam.test.ts, and
 * ships the current code instead when it fails). Each check is a breakage the
 * manual merge of upstream v0.6.0 found that type-checking cannot see:
 *  1. a new API route outside withStore — unauthenticated in multi-user mode
 *     and reading outside the caller's data space / before Convex loads;
 *  2. a Host allowlist that 403s every API call on a public deployment;
 *  3. the plugin platform (server-side code execution) enabled on hosted. */
import "./helpers/isolated-data-dir.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { browserAPIRefusal } from "../src/server/desktop-access.ts";
import { pluginsAllowed } from "../src/server/plugins.ts";

const API = path.join(import.meta.dirname, "..", "app", "api");
/** Deliberately outside withStore: public, touches no stored data. */
const UNWRAPPED_OK = new Set(["version/route.ts"]);

function routes(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? routes(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []);
}

describe("hosted-fork invariants", () => {
	it("every API route runs inside withStore (auth gate + data space + Convex sync)", () => {
		const offenders = routes(API).map((f) => path.relative(API, f)).filter((rel) => !UNWRAPPED_OK.has(rel))
			.filter((rel) => {
				const src = fs.readFileSync(path.join(API, rel), "utf-8");
				const exported = [...src.matchAll(/^export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm)];
				return exported.length > 0 || !/withStore\(/.test(src);
			});
		assert.deepEqual(offenders, [], `API routes bypassing withStore: ${offenders.join(", ")}`);
	});
	it("a public deployment's own host name is never refused", () => {
		assert.equal(browserAPIRefusal(new Request("https://learnharness-gamma.vercel.app/api/chats"), { VERCEL: "1", LH_PROFILE: "hosted" }), undefined);
		assert.equal(browserAPIRefusal(new Request("https://learnharness-gamma.vercel.app/api/chat", { method: "POST" }), { VERCEL: "1", LH_PROFILE: "hosted" }), undefined);
	});
	it("the plugin platform stays off on hosted unless the operator opts in", () => {
		assert.equal(pluginsAllowed({ LH_PROFILE: "hosted" }), false);
	});
});
