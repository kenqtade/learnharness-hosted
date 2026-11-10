import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	defineExtension,
	hook,
	section,
	ToolTask,
	type Conversation,
	type EntryRecord,
	type Extension,
	type LiveState,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { QUESTION_TOOLS } from "../../core/pending.ts";
import { PRACTICE_PROBLEM_TOOL, toLlmMessages } from "../../core/native-messages.ts";
import { ToolCallIdUniquifier } from "../pi/call-ids.ts";
import type { PiTurnHandle, TurnWireEvent } from "../pi/ui-stream.ts";
import { durableRuntime, TURN_INDEX_KIND, TURN_SETTLED_KIND, type TurnIndexData } from "./harness.ts";

/**
 * THE DURABLE TURN (DURABLE-PI BRANCH, LH_RUNTIME=pi-durable).
 *
 * Same contract as runPiTurn (src/server/pi/ui-stream.ts) — a PiTurnHandle
 * with subscribe()/abort(), the same SSE dialect, the same onFinish seam —
 * but the agent loop runs inside pi-durable's Harness instead of an
 * in-memory pi Agent. Every model answer and tool result is COMMITTED to
 * storage before anything else sees it, so a process that dies mid-turn
 * resumes on the next boot (recovery.ts) instead of losing the turn:
 *   - finished model calls are never repeated (they are entries already);
 *   - a model call cut off mid-stream is retried (settings.retry);
 *   - finished tools never re-run; an interrupted tool re-runs only when
 *     REPLAY_SAFE, otherwise the model gets an "interrupted" error result
 *     and decides what to do (no double job spawns).
 *
 * The app's chat record stays the source of truth: each turn is a fresh
 * Harness conversation seeded with the turn's starting messages, and at
 * settle the new messages are handed to onFinish exactly like runPiTurn
 * (persistTurn slices past the base count). Harness storage is the
 * in-flight journal, not a second history.
 */

/** Read-only or pure tools: safe to re-execute after a crash interrupted
 *  them. Everything else (job spawners research/demo/visual/pdf, plan and
 *  phase markers) is "unsafe" → an interrupted call becomes an error result
 *  instead of a silent second side effect. */
export const REPLAY_SAFE_TOOLS: ReadonlySet<string> = new Set([
	"read", "ls", "grep", "find",
	"web_search", "web_fetch", "web_fetch_pdf",
	"pdf_info", "pdf_search", "pdf_extract",
	"list_sessions", "list_propositions", "find_candidates",
	// Question / problem poses produce a synthetic placeholder result only —
	// the learner's answer arrives as the next turn.
	...QUESTION_TOOLS, PRACTICE_PROBLEM_TOOL,
]);

export type DurableAgentKind = "teacher" | "prober" | "practice";

/** What a turn needs, read off the already-constructed pi Agent. */
export interface DurableTurnPlan {
	kind: DurableAgentKind;
	systemPrompt: string;
	tools: AgentTool<any>[];
	model: { provider: string; modelId: string };
	thinkingLevel?: ThinkingLevel;
}

export interface DurableTurnCallbacks {
	usedToolCallIds?: ReadonlySet<string>;
	onUsage?: (usage: Usage) => void;
	onError?: (error: unknown) => string;
	onSettleError?: (error: unknown) => string;
	onSettleFailure?: (error: unknown, reportedErrorText?: string) => void;
	/** Same seam as runPiTurn: the FULL message list (base + new). */
	onFinish: (messages: AgentMessage[], isAborted: boolean) => void;
	updateFlushMs?: number;
}

export interface DurableTurnSpec extends DurableTurnCallbacks {
	chatId: string;
	plan: DurableTurnPlan;
	/** The agent's starting transcript (system messages excluded). */
	baseMessages: AgentMessage[];
	/** persistTurn's base count for this turn (recorded for recovery). */
	baseCount: number;
}

const ctx = BACKGROUND_CONTEXT;

function jsonSafe(value: unknown): any {
	if (value === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return null;
	}
}

function stopToolsFor(kind: DurableAgentKind): ReadonlySet<string> {
	return new Set<string>([...QUESTION_TOOLS, ...(kind === "practice" ? [PRACTICE_PROBLEM_TOOL] : [])]);
}

type ToolUpdate = (toolCallId: string, toolName: string, partialResult: unknown) => void;

let toolObserver: ((toolName: string) => void) | undefined;
/** Diagnostics/tests: observe every real tool execution in this process
 *  (the crash test proves a committed tool is never re-run). */
export function setDurableToolObserver(observer: ((toolName: string) => void) | undefined): void {
	toolObserver = observer;
}

/** AgentTool (pi-agent-core) → ToolRegistration (pi-durable). */
export function adaptTool(tool: AgentTool<any>, onUpdate?: ToolUpdate): ToolRegistration {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		replay: tool.replay === "safe" || REPLAY_SAFE_TOOLS.has(tool.name) ? "safe" : "unsafe",
		...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
		...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments as (args: unknown) => any } : {}),
		async execute(args, api, context): Promise<ToolExecutionResult> {
			toolObserver?.(tool.name);
			const result = await tool.execute(api.callId, args as never, context.abortSignal, (partial) => onUpdate?.(api.callId, tool.name, partial));
			return {
				output: result.content,
				details: jsonSafe(result.details),
				...(result.isError ? { isError: true } : {}),
				...(result.terminate ? { control: { terminate: true } } : {}),
				...(result.usage ? { usage: result.usage } : {}),
			};
		},
	};
}

/** The question-stop rule (teacher-agent makeQuestionStopper) in Harness
 *  terms. The Harness ends a run when EVERY result of a round carries
 *  control.terminate; a cleanly-posed question already does (tool-execute's
 *  questionResult). So: every OTHER call in a round that contains a pose
 *  also terminates. A pose that failed validation returns an error without
 *  terminate → not all terminate → the model retries in the same turn —
 *  exactly the in-process semantics. */
function questionStopHook(kind: DurableAgentKind) {
	const stopTools = stopToolsFor(kind);
	return hook(ToolTask, {
		async afterTool(call, result, api, context) {
			if (call.parent || stopTools.has(call.name)) return undefined;
			const page = await api.entries({ order: "descending" }, 32, undefined, context);
			const assistant = page.items.find((entry) => entry.kind === "pi.assistant");
			const message = assistant?.model?.[0] as AssistantMessage | undefined;
			const hasPose = message?.content.some((c) => c.type === "toolCall" && stopTools.has(c.name) && c.id !== call.id);
			if (!hasPose) return undefined;
			return { ...result, control: { ...(result.control ?? {}), terminate: true } };
		},
	});
}

export function turnExtension(name: string, plan: DurableTurnPlan, onUpdate?: ToolUpdate): Extension {
	return defineExtension({
		name,
		tools: plan.tools.map((tool) => adaptTool(tool, onUpdate)),
		// Untagged: the model sees exactly the app's composed prompt.
		sections: [section("lh_system", () => plan.systemPrompt, { tag: false })],
		hooks: [questionStopHook(plan.kind)],
	});
}

/** Deterministic record ids: a recovered settle that already landed once is
 *  recognised (idempotent persist), never appended twice. */
export function durableMessageId(conversationId: number | string, entryId: number | string, index: number): string {
	return `dur_${conversationId}_${entryId}${index ? `_${index}` : ""}`;
}

/**
 * The SSE fan-out (a compact twin of runPiTurn's log): settled events append,
 * in-flight message/tool updates coalesce to their latest snapshot, late
 * views replay the log then go live. Kept separate on purpose so the default
 * in-process path (ui-stream.ts) is untouched by this branch.
 */
function createBroadcast(updateFlushMs: number) {
	const log: TurnWireEvent[] = [];
	const slots = new Map<string, number>();
	const pending = new Map<string, TurnWireEvent>();
	const subscribers = new Set<{ push(e: TurnWireEvent): void; done(): void }>();
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const key = (e: TurnWireEvent) => (e.type === "message_update" ? "message" : e.type === "tool_execution_update" ? `tool:${(e as { toolCallId: string }).toolCallId}` : null);
	const flush = () => {
		if (timer) { clearTimeout(timer); timer = undefined; }
		if (pending.size === 0) return;
		const batch = [...pending.values()];
		pending.clear();
		for (const sub of subscribers) for (const e of batch) sub.push(e);
	};
	return {
		get settled() { return settled; },
		send(event: TurnWireEvent) {
			if (settled) return;
			const k = key(event);
			if (k) {
				const idx = slots.get(k);
				if (idx !== undefined) log[idx] = event;
				else { slots.set(k, log.length); log.push(event); }
				pending.set(k, event);
				if (!timer) {
					timer = setTimeout(() => { timer = undefined; flush(); }, updateFlushMs);
					(timer as { unref?: () => void }).unref?.();
				}
				return;
			}
			if (event.type === "message_end") slots.delete("message");
			if (event.type === "tool_execution_end") slots.delete(`tool:${(event as { toolCallId: string }).toolCallId}`);
			flush();
			log.push(event);
			for (const sub of subscribers) sub.push(event);
		},
		close() {
			if (settled) return;
			flush();
			settled = true;
			for (const sub of subscribers) sub.done();
			subscribers.clear();
		},
		subscribe(): ReadableStream<Uint8Array> {
			let sub: { push(e: TurnWireEvent): void; done(): void } | undefined;
			return new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					let closed = false;
					sub = {
						push(e) {
							if (closed) return;
							try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { closed = true; }
						},
						done() {
							if (closed) return;
							closed = true;
							try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); } catch { /* cancelled */ }
						},
					};
					subscribers.add(sub);
					for (const e of log) sub.push(e);
					if (settled) sub.done();
				},
				cancel() { if (sub) subscribers.delete(sub); },
			});
		},
	};
}

/** Start a NEW durable turn: one Harness conversation, seeded with the turn's
 *  starting messages, indexed for recovery, then run. */
export async function startDurableTurn(spec: DurableTurnSpec): Promise<PiTurnHandle> {
	const runtime = await durableRuntime();
	const { harness, registry } = runtime;
	const extName = `lh.turn.${crypto.randomUUID()}`;
	const toolUpdates: { fn?: ToolUpdate } = {};
	const ext = turnExtension(extName, spec.plan, (id, name, partial) => toolUpdates.fn?.(id, name, partial));
	registry.install(ext);
	const conversation = await harness.createConversation({
		ownership: { kind: "ownerless" },
		agent: {
			model: spec.plan.model,
			...(spec.plan.thinkingLevel ? { thinkingLevel: spec.plan.thinkingLevel as never } : {}),
			extensions: [ext],
		},
	}, ctx);
	const seedMessages = toLlmMessages(spec.baseMessages).filter((m) => (m as { role?: string }).role !== "system");
	await (await conversation.submit({ type: "write", entry: { kind: "lh.seed", model: seedMessages, data: { chatId: spec.chatId, baseCount: spec.baseCount } } }, ctx)).wait(ctx);
	const seedId = await latestEntryId(conversation, "lh.seed");
	const index: TurnIndexData = { conversationId: conversation.id as number, chatId: spec.chatId, baseCount: spec.baseCount, extension: extName, kind: spec.plan.kind, seedId: seedId as number };
	await runtime.index(index);
	return attachDurableTurn(conversation, index, spec, { start: true, toolUpdates });
}

async function latestEntryId(conversation: Conversation, kind: string): Promise<number> {
	const page = await conversation.entries({ order: "descending" }, 16, undefined, ctx);
	const entry = page.items.find((e) => e.kind === kind);
	if (!entry) throw new Error(`durable: no ${kind} entry in conversation ${conversation.id}`);
	return entry.id as number;
}

/** Watch a durable conversation and drive the app's turn contract from it.
 *  Used for new turns (start: true) and for turns recovered after a crash. */
export function attachDurableTurn(
	conversation: Conversation,
	index: TurnIndexData,
	spec: DurableTurnCallbacks & { baseMessages: AgentMessage[] },
	options: { start: boolean; toolUpdates?: { fn?: ToolUpdate } },
): PiTurnHandle {
	const broadcast = createBroadcast(spec.updateFlushMs ?? 100);
	const uniquifier = spec.usedToolCallIds ? new ToolCallIdUniquifier(spec.usedToolCallIds) : undefined;
	const send = (event: AgentEvent | TurnWireEvent) => {
		const e = (uniquifier && event.type !== "error" ? uniquifier.event(event as AgentEvent) : event) as TurnWireEvent;
		broadcast.send(e.type === "message_update" ? { type: "message_update", message: (e as { message: AgentMessage }).message } : e);
	};
	const processed = new Set<number>();
	const newMessages: AgentMessage[] = [];
	const callArgs = new Map<string, { name: string; args: unknown }>();
	const startedTools = new Set<string>();
	let messageOpen = false;
	let round: { assistant: AssistantMessage; expected: number; results: ToolResultMessage[] } | undefined;
	let sawAbort = false;
	let reportedErrorText: string | undefined;

	if (options.toolUpdates) {
		options.toolUpdates.fn = (toolCallId, toolName, partialResult) =>
			send({ type: "tool_execution_update", toolCallId, toolName, args: callArgs.get(toolCallId)?.args, partialResult } as AgentEvent);
	}

	const closeRound = () => {
		if (!round) return;
		send({ type: "turn_end", message: round.assistant, toolResults: round.results } as AgentEvent);
		round = undefined;
	};

	const onEntry = (entry: EntryRecord) => {
		const id = entry.id as number;
		if (id <= index.seedId || processed.has(id)) return;
		processed.add(id);
		const messages = (entry.model ?? []) as Message[];
		messages.forEach((message, i) => {
			const role = (message as { role: string }).role;
			if (role === "system") return;
			const stored = { ...message, id: durableMessageId(index.conversationId, id, i) } as unknown as AgentMessage;
			newMessages.push(stored);
			if (role === "assistant") {
				const assistant = message as AssistantMessage;
				closeRound();
				if (!messageOpen) send({ type: "message_start", message: assistant } as AgentEvent);
				send({ type: "message_end", message: assistant } as AgentEvent);
				messageOpen = false;
				if (assistant.usage) spec.onUsage?.(assistant.usage);
				if (assistant.stopReason === "aborted") sawAbort = true;
				const calls = assistant.content.filter((c): c is ToolCall => c.type === "toolCall");
				for (const call of calls) callArgs.set(call.id, { name: call.name, args: call.arguments });
				round = { assistant, expected: calls.length, results: [] };
				if (calls.length === 0) closeRound();
			} else if (role === "toolResult") {
				const result = message as ToolResultMessage;
				if (!startedTools.has(result.toolCallId)) {
					startedTools.add(result.toolCallId);
					send({ type: "tool_execution_start", toolCallId: result.toolCallId, toolName: result.toolName, args: callArgs.get(result.toolCallId)?.args } as AgentEvent);
				}
				send({ type: "tool_execution_end", toolCallId: result.toolCallId, toolName: result.toolName, result: { content: result.content, details: result.details }, isError: result.isError } as AgentEvent);
				send({ type: "message_start", message: result } as AgentEvent);
				send({ type: "message_end", message: result } as AgentEvent);
				if (round) {
					round.results.push(result);
					if (round.results.length >= round.expected) closeRound();
				}
			} else {
				// Steers / inputs placed mid-run: start + end only (no partials).
				send({ type: "message_start", message } as AgentEvent);
				send({ type: "message_end", message } as AgentEvent);
			}
		});
	};

	const onLive = (live: LiveState | undefined) => {
		const partial = live?.generation?.message as AssistantMessage | undefined;
		if (partial && partial.content?.length) {
			if (!messageOpen) { send({ type: "message_start", message: partial } as AgentEvent); messageOpen = true; }
			send({ type: "message_update", message: partial } as unknown as AgentEvent);
		}
		for (const slot of live?.tools ?? []) {
			if (slot.status !== "pending" && !startedTools.has(slot.callId)) {
				startedTools.add(slot.callId);
				send({ type: "tool_execution_start", toolCallId: slot.callId, toolName: slot.name, args: callArgs.get(slot.callId)?.args } as AgentEvent);
			}
		}
	};

	let stopWatch: (() => void) | undefined;
	let lastFailure: LiveState["runFailure"];
	send({ type: "agent_start" } as AgentEvent);

	void (async () => {
		try {
			const watch = await conversation.watch(ctx, { from: (index.seedId + 1) as never, min: 200, max: 400 });
			const apply = (value: { entries: readonly EntryRecord[]; docs: Record<string, unknown> }) => {
				for (const entry of value.entries) onEntry(entry);
				const live = value.docs["pi.live"] as LiveState | undefined;
				lastFailure = live?.runFailure;
				onLive(live);
			};
			apply(watch.value as never);
			watch.start(async (call) => { if (call.kind === "value") apply(call.value as never); });
			stopWatch = () => { void watch.stop(); };

			if (options.start) {
				const submission = await conversation.submit({ type: "continue" }, ctx);
				await submission.wait(ctx);
			} else {
				await conversation.waitForIdle(ctx);
			}
			// Catch up on anything the watch has not delivered yet.
			let cursor: unknown;
			do {
				const page = await conversation.entries({ order: "ascending", minEntryId: (index.seedId + 1) as never }, 200, cursor as never, ctx);
				for (const entry of page.items) onEntry(entry);
				cursor = page.next;
			} while (cursor);
			const view = await conversation.watch(ctx, { min: 1 });
			lastFailure = (view.value.docs["pi.live"] as LiveState | undefined)?.runFailure ?? lastFailure;
			void view.stop();
			closeRound();
			if (lastFailure && lastFailure.reason !== "aborted" && !newMessages.some((m) => (m as { role?: string }).role === "assistant" && (m as AssistantMessage).stopReason === "error")) {
				// A run that ended without an answer and without an error
				// message of its own (no_model, faulted, restart_limit…).
				reportedErrorText = spec.onError?.(new Error(`durable run ${lastFailure.reason}`)) ?? "An error occurred.";
				send({ type: "error", errorText: reportedErrorText });
			}
			if (lastFailure?.reason === "aborted") sawAbort = true;
		} catch (err) {
			console.error("[durable] turn watch failed:", err);
			reportedErrorText = spec.onError?.(err) ?? "An error occurred.";
			send({ type: "error", errorText: reportedErrorText });
		} finally {
			stopWatch?.();
			const settledMessages = [...spec.baseMessages, ...((uniquifier?.remapSettled(newMessages) as AgentMessage[]) ?? newMessages)];
			send({ type: "agent_end", messages: settledMessages } as AgentEvent);
			let persisted = false;
			try {
				spec.onFinish(settledMessages, sawAbort);
				persisted = true;
			} catch (err) {
				console.error("[durable] settlement failed:", err);
				try { spec.onSettleFailure?.(err, reportedErrorText); } catch (cleanup) { console.error("[durable] settlement cleanup failed:", cleanup); }
				if (reportedErrorText === undefined) {
					reportedErrorText = spec.onSettleError?.(err) ?? "An error occurred.";
					send({ type: "error", errorText: reportedErrorText });
				}
			}
			broadcast.close();
			if (persisted) {
				try {
					const runtime = await durableRuntime();
					await runtime.markSettled(index);
				} catch (err) {
					console.error("[durable] could not mark turn settled:", err);
				}
			}
		}
	})();

	return {
		subscribe: () => broadcast.subscribe(),
		abort() {
			if (broadcast.settled) return;
			sawAbort = true;
			void conversation.abort(ctx).catch((err) => console.error("[durable] abort failed:", err));
		},
	};
}

export { TURN_INDEX_KIND, TURN_SETTLED_KIND };
