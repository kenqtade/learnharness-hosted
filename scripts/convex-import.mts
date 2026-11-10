/**
 * One-time import of an existing data dir into Convex (convex-store branch).
 *
 *   CONVEX_URL=... LH_CONVEX_SECRET=... npx tsx scripts/convex-import.mts <dataDir> [authFile] [--skip <name>...]
 *
 * Uploads every file the stores own (chats/, graph/, jobs/, prompts/,
 * settings, auth) under the same keys src/store/vfs.ts uses. Skips the
 * durable-turn SQLite, debug captures and subscription credentials (those
 * are not stores). Re-running overwrites with the local copy.
 */
import fs from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const args = process.argv.slice(2);
const skip = new Set<string>();
const pos: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i] === "--skip") skip.add(args[++i]!); else pos.push(args[i]!); }
const [dataDir, authFile] = pos;
if (!dataDir) { console.error("usage: convex-import.mts <dataDir> [authFile] [--skip name]"); process.exit(2); }
const client = new ConvexHttpClient(process.env.CONVEX_URL!);
const secret = process.env.LH_CONVEX_SECRET!;

const EXCLUDE_DIRS = new Set(["durable", "debug", "background-captures", "provider-events"]);
const EXCLUDE_FILES = new Set(["chatgpt-credentials.json", "auth.json"]);
const ops: { path: string; data: string }[] = [];
const walk = (dir: string, rel: string) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(path.join(dir, e.name), r); continue; }
		if (EXCLUDE_FILES.has(e.name) || skip.has(e.name) || e.name.includes(".tmp")) continue;
		ops.push({ path: `data/${r}`, data: fs.readFileSync(path.join(dir, e.name), "utf-8") });
	}
};
walk(dataDir, "");
if (authFile && fs.existsSync(authFile)) // on Vercel and in run-app.sh the auth file sits inside the data dir → key data/auth.json
	ops.push({ path: `data/${path.basename(authFile)}`, data: fs.readFileSync(authFile, "utf-8") });
for (const op of ops) console.log(`  ${op.path}  (${op.data.length} bytes)`);
const res = await client.mutation(api.vfs.apply, { secret, ops });
console.log(`imported ${ops.length} files → Convex version ${res.after}`);
