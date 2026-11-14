"use client";

/**
 * THE SHARED TURN-BUSY LEDGER: which chats have a turn in flight in THIS
 * window.
 *
 * The hosted refresh banner (components/deploy-refresh-banner.tsx) reloads a
 * HIDDEN tab by itself, so a background tab is already current when the
 * learner comes back. That reload must never happen while a turn is in
 * flight: it would drop the window's only attachment to that turn — and for
 * a turn running on ANOTHER instance, its only liveness channel (the record
 * watch would restart, but the in-flight reply's rendering would be lost).
 *
 * A tiny module-level ledger (no context): both consumers are client
 * components of the same window, and "a turn is running" is a fact about
 * the WINDOW, not about a React tree. The ledger lives on globalThis so
 * duplicated module instances (a second bundle of the same file) still
 * share one truth.
 */

interface TurnBusyGlobal {
	__lhTurnBusy?: Set<string>;
}

function ledger(): Set<string> {
	const g = globalThis as typeof globalThis & TurnBusyGlobal;
	return (g.__lhTurnBusy ??= new Set<string>());
}

/** Record (or clear) that this chat's turn is in flight. */
export function setTurnBusy(chatId: string, busy: boolean): void {
	if (busy) ledger().add(chatId);
	else ledger().delete(chatId);
}

/** Is ANY chat's turn in flight in this window? */
export function anyTurnBusy(): boolean {
	return ledger().size > 0;
}

/** The busy chats (diagnostics and tests). */
export function busyChatIds(): string[] {
	return [...ledger()];
}
