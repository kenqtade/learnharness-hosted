# Agent reliability eval — 20261110-205117

- target: https://learnharness-multiuser.vercel.app
- teacher: nvidia/deepseek-ai/deepseek-v4.1-flash
- runs: 2

**Overall: 0/2 ok**

| scenario | ok | outcomes | median s | max turn s | max job s |
|---|---|---|---|---|---|
| turn | 0/2 | turn-error×2 | 136 | 135.9 | 0 |

## Failures

- **turn** → `turn-error`: opening: Request timed out. (after 131.8s)
- **turn** → `turn-error`: opening: Request timed out. (after 135.9s)
