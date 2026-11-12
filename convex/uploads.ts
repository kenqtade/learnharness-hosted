/**
 * HOSTED FORK — blob storage for learner uploads.
 *
 * Vercel caps a request body at 4.5 MB, so uploads never pass through our
 * API: the browser asks for a Convex upload URL, PUTs the file directly to
 * Convex storage, then tells our API the returned storage id. These functions
 * are the only server-side blob operations (src/server/uploads.ts wraps
 * them). Blob bytes never enter the text store in convex/vfs.ts.
 *
 * Every function requires `secret` === LH_CONVEX_SECRET (copy of the check
 * in convex/vfs.ts): Convex public functions are reachable by anyone who
 * knows the deployment URL.
 */
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel.js";
import { v } from "convex/values";

function check(secret: string) {
	const expected = process.env.LH_CONVEX_SECRET;
	if (!expected) throw new Error("LH_CONVEX_SECRET is not set on the Convex deployment");
	if (secret !== expected) throw new Error("unauthorized");
}

/** A one-shot URL the browser PUTs the file to. */
export const generateUploadUrl = mutation({
	args: { secret: v.string() },
	handler: async (ctx, { secret }) => {
		check(secret);
		return await ctx.storage.generateUploadUrl();
	},
});

/** Size + content type of a stored blob, or null when it does not exist. */
export const info = query({
	args: { secret: v.string(), storageId: v.string() },
	handler: async (ctx, { secret, storageId }) => {
		check(secret);
		const row = await ctx.db.system.get("_storage", storageId as Id<"_storage">);
		if (!row) return null;
		return { size: row.size, contentType: row.contentType ?? null };
	},
});

/** A download URL for the blob, or null when it does not exist. */
export const url = query({
	args: { secret: v.string(), storageId: v.string() },
	handler: async (ctx, { secret, storageId }) => {
		check(secret);
		return await ctx.storage.getUrl(storageId as Id<"_storage">);
	},
});

/** Delete a blob. Deleting a missing blob is a no-op. */
export const remove = mutation({
	args: { secret: v.string(), storageId: v.string() },
	handler: async (ctx, { secret, storageId }) => {
		check(secret);
		await ctx.storage.delete(storageId as Id<"_storage">);
		return null;
	},
});
