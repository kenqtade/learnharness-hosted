# Auto-update (hosted app only)

**What it does:** the hosted app (Vercel) keeps itself on the latest upstream LearnHarness release. When a newer release exists, it starts a Vercel rebuild that merges that release with our changes (Convex storage, multi-user). If the merge, the safety checks and the build all succeed, the new version goes live and open pages offer a refresh. If any step fails, the previous version stays live and Settings shows why.

**The whole feature is OFF unless `LH_AUTO_UPDATE=1`.** With it unset, the build and runtime behave exactly as before: no checks and no merges.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `LH_AUTO_UPDATE` | To turn it on | Set to `1` to enable auto-update |
| `CRON_SECRET` | Yes, when enabled | The secret Vercel Cron sends to `/api/cron/update` |
| `LH_VERCEL_TOKEN` | Yes, when enabled | A Vercel API token. It starts the rebuild and follows its build state |
| `LH_VERCEL_PROJECT_NAME` | Yes, unless the project is called `learnharness` | The Vercel project name |
| `LH_VERCEL_TEAM_ID` | When the project belongs to a team | The Vercel team id (`team_…`) |
| `VERCEL_DEPLOYMENT_ID` | Automatic | Vercel's system variable; the rebuild re-uses this deployment's files. It needs "Automatically expose System Environment Variables", which is on by default |
| `LH_UPSTREAM_REPO` | No | Defaults to `amosblomqvist/learnharness` |
| `GITHUB_TOKEN` | No | Avoids GitHub API rate limits |

## How it works

1. **When it checks.** Vercel Cron calls `GET /api/cron/update` daily at 03:17 UTC; Hobby plans allow at most daily crons. On top of that, any page that reads the update status (Settings → General) runs the check when the last one is more than 6 hours old. So a new release is picked up within hours of anyone using the app. A rebuild for any one version starts at most once per 24 hours, so this cannot loop.
2. **Version check.** The latest GitHub release is compared with the running `package.json` version.
3. **Rebuild.** If the release is newer, the Vercel API redeploys the current deployment. The deployment id is recorded so the app can follow the build.
4. **Build-time merge.** `scripts/vercel-build.sh` runs `scripts/upstream-merge.mjs`. It downloads the base release (`upstream.json`) and the latest release, replays our changes onto the latest in a temporary git repo, then copies the result back.
5. **Safety gates, then build.** See below. Vercel only promotes a build that succeeds.
6. **Status follow-up.** While a rebuild is running, status reads ask Vercel for its state. A failed build becomes `update-failed` ("the current version stays live"). A ready build tells users to refresh. Once the new deployment is serving, it reports "up to date".
7. **Refresh.** Every page carries the build id it was built with (`LH_BUILD_ID`, baked from `VERCEL_DEPLOYMENT_ID` by `next.config.ts`). The page polls the public `GET /api/version` every 5 minutes and when the tab regains focus. When the live build id differs, it shows **"A new version of LearnHarness is available — Refresh"**. A tab in the background with no unsent text reloads by itself.

## Multi-user mode (`LH_MULTI_USER=1`)

- The status is stored once for the whole server, in the platform space (`<data>-platform/update-status.json`, which is Convex in hosted mode), so every account sees the same thing.
- **Owner:** Settings → General shows the version, the status, when it last checked, and **Check for updates now**. Failure details (for example "see the Vercel build logs") are shown only to the owner.
- **Members:** the same version and status, read-only, marked "Managed by the owner of this server", with no operator details.
- **Everyone** gets the refresh banner, plus a Refresh button in Settings once a newer version is live.
- **Access rules:**

  | Route | Who |
  | --- | --- |
  | `GET /api/update` | any signed-in account |
  | `POST /api/update` | owner only |
  | `/api/cron/update` | public (checks `CRON_SECRET`) |
  | `GET /api/version` | public (version and build id only) |

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

Owners can click **Check for updates now** in Settings → General, or `POST /api/update`. `GET /api/update` returns the status:

```json
{
  "enabled": true,
  "current": "0.5.0",
  "latest": "0.5.1",
  "checkedAt": "2026-11-10T10:30:00.000Z",
  "state": "update-triggered",
  "message": "A rebuild for 0.5.1 was started, the app updates when the build succeeds.",
  "lastAttempt": { "version": "0.5.1", "at": "2026-11-10T10:30:00.000Z", "deploymentUrl": "https://….vercel.app", "deploymentId": "dpl_…", "buildState": "building" },
  "buildId": "dpl_…"
}
```

`state` is one of `disabled`, `up-to-date`, `update-triggered`, `update-failed` or `error`.

## Setting up for the first time

1. Generate a cron secret: `openssl rand -hex 32`.
2. In the Vercel project's environment variables, set `LH_AUTO_UPDATE=1`, `CRON_SECRET`, `LH_VERCEL_TOKEN` (Vercel → Account Settings → Tokens), `LH_VERCEL_PROJECT_NAME` and, for team projects, `LH_VERCEL_TEAM_ID`.
3. Deploy. The cron in `vercel.json` registers with the production deployment.

The app checks at the next cron run, whenever someone opens Settings after 6 hours without a check, and when the owner clicks "Check for updates now".
