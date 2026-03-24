# Forward Validation

- Generated at: 2026-03-23T14:29:37.456Z
- Tracked matches: 16
- Bets: 4
- Settled bets: 4
- No-bet rate: 75.0%
- Average edge: 23.28%
- Average ROI: 36.25%
- Average CLV: -0.1
- Beat closing line rate: 75%
- Stale tracked matches: 9
- Quota-degraded matches: 1
- Weak-price bets: 4
- Weak-board matches: 8
- Unusable-board matches: 4

## Warnings
- Historical betting validation is still unavailable because only 8 finished matches have archived pre-kickoff odds.
- 9 tracked matches are using stale odds snapshots.
- 1 tracked matches were captured under quota-degraded odds coverage.
- 12 tracked matches were blocked by weak or unusable price boards.
- 4 forward bets come from weak price-quality conditions and should not be trusted like clean board bets.
- There are still no strong-price betting opportunities in the tracked forward sample.

## Market Priority
- Over / Under 2.5 (primary): This is the main forward-validation market.
- 1X2 (secondary): This stays conservative and calibrated.
- BTTS (experimental): This is tracked, but it should not be treated as core evidence yet.

## Validation Splits
- All tracked matches
  Tracked: 16
  Bets: 4
  No-bet rate: 75.0%
  Average edge: 23.28%
  Average ROI: 36.25%
  Average CLV: -0.1
  Beat close: 75%
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
  Tracked: 4
  Bets: 4
  No-bet rate: 0.0%
  Average edge: 23.28%
  Average ROI: 36.25%
  Average CLV: -0.1
  Beat close: 75%
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
  Tracked: 7
  Bets: 3
  No-bet rate: 57.1%
  Average edge: 26.23%
  Average ROI: -25%
  Average CLV: -0.08
  Beat close: 66.7%
- Strong-price O/U only
  Tracked: 0
  Bets: 0
  No-bet rate: n/a%
  Average edge: n/a%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
- Settled O/U bets only
  Tracked: 3
  Bets: 3
  No-bet rate: 0.0%
  Average edge: 26.23%
  Average ROI: -25%
  Average CLV: -0.08
  Beat close: 66.7%
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
  Bets: 3
  Passes: 4
  Average edge: 26.23%
  Average ROI: -25%
  Average CLV: -0.08
  Beat close: 66.7%
  Stale odds: 3
  Weak-price bets: 3
- 1X2 [secondary]
  Bets: 1
  Passes: 8
  Average edge: 14.43%
  Average ROI: 220%
  Average CLV: -0.17
  Beat close: 100%
  Stale odds: 6
  Weak-price bets: 1
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
  Bets: 4
  Settled bets: 4
  Average ROI: 36.25%
- Medium
  Bets: 0
  Settled bets: 0
  Average ROI: n/a%
- Low
  Bets: 0
  Settled bets: 0
  Average ROI: n/a%

## Price Quality
- Average odds freshness: 3755.5 minutes
- Average data completeness: 0.75
- Average source reliability: 0
- Average bookmaker depth: 15.2
- Usable board rate: 0%
- Strong board rate: 0%
- Strong-price bets: 0
- Weak-price bets: 4
- Fallback-used matches: 0
- Weak-board matches: 8
- Blocked due to unusable boards: 4
- Blocked due to weak boards: 8
- Blocked due to any price-quality rule: 12
- Quota-impacted collector runs: 10/30
- Board tiers:
  - strong: 0
  - usable: 0
  - weak: 8
  - unusable: 4
- Board providers:
  - unknown: 15
  - odds-api: 1
- Provider health:
  - unknown: 15 matches, 0 strong, 0 usable+, 9 stale, 0 quota-degraded, reliability 0
  - odds-api: 1 matches, 0 strong, 0 usable+, 0 stale, 1 quota-degraded, reliability n/a
- Provider request health:
  - none: success 0%, quota-degraded 1.4%, fallback 0%, avg odds events 0
  - odds-api: success 100%, quota-degraded 0%, fallback 0%, avg odds events 0
- Source reliability bands:
  - High reliability: 0
  - Medium reliability: 0
  - Low reliability: 11
- Block reasons:
  - model-rejection: 0
  - stale-odds: 9
  - weak-board: 8
  - unusable-board: 4
  - quota-degraded: 1
  - missing-implied-probability: 3
  - missing-bookmaker-depth: 5

## Operational Diagnostics
- Aggregate tracked matches: 16
- Aggregate stale boards: 9
- Aggregate weak boards: 8
- Aggregate unusable boards: 4
- Aggregate usable-or-better boards: 0
- Aggregate strong boards: 0
- Aggregate quota-degraded boards: 1
- Aggregate fallback-used boards: 0
- Missing board_quality_tier: 4
- Missing market_probability: 7
- Missing bookmaker_count: 4
- Settled bets: 4
- Settled price-trustworthy bets: 0
- Settled usable-or-better bets: 0
- Settled strong-price bets: 0
- Freshness distribution:
  - count: 9
  - median: 4071.2 min
  - p75: 5541.3 min
  - p90: 5622.2 min
- Bookmaker depth distribution:
  - count: 12
  - median: 10
  - p75: 34.3
  - p90: 35
- By provider/source:
  - unknown / live: 11 tracked, 9 stale, 8 weak, 3 unusable, 0 usable+, 0 strong
  - unknown / unknown: 4 tracked, 0 stale, 0 weak, 0 unusable, 0 usable+, 0 strong
  - odds-api / live: 1 tracked, 0 stale, 0 weak, 1 unusable, 0 usable+, 0 strong
- By provider:
  - unknown: 15 tracked, 9 stale, 8 weak, 3 unusable, freshness median 4071.2 min
  - odds-api: 1 tracked, 0 stale, 0 weak, 1 unusable, freshness median n/a min
- By competition:
  - CL: 8 tracked, 4 stale, 3 weak, 1 unusable, freshness median 2844.3 min
  - EL: 8 tracked, 5 stale, 5 weak, 3 unusable, freshness median 5541.3 min
- By provider and competition:
  - CL / unknown: 8 tracked, 4 stale, 3 weak, 1 unusable
  - EL / unknown: 7 tracked, 5 stale, 5 weak, 2 unusable
  - EL / odds-api: 1 tracked, 0 stale, 0 weak, 1 unusable
- By kickoff window:
  - 6-24h: 7 tracked, 5 stale, 5 weak, 2 unusable, 0 usable+, 0 strong
  - <=1h: 4 tracked, 0 stale, 0 weak, 0 unusable, 0 usable+, 0 strong
  - 3-6h: 3 tracked, 3 stale, 2 weak, 1 unusable, 0 usable+, 0 strong
  - 1-3h: 2 tracked, 1 stale, 1 weak, 1 unusable, 0 usable+, 0 strong
- Collector runs:
  - #168 partial (script): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #167 partial (script): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #166 partial (script): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #165 partial (script): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #164 partial (script): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #163 running (background-scheduled): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #162 partial (script): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #161 partial (background-urgent): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #160 partial (background-urgent): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #159 partial (background-start): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #158 partial (script): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #157 partial (background-scheduled): tracked 7, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
- Run/source diagnostics:
  - cache-hit with zero events: 1 entries across 1 runs
  - live fetch with zero events: 0 entries across 0 runs
  - quota-degraded entries: 3 across 2 runs
  - tracked entries with no fresh odds: 39 across 8 runs
- By request strategy:
  - no-usable-source: 233 tracked matches, 0 odds events, 3 quota-degraded entries, 0 fallback entries, 38 no-fresh entries
  - cache-hit: 7 tracked matches, 0 odds events, 0 quota-degraded entries, 0 fallback entries, 1 no-fresh entries
  - skipped-no-demand: 0 tracked matches, 0 odds events, 0 quota-degraded entries, 0 fallback entries, 0 no-fresh entries
- Worst latest snapshot ages:
  - EL Porto vs VfB Stuttgart: 5622.2 min, provider unknown/live, tier weak
  - EL FC Metz vs Nottingham Forest FC: 5622.2 min, provider unknown/live, tier weak
  - EL Real Betis Balompié vs Panathinaikos: 5541.3 min, provider unknown/live, tier weak
  - CL Tottenham Hotspur FC vs Atlético Madrid: 4291.3 min, provider unknown/live, tier weak
  - CL FC Bayern München vs Atalanta: 4071.2 min, provider unknown/live, tier weak
  - EL Aston Villa FC vs LOSC Lille: 2710.9 min, provider unknown/live, tier weak
  - EL AS Roma vs Bologna FC 1909: 2710.9 min, provider unknown/live, tier weak
  - CL Liverpool FC vs Galatasaray: 1617.4 min, provider unknown/live, tier unusable
  - CL FC Barcelona vs Newcastle United FC: 1612.4 min, provider unknown/live, tier weak
  - EL SC Freiburg vs Dinamo Zagreb: n/a min, provider unknown/live, tier unusable

## Edge Diagnosis
- Verdict: Average edge is not believable yet because there are no clean usable-price bets in the sample.
- The sample is still tiny, so random noise can easily inflate edge averages.
- A large share of bets still comes from weak price-quality boards.
- Some tracked matches still relied on stale odds snapshots.
- Provider quota limits degraded parts of the odds board.
- There are still no bets backed by usable-or-better price boards.
- Some older tracked rows still predate the new market-probability capture.
- The model is still capable of producing aggressive model-versus-market gaps.

## Calibration Audit
- Tracked rows: 16
- Bet rows: 4
- Settled bet rows: 4
- Settled bet probability buckets:
  - 30-40%: 1 bets, avg model 0.3576, avg market n/a, hit 100%
  - 40-50%: 3 bets, avg model 0.455, avg market n/a, hit 33.3%
- By market:
  - Over / Under 2.5: 3 settled bets
    - 40-50%: 3 bets, avg model 0.455, hit 33.3%
  - 1X2: 1 settled bets
    - 30-40%: 1 bets, avg model 0.3576, hit 100%
  - BTTS: 0 settled bets

## Edge Quality
- Tracked rows: 16
- Bet rows: 4
- Settled bet rows: 4
- Settled bet edge buckets:
  - 5-10%: 1 bets, avg edge 7.05%, avg ROI 1.25%, avg CLV -0.07, hit 100%
  - 10%+: 3 bets, avg edge 28.69%, avg ROI 0.07%, avg CLV -0.11, hit 33.3%
- By market:
  - Over / Under 2.5: 3 settled bets
    - 5-10%: 1 bets, avg ROI 1.25%, avg CLV -0.07
    - 10%+: 2 bets, avg ROI -1%, avg CLV -0.08
  - 1X2: 1 settled bets
    - 10%+: 1 bets, avg ROI 2.2%, avg CLV -0.17
  - BTTS: 0 settled bets
