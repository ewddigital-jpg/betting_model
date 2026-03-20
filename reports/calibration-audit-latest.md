# Calibration Audit

Generated at: 2026-03-19T11:14:44.220Z
Sample size: 1000 finished matches

## Precondition

- Semantic integrity checks passed before this audit:
  - market mapping / settlement tests: passing
  - implied probability / edge tests: passing
  - team identity audit: no active cross-team contamination detected

## Market Summary

| Market | Sample | Lean Accuracy % | Log Loss | Brier | Avg Selected P | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- | --- |
| 1X2 | 1000 | 49.8 | 1.0273 | 0.6164 | 0.4982 | -0.0002 |
| Over / Under 2.5 | 1000 | 55.5 | 0.6914 | 0.249 | 0.5452 | 0.0098 |
| BTTS | 1000 | 50.5 | 0.6994 | 0.2529 | 0.5413 | -0.0363 |

## Reliability Curves

### 1X2

| Bucket | Count | Expected % | Actual % | Gap % |
| --- | --- | --- | --- | --- |
| 30-40% | 137 | 38 | 44.5 | 6.5 |
| 40-50% | 414 | 44.9 | 43.5 | -1.4 |
| 50-60% | 309 | 54.6 | 54.7 | 0.1 |
| 60-70% | 120 | 64.1 | 59.2 | -4.9 |
| 70-80% | 20 | 72.8 | 85 | 12.2 |

### Over / Under 2.5

| Bucket | Count | Expected % | Actual % | Gap % |
| --- | --- | --- | --- | --- |
| 30-40% | 2 | 39.1 | 0 | -39.1 |
| 40-50% | 5 | 43.9 | 20 | -23.9 |
| 50-60% | 920 | 54 | 56.4 | 2.4 |
| 60-70% | 73 | 62 | 47.9 | -14 |

### BTTS

| Bucket | Count | Expected % | Actual % | Gap % |
| --- | --- | --- | --- | --- |
| 50-60% | 959 | 53.8 | 50.1 | -3.7 |
| 60-70% | 41 | 62.1 | 61 | -1.1 |

## Segment Analysis

### 1X2

By region

| Segment | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| Domestic | 788 | 49.5 | 1.0336 | 0.6208 | -0.0058 |
| Europe | 212 | 50.9 | 1.0039 | 0.5998 | 0.0204 |

By selected side

| Side | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| home | 713 | 51.2 | 1.0132 | 0.6061 | -0.0072 |
| away | 287 | 46.3 | 1.0623 | 0.6419 | 0.017 |

By favorite / balanced / underdog

| Profile | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| favorites | 140 | 62.9 | 0.8988 | 0.526 | -0.0246 |
| balanced | 723 | 48.3 | 1.0465 | 0.6294 | -0.0079 |
| underdogs | 137 | 44.5 | 1.0573 | 0.6399 | 0.065 |

### Over / Under 2.5

By region

| Segment | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| Domestic | 788 | 53.7 | 0.6984 | 0.2524 | -0.0078 |
| Europe | 212 | 62.3 | 0.6654 | 0.2362 | 0.0753 |

By selected side

| Side | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| over | 665 | 57.1 | 0.6891 | 0.2479 | 0.0208 |
| under | 335 | 52.2 | 0.6958 | 0.2513 | -0.012 |

By favorite / balanced / underdog

| Profile | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| favorites | 73 | 47.9 | 0.7557 | 0.2799 | -0.1404 |
| balanced | 925 | 56.2 | 0.6868 | 0.2468 | 0.0225 |
| underdogs | 2 | 0 | 0.4668 | 0.1391 | -0.3912 |

### BTTS

By region

| Segment | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| Domestic | 788 | 50.5 | 0.7016 | 0.2539 | -0.034 |
| Europe | 212 | 50.5 | 0.6916 | 0.2492 | -0.0448 |

By selected side

| Side | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| yes | 630 | 53.8 | 0.6888 | 0.2478 | -0.0044 |
| no | 370 | 44.9 | 0.7175 | 0.2616 | -0.0906 |

By favorite / balanced / underdog

| Profile | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| favorites | 42 | 59.5 | 0.7071 | 0.2542 | -0.0255 |
| balanced | 958 | 50.1 | 0.6991 | 0.2529 | -0.0368 |
| underdogs | 0 | - | - | - | - |

## Diagnostics

| Finding | Impact | Evidence |
| --- | --- | --- |
| Over / Under 2.5 overconfident tail | 14 | 60-70% bucket expected 62% but hit 47.9%. |

## Recommendation

1. Fit a market-specific post-hoc calibration layer from walk-forward history: temperature scaling for 1X2 and lightweight isotonic or bucket calibration for Over/Under 2.5 and BTTS.
2. Treat Europe separately in calibration reporting. If Europe keeps showing worse log loss alongside weaker xG coverage, use a competition-group calibration overlay before touching core features.
3. Leave BTTS experimental. Its calibration and directional accuracy are still too weak for threshold tuning to be meaningful.

