# Agent reliability eval — 20261112-181149

- target: https://learnharness-multiuser.vercel.app
- teacher: nvidia/minimaxai/minimax-m3.1-flash
- runs: 2

**Overall: 1/2 ok**

| scenario | ok | outcomes | median s | max turn s | continuations | max job s |
|---|---|---|---|---|---|---|
| visual-direct | 0/1 | job-error×1 | 125 | 0 | 0 | 124 |
| demo-direct | 1/1 | ok×1 | 76 | 0 | 0 | 22 |

## Failures

- **visual-direct** → `job-error`: job_mwdv7a0c_865623a2: FAILED: the maker crashed — Request timed out.
