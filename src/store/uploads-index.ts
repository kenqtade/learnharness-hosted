/**
 * HOSTED FORK — the per-user uploads index.
 *
 * ONE small JSON file in the user's data space: `<data dir>/uploads/index.json`.
 * It goes through the storage seam (vfs), so on a hosted deployment it lands
 * in that user's Convex data space and in local runs it lives beside the
 * other stores. Only metadata is stored here; blob bytes stay in Convex
 * storage (src/server/uploads.ts) and never enter the synced text store.
 */
import * as fs from "./vfs.ts";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export interface UploadEntry {
	id: string;
	name: string;
	size: number;
	type: string;
	storageId?: string;
	createdAt: string;
}

interface UploadsIndex {
	version: 1;
	uploads: UploadEntry[];
}

const UPLOADS_DIR = path.join(/* turbopackIgnore: true */ PATHS.data, "uploads");
const INDEX_FILE = path.join(/* turbopackIgnore: true */ UPLOADS_DIR, "index.json");

function isEntry(value: unknown): value is UploadEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === "string" &&
		typeof entry.name === "string" &&
		typeof entry.size === "number" &&
		Number.isFinite(entry.size) &&
		typeof entry.type === "string" &&
		typeof entry.createdAt === "string" &&
		(entry.storageId === undefined || typeof entry.storageId === "string")
	);
}

/** The user's index. Corrupt or unknown shapes read as empty, never guessed. */
export function listUploads(): UploadEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ INDEX_FILE, "utf-8"));
	} catch {
		return [];
	}
	const uploads = (parsed as Partial<UploadsIndex> | null)?.uploads;
	if (!Array.isArray(uploads)) return [];
	return uploads.filter(isEntry).map((entry) => ({ ...entry }));
}

function writeIndex(uploads: UploadEntry[]): void {
	fs.mkdirSync(UPLOADS_DIR, { recursive: true });
	writeFileAtomicSync(INDEX_FILE, JSON.stringify({ version: 1, uploads } satisfies UploadsIndex, null, "\t"));
}

/** Append one entry; a same-id entry is replaced (never duplicated). */
export function addUpload(entry: UploadEntry): UploadEntry {
	const uploads = listUploads().filter((existing) => existing.id !== entry.id);
	uploads.push({ ...entry });
	writeIndex(uploads);
	return { ...entry };
}

/** Remove one entry; returns it, or null when it was not indexed. */
export function removeUpload(id: string): UploadEntry | null {
	const uploads = listUploads();
	const index = uploads.findIndex((entry) => entry.id === id);
	if (index === -1) return null;
	const [removed] = uploads.splice(index, 1);
	writeIndex(uploads);
	return removed ?? null;
}
