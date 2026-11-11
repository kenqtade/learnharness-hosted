/** THE STORAGE SEAM GUARD (hosted fork). Every persisted byte must go
 * through src/store/vfs.ts: on Vercel that seam is Convex, and any store
 * file that talks to node:fs directly writes to a throwaway instance disk,
 * so the data silently vanishes on the next cold start.
 *
 * Why a test and not just review: the auto-update build merges each new
 * upstream release with this fork. A merge can be textually clean and
 * still route a store around the seam (upstream v0.5.0 does exactly that:
 * every store saves through a new node:fs atomic-write helper). The
 * update build runs this test on the merged tree and refuses to ship when
 * it fails, so the old deployment stays live. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const STORE_DIR = path.join(import.meta.dirname, "..", "src", "store");
const FS_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?fs(?:\/promises)?["']/;

/** Plugin-platform record stores (upstream v0.6.0) need real-disk semantics
 *  (directory fsync, exclusive opens) and only ever run when plugins are
 *  allowed — never on a hosted server (src/server/plugins.ts pluginsAllowed;
 *  pinned by tests/plugins-hosted-gate.test.ts). Named one by one so a NEW
 *  upstream store that bypasses the seam still fails this gate. */
const LOCAL_ONLY_PLUGIN_STORES = new Set(["plugin-agent-records.ts", "plugin-data-paths.ts", "plugin-task-records.ts"]);

test("no store module touches node:fs directly (only vfs.ts may)", () => {
	const offenders = fs
		.readdirSync(STORE_DIR)
		.filter((f) => f.endsWith(".ts") && f !== "vfs.ts" && !LOCAL_ONLY_PLUGIN_STORES.has(f))
		.filter((f) => FS_IMPORT.test(fs.readFileSync(path.join(STORE_DIR, f), "utf-8")));
	assert.deepEqual(offenders, [], `these store files bypass the Convex storage seam (src/store/vfs.ts): ${offenders.join(", ")}`);
});

test("the guard itself catches every import form", () => {
	for (const line of [`import fs from "node:fs";`, `import * as fs from "fs";`, `import { readFile } from "node:fs/promises";`, `const fs = require("fs");`, `await import("node:fs")`]) {
		assert.ok(FS_IMPORT.test(line), line);
	}
	assert.ok(!FS_IMPORT.test(`import fs from "./vfs.ts";`));
});
