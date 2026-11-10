# Multi-user platform (branch `feat/multi-user`)

Turn one LearnHarness deployment into a small platform: several people,
each with their **own private sessions, notes, knowledge graph, settings
and API keys**. Nobody runs on anyone else's credentials.

It is **off unless `LH_MULTI_USER=1`**. Without it the app is the
single-user app, byte-for-byte; the full test suite runs in that mode.

## How people use it

| Who | What they do |
|---|---|
| **Owner** (the first account) | Opens `/signup`, picks a username + password, enters the **owner setup code**. Adds their own API keys (Settings → Providers), creates invites, and disables or deletes accounts (`/admin`). |
| **Member** | Gets an invite link from the owner (`/signup?invite=CODE`, with the code already filled in), picks a username + password, then adds **their own** API key in Settings → Providers and picks models, the same first-run setup as a fresh install. Signs in later at `/login` with username + password. |

- Sign-in is **username + password**. Usernames are 3–32 characters
  (letters, numbers, dot, dash, underscore) and case-insensitive.
- A plain invite (Admin → Create invite) is a random code that works
  **once** and expires after **14 days**.
- **Shareable codes:** type your own code into "Own code" (e.g.
  `EARLY-ACCESS-2026`, 4–40 letters, digits or dashes) and set how many
  people may use it. That gives one easy code to send to a group. Upper and
  lower case don't matter, and spaces around a pasted code are ignored. The
  admin list shows "3/25 used". Revoke it at any time. Through the API:
  `POST /api/admin/invites {"code":"EARLY-ACCESS-2026","maxUses":25,"days":60}`.
- The owner can instead allow open sign-ups (Admin → Sign-ups), so no
  invite is needed.
- **Everyone uses only their own credentials.** Each account saves its own
  API keys and custom endpoint in Settings → Providers. Usage counts against
  that person's own provider account.
  - Keys are never placed in the server's shared environment. Every model
    request looks up the key of the account that sent it.
  - Keys set on the deployment itself (e.g. `NVIDIA_API_KEY` in Vercel's
    environment variables) are **ignored** in platform mode, because they
    would be shared by everyone.
  - Background work that runs for no particular account gets no keys at all.
    It never borrows the owner's.
- **Owner-only: the server machine's own logins.** Subscription logins
  (ChatGPT Plus and similar; the app supports one connected login per
  server), the Claude Code CLI, and AWS/gcloud credential files on the
  server belong to whoever runs the server. Only the owner can use them.
  Members see a short note there and use an API key instead.
- New members start with default settings (no models chosen), not the
  owner's. The owner's model choices and custom endpoint would point them
  at providers they have no key for.

## Settings (Vercel → Project → Environment Variables)

| Variable | Value |
|---|---|
| `LH_MULTI_USER` | `1` |
| `LH_OWNER_SETUP_CODE` | a secret code; only needed once, to create the owner account |
| `LH_SESSION_SECRET` | random 64-hex (signs the sign-in cookies; changing it signs everyone out). Falls back to a value derived from `LH_CONVEX_SECRET` |

Everything else is the same as `docs/convex-vercel.md`.

## What's private and what's shared

| Data | Where it lives |
|---|---|
| Owner's sessions, graph, settings, prompts, jobs | the original data (`data/…` in Convex), so turning the platform on keeps all existing data as the owner's |
| A member's sessions, graph, settings, prompts, jobs | `users/<id>/…` in Convex; nobody else can read it |
| Accounts, invites, platform options, app update status | `platform/…` in Convex |
| Owner's API keys | the original `auth.json` |
| A member's API keys | `users/<id>/auth/auth.json` in Convex; only that member's requests read it |

Live updates (the events stream), the activity dock and background
extraction runs are also per user: nobody sees or can cancel another
person's work.

## App updates

With `LH_AUTO_UPDATE=1`, the server keeps itself on the latest upstream
release (docs/auto-update.md). Everyone sees the version and the update
status in Settings → General, and a "new version available — Refresh"
banner once a newer build is live. Only the owner can start a check, and
only the owner sees failure details.

## Security notes

- Passwords are stored as scrypt hashes, never in plain text.
- The sign-in cookie is HttpOnly, SameSite=Lax, Secure on https, and
  signed (HMAC-SHA256). It lasts 30 days. Changing a password, "Sign out
  of all devices", or being disabled ends every session at once.
- 5 wrong passwords in a row lock that username for a minute (per server
  instance).
- Owner-only on the server, whatever the UI shows: changing API keys,
  custom providers, subscriptions, the Claude Code check, and everything
  under `/api/admin`.
- Deleting an account deletes all of its data. The owner can't be deleted
  or disabled.

## Known limits

1. Background work that restarts after a server restart (boot-time job
   recovery) runs as the owner only. Members' interrupted jobs resume the
   next time they open the session.
2. The sign-in throttle is per Vercel instance, not global.
3. Built for a handful of people on the free plans: every account shares
   the owner's provider rate limits and the Convex free quota.

## Testing it

- Unit: `NODE_ENV=test npx tsx --test tests/multi-user.test.ts` (19 tests).
- Live staging (API, including a real tutor reply): `python3 ~/scripts/live-multiuser.py`.
- Live staging (real browser): `node ~/scripts/live-mu-browser.mjs`.
