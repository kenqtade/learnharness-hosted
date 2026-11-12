#!/usr/bin/env bash
# HOSTED FORK — deploy the CURRENT COMMIT to one hosted target (CI and manual).
#
#   scripts/ci/deploy.sh staging|production
#
# Env (CI secrets):
#   VERCEL_TOKEN, VERCEL_ORG_ID
#   VERCEL_PROJECT_ID_STAGING / VERCEL_PROJECT_ID_PRODUCTION
#   CONVEX_DEPLOY_KEY_STAGING / CONVEX_DEPLOY_KEY_PRODUCTION
#   STAGING_URL / PRODUCTION_URL
#
# - Only committed files ship (git archive): local data, keys and node_modules never upload.
# - Convex functions are deployed from the SAME commit first.
# - The Vercel build runs with LH_AUTO_UPDATE=0: CI already merged and
#   verified this commit, so the build must not merge anything unverified.
# - Waits until the target serves this commit's package version.
set -euo pipefail
TARGET=${1:?usage: deploy.sh staging|production}
case "$TARGET" in
	staging) PROJECT=${VERCEL_PROJECT_ID_STAGING:?}; CONVEX_KEY=${CONVEX_DEPLOY_KEY_STAGING:?}; URL=${STAGING_URL:?} ;;
	production) PROJECT=${VERCEL_PROJECT_ID_PRODUCTION:?}; CONVEX_KEY=${CONVEX_DEPLOY_KEY_PRODUCTION:?}; URL=${PRODUCTION_URL:?} ;;
	*) echo "unknown target $TARGET" >&2; exit 2 ;;
esac
: "${VERCEL_TOKEN:?}" "${VERCEL_ORG_ID:?}"
cd "$(dirname "$0")/../.."
VERSION=$(node -p "require('./package.json').version")
SHA=$(git rev-parse --short HEAD)

echo "▶ Convex functions ($TARGET @ $SHA)"
CONVEX_DEPLOY_KEY="$CONVEX_KEY" npx --yes convex deploy -y --typecheck disable 2>&1 | tail -2

OUT=$(mktemp -d)
git archive HEAD | tar -x -C "$OUT"
mkdir -p "$OUT/.vercel"
printf '{"orgId":"%s","projectId":"%s"}' "$VERCEL_ORG_ID" "$PROJECT" > "$OUT/.vercel/project.json"

echo "▶ Vercel build + deploy ($TARGET @ $SHA, v$VERSION)"
LOG=$(mktemp)
# VERCEL_ORG_ID / VERCEL_PROJECT_ID must not leak into the CLI's env (it would
# demand both); the project.json above is the single source.
(cd "$OUT" && env -u VERCEL_ORG_ID -u VERCEL_PROJECT_ID npx --yes vercel@latest deploy --prod --yes \
	--build-env LH_AUTO_UPDATE=0 --token "$VERCEL_TOKEN") >"$LOG" 2>&1 || true
grep -E "Production|Aliased|Ready|Error" "$LOG" | tail -5 || true
if grep -q "Error" "$LOG" && ! grep -q "Aliased" "$LOG"; then
	echo "✖ Vercel deploy failed — the previous deployment stays live" >&2
	tail -40 "$LOG" >&2
	exit 1
fi

echo "▶ Waiting for $URL to serve v$VERSION"
for _ in $(seq 1 30); do
	got=$(curl -fsS "$URL/api/version" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).version)}catch{console.log('')}})")
	[ "$got" = "$VERSION" ] && { echo "✔ $TARGET serves v$VERSION ($SHA)"; exit 0; }
	sleep 10
done
echo "✖ $URL never served v$VERSION (last: ${got:-none})" >&2
exit 1
