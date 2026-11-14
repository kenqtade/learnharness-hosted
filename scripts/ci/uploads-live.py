#!/usr/bin/env python3
"""HOSTED FORK — live check of learner uploads on a deployment (model-independent).

  SMOKE_URL=https://… SMOKE_USER=owner SMOKE_PASSWORD=… python3 scripts/ci/uploads-live.py

Uploads a small text file and a 6 MB file (above Vercel's 4.5 MB body cap, so it
must go browser→Convex directly), commits both, lists them, checks the anonymous
block and an oversize/unknown-blob refusal, then deletes everything it created.
"""
import json, os, sys, urllib.request, urllib.error, http.cookiejar

URL = os.environ["SMOKE_URL"].rstrip("/")
USER = os.environ.get("SMOKE_USER", "owner")
OPEN = os.environ.get("SMOKE_OPEN") == "1"  # deployment without sign-in
PW = os.environ.get("SMOKE_PASSWORD", "")
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
anon = urllib.request.build_opener()
passed = failed = 0


def req(method, path, body=None, o=None, raw=None, headers=None, absolute=False):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"Content-Type": "application/json"} if body is not None else {}
    h.update(headers or {})
    r = urllib.request.Request(path if absolute else URL + path, data=data, method=method, headers=h)
    try:
        with (o or opener).open(r, timeout=120) as resp:
            txt = resp.read().decode()
            return resp.status, (json.loads(txt) if txt.strip().startswith(("{", "[")) else txt)
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, txt


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {detail}")


def upload(name, content, ctype):
    code, d = req("POST", "/api/files", {"action": "upload-url"})
    if code != 200 or "url" not in d:
        return None, f"upload-url {code} {d}"
    code, put = req("POST", d["url"], raw=content, headers={"Content-Type": ctype}, absolute=True)
    if code != 200 or "storageId" not in put:
        return None, f"put {code} {put}"
    code, entry = req("POST", "/api/files", {"action": "commit", "storageId": put["storageId"], "name": name})
    return (entry if code == 200 else None), f"commit {code} {entry}"


print(f"== uploads on {URL}")
if not OPEN:
    code, d = req("POST", "/api/auth/login", {"username": USER, "password": PW})
    check("login", code == 200, f"{code} {d}")
    code, _ = req("GET", "/api/files", o=anon)
    check("anonymous GET /api/files refused", code == 401, code)
    code, _ = req("POST", "/api/files", {"action": "upload-url"}, o=anon)
    check("anonymous upload-url refused", code == 401, code)
code, d = req("GET", "/api/files")
check("uploads are enabled", code == 200 and d.get("enabled") is True, f"{code} {d}")
before = {f["id"] for f in d.get("files", [])} if isinstance(d, dict) else set()

created = []
small, why = upload("ci notes.txt", b"Binary search halves the range each step.\n", "text/plain")
check("small text upload committed", bool(small), why)
if small:
    created.append(small["id"])
    check("entry has a path inside the user's uploads", isinstance(small.get("path"), str) and "ci notes" in small["path"], small)

big_bytes = os.urandom(6 * 1024 * 1024)
big, why = upload("ci-big.bin", big_bytes, "application/octet-stream")
check("6 MB upload (above Vercel's 4.5 MB cap) committed", bool(big) and big.get("size") == len(big_bytes), why)
if big:
    created.append(big["id"])

code, d = req("GET", "/api/files")
ids = {f["id"] for f in d.get("files", [])} if code == 200 else set()
check("both files listed", all(i in ids for i in created), f"{code} {ids}")

code, d = req("POST", "/api/files", {"action": "commit", "storageId": "kg2notarealstorageid000000000000", "name": "x.txt"})
check("commit of an unknown blob refused", code == 400, f"{code} {d}")

for i in created:
    code, d = req("DELETE", f"/api/files?id={i}")
    check(f"delete {i}", code == 200, f"{code} {d}")
code, d = req("GET", "/api/files")
left = {f["id"] for f in d.get("files", [])} - before if code == 200 else {"?"}
check("nothing left behind", not (left & set(created)), left)

print(f"\n== {passed}/{passed + failed} passed")
sys.exit(1 if failed else 0)
