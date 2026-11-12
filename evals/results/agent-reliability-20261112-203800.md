# Agent reliability eval — 20261112-203800

- target: https://learnharness-multiuser.vercel.app
- teacher: nvidia/minimaxai/minimax-m3.1-flash
- runs: 2

**Overall: 1/2 ok**

| scenario | ok | outcomes | median s | max turn s | continuations | max job s |
|---|---|---|---|---|---|---|
| visual-direct | 0/1 | job-error×1 | 207 | 0 | 0 | 204 |
| demo-direct | 1/1 | ok×1 | 79 | 0 | 0 | 51 |

## Failures

- **visual-direct** → `job-error`: job_mwe0fb62_4079a7da: FAILED: the maker crashed — Request timed out.
