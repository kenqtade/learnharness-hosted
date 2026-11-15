#!/usr/bin/env python3
"""HOSTED FORK — live check that a plugin BACKGROUND WORKER finishes on hosted.

  PLUGINS_URL=https://learnharness-plugins.vercel.app python3 scripts/ci/plugins-worker-live.py

Flashcards "generate from file": the request that starts the batch returns at
once; the model work runs in a plugin worker AFTER the response. On Vercel that
only finishes if the worker is kept alive (waitUntil). Costs one small cheap-model
call. Requires the cheap model slot to be configured on the deployment.
"""
import json, os, sys, time, urllib.request, uuid

URL = os.environ.get("PLUGINS_URL", "https://learnharness-plugins.vercel.app").rstrip("/")
HEAD = {"Content-Type": "application/json", "Origin": URL, "Sec-Fetch-Site": "same-origin"}

def call(op, data=None):
    r = urllib.request.Request(f"{URL}/api/plugins/flashcards/call", method="POST", headers=HEAD,
                               data=json.dumps({"operation": op, "input": data or {}}).encode())
    try:
        with urllib.request.urlopen(r, timeout=120) as resp: return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")

tag = uuid.uuid4().hex[:6]
note = f"""# Photosynthesis ({tag})

Photosynthesis is the process by which green plants use light energy to turn carbon
dioxide and water into glucose and oxygen. It happens in the chloroplasts, which contain
the green pigment chlorophyll. The light-dependent reactions take place in the thylakoid
membranes and produce ATP and NADPH; the Calvin cycle in the stroma uses them to fix carbon.
"""
c, pre = call("preflight-file", {"name": f"photosynthesis-{tag}.md", "markdown": note})
print("preflight", c, json.dumps(pre)[:300])
if c != 200: sys.exit(1)
plan = pre["result"]
c, started = call("start-generation", {"preflightId": plan["id"], "requestId": str(uuid.uuid4())})
batch = (started.get("result") or {}).get("batch") if c == 200 else None
print("start", c, json.dumps(batch or started)[:300])
if c != 200: sys.exit(1)

t0 = time.time()
while time.time() - t0 < 300:
    time.sleep(10)
    c, st = call("resume-results")
    b = (st.get("result") or {}).get("batch") or {}
    chunks = [(ch.get("status"), ch.get("added")) for ch in b.get("chunks", [])]
    print(f"  {int(time.time()-t0):>3}s batch={b.get('status')} chunks={chunks}")
    if b.get("status") not in ("running", "queued", None):
        break
added = sum(ch.get("added") or 0 for ch in b.get("chunks", []))
ok = b.get("status") in ("completed", "succeeded", "done") or added > 0
print(("PASS" if ok else "FAIL") + f": batch {b.get('status')}, {added} cards added in {int(time.time()-t0)}s")
sys.exit(0 if ok else 1)
