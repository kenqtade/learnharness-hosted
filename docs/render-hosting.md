# Hosting on Render (free)

LearnHarness runs on Render's free web services as one ordinary Node server (`next start`).
Data stays in **Convex** (`LH_STORE=convex`), so the server's own disk doesn't matter.

## Why it remembers everything

| What could be lost when a free service sleeps | How it's handled |
|---|---|
| Chats, graph, settings, keys, plugin data | Stored in Convex. Loaded at boot (`instrumentation.ts` → `storeReady`) |
| Writes queued in memory when Render stops the server | `src/server/shutdown.ts` flushes them on SIGTERM (`NEXT_MANUAL_SIG_HANDLE=true`; Render allows about 30 s) |
| A long AI turn or background job when nobody is clicking | `keepAlive()` pings the service's own URL every 4 min while work is running, which counts as traffic. When the work ends the pings stop and the service may sleep |
| A job cut off anyway (crash, redeploy) | `recoverStaleJobs()` restarts unfinished jobs on the next boot |
| Uploaded files | Convex file storage (`convex/uploads.ts`), not local disk |

Known gap: ChatGPT *subscription* logins are saved in pi's own file store (see `docs/convex-vercel.md`
limit 5), so they must be redone after a restart. API keys are not affected.

## Free-plan limits (Render, 2026)

- 512 MB RAM, 0.1 CPU. `NODE_OPTIONS=--max-old-space-size=400`.
- Sleeps after **15 minutes** without inbound traffic. The first request after that waits **about a minute** while it wakes.
- **750 instance hours per workspace per month.** A service only uses hours while awake, and one always-awake service uses 744.
  If the workspace runs out, every free service is suspended until the 1st of the next month.
- 500 build minutes a month. Each push to `hosted` or `feat/core-plugins` triggers one build.
- The local filesystem is wiped on every sleep, restart and deploy (fine: nothing is kept there).

Compared with Vercel, there's no 300 s function limit and no 4.5 MB body limit, and background work runs in-process.

## Setup

1. Render dashboard → **New → Blueprint** → pick this repo, branch `hosted` (it reads `render.yaml`).
2. Enter the secrets it asks for (`CONVEX_URL`, `LH_CONVEX_SECRET`, `LH_SESSION_SECRET`, `LH_OWNER_SETUP_CODE`, `CRON_SECRET`).
   Use the same values as the old Vercel projects. The plugins service uses the dev/staging Convex deployment.
3. Wait for the first build, then open `https://learnharness.onrender.com`.

`.github/workflows/render-smoke.yml` builds the app the same way and fails if memory goes over about 480 MB.
