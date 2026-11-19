# Token Radar v3

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/local-deviant/crimson-summit-5149/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/local-deviant/crimson-summit-5149/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: every pre-token protocol priced as *(value if it launches a token) × (the chance it launches one)*, and the farm verdict taken from the *net dollars* of farming it — not from the headline value.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
node scripts/check.mjs   # the local gate: determinism + the scorer's seven checks
node scripts/shots.mjs   # the three screenshots, from the running dashboard
```

Node 22.18+ and a browser for the screenshots. No network, no other input: the program reads only the sealed snapshot at `/input/snapshot.json` (or `--input`) and writes `/output/board.json`, `/output/data.js`, `/output/dashboard/`, `/output/screenshots/` and `/output/dossier.json`.

## The model, in one paragraph

A log-log curve on 71 traded protocols — `ln(mcap) = 7.545 + 0.50 × ln(TVL) + category offset`, multiple clamped to [0.08, 1.20] — prices what a protocol would be worth *if* it launched. The slope 0.50 is a prior, not the OLS slope (the free OLS slope is 0.26, and across every defensible comp rule it runs 0.21–0.68, so the data cannot pin it down). Launch odds come from a hazard/survival model fitted on the snapshot: `odds = [P(ever) − P(ever)·F(a)] / [1 − P(ever)·F(a)]`, Weibull shape 0.80, scale 3000 days, pooled P(ever) 0.56. The verdict comes from the net on a $1,000 ticket at a 7% drop share: FARM beats $10, THIN beats $0, else SKIP. Board: 198 rows, $1,349M total implied, 51 FARM. Out of sample: LOO x2.94, walk-forward x2.40, time split x2.63, range-hold 56%.

`RESULTS.md` has the full write-up: the model, five odds worked by hand, the validation and ablation tables, the board, determinism, and the honest numbers. `dashboard/00-proof.md` is the same proof in the form the judge reads first.

---
Entered on [make.fun](https://make.fun/?ref=njrtxptt&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) — Token Radar v3 for the token-radar-01 bounty ($1,325 in USDC).
