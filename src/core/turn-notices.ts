/**
 * TURN NOTICES (client half, reliability wave, 2026-11): the server's
 * deadline-pause notice is NOT a failure — the turn is PAUSED and continues
 * automatically in a fresh server run (src/server/chat-handler.ts
 * continuingTurnText). The learner must never see it as the red
 * failed-reply banner: a red banner reads as "your reply broke", invites a
 * Retry that races the continuation, and (on a multi-instance host) leaves
 * the session looking dead while the answer is still being written.
 *
 * The predicate matches the notice's STABLE parts only — its opening clause
 * and the continuation clause — never the numbers (the budget seconds and
 * the run counter change with the hop and the budget). The FINAL notice
 * ("This reply ran out of time: …") carries no continuation clause, so it
 * stays an honest error.
 *
 * Pure and browser-safe: the shell may import it through "@/src/core".
 */

/** The stable opening of the server's continuing notice. */
export const CONTINUING_NOTICE_PREFIX = "This reply needed more time than one server run allows";

/** The stable clause that makes the notice a continuation, not a failure. */
export const CONTINUING_NOTICE_CLAUSE = "continues automatically";

/**
 * Is this failure text the server's continuing-turn notice?
 *
 * @param text the assistant message's errorMessage (or any banner text)
 */
export function isContinuingNotice(text: string | undefined | null): boolean {
	if (!text) return false;
	return text.includes(CONTINUING_NOTICE_PREFIX) && text.includes(CONTINUING_NOTICE_CLAUSE);
}

/**
 * The learner-facing status line for a continuing turn: NEUTRAL, never the
 * failed-reply styling. The run counter is carried over when the notice has
 * one ("run 2 of at most 3"); the wording never depends on it.
 */
export function continuingNoticeStatus(text: string): string {
	const run = /\(run (\d+) of at most (\d+)\)/.exec(text);
	const runs = run ? ` (run ${run[1]} of at most ${run[2]})` : "";
	return `Still working — this reply continues in a fresh server run${runs}…`;
}

/** Shown when the chat still ends on the continuing notice but NO turn runs
 *  anywhere any more: the continuation never started (or died). Honest, calm,
 *  and paired with Retry in the chat view. */
export const CONTINUATION_LOST_TEXT = "This reply was interrupted before it could finish. Retry to continue it.";
