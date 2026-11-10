import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { timingSafeEqual } from "node:crypto";

const parseVersion = (s: string): [number, number, number] | null => {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
};

describe("parseVersion", () => {
	it("accepts v-prefixed versions", () => {
		assert.deepEqual(parseVersion("v0.5.0"), [0, 5, 0]);
		assert.deepEqual(parseVersion("v1.0.0"), [1, 0, 0]);
		assert.deepEqual(parseVersion("v10.20.30"), [10, 20, 30]);
	});

	it("accepts version without v prefix", () => {
		assert.deepEqual(parseVersion("0.5.0"), [0, 5, 0]);
		assert.deepEqual(parseVersion("1.0.0"), [1, 0, 0]);
	});

	it("rejects invalid versions", () => {
		assert.equal(parseVersion("invalid"), null);
		assert.equal(parseVersion("v0.5"), null);
		assert.equal(parseVersion("v0.5.0.0"), null);
		assert.equal(parseVersion(""), null);
	});
});

describe("compareVersions", () => {
	const compareVersions = (a: string, b: string): -1 | 0 | 1 => {
		const pa = parseVersion(a);
		const pb = parseVersion(b);
		if (!pa || !pb) throw new Error(`cannot compare version "${a}" and "${b}"`);
		if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
		if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
		if (pa[2] !== pb[2]) return pa[2] < pb[2] ? -1 : 1;
		return 0;
	};

	it("returns 0 for equal versions", () => {
		assert.equal(compareVersions("0.5.0", "0.5.0"), 0);
		assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
	});

	it("returns -1 when first is older", () => {
		assert.equal(compareVersions("0.4.0", "0.5.0"), -1);
		assert.equal(compareVersions("v1.0.0", "v2.0.0"), -1);
	});

	it("returns 1 when first is newer", () => {
		assert.equal(compareVersions("0.5.0", "0.4.0"), 1);
		assert.equal(compareVersions("v2.0.0", "v1.0.0"), 1);
	});
});

describe("timingSafeEqual", () => {
	it("returns true for equal buffers", () => {
		const a = Buffer.from("test123");
		const b = Buffer.from("test123");
		assert.equal(timingSafeEqual(a, b), true);
	});

	it("returns false for different buffers", () => {
		const a = Buffer.from("test123");
		const b = Buffer.from("test456");
		assert.equal(timingSafeEqual(a, b), false);
	});

	it("requires equal lengths (differs in timing safety test)", () => {
		const a = Buffer.from("short");
		const b = Buffer.from("much-longer");
		// This should throw or return false - timingSafeEqual throws on length mismatch
		let threw = false;
		try {
			timingSafeEqual(a, b);
		} catch {
			threw = true;
		}
		assert.ok(threw, "timingSafeEqual throws on length mismatch");
	});
});