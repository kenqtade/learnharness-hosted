# Agent reliability eval — 20261112-190556

- target: https://learnharness-multiuser.vercel.app
- teacher: nvidia/minimaxai/minimax-m3.1-flash
- runs: 1

**Overall: 0/1 ok**

| scenario | ok | outcomes | median s | max turn s | continuations | max job s |
|---|---|---|---|---|---|---|
| visual-direct | 0/1 | job-error×1 | 210 | 0 | 0 | 206 |

## Failures

- **visual-direct** → `job-error`: job_mwdx4vf0_fe68c70b: FAILED: the maker crashed — Request timed out.
