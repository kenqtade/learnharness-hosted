# Convex route map (Phase 0 inventory)

Inventory date: 2026-11-24. Branch: `hosted`. Scope: all **61** `app/api/**/route.ts` files
(**94** exported HTTP handlers). This is an inventory for
[`convex-hosting-plan.md`](convex-hosting-plan.md), not an implementation decision.

## Reading the table

- **Baseline on almost every route:** `withStore()` from `src/server/store-ready.ts`
  wraps the handler. In platform mode it calls `storeReady()` (Convex sync/flush),
  `initAuthEnv()`, verifies the `lh_session` cookie, enters the per-user scope with
  `AsyncLocalStorage` (`node:async_hooks`), checks `routeAccess`, and flushes writes.
  It transitively pulls `src/store/vfs.ts` (`node:fs`, `ConvexHttpClient`) and
  `src/server/keep-alive.ts` (`@vercel/functions.waitUntil`). Exceptions are called
  out in the route notes (`/api/version` needs no store; `/api/cron/update` has its
  own `CRON_SECRET` gate).
- **Streams?** describes the **response** unless marked "request". "SSE" means an
  open `text/event-stream`; "NDJSON" means a chunked run log.
- **Long?** = awaits a model/tool call, holds a connection, or runs work after the
  response. Short network calls (GitHub, Deepgram) are noted but not "long".
- **Target** is the suggested primary destination:
  `direct-query` (Convex query/mutation), `node-bridge` (Phase 1 Node action),
  `scheduler` (Convex scheduled function/action), `subscription` (Convex table +
  client subscription), `drop-on-hosted` (unavailable/degraded on Convex).
  Where one HTTP route splits into several targets, the split is named.
- `node-bridge` is the **Phase 1** default for everything not yet rewritten; the
  targets below describe where the route should finish up.

## Routes

| Route (`app/api/...`) | Methods | Streams? | Long? | Node-only imports / important side effects | Target |
|---|---|---|---|---|---|
| `account/route.ts` | GET, PATCH, POST | no | no (scrypt is short) | `node:crypto` (`scryptSync`, `timingSafeEqual`, `randomBytes`), `node:path`; session cookie set/cleared, sessionVersion bumps; 404 in single-user mode | `node-bridge` (cookie + scrypt; account records could become queries later) |
| `activity/abort/route.ts` | POST | no | no (delivery is backgrounded) | `keepAlive` + `waitUntil` for job abort delivery; aborts process-local extraction/turn/plugin-worker registries | `subscription` (persist run records first; abort becomes a mutation) |
| `activity/route.ts` | GET | no | no | `graphRevision()` uses `node:fs.statSync`; composes global job/extraction/worker registries and Pi pricing | `subscription` (replace registries with Convex run records) |
| `admin/config/route.ts` | GET, PUT | no | no | owner cookie gate; one platform record (`openSignups`) | `direct-query` |
| `admin/invites/route.ts` | GET, POST, DELETE | no | no | owner gate; invite codes via accounts store (`node:crypto`) | `direct-query` |
| `admin/users/route.ts` | GET, PATCH, DELETE | no | no | owner gate; `node:crypto`/`node:path` via accounts; DELETE wipes user space (`vfs.rmSync`) + fire-and-forget upload cleanup | `direct-query` (data-space/blob deletion needs a `node-bridge`/action) |
| `auth/login/route.ts` | POST | no | no | `scryptSync` + HMAC cookie (`node:crypto`) via `accounts.ts`; issues `Set-Cookie` | `node-bridge` |
| `auth/logout/route.ts` | POST | no | no | HMAC cookie helpers; clears `Set-Cookie` | `node-bridge` |
| `auth/me/route.ts` | GET | no | no | HMAC cookie verification (`node:crypto`), returns `multiUser`, `platform`, `hostedFileAccess` | `node-bridge` (Phase 1); later a default-runtime session query (Phase 2/7) |
| `auth/signup/route.ts` | POST | no | no | scrypt hash + invite write + `Set-Cookie` | `node-bridge` |
| `capabilities/route.ts` | GET | no | no | `node:fs.existsSync` probes local Chrome binary paths; env mirror; no store write | `direct-query` with a Convex-stored capability report (drop the `existsSync` probe) |
| `chat/route.ts` | POST | no (JSON ack); `settledTurnResponse` SSE only on the sibling-question gate | **yes** — starts teacher turn under `keepAlive`; may await plugin grading | `node:async_hooks`, vfs `node:fs`, `internal-dispatch` HMAC, job paths reach `child_process`/puppeteer/`@resvg/resvg-js`; durable markers; `maxDuration=300` | `scheduler` (one action starts, scheduled functions continue the turn) |
| `chats/route.ts` | GET, POST | no | no | vfs-backed chat store; creates chat, settings stamp, graph-context marker; `emit("chats-changed")` | `direct-query` (Convex query/mutation) |
| `chats/[id]/route.ts` | GET, PUT, DELETE | no | GET awaits durable liveness; DELETE polls extraction wind-down for a few seconds | plugin host (`node:path`, `node:crypto`, `createRequire`), `emit`, graph/activity/project cleanup | `direct-query` (delete orchestration as a mutation; plugin reconciliation stays behind the bridge) |
| `chats/[id]/artifact-ui/route.ts` | POST | no | no | pure `setSteerUiInverted` + chat record write; comment says "no wake, no agent, no tokens, no SSE" | `direct-query` |
| `chats/[id]/dismiss/route.ts` | POST | no | no | saves messages / `parkDismissal`; aborts a live turn via in-process registry; `emit` | `subscription` for live-turn control; record write is `direct-query` |
| `chats/[id]/images/[snapshotId]/route.ts` | GET | no | no | validates 64-hex id; reads `chat.imageSnapshots` only | `direct-query` |
| `chats/[id]/markdown/route.ts` | GET | no (full body) | no | pure formatting; `Content-Disposition: attachment` | `direct-query` |
| `chats/[id]/settings/route.ts` | PUT | no | no | catalog validation is pure; per-chat settings record write | `direct-query` |
| `chats/[id]/side-chats/route.ts` | GET, POST | GET no; POST **NDJSON** chunked run log | **yes** — Pi side-answer model call | `piEngineForSpec`; `updateSideChats`; live run registry on `globalThis`; `emit` | `scheduler` + `subscription` (run in an action, write results to an events/chat table) |
| `chats/[id]/side-chats/[threadId]/route.ts` | GET, PATCH | GET **NDJSON** watch stream | GET holds wire while answer runs | PATCH writes `updateSideChats` + emits; GET attaches to process-local listener | `subscription` (PATCH becomes a mutation) |
| `chats/[id]/side-chats/[threadId]/stop/route.ts` | POST | no | no (abort only) | aborts an `AbortController` in the process-local runs map; partial answer saved by the running answer | `subscription` (persist abort request in Convex) |
| `chats/[id]/steer/route.ts` | POST | no | no (steers a live agent) | `node:worker_threads.Worker` + `Buffer` for image resize; in-memory `agent.steer()` queue | `subscription` (write steer to Convex turn table; live agent picks it up) |
| `chats/[id]/stream/route.ts` | GET | **yes** — SSE; live replay, remote `: waiting` poll (3 s interval, 240 s cap), settled terminal | **yes** — holds wire up to 240 s | `events-stream`/`turn-stream` timers; `keepAlive`; durable marker reads; `maxDuration=300` | `subscription` (Phase 4 replaces SSE entirely) |
| `claude-code/route.ts` | GET | no | no | `node:child_process.execFile` (`--version`, 5 s), `node:os.tmpdir`, `node:fs`; owner + same-origin gate | `drop-on-hosted` (no CLI binary in Convex) |
| `cron/update/route.ts` | GET | no | no (awaits GitHub + Vercel APIs) | `node:path`, `node:crypto`/`Buffer`, vfs status file; own `CRON_SECRET` check, public route otherwise; can trigger a Vercel rebuild | `scheduler` (`convex/crons.ts`) |
| `custom-provider/route.ts` | GET, POST, PATCH, DELETE | no | POST awaits `discoverModels()` network probe | `node:crypto` HMAC ETag / `If-Match`, credential binding, `syncCustomProvider()` | `node-bridge` |
| `eval/job/route.ts` | POST | no | **yes** — visual/demo sub-agent with model + browser | `spawnEvalJob`; dynamic puppeteer-core, `node:child_process`, `@resvg/resvg-js`; HMAC self-dispatch; owner gate; 404 unless `LH_EVAL_HOOKS=1`; `maxDuration=300` | `drop-on-hosted` (staging-only hook; if needed, `scheduler` outside Convex) |
| `events/route.ts` | GET | **yes** — SSE with `: ping` every 25 s until cancel | **yes** — long-lived by design | in-process event bus `subscribe()` + timers; no durable storage | `subscription` (Phase 4 events table) |
| `files/route.ts` | GET, POST (`upload-url`, `commit`), DELETE | no | no | `node:crypto`, `node:fs`, `node:path` via uploads/hosted-files; Convex blob mutations + browser direct PUT; per-user upload index | `direct-query` (blob URL mint/commit/delete) |
| `graph/route.ts` | GET | no | no | pure store read/derivation | `direct-query` |
| `graph/costs/route.ts` | GET | no | no | read-time fold over Convex-backed records | `direct-query` |
| `graph/coverage/extract/route.ts` | POST | no | **yes** — fire-and-forget `runExtraction` with model calls | `@vercel/functions.waitUntil` via `keepAlive`; process run registry; emits per phase; `maxDuration=300` | `scheduler` |
| `graph/import/route.ts` | POST | no (bounded-chunk multipart **request**) | **yes** — 3 model-driven workers + PDF conversion, awaited | `node:crypto`, `node:fs/promises`, `node:url`, `pdfjs-dist/legacy`; 25 MiB support | `scheduler` for the pipeline; `node-bridge` for PDF conversion |
| `graph/nodes/[id]/route.ts` | DELETE | no | no | `node:fs.statSync` in `graphRevision()`; full ledger rewrite; 409 while extraction runs | `direct-query` (replace fs mtime with a version field) |
| `graph/positions/route.ts` | PUT | no | no | `graphStore.writePositions()`, optional synchronous settle | `direct-query` |
| `graph/render-settings/route.ts` | GET, PUT | no | no | vfs + atomic-write helpers for one JSON record | `direct-query` |
| `graph/sources/route.ts` | GET, POST, DELETE | no | no | `node:crypto` hash/uuid; source + chat-rename writes; emits in `finally` | `direct-query` (republish events through Convex) |
| `graph/status/route.ts` | GET | no | no | reads module/global extraction run registry; `node:crypto` deeper in pipeline | `subscription` (persist runs) |
| `internal/run/route.ts` | POST | no | **yes** — receives HMAC-signed self-POST and runs job/delivery/extraction/continue work under `keepAlive` | `node:crypto` HMAC + `timingSafeEqual`; `storeReady(true)`; `runAsUser`; 202 immediately; `maxDuration=300` | `scheduler` (this adapter *is* a scheduled invocation today) |
| `jobs/route.ts` | GET | no | no (may be in the same instance as `waitUntil` work) | `listJobs`, durable turn marker read; `maxDuration=300` | `direct-query` |
| `keys/route.ts` | GET | no | no | `keys.ts` reads `process.env` + vfs auth store; masked statuses | `direct-query` (env-source annotation must survive) |
| `keys/[id]/route.ts` | PUT, DELETE | no | no | saves/deletes key and reflects into `process.env`; env precedence/`shadowedByEnv` | `node-bridge` (env reflection; data half is a mutation) |
| `models/route.ts` | GET | no | short network calls only (catalog refresh) | `model-catalog.ts` bridges; `process.send` in subscription bridge; refreshes in-memory catalog on GET | `direct-query` with cached catalog; refresh moves to `scheduler` |
| `plugins/route.ts` | GET, POST | no | no (refresh awaits host init) | `runtime="nodejs"`; plugin host `node:path`, `node:crypto`, `createRequire`, `scripts/plugin-loader.cjs`; `syncHosted()`; emits | `node-bridge` in Phase 6; list itself can become `direct-query` |
| `plugins/[id]/route.ts` | PUT | no | maybe — activation can start services | same plugin host; writes `plugins-state.json` via vfs; `keepAlive` for hosted workers | `node-bridge` Phase 6 |
| `plugins/[id]/assets/[...file]/route.ts` | GET | no (in-memory bytes) | no | `runtime="nodejs"`; `node:path`, `node:crypto`, `createRequire`; plugin activation; allowlist | `node-bridge` Phase 6, then Convex file storage for bytes |
| `plugins/[id]/call/route.ts` | POST | no | **ambiguous** — arbitrary plugin handler may call models/workers | `runtime="nodejs"`; `createRequire`; arbitrary plugin backend deps; hosted workers use `keepAlive` | `node-bridge` Phase 6 (plugin code cannot be bundled generally) |
| `plugins/[id]/documents/markdown/route.ts` | POST, OPTIONS, GET, HEAD, PUT, PATCH, DELETE | no response stream; multipart **request** is chunked | **yes** — up to 25 MiB / 1000-page PDF conversion, CPU-bound | `runtime="nodejs"`; `node:fs/promises`, `node:path`, `node:url`, `pdfjs-dist/legacy`; process-wide `busy` gate | `node-bridge` Phase 6 |
| `search/route.ts` | GET | no | no | vfs-backed store refresh/flush only | `direct-query` |
| `settings/route.ts` | GET | no | no | `node:os`/`node:path` via `fileAccessConfigurationError()` | `direct-query` |
| `settings/[section]/route.ts` | PUT | no | no | `node:path` body validation; orphan-switch heal; `refreshWorkerRequestAdmission()` is process-local | `direct-query` (admission pool stays behind bridge) |
| `settings/prompts/route.ts` | GET | no | no | reads source `.md` fragments with `node:fs`/`node:path` | `node-bridge` (or ship fragments as Convex records) |
| `settings/prompts/[...segment]/route.ts` | PUT, DELETE | no | no | validates against deployment source `.md` tree via `node:fs`; writes override via vfs | `node-bridge` |
| `stt/token/route.ts` | GET | no | short Deepgram grant fetch | `process.env.DEEPGRAM_API_KEY` / key store; outbound `fetch` | `node-bridge` (secret stays server-side) |
| `subscriptions/route.ts` | GET, POST | no | no | `runtime="nodejs"`; imports Electron CJS (`electron/chatgpt.cjs`, `electron/subscriptions.cjs`, IPC helpers); `Buffer.concat`; process-owned connections | `drop-on-hosted` |
| `subscriptions/browser/route.ts` | GET, POST | no | no | `runtime="nodejs"`; same Electron CJS imports; in-memory one-use `BrowserAction` map; 303 redirect | `drop-on-hosted` |
| `themes/route.ts` | GET, POST | no | no | `src/store/themes.ts` uses vfs + `node:path` + atomic write; slug collision loop | `direct-query` |
| `themes/[id]/route.ts` | DELETE | no | no | vfs theme delete + settings fallback to `"default"` | `direct-query` |
| `update/route.ts` | GET, POST | no | short GitHub/Vercel network calls | `node:path`, `node:crypto` (`randomUUID`, `timingSafeEqual`), `Buffer`, JSON import attributes; stale GET can trigger Vercel rebuild; owner gate on POST | `scheduler` (`convex/crons.ts`) |
| `version/route.ts` | GET | no | no | no `withStore`; public; `runningBuildId()`/`runningVersion()` from config/package.json | `direct-query` (Phase 1: pure default-runtime handler) |

## Server-rendered pages

All nine pages are **async/server components** (none has `"use client"`); their
interactive leaves are client components. None fetches `/api/*` server-side.

| Page | Server reads | What a static client page needs |
|---|---|---|
| `app/page.tsx` (`dynamic="force-dynamic"`) | `pageSessionToken()` → `cookies()` + `storeReady`; `enterPageScope()`; `readSettingsRecord()`; `resolveSettings(...).graph.rendering`; `slotsConfigured()`; redirects to `/login` | `GET /api/auth/me`, `GET /api/settings`; client-side 401 → `/login`; browser-safe equivalents for rendering/config flags |
| `app/chat/new/page.tsx` (`force-dynamic`) | `searchParams.mode`; cookie + `enterPageScope`; settings/config; auth redirect | `useSearchParams()`, `/api/auth/me`, `/api/settings` |
| `app/chat/[id]/page.tsx` (`force-dynamic`) | `params.id`, `searchParams.prompt`; cookie/scope; `getChat(id)`; settings; `turnFailure`, `isTurnRunning`, `compactionInFlight` (process-local); `notFound()`/redirect | `GET /api/chats/[id]` (already includes `turnInFlight`, `turnError`, `compacting`, coverage, pricing, plugin availability), `/api/settings`, `/api/auth/me`; client 404. Note: API uses the *durable* liveness marker, page uses only the local registry — behavior differs today. |
| `app/login/page.tsx` | `multiUser` env flag; redirects to `/` when disabled | `GET /api/auth/me` (`multiUser`); client redirect |
| `app/signup/page.tsx` | same as login | same as login |
| `app/admin/page.tsx` (`force-dynamic`) | cookie/scope; `multiUser`; `currentUser()?.role === "owner"`; redirects | `/api/auth/me` for role; `AdminPanel` already calls `/api/admin/*` |
| `app/settings/page.tsx` | only `redirect("/chat/new")` | client redirect (static export can't emit a server redirect) |
| `app/account/page.tsx` (`force-dynamic`) | cookie/scope; `multiUser`; redirects | `/api/auth/me`; `AccountPanel` already calls it |
| `app/plugins/[pluginId]/[viewId]/page.tsx` | only awaits `params`; no data | `useParams()`; plugins already client-loaded via `/api/plugins` |

App-level blockers:
- `app/layout.tsx`: server component; imports `next/font/google`, calls `connection()`
  and `headers()`, then `readThemeBootFor(cookie)` (settings/theme store + cookie
  verification). Static export must drop `connection()`/`headers()`/server fonts
  and move theme boot to the client (`GET /api/settings` + `/api/themes` already
  used by `components/settings/appearance.tsx`); first-paint theme strategy is an
  open design question.
- `app/page-scope.ts`: server-only `cookies()` + `SESSION_COOKIE = "lh_session"` + `storeReady()`.
- `proxy.ts` (Next 16 "proxy", not `middleware.ts`): applies `apiRequestRefusal` to
  `/api` except the plugin-markdown route; 403 JSON with `Cache-Control: no-store`.
  `src/server/desktop-access.ts` checks Host allowlist (skipped when `VERCEL=1` or
  `LH_PROFILE=hosted`) plus cross-site writes. Convex HTTP actions must preserve
  this gate.
- `instrumentation.ts`: Node boot hook — `LH_STORE=convex` → `storeReady(true)` +
  `initAuthEnv()`, `initializePlugins()`, optional durable recovery. No equivalent
  in a static export; these must be triggered by API routes/functions.
- `next.config.ts`: currently `output: "standalone"`; bakes `LH_VERSION`,
  `LH_HOMEPAGE`, `LH_BUILD_ID = process.env.VERCEL_DEPLOYMENT_ID || "dev"`.

## Platform-specific usages to replace

### `keepAlive` (31 hits)
Definition: `src/server/keep-alive.ts:14` — calls Vercel `waitUntil()` **only** when
`process.env.VERCEL` is truthy (`:15-16`), swallowing errors; returns the original
promise. Re-exported at `src/server/index.ts:77`. Call sites:
`src/server/plugins.ts:80,90` (hosted plugin agents/workers, capped at 240 s via
`HOSTED_WORKER_TIMEOUT_MS` at `:35`), `compaction.ts:354`, `chat-handler.ts:259,262,273,397,1246`,
`turn-runs.ts:70`, `turn-service.ts:122`, `jobs.ts:233,423,461,777`,
`src/store/vfs.ts:205,257` (debounced Convex flush + retry),
`app/api/graph/coverage/extract/route.ts:14,37,40`, `HOSTED.md:39`.

### `waitUntil` (serverless meaning; 46 total hits including unrelated ones)
`src/server/keep-alive.ts:6,12,16`; rationale in `src/server/internal-dispatch.ts:5`,
`src/store/vfs.ts:20`, `src/store/turn-markers.ts:17`; route comments at
`app/api/chat/route.ts:10`, `app/api/chats/[id]/stream/route.ts:29`,
`app/api/jobs/route.ts:5`, `app/api/graph/coverage/extract/route.ts:17,38`.
Unrelated: Electron `waitUntilUp` (`electron/main.cjs:263,722`) and Playwright
`{ waitUntil: "load" }` in agent/browser scripts.

### `dispatchTarget` (15 hits)
`src/server/internal-dispatch.ts:49` (definition), `:111` (call), `:5,17` (docs).
Rules at `:51-57`: `LH_INTERNAL_DISPATCH="0"` → off; no `VERCEL` and not `"1"` → off;
preview `VERCEL_ENV` → off unless forced; requires a secret; target is
`LH_INTERNAL_ORIGIN` or `https://VERCEL_PROJECT_PRODUCTION_URL`, path
`/api/internal/run`. Callers: `src/server/chat-handler.ts:178,258,271`.
Tests: `tests/job-reliability.test.ts:30,371-377`.

### `process.env.VERCEL` / `VERCEL_ENV` / related
Production: `next.config.ts:17,46`; `src/server/keep-alive.ts:15`;
`src/server/plugins.ts:33`; `src/agent/tools/file-access.ts:26`;
`src/agent/subagents/runner.ts:122` (`VERCEL_REGION`);
`src/server/internal-dispatch.ts:54` (`VERCEL_ENV`);
`src/server/turn-liveness.ts:79` (`convexMode || VERCEL` → durable markers);
`src/server/chat-handler.ts:133,141,160` (Vercel budgets: jobs 240 s, turn 270 s,
2 continuations, all overridable); `src/server/desktop-access.ts:72`;
`src/agent/subagents/headless.ts:131` (serverless Chromium on Linux);
`src/agent/models.ts:199`; `src/server/upstream-update.ts:68,205,207,210,233,234,236,238,239`;
`scripts/vercel-build.sh`, `scripts/ci/deploy.sh`, `.github/workflows/hosted-update.yml:133-136`.
Many test fixtures set `VERCEL: "1"`; see `tests/job-reliability.test.ts`,
`serverless-chromium.test.ts`, `hosted-*.test.ts`, `update-flow.test.ts`,
`upstream-update.test.ts`, `browser-api-access.test.ts`, `vercel-build.test.ts`.

### `maxDuration`
All `export const maxDuration = 300` (seconds): `app/api/chat/route.ts:12`,
`app/api/chats/[id]/stream/route.ts:31`, `app/api/eval/job/route.ts:10`,
`app/api/graph/coverage/extract/route.ts:19`, `app/api/internal/run/route.ts:13`,
`app/api/jobs/route.ts:7`; plus the rationale comment at `src/server/chat-handler.ts:126`
("Vercel kills at 300 s"). Convex Node actions get 600 s; Phase 3 raises budgets
(`LH_TURN_WALL_MS` ≈ 540 s) and keeps continuations.

### `dynamic = "force-dynamic"`
44 API routes + 5 pages (listed above). Purpose: disable caching/prerender for
per-user/store/live data. `revalidate` hits are **not** Next ISR — they are a
local stale-while-revalidate parameter in `components/model-catalog.ts:7,17,18`
and test names.

### `runtime = "nodejs"`
Seven API routes: all five `plugins/**` routes plus both `subscriptions` routes.

### Host flags
- **There is no `LH_HOST` or `NEXT_PUBLIC_LH_HOST` in the current code** — only
  `LH_HOSTED_FILE_ACCESS` (`src/server/hosted-files.ts:29`,
  `src/agent/tools/file-access.ts:25`) and `LH_STORE=convex`. The plan's host flag
  must be introduced in Phase 1/2 without changing local behavior.
- `LH_STORE` (25 hits): `instrumentation.ts:3,14`, `src/store/vfs.ts:9,38,147,153,159`,
  `src/server/keys.ts:144`, `src/server/hosted-files.ts:30`,
  `src/core/capabilities/providers.ts:131`, `src/agent/tools/file-access.ts:25`,
  plus test fixtures. Value is always `"convex"`; anything else means local disk.
- `src/store/vfs.ts:143-148` reads `CONVEX_URL` / `NEXT_PUBLIC_CONVEX_URL`, **not**
  `CONVEX_CLOUD_URL` as the plan expects inside Convex. A decision is needed in
  Phase 2 (bridge can set one from the other; never hard-code a URL).

## Node-action bundle estimate

**Measured source footprint:** 61 route files / ~95 KB; `src/` 241 files / ~2.22 MB;
all first-party TS/TSX/JS/MJS in `app/api`, `src`, `lib`, `convex`, `config.ts`:
315 files / ~2.24 MB. `package.json` has no `"sideEffects": false`, and nearly
every route imports the broad `src/server/index.ts` barrel (50+ re-exports), so
an import-everything bridge drags in far more than the route it serves. Source
size is not bundled size; there is no Convex build artifact yet and no local
documentation of a function-size cap, so the exact number is unknown. Pure-JS
closure is plausibly low tens of MB; native/WASM payloads dominate.

**Pure JS likely bundleable:** `@earendil-works/pi-ai` (~1.94 MB JS), `pi-agent-core`
(~60 KB), `pi-durable` (~1.16 MB), `chord` (~1.74 MB), `@modelcontextprotocol/sdk`
(~1.67 MB), `undici` (~1.24 MB, used for SSRF-safe fetch at
`src/agent/tools/safe-fetch.ts:2`), `katex`/`d3-force` from `src/core`, `pdfjs-dist`
legacy JS (~5.7 MB JS but expects `standard_fonts` on disk —
`src/agent/subagents/pdf-ops.ts:54-56`).

**Native / OS / subprocess blockers:**
- `@resvg/resvg-js` — native binding, system fonts; imported
  `src/agent/subagents/headless.ts:553` (~4.2 MB platform package).
- `@napi-rs/canvas` — native binding, ~30–34 MB platform package; PDF rasterization
  at `headless.ts:637`; one 16 MP page needs ~61 MiB canvas before overhead.
- `@silvia-odwyer/photon-node` — WASM, dynamic import with catch at
  `src/agent/image-processing/photon.mjs:13`.
- `@libsql/client`/`libsql` — native `@libsql/<target>` via `@neon-rs/load`
  (`src/server/durable/libsql.ts:2`); `src/server/durable/storage.ts:40` dynamically
  loads the sqlite node backend or `node:sqlite`. Durable mode is opt-in but sits
  in the barrel closure.
- `puppeteer-core` + spawned Chromium — dynamic imports at `headless.ts:159,227,336`;
  `@sparticuz/chromium` is installed only by `scripts/vercel-build.sh:40-44` and
  copied by `next.config.ts:12-38`; no Convex equivalent.
- `child_process` — `src/agent/claude-code/installation.ts:1` (`execFile`),
  `launch.ts:1` (`spawn`), plus plugin program execution.
- `worker_threads` — `src/agent/image-processing/resize.ts:3`,
  `src/agent/tools/learner-image.ts:3` (worker scripts are `.mjs` sidecars).
- `@vercel/functions` — `src/server/keep-alive.ts:12`; must be stubbed or bypassed
  in Convex mode.
- Plugin host — `createRequire` + `scripts/plugin-loader.cjs` patches `Module._load`
  (`src/server/plugin-host.ts:334-344`); arbitrary plugin backends can use native
  deps and puppeteer. Cannot be bundled generically.
- Browser UI deps (`next`, `react`, `mermaid`, `@xyflow/react`, Radix, Electron,
  electron-builder) are **not** reachable from route handlers except `katex` and
  `d3-force` in `src/core`.

**Limits to design for:** 10-minute Node actions; 512 MB billed memory (~40 h/month
wall for 20 GB-hours); HTTP action responses ≤ 20 MiB (≈15 MiB after base64) —
so 25 MiB PDFs/images cannot be echoed through the bridge; hydrated filesystem
paths and dynamic native imports are unavailable; Convex env vars must be set
separately from Vercel env vars.

**Conclusion:** a single universal bridge that imports every unchanged handler is
not a safe end state. Phase 1 can use a generated **leaf-module** route table with
explicit Convex-mode seams for store readiness, context, background work and
response serialization; phases 2–7 progressively move routes out of it.

## Open questions (design authority stays with the owner)

1. Which routes may be `drop-on-hosted` vs. must be reimplemented (especially
   Claude Code, subscriptions, eval hooks, plugin code execution, PDF conversion)?
2. How to preserve first-paint theme on a static export without `headers()`/`connection()`.
3. Whether `CONVEX_CLOUD_URL` should be aliased inside Convex or `vfs.ts` should
   learn to read it directly.
4. Exact Convex bundle-size cap and native-addon support (requires a deploy/build
   experiment, explicitly out of scope for this run).
5. How to represent `routeAccess`, `enterPageScope` and proxy Host checks on
   `convex.site` (one origin, but no Next proxy).
