# LearnHarness — hosted fork

This repository is the **hosted (web) version** of [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness),
running on Vercel + Convex. It is licensed under the same **AGPL-3.0** as upstream; this public repository is
the corresponding source of the hosted deployments.

| Deployment | URL | Mode |
|---|---|---|
| Production ("gamma") | https://learnharness-gamma.vercel.app | single-user, no sign-in |
| Staging ("multiuser") | https://learnharness-multiuser.vercel.app | multi-user, sign-in |

## How it stays up to date — `.github/workflows/hosted-update.yml`

Every day at 03:17 UTC (or on demand: **Actions → hosted-update → Run workflow**, tick *redeploy* to redeploy without a new release):

1. **Merge** — if upstream published a newer release, it is merged into the `hosted` line on an `update/<tag>` branch.
   New upstream features that don't fit hosting stay **off** (plugins need `LH_PLUGINS=1`, etc.).
2. **Verify** — install, type-check, the hosted-fork invariant tests, and the upstream tests the release changed.
3. **Staging** — deploy, then live smoke + upload checks against staging.
4. **Production** — encrypted Convex export (backup), deploy, live smoke. On failure: automatic rollback to the previous
   deployment and an issue labelled `hosted-update`. On success, `hosted` is fast-forwarded.

A merge that needs a human never touches production — it opens an issue instead.

Branches: `hosted` is the default and the deployed line. Tags are never pushed here (upstream's desktop release
workflow must not run on this repository).

Source for the hosted deployments; report hosted-only problems as issues here.

## Core plugins on hosted (branch `feat/core-plugins`)

Flashcards, Drawing Pad and Rich code blocks run on hosted; **Coding Questions is
blocked** (it runs programs on the server). Turn plugins on with `LH_PLUGINS=1`.

| Problem on Vercel | Fix |
|---|---|
| `core-plugins/` is built, not committed | `vercel-build.sh` runs `npm run plugins:build-core`; `next.config.ts` traces it into the functions |
| plugins write files on a temporary instance disk | host stores and plugin backends' `require("fs")` go through `src/store/vfs.ts` → Convex (`plugin-loader.cjs` hook, hosted only) |
| a function freezes after its response, killing background workers | workers get `keepAlive` (`waitUntil`), capped at 240 s |
| several instances cache old plugin data | Flashcards / settings re-read when another instance wrote a newer revision |

| Env | Effect |
|---|---|
| `LH_PLUGINS=1` | plugins available (each still enabled in Settings → Plugins) |
| `LH_MULTI_USER=1` | plugins off unless `LH_PLUGINS_MULTI_USER=1` (plugin data is not per user yet) |
| `LH_PLUGINS_ALLOW_CODE=1` | unblocks Coding Questions — **do not set on a public server** |

Live checks: `python3 scripts/ci/plugins-live.py` (enable + persistence) and
`python3 scripts/ci/plugins-worker-live.py` (a background worker finishes; one cheap model call).
Preview: https://learnharness-plugins.vercel.app (staging Convex).
