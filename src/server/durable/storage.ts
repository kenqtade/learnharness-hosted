import fs from "node:fs";
import path from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { PATHS } from "../../../config.ts";
import { LibsqlDatabase } from "./libsql.ts";

/**
 * Where durable turns live (DURABLE-PI BRANCH). One protocol, two homes —
 * pi-durable's own SQLite schema either way:
 *
 *   LH_DURABLE_LIBSQL_URL set   → libSQL (Turso when hosted; `file:` works
 *                                  too) + LH_DURABLE_LIBSQL_TOKEN.
 *   otherwise                   → Node's built-in SQLite at
 *                                  <LH_DATA_DIR>/durable/turns.sqlite.
 *
 * A serverless host (Netlify/Vercel) has no persistent disk — /tmp dies with
 * the instance — so hosted MUST set the libSQL URL; the capability probe
 * reports which one is in effect.
 */
export type DurableStorageKind = "node-sqlite" | "libsql";

export function durableStorageKind(): DurableStorageKind {
	return process.env.LH_DURABLE_LIBSQL_URL ? "libsql" : "node-sqlite";
}

export function durableSqlitePath(): string {
	return path.join(PATHS.data, "durable", "turns.sqlite");
}

export async function openDurableStorage(): Promise<Storage> {
	const url = process.env.LH_DURABLE_LIBSQL_URL;
	if (url) {
		const db = LibsqlDatabase.open(url, process.env.LH_DURABLE_LIBSQL_TOKEN || undefined);
		return SqliteStorage.open(db, { prefix: "lh" });
	}
	const file = durableSqlitePath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// Lazy: node:sqlite only exists on Node >= 22.5 (pi itself needs 22.19).
	const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
	return openNodeSqliteStorage(file, { prefix: "lh" });
}
