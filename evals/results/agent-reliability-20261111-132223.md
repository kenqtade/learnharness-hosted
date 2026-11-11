# Agent reliability eval — 20261111-132223

- target: https://learnharness-multiuser.vercel.app
- teacher: nvidia/minimaxai/minimax-m3.1-flash
- runs: 4

**Overall: 0/4 ok**

| scenario | ok | outcomes | median s | max turn s | max job s |
|---|---|---|---|---|---|
| turn | 0/1 | turn-error×1 | 387 | 284.1 | 0 |
| visual-direct | 0/1 | job-error×1 | 11 | 0 | 10 |
| demo-direct | 0/1 | job-error×1 | 1 | 0 | 0 |
| demo-deadline | 0/1 | job-wrong-outcome×1 | 0 | 0 | 0 |

## Failures

- **turn** → `turn-error`: answer-2: This reply ran out of time: the model had not finished within the server's 270 s time budget, so the turn was stopped before the hard limit. Send your message again, or pick a faster model in Settings. (after 284.1s)
- **visual-direct** → `job-error`: job_mwc5nhfz_06a86b31: FAILED: No render engine available: the app's own browser helper failed to start and no system Chrome/Chromium was found. Install Google Chrome or set CHROME_PATH to a Chrome executable. (Verification is mandatory — demos are never delivered untested.)
- **demo-direct** → `job-error`: job_mwc5nqez_201797dc: FAILED: No render engine available: the app's own browser helper failed to start and no system Chrome/Chromium was found. Install Google Chrome or set CHROME_PATH to a Chrome executable. (Verification is mandatory — demos are never delivered untested.)
- **demo-deadline** → `job-wrong-outcome`: job_mwc5nrhn_bfbe1e78: expected the honest out-of-time error, got error: FAILED: No render engine available: the app's own browser helper failed to start and no system Chrome/Chromium was found. Install Google Chrome or set CHROME_PATH to a Chrome executable. (Verification is mandatory — demos are never delivered untested.)
