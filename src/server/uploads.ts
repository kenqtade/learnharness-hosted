/**
 * HOSTED FORK — learner uploads (blob storage + the per-user index).
 *
 * The browser uploads straight to Convex file storage (Vercel caps a request
 * body at 4.5 MB; files may be 25 MB), then calls this module with the
 * storage id. Only metadata goes into the user's data space
 * (src/store/uploads-index.ts); blob bytes never enter the text store.
 *
 * The learner file tools still see ordinary files: materializeUploads()
 * downloads the indexed blobs into the user's uploads folder before a turn
 * or job starts (src/server/hosted-files.ts userUploadsDir). It is a no-op
 * on desktop/local runs where hostedFileAccess() is false.
 *
 * Tests set VERCEL=1 without Convex and inject a fake blob backend through
 * setUploadsBlobBackend(); production always uses the Convex functions in
 * convex/uploads.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { addUpload, listUploads, removeUpload, type UploadEntry } from "../store/uploads-index.ts";
import { convexMode } from "../store/vfs.ts";
import { hostedFileAccess, userUploadsDir } from "./hosted-files.ts";

export const uploadLimits = {
	/** 25 MB per file (the browser also checks this before uploading). */
	maxFileBytes: 25 * 1024 * 1024,
	/** 200 MB and 100 files per user. */
	maxTotalBytes: 200 * 1024 * 1024,
	maxFiles: 100,
} as const;

export interface UploadBlobInfo {
	size: number;
	contentType: string | null;
}

/** The blob operations uploads need. Production talks to Convex; tests
 *  inject a temp-file fake. */
export interface UploadBlobBackend {
	uploadUrl(): Promise<string>;
	info(storageId: string): Promise<UploadBlobInfo | null>;
	download(storageId: string, dest: string): Promise<void>;
	remove(storageId: string): Promise<void>;
}

// ─── blob backend (Convex by default, injectable for tests) ───────────────

let injectedBackend: UploadBlobBackend | null = null;

/** Test seam: pass null to restore the Convex backend. */
export function setUploadsBlobBackend(backend: UploadBlobBackend | null): void {
	injectedBackend = backend;
	materialized.clear();
}

let client: ConvexHttpClient | null = null;
function convex(): ConvexHttpClient {
	if (client) return client;
	const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
	if (!url) throw new Error("File uploads need CONVEX_URL on a hosted deployment");
	client = new ConvexHttpClient(url);
	return client;
}
function secret(): string {
	const value = process.env.LH_CONVEX_SECRET;
	if (!value) throw new Error("File uploads need LH_CONVEX_SECRET on a hosted deployment");
	return value;
}

const convexBackend: UploadBlobBackend = {
	async uploadUrl() {
		return await convex().mutation(api.uploads.generateUploadUrl, { secret: secret() });
	},
	async info(storageId) {
		return (await convex().query(api.uploads.info, { secret: secret(), storageId })) as UploadBlobInfo | null;
	},
	async download(storageId, dest) {
		const url = (await convex().query(api.uploads.url, { secret: secret(), storageId })) as string | null;
		if (!url) throw new Error("The uploaded file is no longer available");
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Could not download the uploaded file (${response.status})`);
		await fs.promises.writeFile(dest, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
	},
	async remove(storageId) {
		await convex().mutation(api.uploads.remove, { secret: secret(), storageId });
	},
};

function blobBackend(): UploadBlobBackend {
	if (injectedBackend) return injectedBackend;
	if (!convexMode) throw new Error("File uploads are not enabled on this server.");
	return convexBackend;
}

function requireUploads(): void {
	if (!hostedFileAccess()) throw new Error("File uploads are not enabled on this server.");
}

// ─── names ────────────────────────────────────────────────────────────────

const MAX_NAME_LENGTH = 120;

function clampName(name: string): string {
	if (name.length <= MAX_NAME_LENGTH) return name;
	const dot = name.lastIndexOf(".");
	// Keep a reasonable extension when cutting a very long name.
	if (dot > 0 && name.length - dot <= 20) return name.slice(0, MAX_NAME_LENGTH - (name.length - dot)) + name.slice(dot);
	return name.slice(0, MAX_NAME_LENGTH);
}

/** A safe file name for the uploads folder. Basename only, no control
 *  characters, at most 120 characters, no leading dot. Collisions get
 *  "notes (2).pdf" style suffixes against `taken`. */
export function safeUploadName(name: string, taken: Iterable<string> = []): string {
	let base = String(name ?? "").split(/[\\/]/).pop() ?? "";
	base = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	// A leading dot would hide the file from ordinary listings and can name
	// "." / ".." — drop the dots, then fall back when nothing is left.
	base = base.replace(/^\.+/, "").trim();
	if (!base) base = "file";
	base = clampName(base);
	const used = new Set(Array.from(taken, (existing) => existing.toLowerCase()));
	if (!used.has(base.toLowerCase())) return base;

	const dot = base.lastIndexOf(".");
	const hasExtension = dot > 0 && dot < base.length - 1;
	const stem = hasExtension ? base.slice(0, dot) : base;
	const extension = hasExtension ? base.slice(dot) : "";
	for (let number = 2; ; number++) {
		const suffix = ` (${number})`;
		const room = Math.max(1, MAX_NAME_LENGTH - suffix.length - extension.length);
		const candidate = `${stem.slice(0, room)}${suffix}${extension}`;
		if (!used.has(candidate.toLowerCase())) return candidate;
	}
}

// ─── quota ────────────────────────────────────────────────────────────────

function quotaProblem(entries: UploadEntry[], incomingSize: number): string | null {
	if (entries.length >= uploadLimits.maxFiles) return `You can keep at most ${uploadLimits.maxFiles} uploaded files. Delete one first.`;
	const used = entries.reduce((total, entry) => total + entry.size, 0);
	if (used + incomingSize > uploadLimits.maxTotalBytes) return "Your uploaded files would exceed the 200 MB limit. Delete a file first.";
	return null;
}

async function removeBlobQuietly(storageId: string): Promise<void> {
	try {
		await blobBackend().remove(storageId);
	} catch (error) {
		console.error("[uploads] could not remove refused blob:", error);
	}
}

// ─── public operations ────────────────────────────────────────────────────

/** True when the UI should offer uploads on this deployment. */
export function uploadsEnabled(): boolean {
	return hostedFileAccess();
}

/** A URL the browser uploads to directly. */
export async function createUploadUrl(): Promise<string> {
	requireUploads();
	return await blobBackend().uploadUrl();
}

/** Verify the just-uploaded blob and record it in the user's index. */
export async function commitUpload({ storageId, name }: { storageId: string; name: string }): Promise<{ id: string; name: string; size: number; path: string }> {
	requireUploads();
	if (!storageId || typeof storageId !== "string") throw new Error("The upload is missing its storage id.");
	const dir = userUploadsDir();
	if (!dir) throw new Error("This account has no uploads folder.");

	const info = await blobBackend().info(storageId);
	if (!info) throw new Error("The uploaded file was not found. Please upload it again.");
	if (info.size > uploadLimits.maxFileBytes) {
		await removeBlobQuietly(storageId);
		throw new Error("This file is larger than 25 MB.");
	}

	const existing = listUploads();
	const problem = quotaProblem(existing, info.size);
	if (problem) {
		await removeBlobQuietly(storageId);
		throw new Error(problem);
	}

	const entry: UploadEntry = {
		id: `up_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
		name: safeUploadName(name, existing.map((item) => item.name)),
		size: info.size,
		type: info.contentType ?? "",
		storageId,
		createdAt: new Date().toISOString(),
	};
	addUpload(entry);
	return { id: entry.id, name: entry.name, size: entry.size, path: path.join(dir, entry.name) };
}

/** Remove one upload: blob, index entry and materialized file. */
export async function deleteUpload(id: string): Promise<boolean> {
	requireUploads();
	const entry = removeUpload(id);
	if (!entry) return false;
	if (entry.storageId) {
		try {
			await blobBackend().remove(entry.storageId);
		} catch (error) {
			console.error(`[uploads] could not delete blob ${entry.storageId}:`, error);
		}
	}
	const dir = userUploadsDir();
	if (dir) {
		try {
			fs.rmSync(/* turbopackIgnore: true */ path.join(dir, entry.name), { force: true, recursive: true });
		} catch (error) {
			console.error(`[uploads] could not delete materialized file ${entry.name}:`, error);
		}
	}
	return true;
}

/** Per-instance memo: uploads folder → the index signature it mirrors. */
const materialized = new Map<string, string>();

/** Make userUploadsDir() contain exactly the indexed files. Cheap when the
 *  index has not changed since this instance last materialized it. */
export async function materializeUploads(): Promise<void> {
	if (!hostedFileAccess()) return;
	const dir = userUploadsDir();
	if (!dir) return;
	const entries = listUploads();
	const signature = entries
		.map((entry) => [entry.id, entry.name, entry.size, entry.storageId ?? ""].join("\u0000"))
		.sort()
		.join("\n");
	if (materialized.get(dir) === signature) return;

	fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
	const indexed = new Set(entries.map((entry) => entry.name));
	for (const actual of fs.readdirSync(/* turbopackIgnore: true */ dir)) {
		if (indexed.has(actual)) continue;
		try {
			fs.rmSync(/* turbopackIgnore: true */ path.join(dir, actual), { force: true, recursive: true });
		} catch (error) {
			console.error(`[uploads] could not remove stale file ${actual}:`, error);
		}
	}

	for (const entry of entries) {
		const target = path.join(dir, entry.name);
		let present = false;
		try {
			present = fs.statSync(/* turbopackIgnore: true */ target).isFile();
		} catch {
			// missing — download below
		}
		if (present) continue;
		try {
			fs.rmSync(/* turbopackIgnore: true */ target, { force: true, recursive: true });
		} catch {
			// best effort: the rename below reports any real problem
		}
		if (!entry.storageId) continue;
		const temp = path.join(dir, `.upload-${crypto.randomUUID()}.tmp`);
		try {
			await blobBackend().download(entry.storageId, temp);
			fs.renameSync(/* turbopackIgnore: true */ temp, target);
		} catch (error) {
			try {
				fs.rmSync(/* turbopackIgnore: true */ temp, { force: true });
			} catch {
				// the temp is already gone
			}
			throw error;
		}
	}
	materialized.set(dir, signature);
}

/** Account deletion: remove the materialized folder, the index, and every
 *  blob (best effort; a failure is logged and never blocks the account
 *  deletion). Call inside that user's scope. */
export async function deleteAccountUploads(): Promise<void> {
	if (!hostedFileAccess()) return;
	const dir = userUploadsDir();
	const entries = listUploads();
	for (const entry of entries) removeUpload(entry.id);
	if (dir) {
		try {
			fs.rmSync(/* turbopackIgnore: true */ dir, { force: true, recursive: true });
		} catch (error) {
			console.error("[uploads] could not remove the account's uploads folder:", error);
		}
		materialized.delete(dir);
	}
	let backend: UploadBlobBackend;
	try {
		backend = blobBackend();
	} catch {
		return; // no blob storage configured: the index/folder are still gone
	}
	await Promise.all(entries.map(async (entry) => {
		if (!entry.storageId) return;
		try {
			await backend.remove(entry.storageId);
		} catch (error) {
			console.error(`[uploads] could not delete account blob ${entry.storageId}:`, error);
		}
	}));
}
