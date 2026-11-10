/**
 * WHY this module exists: the hosted app (Vercel) has no desktop updater, so
 * the only way it can pick up a newer upstream LearnHarness release is for a
 * scheduled check to notice it and ask Vercel to rebuild. This module owns
 * that decision — it never touches the deployment itself, and it is inert
 * unless LH_AUTO_UPDATE=1.
 *
 * Every IO is injectable (fetch/env/clock) so the whole flow is testable
 * without the network, and every secret it handles is read from the env
 * seam and never logged.
 */

import fs, { PLATFORM_ROOT } from "../store/vfs.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import packageMetadata from "../../package.json" with { type: "json" };

export type UpdatePhase = "disabled" | "up-to-date" | "update-triggered" | "update-failed" | "error";

export interface UpdateStatus {
	enabled: boolean;
	current: string;
	latest?: string;
	checkedAt?: string;
	state: UpdatePhase;
	message?: string;
	lastAttempt?: {
		version: string;
		at: string;
		deploymentUrl?: string;
		/** Vercel deployment id of the rebuild (to follow its build state). */
		deploymentId?: string;
		/** Last known Vercel build state of that rebuild. */
		buildState?: "building" | "ready" | "failed";
	};
	/** The deployment serving this response (changes on every rebuild):
	 *  browsers compare it with the one they loaded to offer a refresh. */
	buildId?: string;
}

export interface UpdateDeps {
	fetch?: typeof fetch;
	env?: Record<string, string | undefined>;
	now?: () => number;
}

export interface ReleaseInfo {
	tag: string;
	version: string;
	publishedAt: string;
	url: string;
}

// PLATFORM SPACE (multi-user branch): one update status for the whole
// deployment, readable by every account. PATHS.data would follow the
// signed-in member into their own data space.
const STATUS_FILE = path.join(PLATFORM_ROOT, "update-status.json");

/** Identifies the build this server runs. Baked at build time by
 *  next.config (LH_BUILD_ID); the client bundle carries the same value,
 *  so a mismatch means a newer deployment is live. */
// Literal `process.env.LH_BUILD_ID`: next build inlines exactly this form.
const BAKED_BUILD_ID = process.env.LH_BUILD_ID;
export function runningBuildId(env: Record<string, string | undefined> = process.env): string {
	return env.LH_BUILD_ID || BAKED_BUILD_ID || env.VERCEL_DEPLOYMENT_ID || "dev";
}

export function parseVersion(s: string): [number, number, number] | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) throw new Error(`cannot compare version "${a}" and "${b}"`);
	if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
	if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
	if (pa[2] !== pb[2]) return pa[2] < pb[2] ? -1 : 1;
	return 0;
}

export function runningVersion(): string {
	return packageMetadata.version;
}

export function upstreamRepo(env: Record<string, string | undefined> = process.env): string {
	return env.LH_UPSTREAM_REPO || "amosblomqvist/learnharness";
}

export async function fetchLatestRelease(deps: UpdateDeps = {}): Promise<ReleaseInfo> {
	const doFetch = deps.fetch ?? globalThis.fetch;
	const env = deps.env ?? process.env;
	const repo = upstreamRepo(env);
	const url = `https://api.github.com/repos/${repo}/releases/latest`;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "learnharness-updater",
	};
	const token = env.GITHUB_TOKEN;
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	const response = await doFetch(url, { method: "GET", headers });
	if (response.status !== 200) {
		throw new Error(`GitHub release lookup failed (${response.status}) for ${repo}`);
	}
	const body = (await response.json()) as {
		tag_name?: string;
		draft?: boolean;
		prerelease?: boolean;
		published_at?: string;
		html_url?: string;
	};
	if (body.draft) {
		throw new Error(`GitHub release for ${repo} is a draft`);
	}
	if (body.prerelease) {
		throw new Error(`GitHub release for ${repo} is a prerelease`);
	}
	const tag = body.tag_name;
	if (!tag) {
		throw new Error(`GitHub release for ${repo} has no tag`);
	}
	const parsed = parseVersion(tag);
	if (!parsed) {
		throw new Error(`GitHub release tag "${tag}" is not a valid version`);
	}
	return {
		tag,
		version: `${parsed[0]}.${parsed[1]}.${parsed[2]}`,
		publishedAt: body.published_at ?? "",
		url: body.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`,
	};
}

function readStoredStatus(): Partial<UpdateStatus> | null {
	try {
		const raw = fs.readFileSync(STATUS_FILE, "utf-8");
		return JSON.parse(raw) as Partial<UpdateStatus>;
	} catch {
		return null;
	}
}

function writeStatus(full: UpdateStatus): void {
	const { buildId: _perInstance, ...status } = full;
	void _perInstance;
	fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
	const tmp = `${STATUS_FILE}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(status, null, "\t"), "utf-8");
		fs.renameSync(tmp, STATUS_FILE);
	} finally {
		if (fs.existsSync(tmp)) {
			fs.unlinkSync(tmp);
		}
	}
}

const DISABLED_MESSAGE = "Auto-update is off (set LH_AUTO_UPDATE=1)";

export function readUpdateStatus(deps: UpdateDeps = {}): UpdateStatus {
	const env = deps.env ?? process.env;
	const stored = readStoredStatus();
	const enabled = env.LH_AUTO_UPDATE === "1";
	const current = runningVersion();
	if (!enabled) {
		return {
			enabled: false,
			current,
			state: "disabled",
			message: DISABLED_MESSAGE,
		};
	}
	return reconcile({
		...stored,
		enabled,
		current,
		state: stored?.state ?? "up-to-date",
		message: stored?.message ?? "Not checked yet.",
	});
}

/** A stored "rebuild started/failed" record is stale once THIS deployment
 *  already runs that version (the rebuild landed): report up to date. */
function reconcile(status: UpdateStatus): UpdateStatus {
	if ((status.state === "update-triggered" || status.state === "update-failed") && status.latest && parseVersion(status.latest) && compareVersions(status.latest, status.current) <= 0) {
		return { ...status, state: "up-to-date", message: `Up to date (latest upstream release: ${status.latest}).` };
	}
	return status;
}

/** Follow the rebuild we started: Vercel knows whether it is still
 *  building, failed (merge refused / safety gates / build error — the
 *  previous version stays live), or is ready. Never throws. */
export async function refreshBuildState(deps: UpdateDeps = {}): Promise<UpdateStatus> {
	const env = deps.env ?? process.env;
	const status = readUpdateStatus(deps);
	const attempt = status.lastAttempt;
	if (!status.enabled || status.state !== "update-triggered" || !attempt?.deploymentId || !env.LH_VERCEL_TOKEN) return status;
	try {
		const teamId = env.LH_VERCEL_TEAM_ID || env.VERCEL_TEAM_ID;
		const response = await (deps.fetch ?? globalThis.fetch)(
			`https://api.vercel.com/v13/deployments/${encodeURIComponent(attempt.deploymentId)}${teamId ? `?teamId=${teamId}` : ""}`,
			{ method: "GET", headers: { Authorization: `Bearer ${env.LH_VERCEL_TOKEN}` } },
		);
		if (!response.ok) return status;
		const body = (await response.json()) as { readyState?: string };
		const rs = body.readyState;
		const buildState = rs === "READY" ? "ready" : rs === "ERROR" || rs === "CANCELED" ? "failed" : "building";
		if (buildState === attempt.buildState) return status;
		const next: UpdateStatus = { ...status, lastAttempt: { ...attempt, buildState } };
		if (buildState === "failed") {
			next.state = "update-failed";
			next.message = `The update to ${attempt.version} did not pass its safety checks or failed to build, so the current version (${status.current}) stays live. Details are in the Vercel build logs.`;
		} else if (buildState === "ready") {
			next.message = `Version ${attempt.version} is built and going live. Refresh the page to load it.`;
		}
		writeStatus(next);
		return reconcile(next);
	} catch {
		return status;
	}
}

export async function triggerRedeploy(deps: UpdateDeps = {}): Promise<{ url: string; id?: string }> {
	const env = deps.env ?? process.env;
	const token = env.LH_VERCEL_TOKEN;
	const deploymentId = env.VERCEL_DEPLOYMENT_ID;
	if (!token || !deploymentId) {
		throw new Error(token ? "VERCEL_DEPLOYMENT_ID is not set" : "LH_VERCEL_TOKEN is not set");
	}
	const teamId = env.LH_VERCEL_TEAM_ID || env.VERCEL_TEAM_ID;
	const projectName = env.LH_VERCEL_PROJECT_NAME || "learnharness";
	const url = `https://api.vercel.com/v13/deployments?forceNew=1${teamId ? `&teamId=${teamId}` : ""}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
	const body = JSON.stringify({
		name: projectName,
		deploymentId,
		target: "production",
	});
	const response = await (deps.fetch ?? globalThis.fetch)(url, {
		method: "POST",
		headers,
		body,
	});
	if (!response.ok) {
		const errorBody = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
		throw new Error(errorBody.error?.message ?? `Vercel deploy failed (${response.status})`);
	}
	const result = (await response.json()) as { url?: string; id?: string };
	const apiUrl = result.url;
	if (!apiUrl) {
		throw new Error("Vercel deploy response missing url");
	}
	return { url: apiUrl.startsWith("http") ? apiUrl : `https://${apiUrl}`, ...(result.id ? { id: result.id } : {}) };
}

const MS_IN_24H = 24 * 60 * 60 * 1000;

export async function runUpdateCheck(deps: UpdateDeps = {}): Promise<UpdateStatus> {
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	const enabled = env.LH_AUTO_UPDATE === "1";
	const current = runningVersion();
	const stored = readStoredStatus();
	const base: UpdateStatus = {
		...stored,
		enabled,
		current,
		state: stored?.state ?? (enabled ? "up-to-date" : "disabled"),
		message: stored?.message ?? (enabled ? "Not checked yet." : DISABLED_MESSAGE),
	};

	if (!enabled) {
		const record: UpdateStatus = { ...base, state: "disabled", message: DISABLED_MESSAGE };
		writeStatus(record);
		return record;
	}

	let release: ReleaseInfo;
	try {
		release = await fetchLatestRelease(deps);
	} catch (err) {
		const message = (err as Error).message;
		const record: UpdateStatus = { ...base, state: "error", message, checkedAt: new Date(now()).toISOString() };
		writeStatus(record);
		return record;
	}

	const latest = release.version;
	if (compareVersions(latest, current) <= 0) {
		const record: UpdateStatus = { ...base, state: "up-to-date", latest, checkedAt: new Date(now()).toISOString(), message: `Up to date (latest upstream release: ${latest}).` };
		writeStatus(record);
		return record;
	}

	const lastAttempt = stored?.lastAttempt;
	if (lastAttempt?.version === latest && now() - Date.parse(lastAttempt.at) < MS_IN_24H) {
		if (stored?.state === "update-failed") {
			// keep the failure visible; the next retry comes after 24 h
			const record: UpdateStatus = { ...base, state: "update-failed", latest, checkedAt: new Date(now()).toISOString() };
			writeStatus(record);
			return record;
		}
		const message = `The rebuild for ${latest} was already started at ${new Date(lastAttempt.at).toISOString()}. If the app still shows the old version, the merge or build probably failed (see Vercel build logs).`;
		const record: UpdateStatus = { ...base, state: "update-triggered", latest, checkedAt: new Date(now()).toISOString(), message };
		writeStatus(record);
		return record;
	}

	let deployUrl: string | undefined;
	let deployId: string | undefined;
	try {
		const result = await triggerRedeploy(deps);
		deployUrl = result.url;
		deployId = result.id;
	} catch (err) {
		const message = (err as Error).message;
		const record: UpdateStatus = { ...base, state: "error", latest, checkedAt: new Date(now()).toISOString(), message };
		writeStatus(record);
		return record;
	}

	const record: UpdateStatus = {
		...base,
		state: "update-triggered",
		latest,
		checkedAt: new Date(now()).toISOString(),
		message: `A rebuild for ${latest} was started, the app updates when the build succeeds.`,
		lastAttempt: {
			version: latest,
			at: new Date(now()).toISOString(),
			deploymentUrl: deployUrl,
			...(deployId ? { deploymentId: deployId, buildState: "building" as const } : {}),
		},
	};
	writeStatus(record);
	return record;
}

export function secretMatches(provided: string | null | undefined, expected: string): boolean {
	if (!provided) return false;
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) {
		timingSafeEqual(a, a);
		return false;
	}
	return timingSafeEqual(a, b);
}

export function cronSecretMatches(provided: string | null | undefined, expected: string): boolean {
	return secretMatches(provided, expected);
}

// ─── opportunistic checks ───────────────────────────────────────────────
// Vercel Hobby crons run at most daily. So that a new release lands within
// hours, a status read also runs the check once the last one is older than
// CHECK_EVERY_MS. A rebuild for one version still starts at most once per
// 24 h (the guard in runUpdateCheck), so this cannot loop or spam deploys.

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let inflight: Promise<UpdateStatus> | null = null;

/** One check at a time per server instance; concurrent callers share it. */
export function runUpdateCheckOnce(deps: UpdateDeps = {}): Promise<UpdateStatus> {
	inflight ??= runUpdateCheck(deps).finally(() => { inflight = null; });
	return inflight;
}

/** Status for display: checks upstream when the last check is stale,
 *  follows a running rebuild, and stamps this server's build id. */
export async function currentUpdateStatus(deps: UpdateDeps = {}): Promise<UpdateStatus> {
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	let status = readUpdateStatus(deps);
	if (status.enabled) {
		const last = status.checkedAt ? Date.parse(status.checkedAt) : NaN;
		if (!Number.isFinite(last) || now() - last >= CHECK_EVERY_MS) {
			try { await runUpdateCheckOnce(deps); } catch { /* keep the stored status */ }
		}
		status = await refreshBuildState(deps);
	}
	return { ...status, buildId: runningBuildId(env) };
}
