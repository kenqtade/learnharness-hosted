"use client";

/**
 * THE HOSTED REFRESH BANNER (auto-update, multi-user branch). When the
 * server rebuilds itself onto a newer upstream release, open tabs still run
 * the old page code. Every page carries the build id it was built with
 * (next.config bakes LH_BUILD_ID into the bundle); this polls the public
 * /api/version and, once the live build id differs, offers a Refresh.
 *
 * - Polls every 5 minutes and whenever the tab becomes visible again (at
 *   most every 30 s), so a returning user sees it right away.
 * - A tab that is in the BACKGROUND with nothing typed into it reloads
 *   itself, so it is already current when the user comes back. A visible
 *   tab or one holding unsent text is never reloaded under the user.
 * - Desktop (window.lh) has its own updater banner; local builds bake
 *   "dev" and never poll.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCwIcon, XIcon } from "lucide-react";

export const CLIENT_BUILD_ID = process.env.LH_BUILD_ID ?? "dev";
const POLL_MS = 5 * 60_000;
const MIN_GAP_MS = 30_000;

export interface LiveBuild {
	version: string;
	buildId: string;
}

/** True when `live` comes from a different (newer) deployment than this page. */
export function isNewerBuild(live: Partial<LiveBuild> | null | undefined, client: string = CLIENT_BUILD_ID): boolean {
	return !!live?.buildId && live.buildId !== "dev" && client !== "dev" && live.buildId !== client;
}

/** Nothing the user typed would be lost by a reload. */
export function hasUnsentText(doc: Document = document): boolean {
	for (const el of Array.from(doc.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input[type=text], input:not([type])"))) {
		if (el.value.trim()) return true;
	}
	return !!doc.querySelector("[contenteditable=true]:not(:empty)");
}

/** The live build when it differs from this page's build, else null. */
export function useNewBuild(): { live: LiveBuild | null; check: () => void } {
	const [live, setLive] = useState<LiveBuild | null>(null);
	const lastRun = useRef(0);
	const check = useCallback(() => {
		if (CLIENT_BUILD_ID === "dev" || typeof window === "undefined" || window.lh) return;
		const now = Date.now();
		if (now - lastRun.current < MIN_GAP_MS) return;
		lastRun.current = now;
		void fetch("/api/version", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<LiveBuild>) : null))
			.then((data) => {
				if (data && isNewerBuild(data)) setLive(data);
			})
			.catch(() => undefined);
	}, []);
	useEffect(() => {
		check();
		const timer = window.setInterval(() => { lastRun.current = 0; check(); }, POLL_MS);
		const onVisible = () => { if (document.visibilityState === "visible") check(); };
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("focus", onVisible);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("focus", onVisible);
		};
	}, [check]);
	return { live, check };
}

export default function DeployRefreshBanner() {
	const { live } = useNewBuild();
	const [dismissed, setDismissed] = useState<string | null>(null);

	// Background tab, nothing typed: take the new version silently.
	useEffect(() => {
		if (!live) return;
		const maybeReload = () => {
			if (document.visibilityState === "hidden" && !hasUnsentText()) window.location.reload();
		};
		maybeReload();
		document.addEventListener("visibilitychange", maybeReload);
		return () => document.removeEventListener("visibilitychange", maybeReload);
	}, [live]);

	if (!live || live.buildId === dismissed) return null;
	return (
		<div
			data-testid="refresh-banner"
			role="status"
			className="fixed top-3 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
		>
			<div className="text-sm">
				<span className="font-medium">A new version of LearnHarness is available{live.version ? ` (${live.version})` : ""}.</span>
				<span className="text-muted-foreground"> Refresh to load it.</span>
			</div>
			<button
				type="button"
				data-testid="refresh-banner-reload"
				onClick={() => window.location.reload()}
				className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
			>
				<RefreshCwIcon className="size-3.5" aria-hidden="true" />
				Refresh
			</button>
			<button
				type="button"
				aria-label="Dismiss"
				onClick={() => setDismissed(live.buildId)}
				className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<XIcon className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}
