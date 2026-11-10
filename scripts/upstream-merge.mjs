#!/usr/bin/env node
/**
 * THE UPSTREAM MERGE SCRIPT (auto-update wave, 2026-11-10):
 *
 * WHY: our hosted fork adds Convex storage to upstream's core; when a newer
 * release is out, a daily cron checks and triggers a Vercel rebuild with
 * the merge included.
 *
 * This script:
 * 1. Reads upstream.json for the current base version
 * 2. Fetches the latest release info from GitHub
 * 3. Downloads and extracts both base and latest tarballs
 * 4. Creates a temp git repo and merges them
 * 5. Handles package-lock.json conflicts specially
 * 6. Copies the merged tree back to cwd
 * 7. Updates upstream.json with the new base
 *
 * Exit codes:
 * - 0: merge succeeded
 * - 10: no newer release (latest == base)
 * - 2: merge conflict (other than package-lock.json)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

function log(...args) {
	console.log(`[upstream-merge]`, ...args);
}

function parseVersion(s) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) throw new Error(`cannot compare versions "${a}" and "${b}"`);
	if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
	if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
	if (pa[2] !== pb[2]) return pa[2] < pb[2] ? -1 : 1;
	return 0;
}

async function fetchLatestRelease() {
	const repo = process.env.LH_UPSTREAM_REPO || "amosblomqvist/learnharness";
	const url = `https://api.github.com/repos/${repo}/releases/latest`;

	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "learnharness-updater",
	};

	const token = process.env.GITHUB_TOKEN;
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const res = await fetch(url, { headers });
	if (!res.ok) {
		throw new Error(`GitHub API error: ${res.status}`);
	}

	const body = await res.json();
	if (body.draft || body.prerelease) {
		throw new Error(`Release is draft or prerelease`);
	}

	const tag = body.tag_name;
	const parsed = parseVersion(tag);
	if (!parsed) {
		throw new Error(`Invalid tag: ${tag}`);
	}

	return {
		tag,
		version: `${parsed[0]}.${parsed[1]}.${parsed[2]}`,
		publishedAt: body.published_at || "",
		url: body.html_url || `https://github.com/${repo}/releases/tag/${tag}`,
	};
}

function getLatestReleaseVersion() {
	if (process.env.LH_UPSTREAM_LATEST) {
		return process.env.LH_UPSTREAM_LATEST;
	}
	return null;
}

function downloadTarball(repo, tag, destDir) {
	const tarballUrl = `https://codeload.github.com/${repo}/tar.gz/refs/tags/${tag}`;

	if (process.env.LH_UPSTREAM_TARBALL_DIR) {
		const localFile = path.join(process.env.LH_UPSTREAM_TARBALL_DIR, `${tag}.tar.gz`);
		const output = path.join(destDir, "tarball.tar.gz");
		fs.copyFileSync(localFile, output);
		return output;
	}

	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(path.join(destDir, "tarball.tar.gz"));
		const req = https.get(tarballUrl, (res) => {
			if (res.statusCode !== 200) {
				file.close();
				return reject(new Error(`Download failed: ${res.statusCode}`));
			}
			res.pipe(file);
			file.on("finish", () => {
				file.close();
				resolve(path.join(destDir, "tarball.tar.gz"));
			});
		});
		req.on("error", reject);
	});
}

function extractTarball(tarballPath, destDir) {
	execFileSync("tar", ["-xzf", tarballPath, "--strip-components=1", "-C", destDir], { stdio: "inherit" });
}

async function main() {
	const upstreamJsonPath = path.join(ROOT, "upstream.json");
	if (!fs.existsSync(upstreamJsonPath)) {
		throw new Error("upstream.json not found");
	}

	const upstreamJson = JSON.parse(fs.readFileSync(upstreamJsonPath, "utf-8"));
	const repo = process.env.LH_UPSTREAM_REPO || upstreamJson.repo || "amosblomqvist/learnharness";
	const baseTag = upstreamJson.base;

	const latestRelease = getLatestReleaseVersion()
		? { tag: getLatestReleaseVersion(), version: getLatestReleaseVersion() }
		: await fetchLatestRelease();

	const baseParts = parseVersion(baseTag);
	const latestParts = parseVersion(latestRelease.tag);
	if (!baseParts || !latestParts) {
		throw new Error("Cannot parse version");
	}

	if (compareVersions(latestRelease.tag, baseTag) <= 0) {
		log(`Latest ${latestRelease.tag} is not newer than base ${baseTag}`);
		process.exit(10);
	}

	log(`Base: ${baseTag}, Latest: ${latestRelease.tag}`);

	const tempDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "upstream-merge-"));
	const baseDir = path.join(tempDir, "base");
	const latestDir = path.join(tempDir, "latest");
	const repoDir = path.join(tempDir, "repo");

	fs.mkdirSync(baseDir, { recursive: true });
	fs.mkdirSync(latestDir, { recursive: true });
	fs.mkdirSync(repoDir, { recursive: true });

	try {
		log(`Downloading base tarball ${baseTag}...`);
		await downloadTarball(repo, baseTag, baseDir);
		extractTarball(path.join(baseDir, "tarball.tar.gz"), baseDir);
		fs.unlinkSync(path.join(baseDir, "tarball.tar.gz"));

		log(`Downloading latest tarball ${latestRelease.tag}...`);
		await downloadTarball(repo, latestRelease.tag, latestDir);
		extractTarball(path.join(latestDir, "tarball.tar.gz"), latestDir);
		fs.unlinkSync(path.join(latestDir, "tarball.tar.gz"));

		log("Initializing merge repo...");
		process.env.GIT_AUTHOR_NAME = "learnharness-updater";
		process.env.GIT_AUTHOR_EMAIL = "updater@local";
		process.env.GIT_COMMITTER_NAME = "learnharness-updater";
		process.env.GIT_COMMITTER_EMAIL = "updater@local";

		execFileSync("git", ["init", "-q"], { cwd: repoDir });

		log("Committing base tree...");
		for (const entry of fs.readdirSync(baseDir)) {
			fs.renameSync(path.join(baseDir, entry), path.join(repoDir, entry));
		}
		execFileSync("git", ["add", "-A"], { cwd: repoDir });
		execFileSync("git", ["commit", "-qm", `Upstream base ${baseTag}`], { cwd: repoDir });

		// Create 'theirs' branch from base commit
		log("Creating theirs branch from base...");
		execFileSync("git", ["checkout", "-b", "theirs"], { cwd: repoDir });

		// Clear and replace with latest tarball
		log("Replacing with latest tarball...");
		for (const entry of fs.readdirSync(repoDir)) {
			if (entry === ".git") continue;
			const fullPath = path.join(repoDir, entry);
			if (fs.lstatSync(fullPath).isDirectory()) {
				fs.rmSync(fullPath, { recursive: true, force: true });
			} else {
				fs.unlinkSync(fullPath);
			}
		}

		for (const entry of fs.readdirSync(latestDir)) {
			const src = path.join(latestDir, entry);
			const dest = path.join(repoDir, entry);
			if (fs.lstatSync(src).isDirectory()) {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.cpSync(src, dest, { recursive: true });
			} else {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.copyFileSync(src, dest);
			}
		}

		execFileSync("git", ["add", "-A"], { cwd: repoDir });
		execFileSync("git", ["commit", "-qm", `Upstream latest ${latestRelease.tag}`], { cwd: repoDir });

		// Go back to base commit and create ours branch
		log("Creating ours branch with current source...");
		execFileSync("git", ["checkout", `HEAD~1`], { cwd: repoDir });
		execFileSync("git", ["checkout", "-b", "ours"], { cwd: repoDir });

		// Clear and replace with our source
		const excludePatterns = [".git", "node_modules", ".next", ".vercel", ".env*"];
		for (const entry of fs.readdirSync(repoDir)) {
			if (entry === ".git") continue;
			const fullPath = path.join(repoDir, entry);
			if (fs.lstatSync(fullPath).isDirectory()) {
				fs.rmSync(fullPath, { recursive: true, force: true });
			} else {
				fs.unlinkSync(fullPath);
			}
		}

		for (const entry of fs.readdirSync(ROOT)) {
			if (excludePatterns.some((p) => (p.startsWith(".") ? entry.includes(p.slice(1)) : entry === p))) {
				continue;
			}
			const src = path.join(ROOT, entry);
			const dest = path.join(repoDir, entry);
			if (fs.lstatSync(src).isDirectory()) {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.cpSync(src, dest, { recursive: true });
			} else {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.copyFileSync(src, dest);
			}
		}

		execFileSync("git", ["add", "-A"], { cwd: repoDir });
		execFileSync("git", ["commit", "-qm", "Our changes"], { cwd: repoDir });

		log("Merging ours into theirs...");
		try {
			execFileSync("git", ["merge", "--no-edit", "ours"], { cwd: repoDir });
		} catch (err) {
			log("Merge conflicts detected.");
			const conflicts = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: repoDir, encoding: "utf-8" }).trim();
			const conflictList = conflicts.split("\n").filter((c) => c);
			log("Conflicted files:");
			for (const f of conflictList) log(`  ${f}`);

			const onlyPackageLock = conflictList.length === 1 && conflictList[0] === "package-lock.json";
			if (onlyPackageLock) {
				log("Only package-lock.json conflicts, taking theirs...");
				execFileSync("git", ["checkout", "--", "package-lock.json"], { cwd: repoDir });
				execFileSync("git", ["add", "package-lock.json"], { cwd: repoDir });
				execFileSync("git", ["commit", "--amend", "--no-edit"], { cwd: repoDir });
			} else {
				throw new Error(`Merge conflicts: ${conflictList.join(", ")}`);
			}
		}

		log("Copying merged tree to cwd...");
		const keepPatterns = [".git", "node_modules", ".next", ".vercel", /^\.env/];

		for (const entry of fs.readdirSync(repoDir)) {
			const src = path.join(repoDir, entry);
			const dest = path.join(ROOT, entry);
			if (keepPatterns.some((p) => (typeof p === "string" ? entry === p : p.test(entry)))) {
				continue;
			}
			if (fs.lstatSync(src).isDirectory()) {
				if (fs.existsSync(dest)) {
					fs.rmSync(dest, { recursive: true, force: true });
				}
				fs.cpSync(src, dest, { recursive: true });
			} else {
				if (fs.existsSync(dest)) {
					fs.unlinkSync(dest);
				}
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.copyFileSync(src, dest);
			}
		}

		log("Updating upstream.json...");
		const upstreamUpdated = {
			repo,
			base: latestRelease.tag,
			mergedAt: new Date().toISOString(),
		};
		fs.writeFileSync(path.join(ROOT, "upstream.json"), JSON.stringify(upstreamUpdated, null, "\t"), "utf-8");

		log("Done!");
		process.exit(0);
	} catch (err) {
		log(`Merge failed: ${err.message}`);
		process.exit(2);
	}
}

main();