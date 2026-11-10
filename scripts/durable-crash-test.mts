// DURABLE-PI BRANCH — the crash → resume proof.
//
//   npm run test:durable-crash
//
// 1. A child process starts a REAL chat turn (real prober agent, real tools,
//    LH_RUNTIME=pi-durable) against a scripted model: call #1 asks for the
//    `ls` tool, call #2 streams a long answer slowly.
// 2. While call #2 is mid-stream, the parent SIGKILLs the child — no
//    shutdown hooks, no flush, exactly like a crashed server or a killed
//    serverless instance.
// 3. A FRESH process opens the same storage. Recovery rebuilds the turn's
//    tools, resumes the run, and settles it into the chat record.
// Asserts: model call #1 is NOT repeated, the tool is NOT re-run, the
// interrupted call #2 is retried, the record ends complete with no
// duplicates, and the turn is marked settled.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const role = process.argv[2] ?? "parent";
const SELF = fileURLToPath(import.meta.url);
const LONG = "Here is a careful walkthrough of what I found in your folder. ".repeat(12).trim();

if (role === "parent") await parent();
else await child(role as "run" | "recover");

async function parent() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-durable-crash-"));
	const calls = path.join(dir, "calls.jsonl");
	const env = { ...process.env, CRASH_DIR: dir };
	const log = (s: string) => console.log(`[crash-test] ${s}`);
	let failed = 0;
	const check = (ok: boolean, what: string) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };
	const readCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as Array<{ role: string; last: string; n: number }>;

	log(`data dir ${dir}`);
	log("phase 1: start a turn in process A, kill -9 it mid-answer");
	const a = spawn(process.execPath, ["--import", "tsx", SELF, "run"], { env, stdio: ["ignore", "inherit", "inherit"] });
	const started = Date.now();
	while (readCalls().filter((c) => c.role === "run").length < 2) {
		if (Date.now() - started > 60_000 || a.exitCode !== null) throw new Error("process A never reached model call #2");
		await new Promise((r) => setTimeout(r, 50));
	}
	await new Promise((r) => setTimeout(r, 700)); // let some of the answer stream
	a.kill("SIGKILL");
	await new Promise((r) => a.once("exit", r));
	log(`process A killed (signal ${a.signalCode}) while model call #2 was streaming`);
	const chatId = fs.readFileSync(path.join(dir, "chat-id.txt"), "utf8").trim();
	const recordAtCrash = JSON.parse(fs.readFileSync(path.join(dir, "chats", `${chatId}.json`), "utf8"));
	const rolesAtCrash = recordAtCrash.messages.map((m: { role?: string }) => m.role);
	log(`chat record at crash: [${rolesAtCrash.join(", ")}] (the in-process runner would have lost this turn)`);

	log("phase 2: fresh process B opens the same storage and recovers");
	const b = spawn(process.execPath, ["--import", "tsx", SELF, "recover"], { env, stdio: ["ignore", "pipe", "inherit"] });
	let out = "";
	b.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
	const code = await new Promise<number>((r) => b.once("exit", (c) => r(c ?? 1)));
	const summary = JSON.parse(out.split("\n").find((l) => l.startsWith("SUMMARY ")).slice(8));

	const all = readCalls();
	const aCalls = all.filter((c) => c.role === "run");
	const bCalls = all.filter((c) => c.role === "recover");
	console.log("\nResults");
	check(code === 0, "process B exited cleanly");
	check(aCalls.length === 2 && aCalls[0].last === "user" && aCalls[1].last === "toolResult", "process A made call #1 (→ tool) and was killed during call #2");
	check(bCalls.length === 1, `process B made exactly ONE model call (made ${bCalls.length})`);
	check(bCalls[0]?.last === "toolResult", "…and it continued from the saved tool result — call #1 was NOT repeated");
	check(summary.recovered.includes(chatId), "recovery found and resumed this chat's turn");
	const roles: string[] = summary.roles;
	check(JSON.stringify(roles.slice(-4)) === JSON.stringify(["user", "assistant", "toolResult", "assistant"]), `final record ends user → assistant(tool call) → toolResult → assistant  [${roles.join(", ")}]`);
	check(roles.filter((r) => r === "toolResult").length === 1, "the tool result appears exactly once (tool not re-run, no duplicate persist)");
	check(summary.finalText === LONG, "the final answer is complete");
	check(summary.unsettled === 0, "the durable index shows no unfinished turns");
	const aRuns = fs.existsSync(path.join(dir, "tool-runs-run.txt")) ? fs.readFileSync(path.join(dir, "tool-runs-run.txt"), "utf8").trim().split("\n") : [];
	check(JSON.stringify(aRuns) === JSON.stringify(["ls"]), `process A really executed the ls tool once  [${aRuns.join(", ")}]`);
	check(summary.toolExecutions === 0, "process B executed no tools (the ls result was already committed)");
	console.log(failed === 0 ? "\nCRASH TEST PASSED — the turn survived kill -9.\n" : `\nCRASH TEST FAILED (${failed} check(s)).\n`);
	const storageFiles = [path.join(dir, "turso-local.sqlite"), path.join(dir, "durable", "turns.sqlite")].filter((f) => fs.existsSync(f)).map((f) => path.relative(dir, f));
	log(`durable storage used: ${storageFiles.join(", ")}`);
	if (failed === 0) fs.rmSync(dir, { recursive: true, force: true });
	process.exit(failed === 0 ? 0 : 1);
}

async function child(which: "run" | "recover") {
	const dir = process.env.CRASH_DIR!;
	process.env = { PATH: process.env.PATH, HOME: dir, NODE_ENV: "test", LH_DATA_DIR: dir, LH_AUTH_FILE: path.join(dir, "auth.json"), LH_RUNTIME: "pi-durable", CRASH_DIR: dir, ...(process.env.CRASH_LIBSQL ? { LH_DURABLE_LIBSQL_URL: `file:${path.join(dir, "turso-local.sqlite")}` } : {}) };
	if (!fs.existsSync(process.env.LH_AUTH_FILE!)) fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
	globalThis.fetch = async () => { throw new Error("CLOSED: no network in the crash test"); };
	const { createFauxCore, createProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
	const { piModels } = await import("../src/agent/models.ts");
	const { writeSettings } = await import("../src/store/settings.ts");
	const { chatStore } = await import("../src/store/chats.ts");
	const { handleChatInput } = await import("../src/server/chat-handler.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	const { durableRuntime } = await import("../src/server/durable/harness.ts");
	const { setDurableToolObserver } = await import("../src/server/durable/turn.ts");
	setDurableToolObserver((name) => fs.appendFileSync(path.join(dir, `tool-runs-${which}.txt`), `${name}\n`));

	// The scripted model. Process A streams slowly so the kill lands mid-answer.
	const faux = createFauxCore(which === "run" ? { tokensPerSecond: 40 } : {});
	const PROVIDER = "crash-fixture";
	const entry = { ...faux.getModel(), provider: PROVIDER, id: "crash-model" };
	let n = 0;
	const stream = (m: never, c: { messages: Array<{ role: string }> }, o: never) => {
		fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ role: which, n: ++n, last: c.messages.at(-1)?.role }) + "\n");
		return faux.streamSimple(m, c as never, o);
	};
	piModels().setProvider(createProvider({ id: PROVIDER, models: [entry], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream: stream as never, streamSimple: stream as never } }));
	const respond = (ctx: { messages: Array<{ role: string }> }) =>
		ctx.messages.at(-1)?.role === "user"
			? fauxAssistantMessage([fauxText("Let me look at your files."), fauxToolCall("ls", { path: "." }, { id: "ls-1" })], { stopReason: "toolUse" })
			: fauxAssistantMessage([fauxText(LONG)]);
	faux.setResponses([respond as never, respond as never, respond as never]);

	if (which === "run") {
		writeSettings({ version: 1, graph: { enabled: false }, models: { strong: { model: { provider: PROVIDER, id: "crash-model" } } } });
		const chat = chatStore.createChat("Crash test");
		fs.writeFileSync(path.join(dir, "chat-id.txt"), chat.id);
		const res = await handleChatInput(chat.id, { type: "text", text: "Please look at the files in my folder." });
		if (res.status !== 200) throw new Error(`turn refused: ${res.status} ${await res.text()}`);
		await new Promise(() => undefined); // keep running until killed
		return;
	}

	// RECOVER: count tool executions in this process by wrapping the registry.
	const runtime = await durableRuntime();
	const chatId = fs.readFileSync(path.join(dir, "chat-id.txt"), "utf8").trim();
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	await new Promise((r) => setTimeout(r, 100));
	const record = chatStore.getChat(chatId)!;
	const runs = path.join(dir, "tool-runs-recover.txt");
	const toolExecutions = fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").trim().split("\n").filter(Boolean).length : 0;
	const final = record.messages.at(-1) as { content?: Array<{ type: string; text?: string }> };
	console.log("SUMMARY " + JSON.stringify({
		recovered: runtime.recovered,
		roles: record.messages.map((m) => (m as { role?: string }).role),
		finalText: final?.content?.find((c) => c.type === "text")?.text,
		unsettled: (await runtime.unsettled()).length,
		toolExecutions,
	}));
	process.exit(0);
}
