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
  [--scenarios turn,visual,demo,extraction] [--repeat 2] \
  [--teacher nvidia/deepseek-ai/deepseek-v4.1-flash] [--out evals/results]
```

* `--teacher provider/id` overrides the chat's conversation model, so you can
  compare models on the same deployment. Without it, the account's
  configured strong slot is used.
* Results go to `evals/results/agent-reliability-<stamp>.{md,json}`. The
  process exits non-zero if any run failed.

## Scenarios (`scenarios.json`)

| id | what it exercises |
|---|---|
| `turn` | Opening turn plus the prober's question rounds. Every turn must settle with a saved assistant message within the function wall. |
| `visual` | Hands off to the teacher, asks for a diagram. The `visual` job must finish once, with no duplicates, and its result must be delivered back into the lesson. |
| `demo` | The same for an interactive `demo` (the longest sub-agent, up to 24 model calls). |
| `extraction` | Presses the manual extract button after a short lesson. Graph nodes whose provenance is this chat must appear (the durable result, not the per-instance status). |

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
