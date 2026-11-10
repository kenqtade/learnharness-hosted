import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";

/**
 * The file-store API the Next.js server calls (src/store/vfs.ts).
 *
 * Every function requires `secret` === the deployment's LH_CONVEX_SECRET
 * env var: Convex public functions are reachable by anyone who knows the
 * deployment URL, and this app has no login (single user, by design).
 */
function check(secret: string) {
	const expected = process.env.LH_CONVEX_SECRET;
	if (!expected) throw new Error("LH_CONVEX_SECRET is not set on the Convex deployment");
	if (secret !== expected) throw new Error("unauthorized");
}

async function getVersion(ctx: QueryCtx | MutationCtx) {
	const row = await ctx.db.query("meta").withIndex("by_key", (q) => q.eq("key", "version")).unique();
	return row?.version ?? 0;
}

/** One round trip: the current version, plus the file manifest only when it changed. */
export const sync = query({
	args: { secret: v.string(), since: v.number() },
	handler: async (ctx, { secret, since }) => {
		check(secret);
		const version = await getVersion(ctx);
		if (version === since) return { version, files: null };
		const files: { path: string; rev: number }[] = [];
		for await (const row of ctx.db.query("files")) {
			if (row.chunk === 0) files.push({ path: row.path, rev: row.rev });
		}
		return { version, files };
	},
});

/** Full contents of the given paths (chunks re-joined). Missing paths are omitted. */
export const read = query({
	args: { secret: v.string(), paths: v.array(v.string()) },
	handler: async (ctx, { secret, paths }) => {
		check(secret);
		const out: { path: string; rev: number; data: string }[] = [];
		for (const path of paths) {
			const rows = await ctx.db.query("files").withIndex("by_path", (q) => q.eq("path", path)).collect();
			if (rows.length === 0) continue;
			rows.sort((a, b) => a.chunk - b.chunk);
			const first = rows[0]!;
			if (rows.length !== first.chunks) continue; // torn write can't happen (one mutation), but be safe
			out.push({ path, rev: first.rev, data: rows.map((r) => r.data).join("") });
		}
		return out;
	},
});

const CHUNK = 900_000;

/**
 * Apply an ordered batch of puts/deletes atomically (one Convex
 * transaction). Returns the version before and after, and each written
 * path's new rev, so the caller can tell whether anyone else wrote
 * in between.
 */
export const apply = mutation({
	args: {
		secret: v.string(),
		ops: v.array(v.object({ path: v.string(), data: v.optional(v.string()) })),
	},
	handler: async (ctx, { secret, ops }) => {
		check(secret);
		const before = await getVersion(ctx);
		const after = before + 1;
		const revs: Record<string, number> = {};
		for (const op of ops) {
			const old = await ctx.db.query("files").withIndex("by_path", (q) => q.eq("path", op.path)).collect();
			for (const row of old) await ctx.db.delete(row._id);
			if (op.data === undefined) { revs[op.path] = -1; continue; }
			const parts: string[] = [];
			for (let i = 0; i < op.data.length; i += CHUNK) parts.push(op.data.slice(i, i + CHUNK));
			if (parts.length === 0) parts.push("");
			for (let i = 0; i < parts.length; i++) {
				await ctx.db.insert("files", { path: op.path, chunk: i, chunks: parts.length, rev: after, data: parts[i]! });
			}
			revs[op.path] = after;
		}
		const meta = await ctx.db.query("meta").withIndex("by_key", (q) => q.eq("key", "version")).unique();
		if (meta) await ctx.db.patch(meta._id, { version: after });
		else await ctx.db.insert("meta", { key: "version", version: after });
		return { before, after, revs };
	},
});
