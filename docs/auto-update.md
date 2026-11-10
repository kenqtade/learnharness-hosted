# Auto-update (hosted app only)

**What it does:** the hosted app (Vercel) checks daily for a newer upstream LearnHarness release. When one exists, it triggers a Vercel rebuild that merges the new release with our changes. If the merge succeeds, the app updates to the new version. If the merge fails or the build fails, the previous version stays live (Vercel only promotes successful builds).

**The whole feature is OFF unless `LH_AUTO_UPDATE=1`.** With it unset, the build and runtime behave exactly as today (no daily checks, no merges).

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `LH_AUTO_UPDATE` | No (but required for feature to work) | Set to `1` to enable auto-update |
| `CRON_SECRET` | Yes (when enabled) | A secret token for the Vercel Cron endpoint |
| `LH_VERCEL_TOKEN` | Yes (when update needed) | Your Vercel API token |
| `LH_VERCEL_DEPLOYMENT_ID` | Yes (when update needed) | The Vercel deployment ID from your deployment's settings |
| `LH_VERCEL_PROJECT_NAME` | No | Defaults to `learnharness` |
| `LH_VERCEL_TEAM_ID` | No | Set if you're on a Vercel team |
| `LH_UPSTREAM_REPO` | No | Defaults to `amosblomqvist/learnharness` |
| `GITHUB_TOKEN` | No | Set to avoid rate limits on GitHub API |

## How it works

1. **Cron check (03:17 UTC daily)**: Vercel Cron calls `GET /api/cron/update` with the `CRON_SECRET` header
2. **Version check**: The endpoint fetches the latest release from GitHub
3. **Redeploy trigger**: If a newer version exists, it calls Vercel's deployment API to rebuild
4. **Build-time merge**: During the build, `scripts/vercel-build.sh` runs `scripts/upstream-merge.mjs` which:
   - Downloads both the current base and the latest release
   - Merges our changes on top in git
   - Copies the result to the working directory
5. **Deploy or rollback**: If the merge and build succeed, the new version deploys. If they fail, the old version stays live.

## What happens on a conflict

If the auto-merge encounters conflicts (different code on the same lines), the build fails. The previous deployment remains live. Check Vercel's build logs to see which files conflicted, then fix the conflict locally and redeploy.

## Safety gates (what stops an unsafe update)

Even a merge with no text conflicts can be wrong for the hosted app, so after a merge and `npm ci` the build runs two checks **before** building:

1. **Storage seam check** (`tests/storage-seam.test.ts`): no file in `src/store/` may use `node:fs` directly. On Vercel every save must go through `src/store/vfs.ts`, which writes to Convex. Anything else writes to a throwaway disk and the data disappears.
2. **Type check** (`tsc --noEmit`).

If either check fails, the build stops with "refusing to ship" and **the previous deployment stays live**. Nothing is lost.

## Status: ported to v0.5.0

v0.5.0 needed a one-time manual port. It had 2 text conflicts, and its new
crash-safe save helper (`src/store/atomic-write.ts`) wrote to disk directly.
That helper now runs through the storage seam (`src/store/vfs.ts`): hosted
saves go to Convex, and local/desktop saves keep upstream's crash-safe
behaviour unchanged. `upstream.json` now says `"base": "v0.5.0"`, so later
releases merge automatically as long as they pass the safety gates.

## Manual update

You can manually check for updates by visiting `GET /api/update` (or clicking "Check now" in settings). This returns the current status:

```json
{
  "enabled": true,
  "current": "0.5.0",
  "latest": "0.5.1",
  "checkedAt": "2024-01-15T10:30:00.000Z",
  "state": "up-to-date",
  "message": "Up to date (latest upstream release: 0.5.1)",
  "lastAttempt": {
    "version": "0.5.1",
    "at": "2024-01-15T10:30:00.000Z",
    "deploymentUrl": "https://build-vercel-url.vercel.app"
  }
}
```

## Setting up for the first time

1. Enable auto-update by setting `LH_AUTO_UPDATE=1` in your Vercel project settings
2. Generate a cron secret: `openssl rand -hex 32`
3. Set these variables in Vercel:
   - `CRON_SECRET` = your secret
   - `LH_AUTO_UPDATE` = `1`
4. Get your Vercel credentials:
   - `LH_VERCEL_TOKEN`: Vercel → Settings → Tokens → Create
   - `LH_VERCEL_DEPLOYMENT_ID`: Vercel → Settings → General → Deployment ID

The app will check for updates at the next scheduled run (daily at 03:17 UTC) and every time you click "Check now" in settings.