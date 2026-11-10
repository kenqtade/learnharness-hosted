import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ConversationBusy, createRegistry, Harness, type Conversation, type HarnessSettings, type Registry } from "@earendil-works/pi-durable";
import { APP_IDENTITY, piModels } from "../../agent/models.ts";
import type { PiTurnHandle } from "../pi/ui-stream.ts";
import { durableStorageKind, openDurableStorage, type DurableStorageKind } from "./storage.ts";
import { attachDurableTurn, turnExtension, type DurableTurnCallbacks, type DurableTurnPlan } from "./turn.ts";

/**
 * The process-wide durable runtime (DURABLE-PI BRANCH): ONE Harness over ONE
 * storage, shared by every chat's turns (each turn is its own conversation).
 *
 * The recovery index lives in the Harness's own root conversation as plain
 * bookkeeping entries — `lh.turn` when a turn starts, `lh.turn.settled` once
 * its messages are in the chat record — so it is exactly as durable as the
 * turns themselves, on either storage.
 *
 * Boot order matters: a recovered run must find its tools registered BEFORE
 * scheduling resumes, or its next model request would be offered no tools.
 * So open() rebuilds every unsettled turn's extension first (through the
 * recoverer chat-handler registers), then calls resume().
 */

export const TURN_INDEX_KIND = "lh.turn";
export const TURN_SETTLED_KIND = "lh.turn.settled";

export interface TurnIndexData {
	conversationId: number;
	chatId: string;
	baseCount: number;
	extension: string;
	kind: DurableTurnPlan["kind"];
	seedId: number;
}

/** What chat-handler hands back to resume one crashed turn. */
export interface RecoveredTurnWiring {
	plan: DurableTurnPlan;
	baseMessages: AgentMessage[];
	callbacks: DurableTurnCallbacks;
	/** Register the resumed turn as live (turn lock, reattach, abort). */
	onAttached(handle: PiTurnHandle): void;
}
/** null → the chat is gone or can't run: the durable run is abandoned. */
export type DurableRecoverer = (turn: TurnIndexData) => RecoveredTurnWiring | null;

export interface DurableRuntime {
	harness: Harness;
	registry: Registry;
	storageKind: DurableStorageKind;
	index(turn: TurnIndexData): Promise<void>;
	markSettled(turn: Pick<TurnIndexData, "conversationId">): Promise<void>;
	unsettled(): Promise<TurnIndexData[]>;
	/** Turns resumed at open (for the capability probe / tests). */
	recovered: string[];
}

export const DURABLE_SETTINGS: HarnessSettings = {
	// No default extension selection: each turn selects its own.
	extensions: [],
	// The app compacts between turns itself (compaction.ts); a Harness
	// summary would fork the record's history.
	compaction: { enabled: false },
	steeringMode: "all",
	followUpMode: "all",
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 1_000 },
};

const ctx = BACKGROUND_CONTEXT;
const KEY = Symbol.for("learnharness.durable.runtime");

interface State {
	runtime?: Promise<DurableRuntime>;
	recoverer?: DurableRecoverer;
}

function state(): State {
	const g = globalThis as unknown as Record<symbol, State>;
	return (g[KEY] ??= {});
}

export function setDurableRecoverer(recoverer: DurableRecoverer): void {
	state().recoverer = recoverer;
}

/** Is the durable runtime the selected turn runner? (switchboard: runtime) */
export function durableRuntimeSelected(): boolean {
	return (process.env.LH_RUNTIME ?? "").trim().toLowerCase() === "pi-durable";
}

export function durableRuntime(): Promise<DurableRuntime> {
	const s = state();
	if (!s.runtime) {
		s.runtime = openRuntime().catch((err) => {
			s.runtime = undefined; // a failed open may be retried by the next turn
			throw err;
		});
	}
	return s.runtime;
}

/** Tests: drop the cached runtime (after closing it). */
export async function closeDurableRuntime(): Promise<void> {
	const s = state();
	const pending = s.runtime;
	s.runtime = undefined;
	if (!pending) return;
	try {
		const runtime = await pending;
		await (runtime.harness as unknown as { close(c: typeof ctx): Promise<void> }).close(ctx);
	} catch { /* already failed */ }
}

async function openRuntime(): Promise<DurableRuntime> {
	const storage = await openDurableStorage();
	const registry = createRegistry();
	const harness = await Harness.open(storage, {
		models: () => piModels(),
		identity: APP_IDENTITY,
		registry,
		settings: DURABLE_SETTINGS,
		onReport: (report) => console.error(`[durable] ${report.kind}:`, report.error),
	}, ctx);
	const root = await harness.root(ctx);
	const write = async (kind: string, data: object) => {
		const submission = await root.submit({ type: "write", entry: { kind, data: data as never } }, ctx);
		await submission.wait(ctx);
	};
	const runtime: DurableRuntime = {
		harness,
		registry,
		storageKind: durableStorageKind(),
		recovered: [],
		index: (turn) => write(TURN_INDEX_KIND, turn),
		markSettled: (turn) => write(TURN_SETTLED_KIND, { conversationId: turn.conversationId }),
		unsettled: () => scanUnsettled(root),
	};
	await recover(runtime);
	harness.resume();
	return runtime;
}

async function scanUnsettled(root: Conversation): Promise<TurnIndexData[]> {
	const settled = new Set<number>();
	const open: TurnIndexData[] = [];
	let cursor: unknown;
	let scanned = 0;
	do {
		const page = await root.entries({ order: "descending" }, 200, cursor as never, ctx);
		for (const entry of page.items) {
			const data = entry.data as Record<string, unknown> | undefined;
			if (!data) continue;
			if (entry.kind === TURN_SETTLED_KIND) settled.add(Number(data.conversationId));
			else if (entry.kind === TURN_INDEX_KIND && !settled.has(Number(data.conversationId))) open.push(data as unknown as TurnIndexData);
		}
		scanned += page.items.length;
		cursor = page.next;
	} while (cursor && scanned < 5_000);
	return open.reverse();
}

async function recover(runtime: DurableRuntime): Promise<void> {
	const turns = await runtime.unsettled();
	if (turns.length === 0) return;
	const recoverer = state().recoverer;
	if (!recoverer) {
		// Never resume runs whose tools we cannot rebuild. Left unsettled;
		// the next open with a recoverer picks them up.
		throw new Error(`durable: ${turns.length} unfinished turn(s) but no recoverer is registered`);
	}
	const attach: Array<() => Promise<void>> = [];
	for (const turn of turns) {
		const conversation = await runtime.harness.conversation(turn.conversationId as never, ctx);
		if (!conversation) {
			await runtime.markSettled(turn);
			continue;
		}
		let wiring: RecoveredTurnWiring | null = null;
		try {
			wiring = recoverer(turn);
		} catch (err) {
			console.error(`[durable] could not rebuild chat ${turn.chatId}:`, err);
		}
		if (!wiring) {
			console.warn(`[durable] abandoning turn for chat ${turn.chatId} (chat gone or not runnable)`);
			attach.push(async () => {
				await conversation.abort(ctx).catch(() => undefined);
				await runtime.markSettled(turn);
			});
			continue;
		}
		const toolUpdates: { fn?: (id: string, name: string, partial: unknown) => void } = {};
		runtime.registry.install(turnExtension(turn.extension, wiring.plan, (id, name, partial) => toolUpdates.fn?.(id, name, partial)));
		const w = wiring;
		attach.push(async () => {
			const latest = (await conversation.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
			let start = latest !== undefined && (latest.id as number) <= turn.seedId;
			if (start) {
				// Crashed between indexing and the run's first commit: start it
				// now (a run already admitted rejects the continue — just watch).
				try {
					const probe = await conversation.submit({ type: "continue" }, ctx);
					void probe; // admitted: attach watches it to idle
				} catch (err) {
					if (!(err instanceof ConversationBusy)) throw err;
				}
				start = false;
			}
			const handle = attachDurableTurn(conversation, turn, { ...w.callbacks, baseMessages: w.baseMessages }, { start, toolUpdates });
			w.onAttached(handle);
			runtime.recovered.push(turn.chatId);
		});
	}
	// Extensions are installed; now let the scheduler run and attach views.
	runtime.harness.resume();
	for (const step of attach) {
		try { await step(); } catch (err) { console.error("[durable] recovery attach failed:", err); }
	}
}
