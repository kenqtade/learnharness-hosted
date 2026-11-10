/**
 * Convex store proof (convex-store branch). Run TWICE as separate processes
 * (= two serverless instances) against a Convex deployment:
 *
 *   LH_STORE=convex CONVEX_URL=... LH_CONVEX_SECRET=... LH_DATA_DIR=/tmp/x \
 *     npx tsx scripts/convex-store-check.mts write <tag>
 *   ... same env ... npx tsx scripts/convex-store-check.mts read <tag>
 *
 * "write" drives the REAL stores (chats, jobs, settings, auth, graph,
 * prompt overrides) and flushes; "read" starts cold, hydrates from Convex
 * and checks everything is there — and that nothing was written to disk.
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../config.ts";
import { flushStore, storeReady, convexMode } from "../src/store/vfs.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { graphStore } from "../src/store/graph.ts";
import { authStore } from "../src/store/auth.ts";
import { promptOverrides } from "../src/store/prompt-overrides.ts";

const [mode, tag = "t1"] = process.argv.slice(2);
let failed = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

if (!convexMode) { console.error("set LH_STORE=convex"); process.exit(2); }
await storeReady(true);

if (mode === "write") {
	const chat = chatStore.createChat(`convex check ${tag}`);
	chatStore.saveMessages(chat.id, [{ role: "user", content: `hello ${tag}`, timestamp: Date.now() } as never]);
	const big = "x".repeat(2_500_000); // > 1 MiB → exercises chunking
	chatStore.saveMessages(chat.id, [{ role: "user", content: `hello ${tag}`, timestamp: Date.now() } as never, { role: "user", content: big, timestamp: Date.now() } as never]);
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: `tc_${tag}` });
	jobStore.updateJob(job.id, { status: "done" } as never);
	authStore.setAuthVar("TAVILY_API_KEY", `tvly-${tag}`);
	promptOverrides.writeOverride("system-prompt.md", `override ${tag}`);
	graphStore.appendCoverage({ chatId: chat.id, fp: `fp-${tag}`, tokens: 1, foldedAt: new Date().toISOString() });
	const t0 = Date.now();
	await flushStore();
	console.log(`flushed in ${Date.now() - t0} ms`);
	fs.writeFileSync(`/tmp/convex-check-${tag}.json`, JSON.stringify({ chatId: chat.id, jobId: job.id }));
	check(!fs.existsSync(PATHS.chats), "nothing written to the local data dir");
} else {
	const { chatId, jobId } = JSON.parse(fs.readFileSync(`/tmp/convex-check-${tag}.json`, "utf-8"));
	const chat = chatStore.getChat(chatId);
	check(chat?.title === `convex check ${tag}`, "chat visible to a fresh instance");
	check(chat?.messages.length === 2 && (chat.messages[1] as { content: string }).content.length === 2_500_000, "2.5 MB message survived chunking");
	check(chatStore.listChats().some((c) => c.id === chatId), "listChats sees it");
	check(jobStore.getJob(jobId)?.status === "done", "job record + update");
	check(authStore.authVars().TAVILY_API_KEY === `tvly-${tag}`, "API key saved");
	check(promptOverrides.readOverride("system-prompt.md") === `override ${tag}`, "prompt override");
	check(promptOverrides.listOverrides().includes("system-prompt.md"), "listOverrides walks dirs");
	check(graphStore.readCoverage().some((c) => c.fp === `fp-${tag}`), "graph ledger append");
	check(chatStore.deleteChat(chatId), "delete chat");
	await flushStore();
	await storeReady(true);
	check(chatStore.getChat(chatId) === null, "delete persisted");
	check(!fs.existsSync(path.join(PATHS.data, "chats")), "still nothing on local disk");
}
console.log(failed ? `FAIL (${failed})` : "PASS");
process.exit(failed ? 1 : 0);
