/**
 * HOSTED FORK — learner uploads end to end (no Convex deployment needed).
 *
 * VERCEL=1 turns on hosted file access; an injected blob backend stands in
 * for Convex storage (temp files), so commit / materialize / delete / quota
 * and the confined read tool are exercised exactly as on the deployment.
 */
import { ISOLATED_DATA_DIR } from "./helpers/isolated-data-dir.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { UploadBlobBackend } from "../src/server/uploads.ts";

const BLOB_DIR = path.join(ISOLATED_DATA_DIR, "fake-blobs");
const MATERIALIZED = path.join(ISOLATED_DATA_DIR, "materialized-uploads");
process.env.LH_UPLOADS_DIR = MATERIALIZED;
process.env.VERCEL = "1";
process.env.LH_MULTI_USER = "1";
delete process.env.LH_PROFILE;
delete process.env.LH_STORE;

const {
	commitUpload,
	createUploadUrl,
	deleteAccountUploads,
	deleteUpload,
	materializeUploads,
	safeUploadName,
	setUploadsBlobBackend,
	uploadLimits,
	uploadsEnabled,
} = await import("../src/server/uploads.ts");
const { addUpload, listUploads } = await import("../src/store/uploads-index.ts");
const { routeAccess } = await import("../src/server/accounts.ts");
const { readTool } = await import("../src/agent/tools/read.ts");
const { setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { fileAccessPolicy } = await import("../src/server/file-access.ts");
const { runAsUser } = await import("../src/store/user-scope.ts");

// The composition root installs this on a real server; the test wires it too.
setFileAccessPolicy(fileAccessPolicy);

type FakeBlob = { file: string; size: number; type: string | null };

class FakeBlobs implements UploadBlobBackend {
	readonly blobs = new Map<string, FakeBlob>();
	readonly removed: string[] = [];
	private next = 0;

	async uploadUrl(): Promise<string> {
		return `fake://upload/${++this.next}`;
	}

	/** Add a blob; `declaredSize` lets a quota test claim a size without writing it. */
	add(content: string, type: string | null = "text/plain", declaredSize?: number): string {
		const id = `storage_${++this.next}`;
		const file = path.join(BLOB_DIR, `${id}.bin`);
		fs.mkdirSync(BLOB_DIR, { recursive: true });
		fs.writeFileSync(file, content);
		this.blobs.set(id, { file, size: declaredSize ?? Buffer.byteLength(content), type });
		return id;
	}

	async info(storageId: string): Promise<{ size: number; contentType: string | null } | null> {
		const blob = this.blobs.get(storageId);
		return blob ? { size: blob.size, contentType: blob.type } : null;
	}

	async download(storageId: string, dest: string): Promise<void> {
		const blob = this.blobs.get(storageId);
		if (!blob) throw new Error("fake blob is missing");
		fs.copyFileSync(blob.file, dest);
	}

	async remove(storageId: string): Promise<void> {
		this.removed.push(storageId);
		const blob = this.blobs.get(storageId);
		if (!blob) return;
		this.blobs.delete(storageId);
		fs.rmSync(blob.file, { force: true });
	}
}

let fake: FakeBlobs;

beforeEach(() => {
	const data = path.join(ISOLATED_DATA_DIR, "data");
	fs.rmSync(data, { recursive: true, force: true });
	fs.rmSync(`${data}-users`, { recursive: true, force: true });
	fs.rmSync(MATERIALIZED, { recursive: true, force: true });
	fs.rmSync(BLOB_DIR, { recursive: true, force: true });
	fake = new FakeBlobs();
	setUploadsBlobBackend(fake);
});

after(() => {
	setUploadsBlobBackend(null);
	fs.rmSync(MATERIALIZED, { recursive: true, force: true });
	fs.rmSync(BLOB_DIR, { recursive: true, force: true });
});

const alice = { id: "u_alice", role: "member" as const };
const bob = { id: "u_bobby1", role: "member" as const };

const toolText = (result: unknown) =>
	((result as { content?: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? "").join("\n");
const read = async (file: string) =>
	toolText(await (readTool as unknown as { execute: (id: string, args: unknown) => Promise<unknown> }).execute("t", { path: file }));

describe("upload names", () => {
	it("keeps only the basename, strips control characters and leading dots, and caps at 120 characters", () => {
		assert.equal(safeUploadName("../../secret.pdf"), "secret.pdf");
		assert.equal(safeUploadName("C:\\Users\\me\\notes.md"), "notes.md");
		assert.equal(safeUploadName("bad\u0000name\u0007.txt"), "badname.txt");
		assert.equal(safeUploadName(".hidden.txt"), "hidden.txt");
		assert.equal(safeUploadName("   "), "file");
		assert.ok(safeUploadName("x".repeat(400)).length <= 120);
		assert.ok(safeUploadName(`${"x".repeat(300)}.pdf`).length <= 120);
	});

	it("uses notes (2).pdf on a collision and keeps counting", () => {
		assert.equal(safeUploadName("notes.pdf", ["notes.pdf"]), "notes (2).pdf");
		assert.equal(safeUploadName("notes.pdf", ["notes.pdf", "notes (2).pdf"]), "notes (3).pdf");
		assert.equal(safeUploadName("NOTES.pdf", ["notes.pdf"]), "NOTES (2).pdf");
	});
});

describe("upload limits", () => {
	it("refuses a blob larger than 25 MB and deletes it", async () => {
		const storageId = fake.add("too big", "application/octet-stream", uploadLimits.maxFileBytes + 1);
		await runAsUser(alice, async () => {
			await assert.rejects(commitUpload({ storageId, name: "big.bin" }), /25 MB/);
			assert.deepEqual(listUploads(), []);
		});
		assert.ok(fake.removed.includes(storageId), "the refused blob is deleted");
	});

	it("refuses a blob that would exceed the 200 MB user quota and deletes it", async () => {
		const storageId = fake.add("one more byte", "text/plain", 1);
		await runAsUser(alice, async () => {
			addUpload({ id: "up_seed", name: "seed.bin", size: uploadLimits.maxTotalBytes, type: "", createdAt: new Date().toISOString() });
			await assert.rejects(commitUpload({ storageId, name: "more.txt" }), /200 MB/);
			assert.equal(listUploads().length, 1, "only the seeded entry remains");
		});
		assert.ok(fake.removed.includes(storageId));
	});

	it("refuses a 101st file and deletes its blob", async () => {
		const storageId = fake.add("", "text/plain");
		await runAsUser(alice, async () => {
			for (let index = 0; index < uploadLimits.maxFiles; index++) {
				addUpload({ id: `up_${index}`, name: `file-${index}.txt`, size: 1, type: "text/plain", createdAt: new Date().toISOString() });
			}
			await assert.rejects(commitUpload({ storageId, name: "extra.txt" }), /100/);
			assert.equal(listUploads().length, uploadLimits.maxFiles);
		});
		assert.ok(fake.removed.includes(storageId));
	});
});

describe("commit → index → materialize → read", () => {
	it("downloads the indexed blob and the confined read tool can read it", async () => {
		await runAsUser(alice, async () => {
			const storageId = fake.add("hello from alice\n", "text/markdown");
			const entry = await commitUpload({ storageId, name: "notes.md" });
			assert.equal(entry.name, "notes.md");
			assert.equal(entry.size, 17);
			assert.equal(entry.path, path.join(MATERIALIZED, alice.id, "notes.md"));
			assert.deepEqual(listUploads().map((item) => item.name), ["notes.md"]);

			await materializeUploads();
			assert.equal(fs.readFileSync(entry.path, "utf-8"), "hello from alice\n");
			assert.match(await read(entry.path), /hello from alice/);

			// The second call is cheap but still exact for the same index.
			await materializeUploads();
			assert.equal(fs.readFileSync(entry.path, "utf-8"), "hello from alice\n");
		});
	});

	it("materialize removes files that are no longer indexed", async () => {
		await runAsUser(alice, async () => {
			const storageId = fake.add("kept\n", "text/plain");
			const entry = await commitUpload({ storageId, name: "kept.txt" });
			await materializeUploads();
			const stray = path.join(MATERIALIZED, alice.id, "stray.txt");
			fs.writeFileSync(stray, "not indexed\n");
			await materializeUploads();
			assert.ok(!fs.existsSync(stray), "a stray file is removed");
			assert.ok(fs.existsSync(entry.path));
		});
	});

	it("users are isolated: A's blob is invisible to B", async () => {
		let alicePath = "";
		await runAsUser(alice, async () => {
			const storageId = fake.add("alice private\n", "text/plain");
			alicePath = (await commitUpload({ storageId, name: "private.txt" })).path;
			await materializeUploads();
		});
		await runAsUser(bob, async () => {
			assert.deepEqual(listUploads(), []);
			await materializeUploads();
			await assert.rejects(read(alicePath), /Access denied/);
			assert.ok(!fs.existsSync(path.join(MATERIALIZED, bob.id, "private.txt")));
		});
	});
});

describe("delete", () => {
	it("removes the index entry, the blob, and the materialized file", async () => {
		await runAsUser(alice, async () => {
			const storageId = fake.add("delete me\n", "text/plain");
			const entry = await commitUpload({ storageId, name: "delete-me.txt" });
			await materializeUploads();
			assert.ok(fs.existsSync(entry.path));

			assert.equal(await deleteUpload(entry.id), true);
			assert.deepEqual(listUploads(), []);
			assert.ok(!fs.existsSync(entry.path), "the materialized file is gone");
			assert.ok(fake.removed.includes(storageId), "the blob is deleted");
			assert.equal(await deleteUpload(entry.id), false, "a second delete is a no-op");
		});
	});

	it("account deletion removes every blob, the index and the folder", async () => {
		let folder = "";
		const storageIds: string[] = [];
		await runAsUser(alice, async () => {
			for (const name of ["one.txt", "two.txt"]) {
				const storageId = fake.add(`${name}\n`, "text/plain");
				storageIds.push(storageId);
				folder = path.dirname((await commitUpload({ storageId, name })).path);
			}
			await materializeUploads();
			await deleteAccountUploads();
			assert.deepEqual(listUploads(), []);
			assert.ok(!fs.existsSync(folder), "the uploads folder is gone");
		});
		for (const storageId of storageIds) assert.ok(fake.removed.includes(storageId), `${storageId} is deleted`);
	});
});

describe("uploads disabled", () => {
	it("upload operations refuse outside a hosted deployment and materialize is a no-op", async () => {
		const previous = { VERCEL: process.env.VERCEL, LH_PROFILE: process.env.LH_PROFILE, LH_STORE: process.env.LH_STORE };
		delete process.env.VERCEL;
		delete process.env.LH_PROFILE;
		delete process.env.LH_STORE;
		try {
			assert.equal(uploadsEnabled(), false);
			await runAsUser(alice, async () => {
				await assert.rejects(createUploadUrl(), /not enabled/);
				await assert.rejects(commitUpload({ storageId: "storage_x", name: "x.txt" }), /not enabled/);
				await materializeUploads(); // no-op, no throw
			});
		} finally {
			if (previous.VERCEL === undefined) delete process.env.VERCEL; else process.env.VERCEL = previous.VERCEL;
			if (previous.LH_PROFILE === undefined) delete process.env.LH_PROFILE; else process.env.LH_PROFILE = previous.LH_PROFILE;
			if (previous.LH_STORE === undefined) delete process.env.LH_STORE; else process.env.LH_STORE = previous.LH_STORE;
		}
	});
});

describe("route access", () => {
	it("/api/files is an ordinary signed-in user route", () => {
		for (const method of ["GET", "POST", "DELETE"]) assert.equal(routeAccess(method, "/api/files"), "user", method);
		assert.equal(routeAccess("GET", "/api/files/"), "user");
	});
});
