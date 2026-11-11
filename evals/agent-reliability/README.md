# Agent reliability eval

Measures what breaks when a hosted LearnHarness (Vercel: hard 300 s
function wall) runs real lessons: turns that are killed or time out, and
background sub-agents (visual, demo, extraction) that run out of time, run
twice, fail, or never reach the lesson.

It drives a **live deployment** through the public API, as a learner would.
Nothing is mocked. Every run creates a throwaway chat and deletes it at the
end (`?mode=delete-nodes`).

```bash
python3 -u evals/agent-reliability/run_live.py \
  --url https://learnharness-multiuser.vercel.app --login "owner:<password>" \
  [--scenarios turn,visual,demo,extraction,visual-direct,demo-direct,demo-deadline] \
  [--repeat 2] [--teacher nvidia/minimaxai/minimax-m3.1-flash] [--job-limit 900] \
  [--out evals/results]
```

* `--teacher provider/id` overrides the chat's conversation model, so you can
  compare models on the same deployment. Without it, the account's
  configured strong slot is used.
* `--job-limit` is how long (seconds) a job may stay running before it counts
  as `job-timeout` / `job-stuck`.
* Sub-agent jobs run on the account's **model slots** (demo and extraction → cheap, visual
  → vision), not on `--teacher`. Point the slots at a model that is
  answering before a run; otherwise you are measuring a provider outage.
* Results go to `evals/results/agent-reliability-<stamp>.{md,json}`. The
  process exits non-zero if any run failed.

## Scenarios (`scenarios.json`)

| id | what it exercises |
|---|---|
| `turn` | Opening turn plus the prober's question rounds. Every turn must settle with a saved assistant message within the function wall. |
| `visual` | Hands off to the teacher, asks for a diagram. The `visual` job must finish once, with no duplicates, and its result must be delivered back into the lesson. |
| `demo` | The same for an interactive `demo` (the longest sub-agent, up to 24 model calls). |
| `extraction` | Presses the manual extract button after a short lesson. Graph nodes whose provenance is this chat must appear (the durable result, not the per-instance status). |
| `visual-direct` | Spawns a `visual` job straight into a fresh chat (eval hook, below). It must run in its own invocation, finish once and be delivered to the lesson. |
| `demo-direct` | The same for a `demo` job, the longest loop. |
| `demo-deadline` | A `demo` job with a forced 20 s budget per attempt. Every attempt must be stopped before the wall and resumed in a fresh invocation. After the attempt cap, the job must end with the honest "ran out of time" error, and that error must be delivered (never a silent kill). |

### The eval hook (direct scenarios)

The `*-direct` and `*-deadline` scenarios measure the job machinery itself
(dispatch, lease, deadline, resume, delivery), whatever the teacher model
decides to call. They use `POST /api/eval/job
{chatId, kind: "visual"|"demo", brief, title?, evalBudgetMs?}` → `202
{jobId}`. The route exists only when the deployment sets `LH_EVAL_HOOKS=1`
(staging, never prod) and is owner-only. The job is delivered with a
synthetic `eval_…` tool-call id, as if the teacher had called the tool.
`evalBudgetMs` overrides the per-attempt budget (default 240 s from the
invocation start).

The learner always answers "I don't know" (`dontKnow`) and asks the prober
to start teaching, so scenarios reach the teacher in a bounded number of
rounds.

## Outcomes

| outcome | meaning |
|---|---|
| `ok` | everything settled and was delivered |
| `turn-http` | POST /api/chat refused the turn |
| `turn-lost` | the turn vanished with no saved reply (killed at the wall) |
| `turn-stuck` | still "in flight" past the wall |
| `turn-error` | the turn saved an error (e.g. `Request timed out.`, or the explained out-of-time message) |
| `probe-not-finished` | the prober never handed off (model behaviour, not infrastructure) |
| `tool-not-called` | the teacher never called the requested sub-agent (model behaviour) |
| `job-stuck` / `job-timeout` | the job stayed running past `--job-limit` |
| `job-duplicate` | more than one job record for one request |
| `job-wrong-outcome` | (`demo-deadline`) the job did not end with the out-of-time error |
| `job-not-resumed` | (`demo-deadline`) out of time, but no attempt was ever resumed in a fresh invocation |
| `job-error` | the job ended in error. The detail says why (`ran out of time` = the attempt cap was hit). |
| `not-delivered` | the job finished but its result never reached the lesson |
| `extraction-missing` | no graph nodes from the lesson |
| `harness-error` | the eval itself crashed |

Read the infrastructure outcomes (`turn-lost`, `turn-stuck`, `job-*`,
`not-delivered`, `extraction-missing`) separately from model behaviour
(`probe-not-finished`, `tool-not-called`, most `turn-error`s).

## Deterministic counterpart

`tests/job-reliability.test.ts` injects the same faults locally with no
network: a hung model at a job's budget, repeated kills up to the attempt
cap, a live or expired lease on another instance, a lease lost mid-run,
signed internal-dispatch envelopes, and the turn deadline end to end.
