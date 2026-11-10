/** THE UPSTREAM MERGE, END TO END (auto-update wave). Runs the real
 * scripts/upstream-merge.mjs against fake GitHub-style release tarballs
 * (LH_UPSTREAM_TARBALL_DIR) and a throwaway ROOT, so the actual git
 * three-way merge, the copy-back and upstream.json bookkeeping are all
 * exercised. These caught two silent-data-loss bugs (substring skip list,
 * merging while on the wrong branch) that unit tests on helpers missed. */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "upstream-merge.mjs");
const LINES = "A\nB\nC\nD\nE\nF\nG\n";

type Tree = Record<string, string>;
function writeTree(dir: string, tree: Tree) {
	for (const [rel, text] of Object.entries(tree)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	}
}
/** GitHub tarballs wrap the tree in one top-level folder. */
function tarball(tars: string, tag: string, tree: Tree) {
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), "tar-"));
	writeTree(path.join(stage, `learnharness-${tag.slice(1)}`), tree);
	execFileSync("tar", ["-czf", path.join(tars, `${tag}.tar.gz`), "-C", stage, `learnharness-${tag.slice(1)}`]);
	fs.rmSync(stage, { recursive: true, force: true });
}
function run(opts: { base: Tree; latest: Tree; ours: Tree; baseTag?: string; latestTag?: string }) {
	const t = fs.mkdtempSync(path.join(os.tmpdir(), "umerge-"));
	const root = path.join(t, "root");
	const tars = path.join(t, "tars");
	fs.mkdirSync(tars);
	const baseTag = opts.baseTag ?? "v1.0.0";
	const latestTag = opts.latestTag ?? "v1.1.0";
	tarball(tars, baseTag, opts.base);
	if (latestTag !== baseTag) tarball(tars, latestTag, opts.latest);
	writeTree(root, { ...opts.ours, "upstream.json": JSON.stringify({ repo: "x/learnharness", base: baseTag }) });
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.copyFileSync(SCRIPT, path.join(root, "scripts", "upstream-merge.mjs"));
	const r = spawnSync("node", [path.join(root, "scripts", "upstream-merge.mjs")], {
		encoding: "utf-8",
		env: { ...process.env, LH_UPSTREAM_TARBALL_DIR: tars, LH_UPSTREAM_LATEST: latestTag, TMPDIR: t },
	});
	const read = (rel: string) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf-8") : null);
	return { status: r.status, out: r.stdout + r.stderr, read, cleanup: () => fs.rmSync(t, { recursive: true, force: true }) };
}

describe("upstream-merge.mjs end to end", () => {
	it("clean merge: both sides' edits land, upstream adds/deletes apply, our extra files and dotfiles survive", () => {
		const r = run({
			base: { "next.config.ts": LINES, "gone.ts": "old", "keep.ts": "k", ".gitignore": "x" },
			latest: { "next.config.ts": LINES.replace("A", "A-up"), "new.ts": "fresh", "keep.ts": "k", ".gitignore": "x" },
			ours: { "next.config.ts": LINES.replace("G", "G-ours"), "gone.ts": "old", "keep.ts": "k", ".gitignore": "x", "vercel.json": "{}", "convex/schema.ts": "ours" },
		});
		try {
			assert.equal(r.status, 0, r.out);
			assert.equal(r.read("next.config.ts"), LINES.replace("A", "A-up").replace("G", "G-ours"));
			assert.equal(r.read("new.ts"), "fresh");
			assert.equal(r.read("gone.ts"), null, "file deleted upstream must not linger");
			assert.equal(r.read("vercel.json"), "{}");
			assert.equal(r.read(".gitignore"), "x");
			assert.equal(r.read("convex/schema.ts"), "ours");
			assert.equal(JSON.parse(r.read("upstream.json")!).base, "v1.1.0");
			assert.equal(r.read(".lock-regenerated"), null);
		} finally {
			r.cleanup();
		}
	});

	it("real conflict: exit 2 and our tree is left untouched", () => {
		const r = run({
			base: { "next.config.ts": LINES },
			latest: { "next.config.ts": LINES.replace("A", "A-up") },
			ours: { "next.config.ts": LINES.replace("A", "A-ours") },
		});
		try {
			assert.equal(r.status, 2, r.out);
			assert.match(r.out, /next\.config\.ts/);
			assert.equal(r.read("next.config.ts"), LINES.replace("A", "A-ours"));
			assert.equal(JSON.parse(r.read("upstream.json")!).base, "v1.0.0");
		} finally {
			r.cleanup();
		}
	});

	it("package-lock-only conflict: takes upstream's lock and flags it for npm install", () => {
		const r = run({
			base: { "package-lock.json": '{"v":0}\n', "package.json": LINES },
			latest: { "package-lock.json": '{"v":"up"}\n', "package.json": LINES.replace("A", "A-up") },
			ours: { "package-lock.json": '{"v":"ours"}\n', "package.json": LINES.replace("G", "G-ours") },
		});
		try {
			assert.equal(r.status, 0, r.out);
			assert.equal(r.read("package-lock.json"), '{"v":"up"}\n');
			assert.equal(r.read("package.json"), LINES.replace("A", "A-up").replace("G", "G-ours"));
			assert.equal(r.read(".lock-regenerated"), "1\n");
		} finally {
			r.cleanup();
		}
	});

	it("nothing newer: exit 10 and nothing changes", () => {
		const r = run({ base: { "a.ts": "1" }, latest: { "a.ts": "1" }, ours: { "a.ts": "mine" }, latestTag: "v1.0.0" });
		try {
			assert.equal(r.status, 10, r.out);
			assert.equal(r.read("a.ts"), "mine");
		} finally {
			r.cleanup();
		}
	});
});
