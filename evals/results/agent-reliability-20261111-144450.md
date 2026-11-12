# Agent reliability eval — 20261111-144450

- target: https://learnharness-multiuser.vercel.app
- teacher: nvidia/minimaxai/minimax-m3.1-flash
- runs: 4

**Overall: 0/4 ok**

| scenario | ok | outcomes | median s | max turn s | continuations | max job s |
|---|---|---|---|---|---|---|
| turn | 0/1 | turn-error×1 | 567 | 291.1 | 2 | 0 |
| visual-direct | 0/1 | job-error×1 | 727 | 0 | 0 | 726 |
| demo-direct | 0/1 | job-error×1 | 729 | 0 | 0 | 728 |
| demo-deadline | 0/1 | job-not-resumed×1 | 62 | 0 | 0 | 61 |

## Failures

- **turn** → `turn-error`: answer-3: This reply ran out of time: the model had not finished within the server's 270 s time budget, so the turn was stopped before the hard limit. Send your message again, or pick a faster model in Settings. (after 291.1s)
- **visual-direct** → `job-error`: job_mwc8pdvx_697d70af: ran out of time — the job was stopped at the hosting time limit 3 times without finishing
- **demo-direct** → `job-error`: job_mwc94z27_63ec03bf: ran out of time — the job was stopped at the hosting time limit 3 times without finishing
- **demo-deadline** → `job-not-resumed`: job_mwc9klxt_66b149a3: out of time but never resumed in a fresh run (activity ['building demo', 'failed'])
