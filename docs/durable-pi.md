# Durable turns on pi-durable (branch `feat/durable-pi`)

## What changes for you

Turn it on with `LH_RUNTIME=pi-durable`. From then on, a chat turn **survives the server dying mid-reply**: kill -9, a crash, a laptop sleep, or a serverless instance killed at its time limit. When the server comes back, the turn continues where it stopped:

- **Finished model calls are not paid for twice.** They are already saved.
- **Finished tools do not run again.** A research job is never spawned twice.
- **A tool that was cut off re-runs only if it is read-only.** Otherwise the model is told it was interrupted and decides what to do.
- **The interrupted model answer is retried.**

Without the switch, nothing changes: the default in-process runner is byte-for-byte the code on `main`.

## Try it

```bash
# Node 22.19 or newer is required (pi itself requires it)
npm run test:durable         # 32 storage cases x 2 backends + 3 real turns through the chat handler
npm run test:durable-crash   # the kill -9 proof, on node:sqlite and on libSQL
npm run test:capabilities    # includes the runtime switch rules
LH_RUNTIME=pi-durable bash ~/run-app.sh local   # use the app with durable turns
```

`/api/capabilities` (and the status panel) then shows `runtime: pi-durable`.

## Where the data lives — same code, two homes

| Home | Setting | Storage |
|---|---|---|
| Laptop | `LH_RUNTIME=pi-durable` | Node's built-in SQLite at `<LH_DATA_DIR>/durable/turns.sqlite` |
| Hosted (Netlify / Vercel) | plus `LH_DURABLE_LIBSQL_URL`, `LH_DURABLE_LIBSQL_TOKEN` | Turso (libSQL): free, no credit card |

Both run pi-durable's own SQLite schema. The libSQL adapter (`src/server/durable/libsql.ts`) passes pi-durable's storage conformance suite, all 32 cases, the same as the built-in storage.

## How it works

```
POST /api/chat ─► chat-handler builds the teacher/prober Agent exactly as before
                   │  (prompt, tools, model, history)
                   ▼
   LH_RUNTIME=pi-durable?
     no  ─► runPiTurn(agent)                       (unchanged)
     yes ─► startDurableTurn(agent as a SPEC)
              1. install the turn's tools + prompt as a Harness extension
              2. new Harness conversation, seeded with the turn's history
              3. index the turn in the Harness root ("lh.turn")
              4. continue → the Harness runs the loop, committing each step
              5. watch → translate to the SAME SSE events the browser reads
              6. settle → onFinish → persistTurn (same seam) → "lh.turn.settled"
boot / reattach / next POST ─► ensureDurableRecovered()
              open runtime → unsettled turns → rebuild their tools (same
              construction function) → resume() → re-register as live turns
```

| File | Role |
|---|---|
| `src/server/durable/harness.ts` | one Harness per process; the recovery index; boot recovery |
| `src/server/durable/turn.ts` | the durable turn: tool adapter, question-stop rule, SSE translation, settle |
| `src/server/durable/storage.ts` | node:sqlite locally, libSQL when a URL is set |
| `src/server/durable/libsql.ts` | chord's `SqliteDatabase` facade over `@libsql/client` |
| `src/server/chat-handler.ts` | `buildConversationAgent` (shared construction), the switch, the recoverer |
| `instrumentation.ts` | resume at boot (no-op unless the switch is on) |

## Kept identical to the in-process runner

- **SSE dialect:** the same events (`agent_start`, `message_*`, `tool_execution_*`, `turn_end`, `agent_end`, `error`, `[DONE]`), ID-less streaming messages, and replay for late viewers.
- **Record:** the same `onFinish` → `persistTurn` seam. Question placeholders are dropped as before.
- **Usage log:** the same `appendTurnUsage`.
- **Question-stop rule:** a cleanly posed question ends the run, even in a mixed batch; a pose that fails validation lets the model retry. This is implemented with an `afterTool` hook plus pi-durable's "all results terminate" rule.
- **Tool-call ID uniquifier:** applied on the wire and in the record.

## Known differences and limits (honest list)

1. **Mid-turn steering is deferred.** The spec Agent never runs, so steers and job results are not injected into the running turn. They stay queued and are delivered by the idle wake right after it. Planned fix: forward steers as Harness `input` submissions with `whenBusy: "steer"`.
2. **Subscription and ChatGPT routes stay in-process.** They stream through their own request cycles, not pi-ai `Models`.
3. **Single writer per storage.** Two processes must not open the same storage at once. Fine locally. Serverless with concurrent instances needs a lease first (see `learnharness-vercel.md`).
4. **Recovery runs when the runtime opens:** at boot, on reattach, or before a new turn. A warm process does not yet adopt turns orphaned by *another* process.
5. **Storage grows.** Each turn's conversation is seeded with the chat's history, so storage is roughly proportional to turns × history length. Pruning settled conversations is a TODO.
6. **pi-durable is "experimental, API may change"**, so versions are pinned exactly (1.5.0).

## Upgrade notes

- `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`: 1.4.0 → 1.5.0. One test import moved: `Type` now comes from `typebox`.
- `engines.node >= 22.19.0` is now declared. pi 1.4 already required it, so the old Node 20 dev box was unsupported.
