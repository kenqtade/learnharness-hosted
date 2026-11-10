import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import type { Storage } from "@earendil-works/pi-durable";
import { LibsqlDatabase } from "../src/server/durable/libsql.ts";

// DURABLE-PI BRANCH: pi-durable's OWN storage conformance suite, run against
// (a) our libSQL adapter (the hosted path: Turso speaks the same protocol as
// a `file:` libSQL database) and (b) the built-in node:sqlite storage (the
// local default) as the control. Same cases, same expectations.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-durable-storage-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

function partialDeepEqual(actual: unknown, expected: unknown, where = "$"): void {
	if (expected === null || typeof expected !== "object") {
		assert.deepStrictEqual(actual, expected, where);
		return;
	}
	assert.ok(actual !== null && typeof actual === "object", `${where}: expected an object`);
	if (Array.isArray(expected)) {
		assert.ok(Array.isArray(actual), `${where}: expected an array`);
		assert.equal((actual as unknown[]).length, expected.length, `${where}: length`);
		expected.forEach((item, i) => partialDeepEqual((actual as unknown[])[i], item, `${where}[${i}]`));
		return;
	}
	for (const [key, value] of Object.entries(expected)) partialDeepEqual((actual as Record<string, unknown>)[key], value, `${where}.${key}`);
}

const assertions = {
	ok: (value: unknown, message?: string) => assert.ok(value, message),
	strictEqual: (a: unknown, b: unknown) => assert.strictEqual(a, b),
	deepEqual: (a: unknown, b: unknown) => assert.deepStrictEqual(a, b),
	partialDeepEqual: (a: unknown, b: unknown) => partialDeepEqual(a, b),
	greaterThan: (a: number, b: number) => assert.ok(a > b, `${a} > ${b}`),
	rejects: async (operation: Promise<unknown>, includes: string) => {
		await assert.rejects(operation, (err: unknown) => String((err as Error)?.message ?? err).includes(includes));
	},
};

function suite(name: string, open: () => Promise<Storage>) {
	describe(name, () => {
		const cases = createStorageConformance({
			assertions,
			withStorage: async (use) => {
				const storage = await open();
				try {
					await use(storage);
				} finally {
					await (storage as unknown as { close?: () => Promise<void> }).close?.();
				}
			},
		});
		for (const c of cases) it(c.name, () => c.run());
	});
}

suite("libSQL adapter (hosted path)", async () => {
	const file = path.join(root, `libsql-${n++}.sqlite`);
	return SqliteStorage.open(LibsqlDatabase.open(`file:${file}`), { prefix: "lh" });
});

suite("node:sqlite (local default, control)", async () => {
	const file = path.join(root, `node-${n++}.sqlite`);
	return openNodeSqliteStorage(file, { prefix: "lh" });
});
