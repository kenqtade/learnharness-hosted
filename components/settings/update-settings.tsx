"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { SettingsRow, Toggle } from "./controls.tsx";
import { useMe } from "@/components/account/use-me";
import { useNewBuild } from "@/components/deploy-refresh-banner";

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
	state: "disabled" | "up-to-date" | "update-triggered" | "update-failed" | "error";
	message?: string;
	lastAttempt?: {
		version: string;
		at: string;
		deploymentUrl?: string;
		buildState?: "building" | "ready" | "failed";
	};
	buildId?: string;
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

/** Hosted status line. `canManage` = the owner (or a single-user server):
 *  members get the same facts without operator instructions/diagnostics. */
export function hostedStatusText(status: HostedUpdateStatus | null, canManage = true): string | null {
	if (!status) return null;
	if (!status.enabled) return canManage ? HOSTED_OFF_OWNER : HOSTED_OFF_MEMBER;
	switch (status.state) {
		case "up-to-date": return status.latest ? `Up to date — ${status.latest} is the latest release.` : "Up to date.";
		case "update-triggered":
			return status.lastAttempt?.buildState === "ready" && status.message
				? status.message
				: `Updating to ${status.latest ?? "the latest release"}… The new version is being built and checked; open pages will offer a refresh when it is live.`;
		case "update-failed": return canManage ? status.message ?? UPDATE_ERROR : `An update to ${status.latest ?? "a newer release"} is waiting on a fix; this version stays in use meanwhile.`;
		case "error": return canManage ? status.message ?? UPDATE_ERROR : "The last update check didn’t complete; it will retry automatically.";
		default: return null;
	}
}

export const HOSTED_OFF_OWNER = "Automatic updates are off on this server (set LH_AUTO_UPDATE=1 in the deployment settings).";
export const HOSTED_OFF_MEMBER = "Automatic updates are off on this server.";
export const HOSTED_AUTO_HINT = "This server checks for new LearnHarness releases every few hours and installs them by rebuilding itself — your data stays as it is. Open pages offer a refresh once the new version is live.";

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
	const isDesktop = typeof window !== "undefined" && !!window.lh;
	if (!isDesktop) return <HostedUpdateRows version={version} homepage={homepage} />;
	return <DesktopUpdateRows autoUpdate={autoUpdate} onAutoUpdateChange={onAutoUpdateChange} version={version} homepage={homepage} />;
}

function DesktopUpdateRows({
	autoUpdate,
	onAutoUpdateChange,
	version,
	homepage,
}: {
	autoUpdate: boolean;
	onAutoUpdateChange: (on: boolean) => void;
	version: string;
	homepage: string;
}) {
	const { state, failed } = useUpdateState();
	const [checkFailed, setCheckFailed] = useState(false);
	useEffect(() => setCheckFailed(false), [state]);
	const active = state !== null && state.status !== "disabled";
	const busy = state?.status === "checking" || state?.status === "downloading";
	const status = state?.status === "downloaded" ? updateStatusText(state)
		: failed || checkFailed ? UPDATE_ERROR : updateStatusText(state);
	const releaseNotes = version && homepage ? `${homepage}/releases/tag/v${version}` : null;
	const check = () => {
		setCheckFailed(false);
		void window.lh?.checkForUpdates?.().catch(() => setCheckFailed(true));
	};

	return (
		<>
			<SettingsRow
				label={`Version ${version || "unknown"}`}
				testid="row-version"
				hint={
					<>
						{status && <span className="block" role="status" data-testid="update-status">{status}</span>}
						{active && <span className="block">{MANUAL_UPDATE_HINT}</span>}
						{releaseNotes && <a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">Release notes</a>}
					</>
				}
			>
				{active && (state.status === "downloaded" ? (
					<Button type="button" size="xs" className="cursor-pointer" data-testid="update-restart" onClick={() => window.lh?.installUpdate?.()}>Restart</Button>
				) : (
					<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={busy} aria-busy={busy} onClick={check}>
						{busy && <BrailleSpinner label={state.status === "downloading" ? "Downloading update" : "Checking for updates"} />}
						Check for updates
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

/** HOSTED (web) update rows. The server updates itself (cron + checks on
 *  status reads); this shows where it stands. The owner — or anyone on a
 *  single-user server — can start a check; members only read. Everyone
 *  gets Refresh once a newer deployment than this page is live. */
function HostedUpdateRows({ version, homepage }: { version: string; homepage: string }) {
	const me = useMe();
	const canManage = me !== null && (!me.multiUser || me.user?.role === "owner");
	const { status, loading, error, refresh } = useHostedUpdateStatus(true);
	const { live, check } = useNewBuild();
	const [checking, setChecking] = useState(false);
	const [checkFailed, setCheckFailed] = useState(false);
	const checkNow = async () => {
		setCheckFailed(false);
		setChecking(true);
		try {
			const res = await fetch("/api/update", { method: "POST" });
			if (!res.ok) throw new Error("Check failed");
			await refresh();
			check();
		} catch {
			setCheckFailed(true);
		} finally {
			setChecking(false);
		}
	};
	const busy = loading || checking;
	const failedNow = checkFailed || (error && !status);
	const line = failedNow ? UPDATE_ERROR : hostedStatusText(status, canManage);
	const shown = version || status?.current || "";
	const releaseNotes = shown && homepage ? `${homepage}/releases/tag/v${shown}` : null;
	const warn = status?.state === "update-failed" || status?.state === "error" || failedNow;
	return (
		<>
			<SettingsRow
				label={`Version ${shown || "unknown"}`}
				testid="row-version"
				hint={
					<>
						{line && <span className={`block ${warn ? "text-amber-400" : ""}`} role="status" data-testid="update-status">{line}</span>}
						{live && <span className="block text-foreground" data-testid="update-live">Version {live.version} is live — refresh to load it.</span>}
						{status?.enabled && status.checkedAt && (
							<span className="block text-xs text-muted-foreground" data-testid="update-checked-at">Last checked: {formatCheckedAt(status.checkedAt)}</span>
						)}
						{releaseNotes && <a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">Release notes</a>}
					</>
				}
			>
				<div className="flex items-center gap-2">
					{live && (
						<Button type="button" size="xs" className="cursor-pointer" data-testid="update-refresh" onClick={() => window.location.reload()}>Refresh</Button>
					)}
					{canManage && status?.enabled && (
						<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={busy} aria-busy={busy} onClick={checkNow}>
							{checking && <BrailleSpinner label="Checking for updates" />}
							Check for updates now
						</Button>
					)}
				</div>
			</SettingsRow>
			{status?.enabled && (
				<SettingsRow
					label="Automatic updates"
					testid="row-hosted-auto-update"
					hint={<>{HOSTED_AUTO_HINT}{!canManage && me?.multiUser && <span className="block">Managed by the owner of this server.</span>}</>}
				>
					<span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground" data-testid="hosted-auto-on">On</span>
				</SettingsRow>
			)}
		</>
	);
}
