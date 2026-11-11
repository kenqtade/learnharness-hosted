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

# Upstream v0.6.0+: the root type check (tsc AND next build's) covers the
# plugin sources, which need their own packages (npm run plugins:setup — what
# upstream CI runs first). --include=dev: Vercel builds with
# NODE_ENV=production, and the plugin SDK/types are devDependencies.
setup_plugins() {
	if node -e 'process.exit(require("./package.json").scripts?.["plugins:setup"] ? 0 : 1)' 2>/dev/null; then
		npm_config_include=dev npm run plugins:setup
	fi
}
# Hosted demos (src/agent/subagents/headless.ts): a Vercel function has no
# Electron helper and no system Chrome, so demos (mandatory browser
# verification) and the visual maker's preflight failed every job. Install the
# serverless Chromium for this build only: --no-save keeps package.json and the
# lockfile (and so every upstream merge) untouched, desktop builds never see
# it, and next.config copies it into the functions. --include=dev: under
# NODE_ENV=production a plain install would prune the build tooling.
# Non-fatal: without it the deploy still ships; demos report "no render engine".
SERVERLESS_CHROMIUM_VERSION=153.0.0
setup_serverless_chromium() {
	[ -n "${VERCEL:-}" ] || return 0
	npm install --no-save --include=dev --no-audit --no-fund "@sparticuz/chromium@$SERVERLESS_CHROMIUM_VERSION" \
		|| echo "[vercel-build] WARNING: serverless Chromium failed to install; hosted demos will report no render engine"
}
build_app() {
	setup_plugins
	setup_serverless_chromium
	exec npx next build
}

if [ "${LH_AUTO_UPDATE:-}" != "1" ]; then
	echo "Auto-update skipped: LH_AUTO_UPDATE is not set"
	build_app
fi

if [ -z "${VERCEL:-}" ]; then
	echo "Auto-update skipped: not on Vercel (VERCEL env unset)"
	build_app
fi

if ! command -v git >/dev/null 2>&1; then
	echo "Auto-update skipped: git not on PATH"
	build_app
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
	# Only a merged release's install changed node_modules: put OUR packages
	# back. --include=dev: Vercel builds with NODE_ENV=production, and npm
	# would otherwise drop the build tooling (tailwind/postcss, typescript).
	if [ "${MERGED_INSTALL:-0}" = "1" ]; then npm ci --include=dev --no-audit --no-fund; fi
	build_app
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
	MERGED_INSTALL=1
	if [ -f .lock-regenerated ]; then
		rm -f .lock-regenerated
		npm install --include=dev --no-audit --no-fund || restore_and_build_current "the merged release's packages failed to install"
	else
		npm ci --include=dev --no-audit --no-fund || restore_and_build_current "the merged release's packages failed to install"
	fi
	# Safety gates run AFTER install (the release may add packages) and
	# BEFORE build.
	echo "[vercel-build] Running storage seam gate..."
	npx tsx --test tests/storage-seam.test.ts tests/hosted-invariants.test.ts || restore_and_build_current "the merged release breaks a hosted-fork invariant (storage seam, withStore routes, host check, plugin gate)"
	echo "[vercel-build] Running type check..."
	setup_plugins || restore_and_build_current "the merged release's plugins failed to set up"
	NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit || restore_and_build_current "the merged release does not type-check"
	setup_serverless_chromium
	npx next build || restore_and_build_current "the merged release failed to build"  # plugins already set up above
	exit 0
elif [ $merge_status -eq 10 ]; then
	echo "[vercel-build] No newer upstream release"
	build_app
else
	restore_and_build_current "upstream merge failed (exit $merge_status)"
fi
