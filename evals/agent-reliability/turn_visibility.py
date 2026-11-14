#!/usr/bin/env python3
"""HOSTED FORK — does a returning view see a running turn? (the tab-switch bug)

  python3 evals/agent-reliability/turn_visibility.py --url … [--login owner:pw] [--runs 2]

Starts a real lesson turn, then — like a tab coming back / a phone reconnecting —
polls GET /api/chats/[id] every 3 s over a FRESH connection each time (so requests
spread over serverless instances) and records `turnInFlight` until the reply is
saved. A poll that says "not in flight" while no reply exists yet is a MISS: the
browser would stop waiting and show the last saved state. Also opens the reattach
stream once mid-turn and records whether it answered "settled" at once (a miss) or
held on. Cleans up its chats.
"""
import argparse, http.cookiejar, json, threading, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--url", required=True)
ap.add_argument("--login")
ap.add_argument("--runs", type=int, default=2)
ap.add_argument("--teacher", default="nvidia/minimaxai/minimax-m3.1-flash")
a = ap.parse_args()
U = a.url.rstrip("/")
jar = http.cookiejar.CookieJar()


def opener():
    # A new opener per call = a new TCP/TLS connection = any instance.
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def req(m, p, b=None, timeout=60):
    r = urllib.request.Request(U + p, data=json.dumps(b).encode() if b is not None else None, method=m,
                               headers={"Content-Type": "application/json", "Connection": "close"})
    try:
        with opener().open(r, timeout=timeout) as resp:
            t = resp.read().decode()
            return resp.status, (json.loads(t) if t.strip().startswith(("{", "[")) else t)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


if a.login:
    u, pw = a.login.split(":", 1)
    print("login", req("POST", "/api/auth/login", {"username": u, "password": pw})[0])

total_polls = total_miss = stream_miss = stream_checks = 0
for run in range(a.runs):
    c, d = req("POST", "/api/chats", {"title": f"eval visibility {time.strftime('%H%M%S')}"})
    cid = d.get("id") or (d.get("chat") or {}).get("id")
    prov, mid = a.teacher.split("/", 1)
    req("PUT", f"/api/chats/{cid}/settings", {"model": {"provider": prov, "id": mid}})
    before = len(req("GET", f"/api/chats/{cid}")[1].get("messages", []))
    t0 = time.time()
    sent = {}
    def _send():
        try:
            sent["r"] = req("POST", "/api/chat", {"chatId": cid, "input": {"type": "text", "text": "Teach me how photosynthesis works, in depth. I'm a beginner."}}, timeout=330)
        except Exception as e:
            sent["r"] = ("timeout", str(e))
    th = threading.Thread(target=_send, daemon=True); th.start()
    th.join(4)  # an immediate refusal (4xx) shows up here
    if "r" in sent and sent["r"][0] != 200:
        print("  send refused →", sent["r"][0], str(sent["r"][1])[:160])
        req("DELETE", f"/api/chats/{cid}?mode=delete-nodes")
        continue
    polls, misses, checked_stream = [], 0, False
    while time.time() - t0 < 600:
        time.sleep(3)
        c, chat = req("GET", f"/api/chats/{cid}")
        msgs = chat.get("messages", []) if isinstance(chat, dict) else []
        tail = [m for m in msgs[before:] if m.get("role") == "assistant"]
        replied = bool(tail) and tail[-1].get("stopReason") is not None
        if tail and tail[-1].get("stopReason") == "error":
            print("   saved error:", str(tail[-1].get("errorMessage"))[:140])
        inflight = chat.get("turnInFlight") if isinstance(chat, dict) else None
        if replied and not inflight:
            break
        polls.append(bool(inflight))
        if not inflight and not replied:
            misses += 1
        if not checked_stream and time.time() - t0 > 8:
            checked_stream = True
            ts = time.time()
            r = urllib.request.Request(U + f"/api/chats/{cid}/stream", headers={"Connection": "close"})
            try:
                with opener().open(r, timeout=8) as resp:
                    head = resp.read(400).decode(errors="replace")
                quick = time.time() - ts < 2 and "turn-settled" in head
            except Exception:
                quick = False  # still open after 8 s = it held on (good)
            stream_checks += 1
            stream_miss += 1 if quick else 0
            print(f"  reattach stream mid-turn: {'answered settled at once (MISS)' if quick else 'held on (ok)'}")
    secs = round(time.time() - t0)
    print(f"run {run + 1}: reply after {secs}s — {len(polls)} polls while running, {misses} said 'not running' (MISS)")
    total_polls += len(polls)
    total_miss += misses
    req("DELETE", f"/api/chats/{cid}?mode=delete-nodes")

print(f"\n== turnInFlight misses: {total_miss}/{total_polls} polls; reattach misses: {stream_miss}/{stream_checks}")
