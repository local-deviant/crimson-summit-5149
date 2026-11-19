# Token Radar v3 — proof (read this first)

**One sentence:** every protocol is priced as *(value if it launches a token) × (the chance it launches one)*, and the farm verdict comes from the *net dollars* of farming it on a $1,000 ticket. Every step below is shown with its numbers, and every number is produced by `main.ts` from the snapshot — re-run it and compare.

Snapshot: DefiLlama, as of 2026-11-14, 758 protocols, watchlist floor $50,000,000. No network, no hand-picked names.

## 1. The model

**Value if it launches.** A log-log curve fitted on 71 traded protocols:

    ln(mcap) = 7.545 + 0.50 x ln(TVL) + category offset

- Comps (71): traded (mcap > 0), TVL > 0, age known. Excluded: CEX, bridges, liquid staking / restaking receipts (their tokens are not a claim on the protocol's own TVL), versioned names (a parent's token, double-counted), exchange names. The exclusion table is in §5.
- **Slope 0.50 is a prior, not the OLS slope.** The free OLS slope on these comps is 0.26, and across every defensible comp rule it runs 0.21–0.68 — the data cannot pin the slope down, so the slope is set to 0.50 (the middle of the range a flat curve needs) and the intercept (7.545) and offsets are fitted at that slope. The ablation table (§3) shows the OLS slope's LOO is worse (x3.41 vs x2.94).
- Category offsets, shrunk n/(n+8) toward zero. Largest: Prediction Market +0.700, Basis Trading +0.422, Privacy +0.378. Smallest: Staking Pool −0.499, Yield −0.467, Lending −0.388.
- Multiple (value / TVL) clamped to [0.08, 1.20]. The clamp binds at the top: the four biggest protocols all sit at 0.08.
- Growth factor: 1 + clamp(change_7d, −60, 120) / 100 × 0.3.

**Launch odds (hazard / survival).** `odds = [P(ever) − P(ever)·F(a)] / [1 − P(ever)·F(a)]`, where P(ever) is the category's ever-launch rate (age-corrected, shrunk toward the pooled 0.56 with strength 15, capped at [0.05, 0.85]) and F(a) is the launch-time CDF — a Weibull (shape 0.80, scale 3000 days) fitted by maximum likelihood on the snapshot's current-status data (each protocol observed at its age, with or without a token). The pooled fit: P(has token | age) = 0.56 × F(age) matches the binned rates (0–180d: 0.034 vs 0.033 model; 365–730d: 0.120 vs 0.127; 1095–1460d: 0.247 vs 0.222; 1460d+: 0.270 vs 0.306). The cumulative rate is NOT used as odds — it rises with age, which points backwards: a protocol that is old and still tokenless is *less* likely to launch, and the hazard form says so.

**Implied value = value if it launches × odds.** Board total $1,349M across 198 rows. Odds across the board: median 0.45, 10th percentile 0.27, 90th percentile 0.82.

**Net and verdict.** On a $1,000 ticket at a 7% drop share: expected drop = (1000 / TVL) × implied × 0.07; gas = 5 transactions at the first chain's rate (Ethereum $6.00, Arbitrum / Optimism / Base $0.20, BSC $0.40, Solana $0.05, Polygon $0.10, other chains $1.50). Net = drop − gas. **FARM when net beats $10, THIN when it beats $0, else SKIP.** The $10 bar is deliberate: a $1 margin is noise against gas estimates that move with congestion. Result: 51 FARM / 65 THIN / 82 SKIP. The farm plan on each row states the deposit, the expected drop and net, the gas per step, the review date (2027-02-06, 84 days after the snapshot), and the exit rule (withdraw if TVL falls under 70% of the snapshot TVL). Best net per hour: +$12.83 (BounceBit Prime).

## 2. Top 10 rows (odds and net shown)

| # | Protocol | TVL | Value if launches | Odds | Implied | Net $1k | Verdict | Rank range (p10–p90) |
|---|---|---|---|---|---|---|---|---|
| 1 | Sentora Curator | $2,758M | $222.2M | 0.25 | $55.5M | −$28.59 | SKIP | 1–2 |
| 2 | Steakhouse Financial | $2,754M | $218.9M | 0.24 | $52.6M | +$0.34 | THIN | 2–3 |
| 3 | USDD | $1,056M | $83.8M | 0.49 | $41.0M | −$4.78 | SKIP | 3–4 |
| 4 | Veda | $1,563M | $122.0M | 0.33 | $40.2M | −$5.70 | SKIP | 4–6 |
| 5 | BitFi Basis | $215M | $41.0M | 0.81 | $33.2M | +$3.30 | THIN | 3–9 |
| 6 | Polymarket International | $320M | $67.9M | 0.47 | $32.2M | +$6.55 | THIN | 1–21 |
| 7 | Gauntlet | $1,578M | $128.4M | 0.24 | $30.8M | +$0.37 | THIN | 5–8 |
| 8 | OnRe | $309M | $33.3M | 0.82 | $27.3M | +$5.93 | THIN | 6–9 |
| 9 | OpenTrade | $241.5M | $29.3M | 0.81 | $23.6M | +$5.34 | THIN | 8–11 |
| 10 | R25 | $198M | $26.7M | 0.83 | $22.3M | +$0.38 | THIN | 9–13 |

The big rows are SKIP/THIN: a $1,000 deposit in a $2.8B protocol buys a $1.41 expected drop against $30 of gas. The FARM rows are the small ones — e.g. #25 Drakewell (TVL $28.2M, implied $13.1M, net +$31.45, +$9.68/h), #43 BounceBit Prime (TVL $11.4M, implied $8.0M, net +$41.71, +$12.83/h). Rank ranges come from 200 bootstrap refits of the comp set (seeded, deterministic).

## 3. Validation (out of sample, computed by the program)

- Leave-one-out (median): **x2.94** (mean x19.09 — the mean is outlier-driven: two comps carry multiples above 35x).
- Walk-forward (fit before 2025-01-01, test after; 42 train / 29 test): **x2.40**.
- Time split (oldest half fit, newest half test; 35 / 36): **x2.63**.
- Range-hold (actual mcap within 3x of prediction): **56%** (40 of 71 comps).
- Spearman (implied rank vs TVL rank): 0.832.

Ablation (LOO median):

| Variant | LOO | Note |
|---|---|---|
| Main: slope 0.50, no age, offsets | x2.94 | the board model |
| Age term on (slope 0.50) | x2.77 | LOO a touch better, walk-forward x5.80 — rejected (below) |
| No offsets | x3.08 | offsets carry the category premia |
| Slope 0.45 | x2.92 | flatter prior, same family |
| Slope 0.55 | x2.94 | steeper prior, same family |
| OLS slope (free, 0.26) | x3.41 | the data-fit slope; values the giants too high |

Rejected variants, with reasons:

- **Age term ln(age).** LOO x2.77 vs x2.94 without it, but walk-forward x5.80 vs x2.40. The age pattern is a cohort effect — young test protocols run 2x the train set's multiples — that does not travel forward, so the term is left out.
- **Huber / LAD robust fit.** Downweights the high-multiple young tokens the board is trying to price; the median-based LOO already limits their influence, so a robust fit buys little and hides the outliers instead of showing them.
- **Spline / quadratic in ln(TVL).** A flexible curve bends up at the top end, where the board needs it flat; it would chase the same high-multiple young tokens the flat prior refuses to chase.
- **Slope per category.** Most categories have under 10 comps; per-category slopes are noise (standard errors wider than the slope itself). One slope, shrunk offsets.
- **Pre-token discount 0.80.** A flat multiplier on every pre-token protocol — pure bias with no basis in the data. Launch odds replace it, per protocol, from the snapshot.
- **Cumulative token rate as odds.** P(has token | age) rises with age, so using it as odds would say old tokenless protocols are the most likely to launch — backwards. The hazard form is used instead.

## 4. Five odds, worked by hand

P(ever) per category: token rate ÷ mean launch-CDF over the category's ages, shrunk toward 0.56 with strength 15, capped at [0.05, 0.85]. F(a) is the Weibull CDF above.

- **Sentora Curator** (Risk Curators, 407 days): 1 of 39 peers has a token (rate 0.026); mean F over the peers' ages 0.138 → raw 0.186 → shrunk P(ever) 0.29. F(407) = 0.183. Odds = (0.29 − 0.29×0.183) / (1 − 0.29×0.183) = 0.237 / 0.947 = **0.25**.
- **Steakhouse Financial** (Risk Curators, 543 days): same P(ever) 0.29. F(543) = 0.225. Odds = (0.29 − 0.065) / (1 − 0.065) = **0.24**.
- **OnRe** (RWA, 488 days): 9 of 33 peers have a token (rate 0.273); mean F 0.247 → raw 1.105 → capped P(ever) 0.85. F(488) = 0.209. Odds = (0.85 − 0.178) / (1 − 0.178) = **0.82**.
- **Polymarket International** (Prediction Market, 1845 days): 1 of 3 peers has a token (rate 0.333); mean F 0.320 → raw 1.042 → shrunk P(ever) 0.64. F(1845) = 0.492. Odds = (0.64 − 0.315) / (1 − 0.315) = **0.47**. Old and still tokenless: the odds have nearly halved from the category's 0.64.
- **Drakewell** (Basis Trading, 43 days): 7 of 21 peers have a token (rate 0.333); mean F 0.204 → raw 1.637 → capped P(ever) 0.85. F(43) = 0.034. Odds = (0.85 − 0.029) / (1 − 0.029) = **0.85**. Young, in a category that launches: the odds are near the cap.

## 5. All 758 protocols, accounted for

| Group | N | Note |
|---|---|---|
| Ranked on the board | 198 | every rankable pre-token protocol (40 watchlist + 158 below / beside it) |
| Token trades | 158 | a market cap or a CoinGecko id is recorded |
| Symbol only, no market cap | 258 | a token is recorded but unpriced — not ranked, not priced |
| Set aside: CEX | 42 | pre-token but not a launch candidate under the board rule |
| Set aside: Liquid Staking | 38 | as above |
| Set aside: Bridge | 28 | as above |
| Set aside: Canonical Bridge | 15 | as above |
| Set aside: versioned name | 11 | as above |
| Set aside: wrapped / staked name | 5 | as above |
| Set aside: Liquid Restaking | 3 | as above |
| Set aside: Restaked BTC | 2 | as above |
| **Total** | **758** | |

## 6. How to verify

1. `node main.ts --input <snapshot>`: re-runs the whole pipeline from the snapshot and rewrites `board.json` and `data.js` byte-identically (deterministic: no clock, no randomness except a seeded bootstrap).
2. `node scripts/check.mjs`: re-runs the program twice, checks determinism, runs the gate's seven checks (dashboard files, board file, sorted by value, coverage of all 40 watchlist slugs, farm steps, screenshots, dossier matches), checks the dashboard data matches the board, and checks every number on this page against the output.
3. The scatter (log TVL vs log mcap, 71 comps + the fitted curve + the 3x band) is drawn in the Method section from the comps in `data.js`.
4. What is NOT claimed: no launch date is promised (the fitted launch-time distribution is long-tailed, so the plan gives a review date and an exit rule, not a date). USDD (#3) is a stablecoin the snapshot records as tokenless; it is ranked because the house's own watchlist includes it, and the model prices it from TVL like any other row.
