#!/usr/bin/env python3
"""AGENT RELIABILITY EVALS (live): drive a deployed LearnHarness the way a
learner does and measure whether turns and sub-agent jobs FINISH. Failures
are classified into time-outs, kills, tool-call limits, model errors and
delivery gaps.

    python3 evals/agent-reliability/run_live.py --url https://… \
        [--login owner:password] [--teacher nvidia/poolside/laguna-xs-2.1] \
        [--scenarios turn,visual,demo,extraction] [--repeat 2] [--out evals/results]

Without --login it talks to a single-user deployment (no session).
Everything it creates is named "eval …" and deleted afterwards.

Outcome categories (one per run; see README.md):
  ok                 the turn/job finished and its result reached the lesson
  turn-http          POST /api/chat failed (4xx/5xx/504 platform time-out)
  turn-lost          no reply was ever saved: the turn died mid-run (killed at the time limit)
  turn-stuck         the chat still reports a turn in flight long after any limit
  turn-error         the assistant message ended in an error (model time-out, provider error)
  tool-not-called    the teacher never dispatched the requested sub-agent (model behaviour)
  job-stuck          a job stayed "running" with no progress for longer than the function limit (killed silently)
  job-duplicate      the same job was (re)started on several servers at once (step count went backwards)
  job-error          the job finished with an error (incl. tool-call/turn limit exhausted)
  job-timeout        the job never reached a terminal state within the eval limit
  not-delivered      the job finished but its result never reached the lesson
  extraction-missing background graph extraction produced nothing for the lesson
  probe-not-finished the prober kept asking and never handed off to the teacher (model behaviour)
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.request

CLIENT_TOOLS = ("ask_user_question", "quiz", "explain", "probe", "recall")
FUNCTION_LIMIT_S = 300  # Vercel's per-invocation ceiling on the plans we run


class Client:
    def __init__(self, url, login=None):
        self.u, self.cookie = url.rstrip("/"), None
        if login:
            user, pw = login.split(":", 1)
            code, d, _ = self.req("POST", "/api/auth/login", {"username": user, "password": pw})
            if code != 200:
                sys.exit(f"login failed: {code} {d}")

    def req(self, method, path, body=None, timeout=90, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json"} if data else {}
        if self.cookie:
            h["Cookie"] = f"lh_session={self.cookie}"
        r = urllib.request.Request(self.u + path, data=data, method=method, headers=h)
        t = time.time()
        try:
            res = urllib.request.urlopen(r, timeout=timeout)
            code, txt, hdrs = res.status, res.read().decode("utf-8", "replace"), res.headers
        except urllib.error.HTTPError as e:
            code, txt, hdrs = e.code, e.read().decode("utf-8", "replace"), e.headers
        except Exception as e:  # noqa: BLE001 — socket time-out / reset = the platform cut us off
            return -1, f"{type(e).__name__}: {e}", time.time() - t
        for c in hdrs.get_all("Set-Cookie") or []:
            m = re.match(r"lh_session=([^;]*)", c)
            if m:
                self.cookie = m.group(1) or None
        if raw:
            return code, txt, time.time() - t
        try:
            return code, (json.loads(txt) if txt else None), time.time() - t
        except ValueError:
            return code, txt, time.time() - t


def stream_terminal(txt):
    """Event types at the end of a turn's SSE body — did it end on purpose?"""
    types = []
    for line in (txt or "").splitlines():
        if line.startswith("data:"):
            body = line[5:].strip()
            if body == "[DONE]":
                types.append("[DONE]")
                continue
            try:
                ev = json.loads(body)
                if isinstance(ev, dict) and ev.get("type"):
                    types.append(ev["type"])
            except ValueError:
                pass
    return types


def last_assistant(chat):
    for m in reversed(chat.get("messages", [])):
        if m.get("role") == "assistant":
            return m
    return None


def pending_client_tool(chat):
    """An unanswered quiz/question the learner must answer before anything else."""
    msgs = chat.get("messages", [])
    answered = {m.get("toolCallId") for m in msgs if m.get("role") == "toolResult"}
    m = last_assistant(chat)
    for c in (m or {}).get("content", []):
        if c.get("type") == "toolCall" and c.get("name") in CLIENT_TOOLS and c.get("id") not in answered:
            return c
    return None


def tool_calls(chat):
    return [c for m in chat.get("messages", []) if m.get("role") == "assistant" for c in m.get("content", []) if c.get("type") == "toolCall"]


class Run:
    """One scenario run: drives the chat and records everything it sees."""

    def __init__(self, cl, scenario, teacher, stamp):
        self.cl, self.s, self.teacher = cl, scenario, teacher
        self.rec = {"scenario": scenario["id"], "teacher": teacher or "(configured)", "turns": [], "jobs": {}, "outcome": None, "detail": ""}
        code, d, _ = cl.req("POST", "/api/chats", {"title": f"eval {scenario['id']} {stamp}"})
        self.cid = (d or {}).get("id") or ((d or {}).get("chat") or {}).get("id")
        if not self.cid:
            raise RuntimeError(f"could not create chat: {code} {d}")
        if teacher:
            prov, mid = teacher.split("/", 1)
            cl.req("PUT", f"/api/chats/{self.cid}/settings", {"model": {"provider": prov, "id": mid}})

    def fail(self, outcome, detail):
        if not self.rec["outcome"]:
            self.rec["outcome"], self.rec["detail"] = outcome, detail[:400]
        return False

    def chat(self):
        return self.cl.req("GET", f"/api/chats/{self.cid}")[1] or {}

    def turn(self, inp, label):
        """POST one learner input, then watch the SAVED chat until the turn
        settles. The POST only starts the turn (it runs in the background);
        "turn in flight" is one server's memory, so settlement is judged
        from durable truth: a new assistant reply, then no change for a
        while. True when it ended cleanly."""
        before = len(self.chat().get("messages", []))
        code, d, secs = self.cl.req("POST", "/api/chat", {"chatId": self.cid, "input": inp}, timeout=120)
        t = {"label": label, "http": code, "startSecs": round(secs, 1)}
        self.rec["turns"].append(t)
        if code == 409:  # a server-side wake turn owns the chat: let it settle, retry once
            self.settle(before, FUNCTION_LIMIT_S + 60)
            before = len(self.chat().get("messages", []))
            code, d, secs = self.cl.req("POST", "/api/chat", {"chatId": self.cid, "input": inp}, timeout=120)
            t.update(http=code, retried=True)
        if code != 200:
            return self.fail("turn-http", f"{label}: HTTP {code} {str(d)[:200]}")
        t0 = time.time()
        chat, state = self.settle(before, FUNCTION_LIMIT_S + 90)
        t["secs"] = round(time.time() - t0, 1)
        if state == "stuck":
            return self.fail("turn-stuck", f"{label}: still marked in flight after {t['secs']}s")
        if state == "lost":
            return self.fail("turn-lost", f"{label}: no reply was ever saved ({t['secs']}s) — the turn died mid-run")
        m = last_assistant(chat)
        if m and (m.get("stopReason") == "error" or m.get("errorMessage")):
            t["error"] = str(m.get("errorMessage"))[:300]
            return self.fail("turn-error", f"{label}: {t['error']} (after {t['secs']}s)")
        return self.rec["outcome"] is None

    def settle(self, before, limit):
        """Wait until the saved chat has an assistant reply past `before`
        messages and stays unchanged for two polls with no turn in flight.
        Returns (chat, "ok" | "lost" | "stuck")."""
        t, last_sig, stable, chat = time.time(), None, 0, {}
        while time.time() - t < limit:
            chat = self.chat()
            msgs = chat.get("messages", [])
            sig = (len(msgs), json.dumps(msgs[-1:])[-200:] if msgs else "")
            replied = len(msgs) > before and msgs[-1].get("role") == "assistant"
            if replied and not chat.get("turnInFlight") and sig == last_sig:
                stable += 1
                if stable >= 2:
                    return chat, "ok"
            else:
                stable = 0
            last_sig = sig
            time.sleep(5)
        return chat, ("stuck" if chat.get("turnInFlight") else "lost")

    def answer_pending(self, max_rounds):
        """Answer the prober's questions with "I don't know" until it stops asking."""
        for i in range(max_rounds):
            chat = self.chat()
            p = pending_client_tool(chat)
            if not p:
                return True
            args = p.get("arguments") or {}
            q = args.get("question") or ""
            if not q and isinstance(args.get("questions"), list) and args["questions"]:
                q = args["questions"][0].get("question", "")
            kind = "quiz" if p["name"] in ("quiz", "probe") else "explain" if p["name"] in ("explain", "recall") else "ask"
            ans = {"type": "answer", "toolCallId": p["id"], "answer": {"kind": kind, "tool": p["name"], "questionText": q, "dontKnow": True, "answers": []}}
            if not self.turn(ans, f"answer-{i + 1}"):
                return False
        return True

    def watch_jobs(self, kind, limit_s):
        """Poll /api/jobs (this is also what triggers server-side recovery)."""
        t0, seen = time.time(), {}
        while time.time() - t0 < limit_s:
            code, d, _ = self.cl.req("GET", f"/api/jobs?chatId={self.cid}")
            jobs = [j for j in (d or {}).get("jobs", []) if not kind or j.get("kind") == kind]
            now = time.time()
            for j in jobs:
                r = seen.setdefault(j["id"], {"kind": j["kind"], "firstSeen": now, "steps": [], "lastChange": now, "maxStall": 0, "updatedAt": None, "activity": []})
                steps = ((j.get("usage") or {}).get("steps")) or 0
                if r["steps"] and steps < r["steps"][-1]:
                    r["restarted"] = True  # step counter went backwards: a second worker started over
                if not r["steps"] or steps != r["steps"][-1]:
                    r["steps"].append(steps)
                if j.get("updatedAt") != r["updatedAt"]:
                    r["updatedAt"], r["lastChange"] = j.get("updatedAt"), now
                if j.get("activity") and (not r["activity"] or r["activity"][-1] != j["activity"]):
                    r["activity"].append(j["activity"][:80])
                r["maxStall"] = max(r["maxStall"], round(now - r["lastChange"]))
                r.update(status=j["status"], error=(j.get("error") or "")[:300], delivery=(j.get("delivery") or {}).get("status"),
                         secs=round(now - r["firstSeen"]), created=j.get("createdAt"))
            self.rec["jobs"] = seen
            if jobs and all(j["status"] != "running" for j in jobs):
                return seen
            time.sleep(10)
        return seen

    def delivered(self, limit_s):
        """The finished job's result reached the lesson (a later assistant reply)."""
        t0 = time.time()
        while time.time() - t0 < limit_s:
            code, d, _ = self.cl.req("GET", f"/api/jobs?chatId={self.cid}")
            jobs = (d or {}).get("jobs", [])
            if jobs and all((j.get("delivery") or {}).get("status") == "delivered" for j in jobs if j.get("delivery")):
                chat, state = self.settle(0, FUNCTION_LIMIT_S)
                return state == "ok"
            time.sleep(10)
        return False

    def cleanup(self):
        self.cl.req("DELETE", f"/api/chats/{self.cid}?mode=delete-nodes")


def run_scenario(cl, s, teacher, stamp, job_limit):
    r = Run(cl, s, teacher, stamp)
    t0 = time.time()
    try:
        if not r.turn({"type": "text", "text": s["opening"]}, "opening"):
            return r.rec
        if not r.answer_pending(s.get("answerRounds", 6)):
            return r.rec
        if s.get("job"):
            # Sub-agents belong to the TEACHER: wait for the probe hand-off
            # (probe_done) and the teacher's first run before asking.
            for k in range(6):
                names = [c.get("name") for c in tool_calls(r.chat())]
                if "probe_done" in names:
                    break
                if not r.answer_pending(4):
                    return r.rec
                if not pending_client_tool(r.chat()) and "probe_done" not in [c.get("name") for c in tool_calls(r.chat())]:
                    if not r.turn({"type": "text", "text": "I don't know anything more about this — please start teaching me now."}, f"handoff-{k + 1}"):
                        return r.rec
            if "probe_done" not in [c.get("name") for c in tool_calls(r.chat())]:
                r.rec["toolCalls"] = [c.get("name") for c in tool_calls(r.chat())]
                r.fail("probe-not-finished", "the prober never handed off to the teacher")
                return r.rec
            r.settle(len(r.chat().get("messages", [])) - 1, FUNCTION_LIMIT_S)  # the teacher's first (wake) run
            r.answer_pending(3)
        if s.get("request"):
            if not r.turn({"type": "text", "text": s["request"]}, "request"):
                return r.rec
            r.answer_pending(3)
        if s.get("job"):
            kind = s["job"]
            calls = [c for c in tool_calls(r.chat()) if c.get("name") == kind]
            if not calls:
                # one nudge, then it's the model's choice
                if r.turn({"type": "text", "text": s.get("nudge", f"Please use the {kind} tool now.")}, "nudge"):
                    r.answer_pending(2)
                if not [c for c in tool_calls(r.chat()) if c.get("name") == kind]:
                    r.fail("tool-not-called", f"the teacher never called {kind}")
                    return r.rec
            jobs = r.watch_jobs(kind, job_limit)
            if not jobs:
                r.fail("tool-not-called", f"{kind} was called but no job record appeared")
                return r.rec
            for jid, j in jobs.items():
                if j.get("restarted"):
                    r.fail("job-duplicate", f"{jid}: step counter went backwards {j['steps']}")
                if j.get("status") == "running":
                    if j["maxStall"] > FUNCTION_LIMIT_S:
                        r.fail("job-stuck", f"{jid}: running with no progress for {j['maxStall']}s (activity {j['activity'][-2:]})")
                    else:
                        r.fail("job-timeout", f"{jid}: still running after {j['secs']}s")
                elif j.get("status") == "error":
                    r.fail("job-error", f"{jid}: {j.get('error')}")
            if r.rec["outcome"]:
                return r.rec
            if not r.delivered(FUNCTION_LIMIT_S + 120):
                r.fail("not-delivered", "job finished but its result never reached the lesson")
                return r.rec
        if s.get("extraction"):
            # Graph extraction runs in the background after a turn; its
            # status lives in ONE server's memory, so measure the durable
            # result instead: graph nodes whose provenance is this chat.
            # A short eval lesson stays under the automatic 4096-token
            # trigger, so press the manual "extract" button (the same run).
            t1, limit = time.time(), s.get("extractionLimit", 480)
            code, _, _ = cl.req("POST", "/api/graph/coverage/extract", {"chatId": r.cid})
            r.rec["extractionStart"] = code
            found, cov = 0, None
            while time.time() - t1 < limit:
                code, g, _ = cl.req("GET", "/api/graph")
                found = sum(1 for n in (g or {}).get("nodes", []) if any(p.get("chatId") == r.cid for p in n.get("provenance", [])))
                cov = r.chat().get("coverage")
                if found:
                    break
                time.sleep(15)
            r.rec["extraction"] = {"nodes": found, "secs": round(time.time() - t1), "coverage": cov}
            if not found:
                r.fail("extraction-missing", f"no graph nodes from this chat {limit}s after the lesson turns")
        if not r.rec["outcome"]:
            r.rec["outcome"] = "ok"
    except Exception as e:  # noqa: BLE001
        r.fail("harness-error", f"{type(e).__name__}: {e}")
    finally:
        r.rec["secs"] = round(time.time() - t0)
        try:
            r.rec.setdefault("toolCalls", [c.get("name") for c in tool_calls(r.chat())])
        except Exception:  # noqa: BLE001
            pass
        r.cleanup()
    return r.rec


def summarize(results, meta):
    by = {}
    for r in results:
        by.setdefault(r["scenario"], []).append(r)
    lines = [f"# Agent reliability eval — {meta['when']}", "", f"- target: {meta['url']}", f"- teacher: {meta['teacher'] or '(configured)'}", f"- runs: {len(results)}", ""]
    ok = sum(1 for r in results if r["outcome"] == "ok")
    lines += [f"**Overall: {ok}/{len(results)} ok**", "", "| scenario | ok | outcomes | median s | max turn s | max job s |", "|---|---|---|---|---|---|"]
    for sid, rs in by.items():
        outs = {}
        for r in rs:
            outs[r["outcome"]] = outs.get(r["outcome"], 0) + 1
        secs = sorted(r.get("secs", 0) for r in rs)
        turn_max = max((t.get("secs", 0) for r in rs for t in r["turns"]), default=0)
        job_max = max((j.get("secs", 0) for r in rs for j in r["jobs"].values()), default=0)
        lines.append(f"| {sid} | {sum(1 for r in rs if r['outcome'] == 'ok')}/{len(rs)} | {', '.join(f'{k}×{v}' for k, v in outs.items())} | {secs[len(secs) // 2]} | {turn_max} | {job_max} |")
    lines += ["", "## Failures", ""]
    for r in results:
        if r["outcome"] != "ok":
            lines.append(f"- **{r['scenario']}** → `{r['outcome']}`: {r['detail']}")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--login")
    ap.add_argument("--teacher", default="")
    ap.add_argument("--scenarios", default="")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--job-limit", type=int, default=900)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "results"))
    a = ap.parse_args()
    scenarios = json.load(open(os.path.join(os.path.dirname(__file__), "scenarios.json")))
    want = [x for x in a.scenarios.split(",") if x]
    scenarios = [s for s in scenarios if not want or s["id"] in want]
    cl = Client(a.url, a.login)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    results = []
    for i in range(a.repeat):
        for s in scenarios:
            print(f"▶ {s['id']} (run {i + 1}/{a.repeat})", flush=True)
            rec = run_scenario(cl, s, a.teacher, stamp, a.job_limit)
            results.append(rec)
            print(f"  → {rec['outcome']} in {rec.get('secs')}s {rec['detail'][:200]}", flush=True)
    os.makedirs(a.out, exist_ok=True)
    meta = {"when": stamp, "url": a.url, "teacher": a.teacher}
    base = os.path.join(a.out, f"agent-reliability-{stamp}")
    json.dump({"meta": meta, "results": results}, open(base + ".json", "w"), indent=1)
    md = summarize(results, meta)
    open(base + ".md", "w").write(md)
    print("\n" + md)
    print(f"saved {base}.md / .json")
    sys.exit(0 if all(r["outcome"] == "ok" for r in results) else 1)


if __name__ == "__main__":
    main()
