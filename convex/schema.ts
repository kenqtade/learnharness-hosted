import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * LearnHarness storage on Convex (branch feat/convex-store).
 *
 * The app's stores (src/store/*) persist JSON files under the data dir.
 * In Convex mode those files live here instead: one row per file chunk
 * (Convex caps a document at 1 MiB, so big files are split into
 * ~900 KB chunks). `meta` holds one row whose `version` bumps on every
 * write, so a server instance can tell in one cheap query whether its
 * in-memory copy is stale.
 */
export default defineSchema({
	files: defineTable({
		path: v.string(),
		chunk: v.number(),
		chunks: v.number(),
		rev: v.number(),
		data: v.string(),
	}).index("by_path", ["path", "chunk"]),
	meta: defineTable({ key: v.string(), version: v.number() }).index("by_key", ["key"]),
});
