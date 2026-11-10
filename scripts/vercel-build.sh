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
# - Merge failed (exit 1): build fails, old version stays live
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

echo "[vercel-build] Running upstream merge..."
node scripts/upstream-merge.mjs
merge_status=$?

if [ $merge_status -eq 0 ]; then
	echo "[vercel-build] Merge succeeded, installing dependencies..."
	npm ci --no-audit --no-fund
	exec npx next build
elif [ $merge_status -eq 10 ]; then
	echo "[vercel-build] No newer upstream release"
	exec npx next build
else
	echo "[vercel-build] Merge failed with exit code $merge_status"
	exit 1
fi