#!/usr/bin/env python3
"""HOSTED FORK — model-in-the-loop check that the tutor can read an UPLOADED file.

  python3 evals/agent-reliability/uploads_live.py --url … --login owner:pw \
      [--teacher nvidia/minimaxai/minimax-m3.1-flash]

Uploads a note holding a random code word (browser→Convex, like the paperclip),
sends a lesson message that references the returned path exactly as the paperclip
chip does (a backtick-quoted rooted path), and checks the tutor's reply / tool
calls show the code word — i.e. the file reached the serverless instance and the
learner file tools could read it. Cleans up the chat and the upload.
"""
import argparse, importlib.util, json, os, secrets, sys, time, urllib.request

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("run_live", os.path.join(here, "run_live.py"))
rl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rl)

ap = argparse.ArgumentParser()
ap.add_argument("--url", required=True)
ap.add_argument("--login", required=True)
ap.add_argument("--teacher", default="nvidia/minimaxai/minimax-m3.1-flash")
a = ap.parse_args()

cl = rl.Client(a.url.rstrip("/"), a.login)
word = "ZEBRA-" + secrets.token_hex(3).upper()
note = f"My study notes.\nThe code word for today's lesson is {word}.\nTopic: binary search.\n".encode()

code, d, _ = cl.req("POST", "/api/files", {"action": "upload-url"})
assert code == 200, f"upload-url {code} {d}"
put = json.loads(urllib.request.urlopen(urllib.request.Request(d["url"], data=note, method="POST", headers={"Content-Type": "text/plain"}), timeout=60).read())
code, entry, _ = cl.req("POST", "/api/files", {"action": "commit", "storageId": put["storageId"], "name": "my notes.txt"})
assert code == 200, f"commit {code} {entry}"
print(f"uploaded → {entry['path']}  (code word {word})")

stamp = time.strftime("%Y%m%d-%H%M%S")
r = rl.Run(cl, {"id": "uploads"}, a.teacher, stamp)
t0 = time.time()
ok = r.turn({"type": "text", "text": f"I attached my notes: `{entry['path']}` — please open that file and tell me the code word written in it before we start."}, "opening")
chat = r.chat()
blob = json.dumps(chat.get("messages", []))
# Our prompt never contains the word, so seeing it means a tool read the file.
saw_word = word in blob
names = [c.get("name") for c in rl.tool_calls(chat)]
reply = rl.last_assistant(chat) or {}
reply_text = " ".join(c.get("text", "") for c in reply.get("content", []) if c.get("type") == "text")
print(f"turn ok={ok} outcome={r.rec['outcome']} {round(time.time() - t0)}s  tools={names}")
print(f"code word seen in the chat: {saw_word}")
r.cleanup()
cl.req("DELETE", f"/api/files?id={entry['id']}")
passed = bool(saw_word)
print("PASS the tutor read the uploaded file" if passed else "FAIL the tutor never saw the uploaded file's content")
sys.exit(0 if passed else 1)
