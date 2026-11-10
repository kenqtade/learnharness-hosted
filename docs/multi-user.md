# Multi-user platform (branch `feat/multi-user`)

Turn one LearnHarness deployment into a small platform: several people,
each with their **own private sessions, notes, knowledge graph and
settings**, all using the owner's API keys.

It is **off unless `LH_MULTI_USER=1`**. Without it the app is the
single-user app, byte-for-byte; the full test suite runs in that mode.

## How people use it

| Who | What they do |
|---|---|
| **Owner** (the first account) | Opens `/signup`, picks a username + password, enters the **owner setup code**. Manages API keys/providers (Settings → Providers), creates invites, and disables or deletes accounts (`/admin`). |
| **Member** | Gets an invite link from the owner (`/signup?invite=CODE`, with the code already filled in), picks a username + password, and starts learning. Signs in later at `/login` with username + password. |

- Sign-in is **username + password**. Usernames are 3–32 characters
  (letters, numbers, dot, dash, underscore) and case-insensitive.
- Invites work **once** and expire after **14 days**. The owner can
  instead allow open sign-ups (Admin → Sign-ups), so no invite is needed.
- Members start with the owner's model choices, and can pick their own
  under Settings → Agent. That changes only their copy.
- Members see "Providers and API keys are managed by the platform owner"
  instead of the key controls. Every account's usage runs on the owner's
  keys and counts against the owner's provider limits.

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
| Accounts, invites, platform options | `platform/…` in Convex |
| API keys (`auth.json`) | shared: the owner's, for everyone |

Live updates (the events stream), the activity dock and background
extraction runs are also per user: nobody sees or can cancel another
person's work.

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
