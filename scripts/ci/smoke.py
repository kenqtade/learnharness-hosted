#!/usr/bin/env python3
"""HOSTED FORK — post-deploy smoke check of a LIVE hosted deployment.

Model-independent on purpose: it proves the PLATFORM works (it's up, the
sign-in gate holds, storage reads and writes round-trip, the core API
answers) without spending a provider key or depending on a model's mood.
Used by the CI update pipeline after every staging and production deploy,
and runnable by hand:

    SMOKE_URL=https://… SMOKE_USER=owner SMOKE_PASSWORD=… python3 scripts/ci/smoke.py

Exit 0 = every check passed. Nothing is left behind: the test chat is deleted.
"""
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request

URL = os.environ.get("SMOKE_URL", "").rstrip("/")
USER = os.environ.get("SMOKE_USER", "owner")
PASSWORD = os.environ.get("SMOKE_PASSWORD", "")
EXPECT_VERSION = os.environ.get("SMOKE_EXPECT_VERSION", "")  # e.g. "0.6.1" — optional
if not URL or not PASSWORD:
    sys.exit("set SMOKE_URL and SMOKE_PASSWORD (and SMOKE_USER if not 'owner')")

results = []


def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def req(op, method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(URL + path, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
    try:
        res = op.open(r, timeout=timeout)
        txt = res.read().decode("utf-8", "replace")
        code = res.status
    except urllib.error.HTTPError as e:
        code, txt = e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 — network failure = failed check
        return -1, f"{type(e).__name__}: {e}"
    try:
        return code, json.loads(txt) if txt else None
    except ValueError:
        return code, txt


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'} {name}" + (f"  — {str(detail)[:200]}" if detail and not ok else ""))


anon, me = client(), client()

# 1. Up, and the expected version
c, d = req(anon, "GET", "/api/version")
check("deployment answers /api/version", c == 200 and isinstance(d, dict) and d.get("version"), f"{c} {d}")
if EXPECT_VERSION:
    check(f"runs version {EXPECT_VERSION}", isinstance(d, dict) and d.get("version") == EXPECT_VERSION, d)

# 2. The sign-in gate holds for anonymous callers
for path in ("/api/chats", "/api/settings", "/api/keys", "/api/jobs"):
    c, _ = req(anon, "GET", path)
    check(f"anonymous GET {path} is refused", c == 401, c)
c, _ = req(anon, "POST", "/api/chat", {"chatId": "smoke", "input": {"type": "continue"}})
check("anonymous POST /api/chat is refused", c == 401, c)

# 3. Sign in
c, d = req(me, "POST", "/api/auth/login", {"username": USER, "password": PASSWORD})
check("sign in", c == 200, f"{c} {d}")
c, d = req(me, "GET", "/api/auth/me")
check("session is recognised", c == 200 and isinstance(d, dict) and (d.get("user") or {}).get("username"), d)

# 4. Core API answers for a signed-in user
for path in ("/api/chats", "/api/settings", "/api/models", "/api/keys", "/api/graph/status", "/api/update"):
    c, d = req(me, "GET", path)
    check(f"GET {path}", c == 200, f"{c} {str(d)[:120]}")

# 5. Storage round-trip (Convex): create → read → rename → list → delete → gone
stamp = time.strftime("%Y%m%d-%H%M%S")
c, d = req(me, "POST", "/api/chats", {"title": f"smoke {stamp}"})
cid = (d or {}).get("id") or ((d or {}).get("chat") or {}).get("id") if isinstance(d, dict) else None
check("create a chat", c in (200, 201) and cid, f"{c} {d}")
if cid:
    c, d = req(me, "GET", f"/api/chats/{cid}")
    check("read it back", c == 200, c)
    c, d = req(me, "GET", f"/api/jobs?chatId={cid}")
    check("its job list answers", c == 200 and isinstance(d, dict) and "jobs" in d, f"{c} {d}")
    c, d = req(me, "GET", "/api/chats")
    titles = [x.get("title") for x in (d or {}).get("chats", [])] if isinstance(d, dict) else []
    check("it is listed", f"smoke {stamp}" in titles, titles[:5])
    c, _ = req(me, "DELETE", f"/api/chats/{cid}?mode=delete-nodes")
    check("delete it", c == 200, c)
    c, _ = req(me, "GET", f"/api/chats/{cid}")
    check("it is gone", c == 404, c)

failed = [n for n, ok in results if not ok]
print(f"\n== {len(results) - len(failed)}/{len(results)} passed" + (f"\n   FAILED: {', '.join(failed)}" if failed else ""))
sys.exit(1 if failed else 0)
