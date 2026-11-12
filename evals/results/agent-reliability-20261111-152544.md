# Agent reliability eval — 20261111-152544

- target: https://learnharness-multiuser.vercel.app
- teacher: nvidia/minimaxai/minimax-m3.1-flash
- runs: 2

**Overall: 1/2 ok**

| scenario | ok | outcomes | median s | max turn s | continuations | max job s |
|---|---|---|---|---|---|---|
| turn | 0/1 | turn-error×1 | 180 | 176.9 | 0 | 0 |
| demo-deadline | 1/1 | ok×1 | 135 | 0 | 0 | 72 |

## Failures

- **turn** → `turn-error`: opening: Service temporarily unavailable (after 176.9s)
