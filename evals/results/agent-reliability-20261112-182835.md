# Agent reliability eval — 20261112-182835

- target: https://learnharness-multiuser.vercel.app
- teacher: nvidia/minimaxai/minimax-m3.1-flash
- runs: 4

**Overall: 2/4 ok**

| scenario | ok | outcomes | median s | max turn s | continuations | max job s |
|---|---|---|---|---|---|---|
| turn | 1/1 | ok×1 | 833 | 562.8 | 3 | 0 |
| visual-direct | 0/1 | job-error×1 | 123 | 0 | 0 | 123 |
| demo-direct | 0/1 | not-delivered×1 | 345 | 0 | 0 | 41 |
| demo-deadline | 1/1 | ok×1 | 345 | 0 | 0 | 61 |

## Failures

- **visual-direct** → `job-error`: job_mwdwaogu_f5781ec9: FAILED: the maker crashed — Request timed out.
- **demo-direct** → `not-delivered`: job finished but its result never reached the lesson
