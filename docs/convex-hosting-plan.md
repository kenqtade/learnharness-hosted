# Convex hosting plan: run LearnHarness without Vercel

**Goal:** the whole hosted app (prod, staging, plugins) runs on **Convex only**, on
the free plan, with no Vercel. The browser loads a static build of the frontend,
and every `/api/*` request is answered by Convex functions.

**Why:** Vercel paused the Hobby team on 2026-11-20 (`FAIR_USE_LIMITS_EXCEEDED`,
Fluid Active CPU, 4 h/month). Every site returns `402 DEPLOYMENT_DISABLED` until
2026-12-20. The data is already in Convex (see `docs/convex-vercel.md`), so
Convex can take over the server too.

**Who does the work:** OpenCode, run by `.github/workflows/convex-migration.yml`
(on the `hosted` branch). It works on branch **`convex-host`** one phase at a time,
ticking boxes in `docs/convex-migration-progress.md`. The owner reviews the draft PR.

---

## Target architecture

```
browser ──► https://<deployment>.convex.site/            static frontend (Next.js `output: "export"`),
   │                                                     served by @convex-dev/static-hosting
   └──────► https://<deployment>.convex.site/api/*        convex/http.ts  (httpAction, default runtime)
                                                           │  cheap reads answered directly with ctx.runQuery
                                                           ▼
                                               internal Node action  convex/node/api.ts  ("use node")
                                                 rebuilds a Request, calls the SAME route handler
                                                 module from app/api/**/route.ts, returns
                                                 {status, headers, bodyBase64}
                                                           │ background work
                                                           ▼
                                               ctx.scheduler.runAfter(0, internal.node.background.run, task)
                                                 (replaces keepAlive/waitUntil and internal-dispatch's self-POST;
                                                  Node actions get a 10-minute wall instead of Vercel's 300 s)
```

- **One origin.** The frontend and the API are both on `convex.site`, so session cookies
  and relative `/api/...` URLs keep working. No CORS needed.
- **Reuse route handlers.** Next route handlers are already `(Request) => Response`.
  Do not rewrite 71 routes by hand. Write one bridge plus a generated route table
  (`scripts/gen-convex-routes.mjs` → `convex/node/routes.gen.ts`, mapping URL patterns
  such as `/api/chats/[id]/steer` to the imported module and its params).
- **Streaming.** `httpAction` → `runAction` cannot stream. Move live updates
  (`/api/chats/[id]/stream`, `/api/events`) to a Convex table that the turn writes to.
  The browser subscribes with `ConvexClient.onUpdate` from `convex/browser`, falling back
  to short polling.
- **Store.** `src/store/vfs.ts` with `LH_STORE=convex` already syncs to Convex.
  Inside Convex, `process.env.CONVEX_CLOUD_URL` is the deployment URL. Keep the module-level
  cache warm between invocations, and pull only changed files (`storeReady()`).
- **Crons.** `vercel.json` crons become `convex/crons.ts`. Free and built in.

## Hard rules (every phase)

1. **Local mode must keep working unchanged.** `npm run dev`, the desktop app and the test suite
   run without Convex. Everything new sits behind `LH_HOST=convex`, or lives in `convex/`.
2. **Never commit secrets.** Keys live in Convex env vars (`npx convex env set`) and GitHub secrets.
3. **Never touch production data.** No `convex deploy` to prod and no import scripts.
4. Follow `AGENTS.md`, eslint `boundaries` (only `src/store/vfs.ts` may import `node:fs` in app code),
   and `noUncheckedIndexedAccess`.
5. `npx tsc --noEmit` must pass at the end of every run. Do not delete or skip tests to make it pass.
6. Small, reviewable commits. Update `docs/convex-migration-progress.md` (tick boxes, add notes,
   list open problems) before finishing.
7. Do not edit `plugins/*` except in phase 6.

## Free-plan budget (design for it)

Convex Free: 1M function calls/month, **20 GB-hours of action compute**, 0.5 GB database,
1 GB file storage, 1 GB egress; actions ≤ 10 min; HTTP action response ≤ 20 MiB.
- Node actions are billed at 512 MB, so 20 GB-h ≈ **40 h of Node action wall time a month**.
  Default-runtime actions are billed at 64 MB, about 8× cheaper.
- So serve every cheap or read-only route **without** a Node action where possible:
  `version`, `auth/me`, `settings` GET, `chats` list, `models`, `themes`, `plugins` list,
  and static plugin assets.
- A turn that waits on a model still burns wall time. Keep the 120 s model timeout, and never
  busy-poll inside actions.
- Static assets count against file bandwidth (1 GB). Use long-cache immutable hashed filenames.

---

## Phases

### Phase 0: inventory (no app code)
- Fill `docs/convex-route-map.md`. For every `app/api/**/route.ts` give: methods,
  streams? (yes/no), long-running? (yes/no), Node-only imports, and target
  (`direct-query` | `node-bridge` | `scheduler` | `subscription` | `drop-on-hosted`).
- List the server-rendered pages (`app/page.tsx`, `app/chat/new/page.tsx`,
  `app/chat/[id]/page.tsx`, `app/layout.tsx`, plus login/admin/others) and what data each reads.
- List every `keepAlive`, `waitUntil`, `dispatchTarget`, `process.env.VERCEL`, and `maxDuration` use.
- Estimate the Node-action bundle (pi agent libs etc.) against Convex's limits. Note any package
  that cannot run in a Convex Node action (native addons, child_process, Playwright, Electron).

### Phase 1: the bridge
- `convex/http.ts`: route `/api/*` (all methods) to the bridge. Add `/api/version` as a pure
  default-runtime route.
- `convex/node/api.ts`: an internal Node action `handle({method, path, query, headers, bodyBase64})`
  that dispatches via `routes.gen.ts`, passes `{ params: Promise.resolve(params) }` like Next does,
  and serializes the response, including `set-cookie`.
- `scripts/gen-convex-routes.mjs`, plus an npm script `convex:routes`. A test checks that the table
  matches the `app/api` tree.
- Unit tests for the bridge (fake ctx). `next/server` imports (`NextResponse`) must still work in Node.

### Phase 2: store and auth inside Convex
- `LH_HOST=convex` mode: the store syncs through the deployment it runs in. Session cookies and
  `enterPageScope`/scope users work through the bridge.
- `/api/auth/login`, `/api/auth/me`, `/api/chats` (GET), and `/api/settings` (GET) work end to end
  (test with a fake ctx, or `convex-test` if practical).

### Phase 3: background work and crons
- `keepAlive()` and `internal-dispatch` in `LH_HOST=convex` mode call
  `ctx.scheduler.runAfter(0, internal.node.background.run, envelope)`. Pass the action ctx via
  AsyncLocalStorage, the same way scope is passed.
- Raise turn deadline budgets for the 10-minute action wall (`LH_TURN_WALL_MS`, about 540 s), and
  keep turn continuation (`kind: "continue"`) for longer turns.
- `convex/crons.ts` replaces `vercel.json` crons.

### Phase 4: live updates without SSE
- Add an `events` table (chatId/userId, seq, payload, createdAt), with an index and a cleanup cron.
- The turn writes to it in convex mode. The client (`components/session*.ts` and the activity dock)
  subscribes with `ConvexClient` when `NEXT_PUBLIC_LH_HOST=convex`; otherwise it uses SSE as today.

### Phase 5: static frontend
- `NEXT_PUBLIC_LH_HOST=convex` build: `output: "export"`.
- Turn the server-rendered pages into client pages that fetch what they need from `/api/...`, and
  redirect to `/login` on 401. Make `chat/[id]` work as a static SPA route (fallback to `index.html`).
- Serve `out/` with `@convex-dev/static-hosting`: SPA fallback, immutable caching for `_next/static`.

### Phase 6: plugins
- Plugin routes (`plugins`, `[id]`, `call`, `assets`, `documents/markdown`) work through the bridge.
  Static assets are served from Convex storage, not a Node action.
- Plugin workers and background tools use the scheduler.

### Phase 7: optimise for the free plan
- Move every read-only route that can be served by queries out of the Node bridge.
- Add a usage estimate to `docs/convex-hosting.md`: calls and GB-hours per chat turn, per page load,
  and per month for one active user.
- Remove per-request work that isn't needed in Convex mode (repeated full `storeReady` pulls,
  warmups, Vercel-only retries).

### Phase 8: deploy tooling and docs
- `scripts/deploy-convex-host.sh`: build the frontend, `npx convex deploy`, upload static files.
  Use an env-provided deploy key; nothing hard-coded.
- A `workflow_dispatch` GitHub workflow that deploys to a target given by the `CONVEX_DEPLOY_KEY_*` secret.
- `docs/convex-hosting.md`: setup, env vars, limits, and how to roll back to Vercel.
- Write **ALL PHASES DONE** at the top of the progress file.
