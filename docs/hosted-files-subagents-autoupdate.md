# Hosted LearnHarness: files, sub-agents, auto-update (status 2026-11-12)

## 1. Files: uploads on the hosted web (BUILT, live on staging)

Since v0.4–0.6, upstream features take **local paths** (path chips). A browser `File` has no local
path, so the hosted version needs an upload step. That step now exists.

**How it works:**
1. **Paperclip on the hosted web.** `POST /api/files {action:"upload-url"}` returns a Convex upload
   URL, and the browser uploads **directly to Convex file storage**. This bypasses Vercel's 4.5 MB
   request cap. Limit: 25 MB per file.
2. **Commit.** `POST /api/files {action:"commit", storageId, name}`:
   - the server checks the blob's real size;
   - it enforces the per-user quota: 200 MB and 100 files;
   - it records the file in the user's own index (`src/store/uploads-index.ts`);
   - it returns `/tmp/lh-uploads/<user>/<name>`, which becomes a normal path chip.

   A refused blob is deleted.
3. **Before each turn or job**, the user's files are materialized into that folder. Only missing
   files are downloaded, and stray files are removed. The confined file tools then see exactly that
   user's files: the tutor's `read`/`ls`/`grep`, the `pdf` job, `show_image` and image annotation.
4. `GET /api/files` lists the files and `DELETE /api/files?id=` removes one. Deleting an account
   removes its files.
5. Every Convex blob function requires the server secret (`convex/uploads.ts`). The route runs in
   the signed-in user's scope.

**Verified:**
- Unit tests: `tests/hosted-uploads.test.ts`.
- Live check (`scripts/ci/uploads-live.py`, **12/12** on staging):
  - a 6 MB upload, beyond Vercel's cap;
  - anonymous access refused;
  - an unknown blob refused;
  - cleanup.
- Model-in-the-loop check (`evals/agent-reliability/uploads_live.py`): the tutor opened an uploaded
  note and read back its random code word in 19 s (the `read` tool).

**Not built yet:**
- A "previously uploaded files" picker. The list and delete APIs exist.
- A byte-level progress bar.
- Extract files and the flashcards plugin still take a multipart body, so on hosted they are capped
  at 4.5 MB.

**Security (fixed earlier, `0ec232a`):** on hosted, every path tool is confined to the signed-in
user's uploads folder. Before this fix it could read the shared function container, including
`/proc/self/environ` and other users' `/tmp` files. Tests: `tests/hosted-file-access.test.ts`.

## 2. Sub-agents on hosted: how they run

The teacher calls a job tool (`research`, `pdf`, `demo`, `visual`). This creates a job record and
sends a signed `POST /api/internal/run`, which gets its **own** function invocation and its own
300 s limit:
- The runner claims a **lease** (60 s TTL, renewed every 20 s) and works within a **240 s budget**.
- At the budget it stops cleanly and hands the job to a fresh invocation, **3 attempts** max.

**Checkpoints (new):**
- The visual maker saves every SVG draft, and the demo builder saves every draft plus each passing
  headless test, into the job record (`checkpoint`).
- A resumed attempt **continues from that draft** instead of starting over.
- If the last attempt still runs out of time, a **verified** draft is delivered as the result rather
  than an error. Verified means it was rendered, or passed a headless test.

**Salvage on provider failure (new):** if the model connection fails (timeout or 5xx) after the
current draft was already rendered or tested, that draft is delivered with an honest note. Before,
the whole job was thrown away.

| sub-agent | hosted status |
|---|---|
| research | works (web fetch/search) |
| demo | headless test via serverless Chromium (job route only, about 2 s cold start) |
| visual | resvg render, with checkpoints and salvage |
| pdf | works on uploaded PDFs |
| extraction | runs after the turn, inside the request |

## 3. Auto-update (CI): safe, free, fixes-only

**State:**
- Prod is on the v0.6 line with sign-in.
- `upstream.json` base is v0.6.1, which merged cleanly; one test was adjusted for pi-ai 1.5.0.

**Pipeline:** `.github/workflows/hosted-update.yml`, on GitHub Actions (free and unlimited for a
public repo, no card). It runs daily at 03:17 UTC, or on demand:
1. **merge:** `scripts/upstream-merge.mjs` merges the latest upstream release into an
   `update/vX.Y.Z` branch.
   - On a conflict it opens a GitHub issue and stops. **Prod is untouched.**
2. **verify:** `npm ci`, `tsc`, the hosted invariant gates (storage seam, invariants, file
   confinement, job reliability, request limits), and every upstream test the release changed.
3. **staging:** `scripts/ci/deploy.sh staging` deploys this commit's Convex functions, then the
   Vercel deployment.
   - The build runs with `LH_AUTO_UPDATE=0`, so it never re-merges anything unverified.
   - It waits until the alias serves the **new deployment id**.
   - Then `scripts/ci/smoke.py` runs (sign-in gate, core API, storage round-trip), followed by
     `scripts/ci/uploads-live.py`. These checks use no model, so no provider key is spent.
4. **prod:**
   - an encrypted Convex export is saved as a 14-day run artifact;
   - the same commit is deployed;
   - the smoke test runs;
   - **if anything fails, prod is redeployed from the last good `hosted` commit** and an issue is
     opened.
5. **promote:** `hosted` is fast-forwarded to the verified commit.

New upstream features that don't suit hosting stay off on hosted:
- plugins need `LH_PLUGINS=1`;
- file tools stay confined to uploads.

So a feature can't block a fix from shipping.

**Setup, once the repo exists** (Settings → Secrets and variables → Actions):

| secret | value |
|---|---|
| `VERCEL_TOKEN` | a Vercel token scoped to the team (create a new one; don't reuse a personal all-access token) |
| `VERCEL_ORG_ID` | the team id |
| `VERCEL_PROJECT_ID_STAGING` / `VERCEL_PROJECT_ID_PRODUCTION` | project ids |
| `CONVEX_DEPLOY_KEY_STAGING` / `CONVEX_DEPLOY_KEY_PRODUCTION` | Convex deploy keys |
| `STAGING_URL` / `PRODUCTION_URL` | the deployment URLs |
| `STAGING_OWNER_PASSWORD` / `PRODUCTION_OWNER_PASSWORD` | owner logins for the smoke checks (`*_OWNER_USER` defaults to `owner`) |
| `BACKUP_PASSPHRASE` | encrypts the prod backup artifact |

Then create the `hosted` branch from the current `feat/multi-user`, add a `production`
environment, and run **hosted-update** once with "redeploy".

Upstream's own `ci.yml` / `release.yml` / `notify-website.yml` are also in the repo:
- `ci.yml` runs on pushes to `main` and on PRs, which is harmless;
- `release.yml` runs only on `v*` tags;
- `notify-website.yml` runs only on published releases.

Don't push `v*` tags to the fork.
