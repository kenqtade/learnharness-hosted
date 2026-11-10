/**
 * THE STORAGE SEAM (branch feat/convex-store, 2026-11-06).
 *
 * The stores in this folder persist JSON files with synchronous `fs` calls.
 * They import THIS module instead of `node:fs`:
 *
 *   - default (local dev, tests, Electron): every call goes straight to
 *     the real `node:fs` — byte-for-byte the old behaviour;
 *   - `LH_STORE=convex` (Vercel): paths under the data dir (and the auth
 *     file) live in Convex. Reads come from an in-memory copy; writes
 *     update that copy synchronously and are sent to Convex in order by a
 *     background flusher. Nothing touches the local disk.
 *
 * Freshness across serverless instances: `storeReady()` runs at the top of
 * every request. It asks Convex for the global version (one query); if
 * another instance wrote since, it pulls just the changed files. Paths
 * with unsent local writes are never overwritten by that pull.
 *
 * Durability: every write schedules a flush and registers it with
 * Vercel's `waitUntil`, so the function stays alive until Convex has it.
 * `flushStore()` lets callers await it explicitly.
 */
import realFs from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { AUTH_FILE, PATHS } from "../../config.ts";
import { keepAlive } from "../server/keep-alive.ts";
import { currentUser, dataSpaceOf, safeUserId } from "./user-scope.ts";

export const convexMode = process.env.LH_STORE === "convex";

// ─── path mapping ─────────────────────────────────────────────────────────

const DATA_ROOT = path.resolve(PATHS.data);
const AUTH_DIR = path.dirname(path.resolve(AUTH_FILE));
const AUTH_ABS = path.resolve(AUTH_FILE);
/** Platform-wide records (accounts, invites, platform config) — never
 *  inside any user's data space. A sibling of the data dir on real fs. */
export const PLATFORM_ROOT = `${DATA_ROOT}-platform`;
/** Real-fs home of non-owner data spaces (multi-user mode, local runs). */
const USERS_ROOT = `${DATA_ROOT}-users`;

const inside = (rel: string) => !rel.startsWith("..") && !path.isAbsolute(rel);
const posix = (rel: string) => rel.split(path.sep).join("/");

/** The legacy (single-user / owner) key of a path, or null if unmanaged. */
function legacyKey(abs: string): string | null {
	const rel = path.relative(DATA_ROOT, abs);
	if (rel === "") return "data";
	if (inside(rel)) return `data/${posix(rel)}`;
	if (path.dirname(abs) === AUTH_DIR && path.basename(abs).includes("auth")) return `auth/${path.basename(abs)}`;
	return null;
}

interface Target {
	/** Convex key, or null when the path stays on real fs. */
	key: string | null;
	/** The real-fs path to use when not in Convex mode. */
	real: string;
	/** True when the path was moved into a member's data space. */
	scoped: boolean;
	/** Member reads only: where to read when the member has no copy yet
	 *  (INHERITED below). Writes always go to the member's own space. */
	inherit?: { key: string | null; real: string };
}

/** Files a member reads from the owner's space until they save their own:
 *  the settings record (model slots, agent knobs, appearance). Keys are
 *  platform-wide, so without this a new member starts with no models
 *  chosen and cannot chat until they find the Agent settings. */
const INHERITED = new Set(["settings.json"]);

/** Where a path really lives for the CURRENT user (see user-scope.ts). */
function target(p: string): Target {
	const abs = path.resolve(String(p));
	// provider keys are platform-wide: the owner's, for every account
	if (abs === AUTH_ABS) return { key: legacyKey(abs), real: abs, scoped: false };
	const prel = path.relative(PLATFORM_ROOT, abs);
	if (inside(prel)) return { key: prel === "" ? "platform" : `platform/${posix(prel)}`, real: abs, scoped: false };
	const rel = path.relative(DATA_ROOT, abs);
	if (inside(rel)) {
		const space = dataSpaceOf(currentUser());
		if (space !== null) {
			if (!safeUserId(space)) throw new Error("vfs: invalid user id");
			return {
				key: rel === "" ? `users/${space}` : `users/${space}/${posix(rel)}`,
				real: rel === "" ? path.join(USERS_ROOT, space) : path.join(USERS_ROOT, space, rel),
				scoped: true,
				...(INHERITED.has(posix(rel)) ? { inherit: { key: legacyKey(abs), real: abs } } : {}),
			};
		}
	}
	return { key: legacyKey(abs), real: abs, scoped: false };
}

/** Real fs, member space: the space folder may not exist yet. */
function ensureParent(t: Target) {
	if (t.scoped) realFs.mkdirSync(path.dirname(t.real), { recursive: true });
}

// ─── in-memory copy + Convex client ───────────────────────────────────────

const files = new Map<string, string>();
const revs = new Map<string, number>();
const dirs = new Set<string>();
let version = -1;
let lastSync = 0;
let syncing: Promise<void> | null = null;

type Op = { path: string; data?: string };
const pending: Op[] = [];
const dirty = new Map<string, number>(); // key → count of unsent ops
let flushing: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

let client: ConvexHttpClient | null = null;
function convex(): ConvexHttpClient {
	if (client) return client;
	const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
	if (!url) throw new Error("LH_STORE=convex but CONVEX_URL is not set");
	client = new ConvexHttpClient(url);
	return client;
}
function secret(): string {
	const s = process.env.LH_CONVEX_SECRET;
	if (!s) throw new Error("LH_STORE=convex but LH_CONVEX_SECRET is not set");
	return s;
}

// 0 = check the version on every request (one small query): instances
// behind a load balancer must see each other's writes immediately.
const SYNC_TTL_MS = Number(process.env.LH_STORE_SYNC_TTL_MS ?? 0);

async function doSync(): Promise<void> {
	const res = (await convex().query(api.vfs.sync, { secret: secret(), since: version })) as {
		version: number;
		files: { path: string; rev: number }[] | null;
	};
	if (res.files) {
		const remote = new Map(res.files.map((f) => [f.path, f.rev]));
		for (const key of [...files.keys()]) {
			if (!remote.has(key) && !dirty.has(key)) { files.delete(key); revs.delete(key); }
		}
		const stale = [...remote].filter(([k, r]) => revs.get(k) !== r && !dirty.has(k)).map(([k]) => k);
		for (let i = 0; i < stale.length; i += 50) {
			const rows = (await convex().query(api.vfs.read, { secret: secret(), paths: stale.slice(i, i + 50) })) as {
				path: string; rev: number; data: string;
			}[];
			for (const row of rows) {
				if (dirty.has(row.path)) continue;
				files.set(row.path, row.data);
				revs.set(row.path, row.rev);
			}
		}
	}
	version = res.version;
	lastSync = Date.now();
}

/**
 * Await before touching a store in a request. No-op on real fs. In Convex
 * mode: first call hydrates everything; later calls re-check the version
 * (at most every SYNC_TTL_MS) and pull only what changed.
 */
export async function storeReady(force = false): Promise<void> {
	if (!convexMode) return;
	if (!force && version >= 0 && SYNC_TTL_MS > 0 && Date.now() - lastSync < SYNC_TTL_MS) return;
	if (!syncing) syncing = doSync().finally(() => { syncing = null; });
	await syncing;
}

function enqueue(op: Op) {
	pending.push(op);
	dirty.set(op.path, (dirty.get(op.path) ?? 0) + 1);
	if (!flushTimer) {
		// a short debounce coalesces bursts (a turn saves often) into one
		// Convex call; keepAlive holds a serverless function open until sent
		keepAlive(new Promise<void>((resolve) => {
			flushTimer = setTimeout(() => {
				flushTimer = null;
				flushStore().then(resolve, (err) => { console.error("[store] flush failed:", err); resolve(); });
			}, 25);
		}));
	}
}

const MAX_BATCH_BYTES = 6_000_000;

async function flushOnce(): Promise<void> {
	while (pending.length > 0) {
		// coalesce: only the LAST op per path in this window matters
		const window = pending.splice(0, pending.length);
		const last = new Map<string, Op>();
		for (const op of window) last.set(op.path, op);
		const ops = [...last.values()];
		let batch: Op[] = [];
		let bytes = 0;
		const send = async (b: Op[]) => {
			let attempt = 0;
			for (;;) {
				try {
					const res = (await convex().mutation(api.vfs.apply, { secret: secret(), ops: b })) as {
						before: number; after: number; revs: Record<string, number>;
					};
					for (const [k, r] of Object.entries(res.revs)) { if (r >= 0) revs.set(k, r); else revs.delete(k); }
					// only advance our version if nobody else wrote in between
					if (res.before === version) version = res.after;
					return;
				} catch (err) {
					if (++attempt >= 5) throw err;
					await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
				}
			}
		};
		let failed = false;
		try {
			for (const op of ops) {
				const size = (op.data?.length ?? 0) + op.path.length;
				if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) { await send(batch); batch = []; bytes = 0; }
				batch.push(op); bytes += size;
			}
			if (batch.length > 0) await send(batch);
		} catch (err) {
			// put the window back so the next flush retries it, in order
			pending.unshift(...window);
			failed = true;
			console.error("[store] Convex write failed — will retry:", (err as Error).message);
		}
		if (failed) {
			setTimeout(() => keepAlive(flushStore()), 2_000);
			return; // the window is still pending, so its paths stay dirty
		}
		for (const op of window) {
			const n = (dirty.get(op.path) ?? 1) - 1;
			if (n <= 0) dirty.delete(op.path); else dirty.set(op.path, n);
		}
	}
}

/** Resolve once every write made so far is in Convex. No-op on real fs. */
export async function flushStore(): Promise<void> {
	if (!convexMode) return;
	while (flushing) await flushing;
	if (pending.length === 0) return;
	flushing = flushOnce().finally(() => { flushing = null; });
	await flushing;
}

/** Test/import helper: the in-memory view (Convex mode only). */
export function storeSnapshot(): ReadonlyMap<string, string> { return files; }

// ─── the fs subset the stores use ─────────────────────────────────────────

function enoent(syscall: string, p: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), {
		code: "ENOENT", errno: -2, syscall, path: p,
	});
}
function isDirKey(key: string): boolean {
	if (key === "data" || key === "platform" || /^users\/[^/]+$/.test(key) || dirs.has(key)) return true;
	const prefix = `${key}/`;
	for (const k of files.keys()) if (k.startsWith(prefix)) return true;
	return false;
}
function put(key: string, data: string) { files.set(key, data); enqueue({ path: key, data }); }
function del(key: string) { files.delete(key); revs.delete(key); enqueue({ path: key }); }
function toText(data: unknown): string {
	if (typeof data === "string") return data;
	if (data instanceof Uint8Array) return Buffer.from(data).toString("utf-8");
	return String(data);
}

class VDirent {
	constructor(readonly name: string, private readonly dir: boolean) {}
	isFile() { return !this.dir; }
	isDirectory() { return this.dir; }
	isSymbolicLink() { return false; }
}

export type Dirent = realFs.Dirent;

/** A member's inherited file falls back to the owner's copy until the
 *  member writes their own (see INHERITED). */
function readable(t: Target): Target {
	if (!t.inherit) return t;
	const own = !convexMode || t.key === null ? realFs.existsSync(t.real) : files.has(t.key);
	return own ? t : { key: t.inherit.key, real: t.inherit.real, scoped: false };
}

function existsSync(p: realFs.PathLike): boolean {
	const t = readable(target(String(p)));
	if (!convexMode || t.key === null) return realFs.existsSync(t.real);
	return files.has(t.key) || isDirKey(t.key);
}

function readFileSync(p: realFs.PathOrFileDescriptor, options?: unknown): any {
	if (typeof p === "number") return realFs.readFileSync(p, options as any);
	const t = readable(target(String(p)));
	if (!convexMode || t.key === null) return realFs.readFileSync(t.real, options as any);
	const data = files.get(t.key);
	if (data === undefined) throw enoent("open", String(p));
	const enc = typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding;
	return enc ? data : Buffer.from(data, "utf-8");
}

function writeFileSync(p: realFs.PathOrFileDescriptor, data: unknown, options?: unknown): void {
	if (typeof p === "number") return realFs.writeFileSync(p, data as any, options as any);
	const t = target(String(p));
	if (!convexMode || t.key === null) { ensureParent(t); return realFs.writeFileSync(t.real, data as any, options as any); }
	put(t.key, toText(data));
}

function appendFileSync(p: realFs.PathOrFileDescriptor, data: unknown, options?: unknown): void {
	if (typeof p === "number") return realFs.appendFileSync(p, data as any, options as any);
	const t = target(String(p));
	if (!convexMode || t.key === null) { ensureParent(t); return realFs.appendFileSync(t.real, data as any, options as any); }
	put(t.key, (files.get(t.key) ?? "") + toText(data));
}

function mkdirSync(p: realFs.PathLike, options?: unknown): any {
	const t = target(String(p));
	if (!convexMode || t.key === null) { ensureParent(t); return realFs.mkdirSync(t.real, options as any); }
	dirs.add(t.key);
	return undefined;
}

function readdirSync(p: realFs.PathLike, options: { withFileTypes: true }): Dirent[];
function readdirSync(p: realFs.PathLike, options?: BufferEncoding | { withFileTypes?: false; encoding?: BufferEncoding }): string[];
function readdirSync(p: realFs.PathLike, options?: unknown): any {
	const t = target(String(p));
	if (!convexMode || t.key === null) return realFs.readdirSync(t.real, options as any);
	const key = t.key;
	if (!isDirKey(key)) throw enoent("scandir", String(p));
	const prefix = `${key}/`;
	const names = new Map<string, boolean>(); // name → isDir
	for (const k of files.keys()) {
		if (!k.startsWith(prefix)) continue;
		const rest = k.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash === -1) { if (!names.has(rest)) names.set(rest, false); }
		else names.set(rest.slice(0, slash), true);
	}
	for (const d of dirs) {
		if (d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) names.set(d.slice(prefix.length), true);
	}
	const sorted = [...names.keys()].sort();
	const withTypes = typeof options === "object" && options !== null && (options as { withFileTypes?: boolean }).withFileTypes;
	return withTypes ? sorted.map((n) => new VDirent(n, names.get(n)!)) : sorted;
}

function renameSync(from: realFs.PathLike, to: realFs.PathLike): void {
	const ta = target(String(from));
	const tb = target(String(to));
	const a = ta.key;
	const b = tb.key;
	if (!convexMode || (a === null && b === null)) { ensureParent(tb); return realFs.renameSync(ta.real, tb.real); }
	if (a === null || b === null) throw new Error(`vfs: cannot rename across storage (${from} → ${to})`);
	const data = files.get(a);
	if (data !== undefined) {
		files.delete(a); revs.delete(a);
		// the tmp file was never meant to persist: drop its pending put if
		// it's still queued, then write the final path
		put(b, data);
		enqueue({ path: a });
		return;
	}
	if (!isDirKey(a)) throw enoent("rename", String(from));
	const prefix = `${a}/`;
	for (const k of [...files.keys()]) {
		if (k.startsWith(prefix)) { const d = files.get(k)!; del(k); put(`${b}/${k.slice(prefix.length)}`, d); }
	}
	dirs.delete(a); dirs.add(b);
}

function unlinkSync(p: realFs.PathLike): void {
	const t = target(String(p));
	if (!convexMode || t.key === null) return realFs.unlinkSync(t.real);
	if (!files.has(t.key)) throw enoent("unlink", String(p));
	del(t.key);
}

function rmSync(p: realFs.PathLike, options?: realFs.RmOptions): void {
	const t = target(String(p));
	if (!convexMode || t.key === null) return realFs.rmSync(t.real, options);
	const key = t.key;
	if (files.has(key)) { del(key); return; }
	if (isDirKey(key)) {
		if (!options?.recursive) throw Object.assign(new Error(`EISDIR: ${p}`), { code: "ERR_FS_EISDIR" });
		const prefix = `${key}/`;
		for (const k of [...files.keys()]) if (k.startsWith(prefix)) del(k);
		for (const d of [...dirs]) if (d === key || d.startsWith(prefix)) dirs.delete(d);
		return;
	}
	if (!options?.force) throw enoent("rm", String(p));
}

function chmodSync(p: realFs.PathLike, mode: realFs.Mode): void {
	const t = target(String(p));
	if (!convexMode || t.key === null) return realFs.chmodSync(t.real, mode);
	// modes have no meaning in Convex; access is gated by LH_CONVEX_SECRET
}

const vfs = {
	existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync,
	readdirSync, renameSync, unlinkSync, rmSync, chmodSync,
};
export {
	existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync,
	readdirSync, renameSync, unlinkSync, rmSync, chmodSync,
};
export default vfs;
