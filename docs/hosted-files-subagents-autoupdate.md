# Hosted LearnHarness: files, sub-agents, auto-update (status 2026-11-11)

## 1. Files — what "attach a file" means on a hosted deployment

Since v0.4–0.6, upstream features take **local paths**, not uploads:

| feature | desktop | hosted web (before today) |
|---|---|---|
| paperclip / drag-drop attach | inserts a local path chip | disabled ("a browser File has no local path") |
| tutor `read` / `ls` / `find` / `grep` | learner's disk | **the server container's disk** |
| `show_image`, learner-image annotation (visual job) | path on learner's disk | server disk |
| `pdf` job / PDF reader | path on learner's disk | server disk |
| Extract files (graph import) | multipart upload | multipart upload, but Vercel caps a request body at **4.5 MB** (app limit 25 MB) |
| flashcards from a file (plugin) | upload | plugins off on hosted |

**Security finding (fixed and deployed today):** on hosted, the tutor's file tools read the shared
function container. `/proc/self/environ` holds the deployment secrets (Convex secret, cron secret,
setup code). Other users' files cached in `/tmp` on a warm instance were reachable too.
- Fix: `552eac4` on staging and `0ec232a` on prod.
  - All path tools go through one choke point (`resolveSourcePath` → `guardSourcePath(policy)`).
  - On hosted, the policy is now always *the signed-in user's uploads folder only*. The File access
    preference can't widen it, and a hosted process defaults to closed.
- Tests: `tests/hosted-file-access.test.ts` (9). Upstream's file-tool suites are unchanged (137 pass).
- The build's auto-update invariant gate now runs this suite on every upstream merge.

**Proposed uploads design** (not built yet):
1. Browser → `POST /api/files/upload-url` → Convex `generateUploadUrl` → the browser uploads
   **directly to Convex file storage**. This bypasses Vercel's 4.5 MB body cap and allows up to 25 MB.
2. `POST /api/files {storageId, name, size, type}` → a small per-user index in the user's data space.
   Blobs never enter the in-memory text store, which is synced to every instance.
3. At the start of each turn or job, the user's uploads are materialized into
   `/tmp/lh-uploads/<user>/` (download only what's missing, with a size cap). The confined tools then
   see exactly those files.
4. The paperclip on hosted uploads the file and inserts a chip with its path. The tutor, the `pdf`
   job, `show_image` and image annotation then work unchanged.
5. Extract files and the flashcards plugin take a `storageId`, so large PDFs work on hosted.
6. Deleting a file, chat or account removes the blob. A per-user quota applies.

All of it would live in fork-owned files plus thin hooks, so upstream merges stay clean.

## 2. Sub-agents on hosted — how they run

The teacher calls a job tool (`research`, `pdf`, `demo`, `visual`). This creates a job record and
sends a signed `POST /api/internal/run`, which gets its **own** function invocation and its own
300 s limit:
- The runner claims a **lease** (60 s TTL, renewed every 20 s) and runs with a **240 s budget**.
- On the budget it stops cleanly and hands the job to a fresh invocation, **3 attempts** max.
- The result (or the honest "ran out of time" error) is saved and delivered into the lesson, which
  wakes the teacher.

| sub-agent | hosted status |
|---|---|
| research | works (web fetch/search) |
| demo | headless test via serverless Chromium (only on the job route, about 2 s cold start) |
| visual | resvg render. Still has a stale headless preflight (TODO) |
| pdf | needs uploads (section 1). Until then it can only refuse honestly |
| extraction | runs after the turn, inside the request |

Live eval on staging (minimax):
- `demo-deadline` **passes**: a forced deadline leads to stop → resume ×3 → honest error delivered.
  The machinery holds.
- Real `visual` / `demo` jobs used all 3 × 240 s without finishing, because every attempt
  **restarted from scratch**. Fix in progress: job checkpoints. A resumed attempt continues from its
  last draft, and the final give-up delivers the last *verified* draft.
- Turn continuation: the 401 bug was fixed (`65679f6`). It hasn't been re-verified live yet, because
  the provider returned 503s.

## 3. Auto-update

- **Prod (v0.5.0 line) can't auto-update any more.** Upstream released v0.6.0, prod's build merges
  it, hits 11 conflicts, and the old build script **aborts the build**. Every prod rebuild,
  including the update cron, has failed silently since then; the old deployment keeps serving.
  - Today's hotfix shipped with auto-merge disabled for that single build.
- **The v0.6.0 line (`feat/multi-user`, on staging)** already has v0.6.0 merged
  (`upstream.json` base v0.6.0). On a conflict it **falls back to building the current code** and
  reports "needs a manual merge"; it doesn't fail. It also runs the hosted invariant gates (storage
  seam, withStore routes, host check, plugin gate, file confinement) before shipping a merge.
  - Staging: 65/65 API checks.
- Recommendation: promote prod to the v0.6.0 line so it auto-updates again.
