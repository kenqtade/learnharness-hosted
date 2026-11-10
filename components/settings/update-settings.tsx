"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { SettingsRow, Toggle } from "./controls.tsx";

/** Observational snapshot from electron/main.cjs; never updater permission. */
export type UpdateState = {
	status: "idle" | "checking" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";
	version: string | null;
	revision: number;
};

/** Hosted update status from the auto-update API. */
export type HostedUpdateStatus = {
	enabled: boolean;
	current: string;
	latest?: string;
	checkedAt?: string;
	state: "disabled" | "up-to-date" | "update-triggered" | "error";
	message?: string;
	lastAttempt?: {
		version: string;
		at: string;
		deploymentUrl?: string;
	};
};

export const APP_VERSION = process.env.LH_VERSION ?? "";
const HOMEPAGE = process.env.LH_HOMEPAGE ?? "";
export const MANUAL_UPDATE_HINT = "Checking downloads available updates. Downloaded updates install when you quit the app.";
export const AUTO_UPDATE_HINT = "Check at startup and every 24 hours. Turning this off does not stop updates already in progress or ready to install.";
const UPDATE_ERROR = "Couldn’t check for updates. Try again later.";

/**
 * Hosted case: fetch status from /api/update. Returns null if check fails.
 * Gated to only run on hosted (non-desktop) environments.
 */
export function useHostedUpdateStatus(enabled: boolean = true) {
	const [status, setStatus] = useState<HostedUpdateStatus | null>(null);
	const [loading, setLoading] = useState(enabled);
	const [error, setError] = useState(false);

	const fetchStatus = async () => {
		try {
			const res = await fetch("/api/update", { method: "GET" });
			if (!res.ok) throw new Error("Failed to fetch");
			const data = (await res.json()) as HostedUpdateStatus;
			setStatus(data);
			setError(false);
		} catch {
			setError(true);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (enabled) fetchStatus();
		else setLoading(false);
	}, [enabled]);

	return { status, loading, error, refresh: fetchStatus };
}

/** Subscribe before requesting the snapshot. IPC replies and pushes can
 *  cross; a revision prevents an older reply from hiding a newer event.
 *  The banner shares this read-only observer so late loads recover too. */
export function useUpdateState() {
	const [state, setState] = useState<UpdateState | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const lh = window.lh;
		if (!lh) return;
		let live = true;
		let revision = -1;
		const accept = (next: UpdateState) => {
			if (!live || next.revision < revision) return;
			revision = next.revision;
			setState(next);
			setFailed(false);
		};
		const off = lh.onUpdateStatus?.(accept);
		void lh.getUpdateState?.().then(accept).catch(() => {
			if (live && revision === -1) setFailed(true);
		});
		return () => { live = false; off?.(); };
	}, []);
	return { state, failed };
}

export function updateStatusText(state: UpdateState | null): string | null {
	switch (state?.status) {
		case "checking": return "Checking for updates…";
		case "downloading": return state.version ? `Downloading version ${state.version}…` : "Downloading an update…";
		case "up-to-date": return "No newer version was found at the last check.";
		case "downloaded": return `${state.version ? `Version ${state.version}` : "An update"} is ready. It will install when you quit the app.`;
		case "error": return UPDATE_ERROR;
		default: return null;
	}
}

export function hostedStatusText(status: HostedUpdateStatus | null): string | null {
	if (!status) return null;
	if (!status.enabled) return "Auto-update is off (set LH_AUTO_UPDATE=1)";
	switch (status.state) {
		case "up-to-date": return `Up to date (latest upstream release: ${status.latest ?? "unknown"})`;
		case "update-triggered": return status.message ?? "Update triggered.";
		case "error": return status.message ?? UPDATE_ERROR;
		default: return null;
	}
}

/** Format the last checked time relative to now */
function formatCheckedAt(checkedAt?: string): string {
	if (!checkedAt) return "never";
	const when = new Date(checkedAt);
	const now = new Date();
	const diffMs = now.getTime() - when.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);
	if (diffMins < 0) return "in the future";
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
	if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
	if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
	return when.toLocaleString();
}

/** Version information is useful everywhere; update controls only belong
 *  to a shell with an available updater. Opening this row never checks. */
export function UpdateSettings({
	autoUpdate,
	onAutoUpdateChange,
	version = APP_VERSION,
	homepage = HOMEPAGE,
}: {
	autoUpdate: boolean;
	onAutoUpdateChange: (on: boolean) => void;
	version?: string;
	homepage?: string;
}) {
	const { state, failed } = useUpdateState();
	const isDesktop = typeof window !== "undefined" && !!window.lh;

	// Desktop: use IPC-based status
	const desktopActive = state !== null && state.status !== "disabled";
	const desktopBusy = state?.status === "checking" || state?.status === "downloading";
	const desktopCheck = () => {
		setCheckFailed(false);
		void window.lh?.checkForUpdates?.().catch(() => setCheckFailed(true));
	};

	// Hosted: use API-based status (gated to non-desktop)
	const { status: hostedStatus, loading: hostedLoading, error: hostedError, refresh } = useHostedUpdateStatus(!isDesktop);
	const [checkFailed, setCheckFailed] = useState(false);
	const [checking, setChecking] = useState(false);
	useEffect(() => setCheckFailed(false), [hostedStatus]);

	// Hosted: use API-based status
	const hostedEnabled = hostedStatus?.enabled ?? false;
	const hostedActive = hostedEnabled;
	const hostedCheck = async () => {
		setCheckFailed(false);
		setChecking(true);
		try {
			const res = await fetch("/api/update", { method: "POST" });
			if (!res.ok) throw new Error("Check failed");
			await refresh();
		} catch {
			setCheckFailed(true);
		}
	};

	const active = isDesktop ? desktopActive : hostedActive;
	const busy = isDesktop ? desktopBusy : (hostedLoading || checking);

	// Desktop: when isDesktop && active, state is guaranteed non-null (see desktopActive definition)
	const desktopState = isDesktop && active ? state! : null;
	const desktopStatusText = desktopState ? updateStatusText(desktopState) : null;

	const status = isDesktop
	? failed || checkFailed ? UPDATE_ERROR
		: desktopStatusText
	: !active ? (hostedStatus !== null && !hostedEnabled ? "Auto-update is off (set LH_AUTO_UPDATE=1)"
		: hostedStatus !== null ? hostedStatusText(hostedStatus)
		: null)
	: (failed || checkFailed || hostedError) ? UPDATE_ERROR
	: hostedStatus?.state === "error" ? hostedStatus.message ?? UPDATE_ERROR
	: hostedStatus?.message ?? hostedStatusText(hostedStatus);

	const releaseNotes = version && homepage ? `${homepage}/releases/tag/v${version}` : null;

	return (
		<>
			<SettingsRow
				label={`Version ${version || "unknown"}`}
				testid="row-version"
				hint={
					<>
						{status && <span className="block" role="status" data-testid="update-status">{status}</span>}
						{active && <span className="block">{MANUAL_UPDATE_HINT}</span>}
						{!hostedEnabled && !isDesktop && (
							<span className="block text-muted-foreground font-normal">Auto-update is off (set LH_AUTO_UPDATE=1)</span>
						)}
						{releaseNotes && <a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">Release notes</a>}
						{hostedStatus?.checkedAt && (
							<span className="block text-xs text-muted-foreground">Last checked: {formatCheckedAt(hostedStatus.checkedAt)}</span>
						)}
					</>
				}
			>
				{active && (isDesktop ? (
					desktopState?.status === "downloaded" ? (
						<Button type="button" size="xs" className="cursor-pointer" data-testid="update-restart" onClick={() => window.lh?.installUpdate?.()}>Restart</Button>
					) : (
						<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={busy} aria-busy={busy} onClick={desktopCheck}>
							{desktopBusy && <BrailleSpinner label={desktopStatusText === "Downloading an update…" ? "Downloading update" : "Checking for updates"} />}
							Check for updates
						</Button>
					)
				) : (
					<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={busy} aria-busy={busy} onClick={hostedCheck}>
						{busy && <BrailleSpinner label="Checking for updates" />}
						Check now
					</Button>
				))}
			</SettingsRow>
			{active && (
				<SettingsRow label="Automatic updates" hint={AUTO_UPDATE_HINT} testid="row-auto-update">
					<Toggle checked={autoUpdate} label="auto update" onChange={onAutoUpdateChange} />
				</SettingsRow>
			)}
		</>
	);
}
