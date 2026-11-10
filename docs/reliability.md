# Time limits and background work on serverless hosts

Vercel kills a function at a hard wall (300 s; `maxDuration`). `waitUntil`
(`src/server/keep-alive.ts`) only *extends the invocation that started the
work*. Before this wave, every background task inherited whatever time the
triggering request had left:

* a sub-agent job dispatched late in a turn got the leftovers and was killed
  silently
* the delivery (wake) turn ran in the job's leftovers
* the manual "extract" button didn't register its run at all, so it was
  frozen as soon as the 202 went out
* a hung model call (2 × 120 s timeout) plus anything else ran into the
  wall with no saved message
* recovery re-ran "orphaned" jobs that were still alive on another instance,
  because liveness was per process

## What runs where now

| work | where it runs | stop rule |
|---|---|---|
| a turn (POST /api/chat) | the request's invocation | stops itself at `LH_TURN_BUDGET_MS` (Vercel default 270 s) and saves an explained error |
| a sub-agent job | **its own invocation** (signed POST to `/api/internal/run`) | stops itself at `LH_JOB_BUDGET_MS` (Vercel default 240 s), hands the job back and resumes in a fresh invocation; after 3 starts it fails with "ran out of time", delivered to the lesson |
| a finished job's delivery (wake turn) | **its own invocation** | the turn budget above |
| manual extraction | the button's invocation (now `keepAlive`'d) | — |
| automatic extraction | the turn's invocation, after the turn settles | — |

If internal dispatch is unavailable (no secret, no origin, a preview
deployment, or the POST fails), the work runs in-process exactly as before.
Nothing is dropped.

## Durable job lease

`JobRecord.lease = {owner, until}` is written when a worker starts and
renewed every 20 s (TTL 60 s). `JobRecord.attempts` counts starts.

* Another worker (or the `/api/jobs` recovery sweep) runs the job only once
  the lease has lapsed, so there are no duplicate runs across instances.
* A worker that finds its lease taken over stops and writes nothing.
* A worker killed at the wall leaves the lease to lapse. The next sweep
  re-runs the job, up to the attempt cap.

## Settings (env)

| var | default | meaning |
|---|---|---|
| `LH_TURN_BUDGET_MS` | 270000 on Vercel, none elsewhere | per-turn wall budget |
| `LH_JOB_BUDGET_MS` | 240000 on Vercel, none elsewhere | per-run job budget |
| `LH_INTERNAL_ORIGIN` | `https://$VERCEL_PROJECT_PRODUCTION_URL` | where internal tasks are sent. Set it to the production alias. |
| `LH_INTERNAL_SECRET` | derived from `CRON_SECRET` / `LH_CONVEX_SECRET` | HMAC key for internal tasks |
| `LH_INTERNAL_DISPATCH` | on for Vercel production | `0` = always in-process. `1` = force on (e.g. a local test with `LH_INTERNAL_ORIGIN`). |
| `LH_MODEL_TIMEOUT_MS` | pi-ai default | per-attempt connect/first-byte timeout. 60000 is recommended on hosted deployments. |

## Known limits

* Turn liveness (`turnInFlight`) and the extraction status dock are still
  per instance. A view served by another instance may not see a run in
  progress, although the durable record is always correct.
* A single sub-agent run that genuinely needs more than the job budget
  restarts from scratch each attempt. There is no mid-loop checkpoint yet.
  The eval reports this as `job-error … ran out of time`.

Measure with `evals/agent-reliability` (live) and
`tests/job-reliability.test.ts` (deterministic).
