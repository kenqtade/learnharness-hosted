#!/usr/bin/env python3
"""HOSTED FORK — live smoke test for core plugins on a hosted deployment.

  PLUGINS_URL=https://learnharness-plugins.vercel.app python3 scripts/ci/plugins-live.py

Checks, over plain HTTP (no browser):
  1. the catalog lists the core plugins; Coding Questions is blocked on hosted
  2. Flashcards, Drawing Pad and Rich code blocks can be enabled
  3. data written by one request is read back by MANY later requests — Vercel
     spreads them over several instances, so this proves the data lives in
     Convex and not on one instance's temporary disk
  4. the enable state itself survives (it is stored the same way)
Leaves the plugins ENABLED and the test deck in place only if KEEP=1.
"""
import json, os, sys, time, urllib.request, uuid

URL = os.environ.get("PLUGINS_URL", "https://learnharness-plugins.vercel.app").rstrip("/")
ROUNDS = int(os.environ.get("ROUNDS", "12"))
HEAD = {"Content-Type": "application/json", "Origin": URL, "Sec-Fetch-Site": "same-origin"}
failures = []

def req(method, path, body=None):
    r = urllib.request.Request(URL + path, method=method, headers=HEAD,
                               data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or "null")
        except Exception: return e.code, None

def check(ok, label, detail=""):
    print(("  ✔ " if ok else "  ✘ ") + label + (f" — {detail}" if detail and not ok else ""))
    if not ok: failures.append(label)

def call(pid, op, data=None):
    return req("POST", f"/api/plugins/{pid}/call", {"operation": op, "input": data or {}})

print(f"▶ catalog ({URL})")
c, cat = req("GET", "/api/plugins")
plugins = {p["id"]: p for p in (cat or {}).get("plugins", [])}
check(c == 200, "GET /api/plugins", str(c))
for pid in ("flashcards", "drawing-pad", "rich-code-blocks", "coding-questions"):
    check(pid in plugins, f"lists {pid}")
cq = plugins.get("coding-questions", {})
check(cq.get("status") == "error" and "hosted" in (cq.get("error") or ""), "coding-questions is blocked on hosted", str(cq)[:160])

print("▶ enable")
for pid in ("flashcards", "drawing-pad", "rich-code-blocks"):
    c, body = req("PUT", f"/api/plugins/{pid}", {"enabled": True})
    st = {p["id"]: p for p in (body or {}).get("plugins", [])}.get(pid, {})
    check(c == 200 and st.get("enabled") is True and st.get("status") == "active", f"enable {pid}", f"{c} {str(body)[:200]}")

print("▶ write")
deck = f"smoke-{uuid.uuid4().hex[:8]}"
c, body = call("flashcards", "create-deck", {"name": deck})
check(c == 200, "flashcards create-deck", f"{c} {str(body)[:200]}")
color = "#%06x" % (uuid.uuid4().int % 0xFFFFFF)
c, body = call("drawing-pad", "set-ink-color", {"darkInkColor": color})
check(c == 200, "drawing-pad set-ink-color", f"{c} {str(body)[:200]}")
c, body = call("rich-code-blocks", "get-settings")
flip = not bool((body or {}).get("result", {}).get("musicalNotation", True))
c, body = call("rich-code-blocks", "set-family", {"family": "musicalNotation", "enabled": flip})
check(c == 200, "rich-code-blocks set-family", f"{c} {str(body)[:200]}")

print(f"▶ read back {ROUNDS}× (spread over instances)")
time.sleep(2)
seen = {"deck": 0, "color": 0, "family": 0, "enabled": 0}
for i in range(ROUNDS):
    c, b = call("flashcards", "get-state")
    if c == 200 and any(d.get("name") == deck for d in (b or {}).get("result", {}).get("decks", [])): seen["deck"] += 1
    c, b = call("drawing-pad", "get-settings")
    if c == 200 and (b or {}).get("result", {}).get("darkInkColor", "").lower() == color: seen["color"] += 1
    c, b = call("rich-code-blocks", "get-settings")
    if c == 200 and (b or {}).get("result", {}).get("musicalNotation") == flip: seen["family"] += 1
    c, b = req("GET", "/api/plugins")
    if c == 200 and all(p.get("enabled") for p in b["plugins"] if p["id"] != "coding-questions"): seen["enabled"] += 1
for k, v in seen.items():
    check(v == ROUNDS, f"{k} visible {v}/{ROUNDS}")

if os.environ.get("KEEP") != "1":
    c, b = call("flashcards", "get-state")
    for d in (b or {}).get("result", {}).get("decks", []):
        if d.get("name", "").startswith("smoke-"):
            call("flashcards", "delete-deck", {"id": d["id"]})

print("PASS" if not failures else f"FAIL ({len(failures)}): " + "; ".join(failures))
sys.exit(1 if failures else 0)
