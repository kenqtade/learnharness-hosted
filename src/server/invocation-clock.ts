/**
 * The invocation clock (reliability wave, 2026-11). Vercel's wall (300 s)
 * counts from the moment the REQUEST started — not from when a turn or a job
 * got going inside it. Compaction, store sync or an earlier turn can use a
 * large share before the turn is even registered, so deadlines must be
 * measured against the invocation's start. withStore (store-ready.ts) runs
 * every route inside this clock; background work started by the request
 * inherits it through AsyncLocalStorage.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const clock = new AsyncLocalStorage<number>();

/** Run `fn` (and everything it starts) on an invocation clock started now. */
export function runWithInvocationClock<T>(fn: () => T, startedAt = Date.now()): T {
	return clock.run(startedAt, fn);
}

/** When the current invocation started, or undefined outside any request. */
export function invocationStartedAt(): number | undefined {
	return clock.getStore();
}

/** What is left of `budgetMs` in the current invocation (never below
 *  `floorMs`). Outside a request the whole budget is left. */
export function remainingInvocationBudget(budgetMs: number, now = Date.now(), floorMs = 1_000): number {
	const start = invocationStartedAt();
	if (start === undefined) return budgetMs;
	return Math.max(floorMs, budgetMs - (now - start));
}
