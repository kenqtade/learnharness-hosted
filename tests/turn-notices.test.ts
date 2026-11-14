/**
 * THE CONTINUING NOTICE (reliability wave, 2026-11): the server's
 * deadline-pause notice is NOT a failure — the turn was paused and
 * continues automatically in a fresh server run. The client renders it as a
 * neutral status line, never as the red failed-reply banner.
 *
 * The server's own factory is pinned here on purpose: the client's
 * predicate matches the notice's stable parts, so a wording drift on the
 * server must fail THIS test rather than reach a learner as a red
 * "Something went wrong" banner for a turn that is still running.
 */
import "./helpers/isolated-data-dir.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONTINUING_NOTICE_CLAUSE,
	CONTINUING_NOTICE_PREFIX,
	continuingNoticeStatus,
	isContinuingNotice,
} from "../src/core/turn-notices.ts";
import { continuingTurnText, outOfTimeTurnText } from "../src/server/chat-handler.ts";

describe("isContinuingNotice — the deadline-pause notice is not a failure", () => {
	it("matches the server's own continuing notice", () => {
		const notice = continuingTurnText(270_000, 0, 2);
		assert.equal(isContinuingNotice(notice), true);
		assert.match(notice, /continues automatically/);
		// Every hop of the continuation reads the same way.
		assert.equal(isContinuingNotice(continuingTurnText(270_000, 1, 2)), true);
		assert.equal(isContinuingNotice(continuingTurnText(60_000, 0, 0)), true);
	});

	it("the FINAL out-of-time notice stays an honest error", () => {
		const final = outOfTimeTurnText(270_000);
		assert.equal(isContinuingNotice(final), false);
		assert.match(final, /ran out of time/);
	});

	it("only the stable parts decide — the numbers never do", () => {
		assert.equal(isContinuingNotice(CONTINUING_NOTICE_PREFIX), false, "the prefix alone is not the notice");
		assert.equal(isContinuingNotice(CONTINUING_NOTICE_CLAUSE), false, "the clause alone is not the notice");
		assert.equal(
			isContinuingNotice(`${CONTINUING_NOTICE_PREFIX}: it was paused before the 270 s limit and ${CONTINUING_NOTICE_CLAUSE} in a fresh run.`),
			true,
		);
	});

	it("anything else is not a notice", () => {
		assert.equal(isContinuingNotice(undefined), false);
		assert.equal(isContinuingNotice(null), false);
		assert.equal(isContinuingNotice(""), false);
		assert.equal(isContinuingNotice("Something went wrong: fetch failed"), false);
		assert.equal(isContinuingNotice("The reply could not be saved."), false);
	});
});

describe("continuingNoticeStatus — the neutral status line", () => {
	it("carries the run counter when the notice has one", () => {
		const status = continuingNoticeStatus(continuingTurnText(270_000, 0, 2));
		assert.equal(status, "Still working — this reply continues in a fresh server run (run 2 of at most 3)…");
	});

	it("never depends on the numbers to read as work in progress", () => {
		const status = continuingNoticeStatus("This reply needed more time than one server run allows.");
		assert.equal(status, "Still working — this reply continues in a fresh server run…");
		assert.doesNotMatch(status, /went wrong/i);
	});
});
