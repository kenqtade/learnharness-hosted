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

export const convexMode = process.env.LH_STORE === "convex";

// ─── path mapping ─────────────────────────────────────────────────────────

const DATA_ROOT = path.resolve(PATHS.data);
const AUTH_DIR = path.dirname(path.resolve(AUTH_FILE));

/** Convex key for a managed path, or null when the path stays on real fs. */
function keyOf(p: string): string | null {
	const abs = path.resolve(String(p));
	const rel = path.relative(DATA_ROOT, abs);
	if (rel === "") return "data";
	if (!rel.startsWith("..") && !path.isAbsolute(rel)) return `data/${rel.split(path.sep).join("/")}`;
	if (path.dirname(abs) === AUTH_DIR && path.basename(abs).includes("auth")) return `auth/${path.basename(abs)}`;
	return null;
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
	if (key === "data" || dirs.has(key)) return true;
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

function existsSync(p: realFs.PathLike): boolean {
	const key = keyOf(String(p));
	if (!convexMode || key === null) return realFs.existsSync(p);
	return files.has(key) || isDirKey(key);
}

function readFileSync(p: realFs.PathOrFileDescriptor, options?: unknown): any {
	const key = typeof p === "number" ? null : keyOf(String(p));
	if (!convexMode || key === null) return realFs.readFileSync(p, options as any);
	const data = files.get(key);
	if (data === undefined) throw enoent("open", String(p));
	const enc = typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding;
	return enc ? data : Buffer.from(data, "utf-8");
}

function writeFileSync(p: realFs.PathOrFileDescriptor, data: unknown, options?: unknown): void {
	const key = typeof p === "number" ? null : keyOf(String(p));
	if (!convexMode || key === null) return realFs.writeFileSync(p, data as any, options as any);
	put(key, toText(data));
}

function appendFileSync(p: realFs.PathOrFileDescriptor, data: unknown, options?: unknown): void {
	const key = typeof p === "number" ? null : keyOf(String(p));
	if (!convexMode || key === null) return realFs.appendFileSync(p, data as any, options as any);
	put(key, (files.get(key) ?? "") + toText(data));
}

function mkdirSync(p: realFs.PathLike, options?: unknown): any {
	const key = keyOf(String(p));
	if (!convexMode || key === null) return realFs.mkdirSync(p, options as any);
	dirs.add(key);
	return undefined;
}

function readdirSync(p: realFs.PathLike, options: { withFileTypes: true }): Dirent[];
function readdirSync(p: realFs.PathLike, options?: BufferEncoding | { withFileTypes?: false; encoding?: BufferEncoding }): string[];
function readdirSync(p: realFs.PathLike, options?: unknown): any {
	const key = keyOf(String(p));
	if (!convexMode || key === null) return realFs.readdirSync(p, options as any);
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
	const a = keyOf(String(from));
	const b = keyOf(String(to));
	if (!convexMode || (a === null && b === null)) return realFs.renameSync(from, to);
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
	const key = keyOf(String(p));
	if (!convexMode || key === null) return realFs.unlinkSync(p);
	if (!files.has(key)) throw enoent("unlink", String(p));
	del(key);
}

function rmSync(p: realFs.PathLike, options?: realFs.RmOptions): void {
	const key = keyOf(String(p));
	if (!convexMode || key === null) return realFs.rmSync(p, options);
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
	const key = keyOf(String(p));
	if (!convexMode || key === null) return realFs.chmodSync(p, mode);
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
