# Convex storage + Vercel hosting (branch `feat/convex-store`)

**What changed:** the app no longer needs a disk. Everything the stores save
(chats, graph, jobs, settings, prompt overrides, API keys) can live in
**Convex**, and the app runs on **Vercel**. Both are on free plans with no
credit card.

## How it works

```
browser ──► Vercel function (Next.js)
               │  storeReady()  → 1 query: "has anything changed?" → pull only changed files
               │  stores (src/store/*) read/write an in-memory copy, as before
               │  every write → queued → sent to Convex in order (waitUntil keeps the function alive)
               ▼
            Convex  (tables: files [chunked ≤ 900 KB], meta.version)
```

* `src/store/vfs.ts` is a drop-in for the `node:fs` calls the stores make.
  - Without `LH_STORE=convex` it calls real `fs`, so tests, Electron and
    local dev are unchanged.
  - With it set, nothing touches the disk.
* `convex/vfs.ts` has three functions: `sync`, `read` and `apply`. Each one
  requires `LH_CONVEX_SECRET`. Convex functions are public by URL, and the app
  has no login (single user, by design).
* `storeReady()` runs at the top of every API route and server page.
  `instrumentation.ts` loads everything at boot.
* `keepAlive()` (`src/server/keep-alive.ts`) registers background turns,
  jobs, extraction, compaction and pending writes with Vercel's
  `waitUntil`.

## Settings (already set on the Vercel project)

| Variable | Value |
|---|---|
| `LH_STORE` | `convex` |
| `CONVEX_URL` | `https://<deployment>.convex.cloud` |
| `LH_CONVEX_SECRET` | random 64-hex; the same value is set on the Convex deployment (`npx convex env set`) |
| `LH_PROFILE` | `hosted` |
| `LH_DATA_DIR` / `LH_AUTH_FILE` | `/tmp/lh-data`, `/tmp/lh-data/auth.json` (only used for path mapping; nothing is written there) |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | `1` (the desktop shell isn't needed on Vercel) |

## Commands

```bash
# deploy Convex functions (schema + vfs)
CONVEX_DEPLOY_KEY=prod:...|... npx convex deploy -y
# prove the store against a Convex deployment (two processes = two instances)
LH_STORE=convex CONVEX_URL=... LH_CONVEX_SECRET=... LH_DATA_DIR=/tmp/x \
  npx tsx scripts/convex-store-check.mts write t1 && ... read t1
# one-time import of an existing data dir
CONVEX_URL=... LH_CONVEX_SECRET=... npx tsx scripts/convex-import.mts <dataDir> <authFile>
```

## Known limits (honest list)

1. **Turns are capped at 300 s** (Vercel Hobby, can't be raised). A turn
   cut off by the cap keeps what it saved so far.
2. **Same-record races:** two instances writing the *same* file at the
   same moment means the last write wins. Unlikely with one user.
3. **Durable turns** (`LH_RUNTIME=pi-durable`) still keep their log in
   SQLite or Turso. A Convex connector for pi-durable's `Storage` interface is
   the next step. On Vercel the runtime is the normal in-process one.
4. **Local-only features** don't run on Vercel: local Chrome browsing,
   folder import, the Claude Code CLI and the desktop app.
5. **Subscription logins** (ChatGPT) save their credentials through pi's own
   file store, not the stores. On Vercel they don't survive a cold start.
6. Free-plan ceilings: Convex has 0.5 GB of data and 1M calls a month;
   Vercel Hobby is for non-commercial use.

## Auto-update (hosted)

The hosted app can update itself to the latest upstream release. See [Auto-update](auto-update.md) for details on enabling it and the required environment variables.
