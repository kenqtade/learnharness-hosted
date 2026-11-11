#!/usr/bin/env bash
#
# THE VERCEL BUILD HOOK (auto-update wave, 2026-11-10): during a Vercel deploy,
# this may merge in a newer upstream release before building.
#
# WHY THIS EXISTS: our hosted fork adds Convex storage to upstream's
# core; when a newer release is out, a daily cron checks and triggers
# a Vercel rebuild with the merge included. The build is the merge.
#
# Behavior:
# - LH_AUTO_UPDATE not set or != "1" → skip merge (today's code only)
# - Not on Vercel (VERCEL env unset) → skip merge (local dev)
# - git not on PATH → skip merge (unexpected environment)
# - Merge succeeded (exit 0): install deps, build
# - Nothing newer (exit 10): just build
# - Merge/gates failed: build the CURRENT code + .upstream-blocked.json marker
#

set -euo pipefail

cd "$(dirname "$0")/.."

if [ "${LH_AUTO_UPDATE:-}" != "1" ]; then
	echo "Auto-update skipped: LH_AUTO_UPDATE is not set"
	exec npx next build
fi

if [ -z "${VERCEL:-}" ]; then
	echo "Auto-update skipped: not on Vercel (VERCEL env unset)"
	exec npx next build
fi

if ! command -v git >/dev/null 2>&1; then
	echo "Auto-update skipped: git not on PATH"
	exec npx next build
fi

# Ship-the-current-code fallback (2026-11-11): an upstream release that cannot
# be merged or does not pass the gates must NOT block deploying our own code
# (the v0.6.0 release conflicted and failed every deploy, fixes included).
# Snapshot the tree, and on any failure restore it, leave a marker
# (.upstream-blocked.json → LH_UPSTREAM_BLOCKED, shown in Settings → Updates
# as "needs a manual merge"; no rebuild loop) and build the current code.
SNAP="${TMPDIR:-/tmp}/lh-pre-merge.tar"
tar --exclude=./node_modules --exclude=./.next --exclude=./.git -cf "$SNAP" .
rm -f .upstream-blocked.json

restore_and_build_current() {
	local why="$1"
	echo "[vercel-build] $why — building the CURRENT code instead; the update needs a manual merge"
	local marker=""
	[ -f .upstream-blocked.json ] && marker="$(cat .upstream-blocked.json)"
	find . -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .next ! -name .git -exec rm -rf {} +
	tar -xf "$SNAP"
	if [ -n "$marker" ]; then printf '%s\n' "$marker" > .upstream-blocked.json
	else node -e 'require("fs").writeFileSync(".upstream-blocked.json", JSON.stringify({release: process.argv[1] || "unknown", reason: process.argv[2], at: new Date().toISOString()}) + "\n")' "${LH_PENDING_RELEASE:-}" "$why"; fi
	npm ci --no-audit --no-fund
	exec npx next build
}

echo "[vercel-build] Running upstream merge..."
set +e
node scripts/upstream-merge.mjs
merge_status=$?
set -e

if [ $merge_status -eq 0 ]; then
	echo "[vercel-build] Merge succeeded, installing dependencies..."
	LH_PENDING_RELEASE="$(node -p 'require("./upstream.json").base' 2>/dev/null || true)"
	export LH_PENDING_RELEASE
	if [ -f .lock-regenerated ]; then
		rm -f .lock-regenerated
		npm install --no-audit --no-fund || restore_and_build_current "the merged release's packages failed to install"
	else
		npm ci --no-audit --no-fund || restore_and_build_current "the merged release's packages failed to install"
	fi
	# Safety gates run AFTER install (the release may add packages) and
	# BEFORE build.
	echo "[vercel-build] Running storage seam gate..."
	npx tsx --test tests/storage-seam.test.ts || restore_and_build_current "the merged release bypasses the Convex storage seam"
	echo "[vercel-build] Running type check..."
	NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit || restore_and_build_current "the merged release does not type-check"
	npx next build || restore_and_build_current "the merged release failed to build"
	exit 0
elif [ $merge_status -eq 10 ]; then
	echo "[vercel-build] No newer upstream release"
	exec npx next build
else
	restore_and_build_current "upstream merge failed (exit $merge_status)"
fi
