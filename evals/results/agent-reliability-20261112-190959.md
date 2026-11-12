# Agent reliability eval — 20261112-190959

- target: https://learnharness-multiuser.vercel.app
- teacher: nvidia/minimaxai/minimax-m3.1-flash
- runs: 1

**Overall: 0/1 ok**

| scenario | ok | outcomes | median s | max turn s | continuations | max job s |
|---|---|---|---|---|---|---|
| visual-direct | 0/1 | job-error×1 | 723 | 0 | 0 | 722 |

## Failures

- **visual-direct** → `job-error`: job_mwdxa0us_6a9b3247: ran out of time — the job was stopped at the hosting time limit 3 times without finishing
