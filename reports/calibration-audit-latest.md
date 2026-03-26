# Calibration Audit

Generated at: 2026-03-25T15:23:10.836Z
Sample size: 1000 finished matches

## Precondition

- Semantic integrity checks passed before this audit:
  - market mapping / settlement tests: passing
  - implied probability / edge tests: passing
  - team identity audit: no active cross-team contamination detected

## Market Summary

| Market | Sample | Lean Accuracy % | Log Loss | Brier | Avg Selected P | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- | --- |
| 1X2 | 1000 | 45.2 | 1.0003 | 0.5975 | 0.4431 | 0.0089 |
| Over / Under 2.5 | 1000 | 57 | 0.6816 | 0.2443 | 0.5607 | 0.0093 |
| BTTS | 1000 | 52.1 | 0.7011 | 0.2539 | 0.5526 | -0.0316 |

## Reliability Curves

### 1X2

| Bucket | Count | Expected % | Actual % | Gap % |
| --- | --- | --- | --- | --- |
| 10-20% | 17 | 16.8 | 0 | -16.8 |
| 20-30% | 93 | 25.5 | 15.1 | -10.4 |
| 30-40% | 134 | 36.9 | 35.8 | -1.1 |
| 40-50% | 494 | 45.3 | 45.7 | 0.5 |
| 50-60% | 233 | 53.6 | 60.5 | 6.9 |
| 60-70% | 28 | 63.2 | 78.6 | 15.4 |
| 70-80% | 1 | 72.2 | 100 | 27.8 |

### Over / Under 2.5

| Bucket | Count | Expected % | Actual % | Gap % |
| --- | --- | --- | --- | --- |
| 50-60% | 887 | 55.3 | 55.6 | 0.2 |
| 60-70% | 113 | 61.8 | 68.1 | 6.4 |

### BTTS

| Bucket | Count | Expected % | Actual % | Gap % |
| --- | --- | --- | --- | --- |
| 50-60% | 965 | 55 | 51.6 | -3.4 |
| 60-70% | 35 | 61 | 65.7 | 4.7 |

## Segment Analysis

### 1X2

By region

| Segment | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| Domestic | 0 | - | - | - | - |
| Europe | 1000 | 45.2 | 1.0003 | 0.5975 | 0.0089 |

By selected side

| Side | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| home | 795 | 49.4 | 1.0104 | 0.6047 | 0.0193 |
| away | 204 | 28.9 | 0.9617 | 0.5704 | -0.0305 |
| draw | 1 | 0 | 0.7798 | 0.4403 | -0.255 |

By favorite / balanced / underdog

| Profile | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| favorites | 29 | 79.3 | 0.6928 | 0.3782 | 0.1584 |
| balanced | 727 | 50.5 | 1.0216 | 0.6125 | 0.0252 |
| underdogs | 244 | 25.4 | 0.9732 | 0.579 | -0.0576 |

### Over / Under 2.5

By region

| Segment | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| Domestic | 0 | - | - | - | - |
| Europe | 1000 | 57 | 0.6816 | 0.2443 | 0.0093 |

By selected side

| Side | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| over | 969 | 57.4 | 0.6816 | 0.2443 | 0.0118 |
| under | 31 | 45.2 | 0.6842 | 0.2456 | -0.0689 |

By favorite / balanced / underdog

| Profile | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| favorites | 114 | 67.5 | 0.63 | 0.2191 | 0.0581 |
| balanced | 886 | 55.6 | 0.6883 | 0.2476 | 0.003 |
| underdogs | 0 | - | - | - | - |

### BTTS

By region

| Segment | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| Domestic | 0 | - | - | - | - |
| Europe | 1000 | 52.1 | 0.7011 | 0.2539 | -0.0316 |

By selected side

| Side | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| yes | 961 | 52.1 | 0.7014 | 0.254 | -0.0327 |
| no | 39 | 51.3 | 0.6934 | 0.25 | -0.0054 |

By favorite / balanced / underdog

| Profile | Sample | Lean Accuracy % | Log Loss | Brier | Overconfidence Gap |
| --- | --- | --- | --- | --- | --- |
| favorites | 35 | 65.7 | 0.6402 | 0.2241 | 0.0468 |
| balanced | 965 | 51.6 | 0.7033 | 0.255 | -0.0344 |
| underdogs | 0 | - | - | - | - |

## Diagnostics

| Finding | Impact | Evidence |
| --- | --- | --- |

## Recommendation

1. Fit a market-specific post-hoc calibration layer from walk-forward history: temperature scaling for 1X2 and lightweight isotonic or bucket calibration for Over/Under 2.5 and BTTS.
2. Treat Europe separately in calibration reporting. If Europe keeps showing worse log loss alongside weaker xG coverage, use a competition-group calibration overlay before touching core features.
3. Leave BTTS experimental. Its calibration and directional accuracy are still too weak for threshold tuning to be meaningful.

