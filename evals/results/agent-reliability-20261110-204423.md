# Agent reliability eval — 20261110-204423

- target: https://learnharness-gamma.vercel.app
- teacher: (configured)
- runs: 1

**Overall: 0/1 ok**

| scenario | ok | outcomes | median s | max turn s | max job s |
|---|---|---|---|---|---|
| turn | 0/1 | turn-lost×1 | 395 | 394.2 | 0 |

## Failures

- **turn** → `turn-lost`: opening: no reply was ever saved (394.2s) — the turn died mid-run
