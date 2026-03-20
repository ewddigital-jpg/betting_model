# Forward Validation

- Generated at: 2026-03-19T10:25:58.761Z
- Tracked matches: 16
- Bets: 7
- Settled bets: 7
- No-bet rate: n/a%
- Average edge: 26.69%
- Average ROI: n/a%
- Average CLV: -0.1
- Beat closing line rate: 85.7%
- Stale tracked matches: undefined
- Quota-degraded matches: 0
- Weak-price bets: 7
- Weak-board matches: 5
- Unusable-board matches: 2

## Warnings
- Historical betting validation is still unavailable because only 8 finished matches have archived pre-kickoff odds.
- 5 tracked matches are using stale odds snapshots.
- 7 tracked matches were blocked by weak or unusable price boards.
- 7 forward bets come from weak price-quality conditions and should not be trusted like clean board bets.
- There are still no strong-price betting opportunities in the tracked forward sample.

## Market Priority
- Over / Under 2.5 (primary): This is the main forward-validation market.
- 1X2 (secondary): This stays conservative and calibrated.
- BTTS (experimental): This is tracked, but it should not be treated as core evidence yet.

## Validation Splits
- All tracked matches
  Tracked: 16
  Bets: 7
  No-bet rate: 56.3%
  Average edge: 26.69%
  Average ROI: -22.14%
  Average CLV: -0.1
  Beat close: 85.7%
- Strong-price only
  Tracked: 0
  Bets: 0
  No-bet rate: n/a%
  Average edge: n/a%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
- Usable-or-better only
  Tracked: 0
  Bets: 0
  No-bet rate: n/a%
  Average edge: n/a%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
- Settled bets only
  Tracked: 7
  Bets: 7
  No-bet rate: 0.0%
  Average edge: 26.69%
  Average ROI: -22.14%
  Average CLV: -0.1
  Beat close: 85.7%
- Settled strong-price bets only
  Tracked: 0
  Bets: 0
  No-bet rate: n/a%
  Average edge: n/a%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%

## Over / Under Focus
- All O/U tracked
  Tracked: 5
  Bets: 5
  No-bet rate: 0.0%
  Average edge: 28.39%
  Average ROI: -55%
  Average CLV: -0.09
  Beat close: 80%
- Strong-price O/U only
  Tracked: 0
  Bets: 0
  No-bet rate: n/a%
  Average edge: n/a%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
- Settled O/U bets only
  Tracked: 5
  Bets: 5
  No-bet rate: 0.0%
  Average edge: 28.39%
  Average ROI: -55%
  Average CLV: -0.09
  Beat close: 80%
- Settled strong-price O/U only
  Tracked: 0
  Bets: 0
  No-bet rate: n/a%
  Average edge: n/a%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%

## By Market
- Over / Under 2.5 [primary]
  Bets: 5
  Passes: 0
  Average edge: 28.39%
  Average ROI: -55%
  Average CLV: -0.09
  Beat close: 80%
  Stale odds: 0
  Weak-price bets: 5
- 1X2 [secondary]
  Bets: 2
  Passes: 9
  Average edge: 22.46%
  Average ROI: 60%
  Average CLV: -0.15
  Beat close: 100%
  Stale odds: 5
  Weak-price bets: 2
- BTTS [experimental]
  Bets: 0
  Passes: 0
  Average edge: n/a%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
  Stale odds: 0
  Weak-price bets: 0

## By Confidence
- High
  Bets: 7
  Settled bets: 7
  Average ROI: -22.14%
- Medium
  Bets: 0
  Settled bets: 0
  Average ROI: n/a%
- Low
  Bets: 0
  Settled bets: 0
  Average ROI: n/a%

## Price Quality
- Average odds freshness: 4441.5 minutes
- Average data completeness: 0.71
- Average source reliability: 0
- Average bookmaker depth: 19.7
- Usable board rate: 0%
- Strong board rate: 0%
- Strong-price bets: 0
- Weak-price bets: 7
- Fallback-used matches: 0
- Weak-board matches: 5
- Blocked due to unusable boards: 2
- Blocked due to weak boards: 5
- Blocked due to any price-quality rule: 9
- Quota-impacted collector runs: 15/30
- Board tiers:
  - strong: 0
  - usable: 0
  - weak: 5
  - unusable: 2
- Board providers:
  - unknown: 16
- Provider health:
  - unknown: 16 matches, 0 strong, 0 usable+, 5 stale, 0 quota-degraded, reliability 0
- Provider request health:
  - none: success 0%, quota-degraded 3%, fallback 0%, avg odds events 0
  - trusted-cache: success 100%, quota-degraded 100%, fallback 100%, avg odds events 0
  - odds-api: success 100%, quota-degraded 0%, fallback 0%, avg odds events 0
- Source reliability bands:
  - High reliability: 0
  - Medium reliability: 0
  - Low reliability: 7
- Block reasons:
  - model-rejection: 0
  - stale-odds: 5
  - weak-board: 5
  - unusable-board: 2
  - quota-degraded: 0
  - missing-implied-probability: 4
  - missing-bookmaker-depth: 4

## Edge Diagnosis
- Verdict: Average edge is not believable yet because there are no clean usable-price bets in the sample.
- The sample is still tiny, so random noise can easily inflate edge averages.
- A large share of bets still comes from weak price-quality boards.
- Some tracked matches still relied on stale odds snapshots.
- There are still no bets backed by usable-or-better price boards.
- Some older tracked rows still predate the new market-probability capture.
- The model is still capable of producing aggressive model-versus-market gaps.
