import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, createProvider, fauxAssistantMessage, fauxText, fauxToolCall, type StreamFunction } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// DURABLE-PI BRANCH: a real turn through handleChatInput with
// LH_RUNTIME=pi-durable — the Harness runs the loop, the chat record and the
// SSE wire must come out the same shape as the in-process runner's.
// Isolation: temp data dir, no network, scripted (faux) model.

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-durable-turn-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), LH_RUNTIME: "pi-durable", LH_UPDATE_FLUSH_MS: "5" };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
const { piModels } = await import("../src/agent/models.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { closeDurableRuntime, durableRuntime } = await import("../src/server/durable/harness.ts");
after(async () => {
	await closeDurableRuntime();
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(directory, { recursive: true, force: true });
});

const PROVIDER = "durable-fixture";
const faux = createFauxCore({});
const entry = { ...faux.getModel(), provider: PROVIDER, id: "chat-model" };
const stream: StreamFunction = (m, c, o) => faux.streamSimple(m, c, o);
piModels().setProvider(createProvider({ id: PROVIDER, models: [entry], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
writeSettings({ version: 1, graph: { enabled: false }, models: { strong: { model: { provider: PROVIDER, id: "chat-model" } } } });

const ran: string[] = [];
const tool = (name: string, result: () => { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean; terminate?: boolean }) => ({
	name, label: name, description: `${name} fixture`, parameters: Type.Object({}),
	execute: async () => { ran.push(name); return result(); },
});
const lookup = tool("lookup", () => ({ content: [{ type: "text", text: "42" }], details: { value: 42 } }));
const quizOk = tool("quiz", () => ({ content: [{ type: "text", text: "Question posed." }], details: {}, terminate: true }));
const quizBad = tool("quiz", () => ({ content: [{ type: "text", text: "Invalid quiz: needs options" }], details: {}, isError: true }));

async function runTurn(text: string, tools: Record<string, ReturnType<typeof tool>>) {
	const chat = chatStore.createChat(`durable ${text}`);
	const response = await handleChatInput(chat.id, { type: "text", text }, (options) => createTeacherAgent(undefined, { ...options, tools }));
	assert.equal(response.status, 200, await response.clone().text());
	const handle = runningTurn(chat.id);
	assert.ok(handle, "the durable turn registers as the running turn (reattach/abort work)");
	const body = await new Response(handle.subscribe()).text();
	const events = body.split("\n\n").filter((f) => f.startsWith("data: ") && f !== "data: [DONE]").map((f) => JSON.parse(f.slice(6)) as { type: string; [k: string]: unknown });
	assert.ok(body.trimEnd().endsWith("data: [DONE]"));
	// onFinish runs before the wire closes; give the settled marker a tick.
	await new Promise((r) => setTimeout(r, 20));
	return { chat: chatStore.getChat(chat.id)!, events };
}

test("a tool round runs durably: wire events, record, usage, ids", async () => {
	ran.length = 0;
	faux.setResponses([
		fauxAssistantMessage([fauxText("Let me look."), fauxToolCall("lookup", {}, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("The answer is 42.")]),
	]);
	const before = faux.state.callCount;
	const { chat, events } = await runTurn("what is it?", { lookup });
	assert.equal(faux.state.callCount - before, 2);
	assert.deepEqual(ran, ["lookup"]);
	const types = events.map((e) => e.type);
	assert.equal(types[0], "agent_start");
	assert.equal(types.at(-1), "agent_end");
	for (const t of ["message_start", "message_end", "tool_execution_start", "tool_execution_end", "turn_end"]) assert.ok(types.includes(t), `wire has ${t}`);
	// The browser tracks the streaming assistant by slot: no ids on the wire.
	for (const e of events) if (e.type.startsWith("message_")) assert.equal((e.message as { id?: string }).id, undefined);
	const turnEnds = events.filter((e) => e.type === "turn_end");
	assert.equal((turnEnds[0]!.toolResults as unknown[]).length, 1);
	const roles = chat.messages.map((m) => (m as { role?: string }).role);
	assert.deepEqual(roles.slice(-4), ["user", "assistant", "toolResult", "assistant"]);
	const final = chat.messages.at(-1) as { id: string; content: Array<{ text?: string }> };
	assert.equal(final.content[0]?.text, "The answer is 42.");
	assert.match(final.id, /^dur_\d+_\d+$/, "persisted messages carry deterministic durable ids");
	assert.equal(chat.turns?.length ?? 0, 1, "usage landed in the turns log");
	const runtime = await durableRuntime();
	assert.equal((await runtime.unsettled()).length, 0, "the turn is marked settled in the durable index");
});

test("a cleanly-posed question in a mixed batch ends the run (no extra model call)", async () => {
	ran.length = 0;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("quiz", {}, { id: "q-1" }), fauxToolCall("lookup", {}, { id: "l-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("SHOULD NOT BE REQUESTED")]),
	]);
	const before = faux.state.callCount;
	const { chat } = await runTurn("quiz me", { quiz: quizOk, lookup });
	assert.equal(faux.state.callCount - before, 1, "the run stopped after the question round");
	assert.deepEqual([...ran].sort(), ["lookup", "quiz"]);
	const texts = JSON.stringify(chat.messages);
	assert.ok(!texts.includes("SHOULD NOT BE REQUESTED"));
	// persistTurn drops the clean question placeholder, like in-process.
	assert.ok(!chat.messages.some((m) => (m as { role?: string; toolName?: string }).role === "toolResult" && (m as { toolName?: string }).toolName === "quiz"));
	faux.setResponses([]);
});

test("a question that fails validation does NOT stop the run — the model retries", async () => {
	ran.length = 0;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("quiz", {}, { id: "q-2" }), fauxToolCall("lookup", {}, { id: "l-2" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Sorry — let me explain instead.")]),
	]);
	const before = faux.state.callCount;
	const { chat } = await runTurn("quiz me badly", { quiz: quizBad, lookup });
	assert.equal(faux.state.callCount - before, 2);
	assert.equal((chat.messages.at(-1) as { content: Array<{ text?: string }> }).content[0]?.text, "Sorry — let me explain instead.");
});
