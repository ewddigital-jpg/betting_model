# Forward Validation

- Generated at: 2026-04-07T07:36:27.532Z
- Tracked matches: 8
- Bets: 5
- Settled bets: 0
- No-bet rate: 37.5%
- Average edge: 24.08%
- Average ROI: n/a%
- Average CLV: n/a
- Beat closing line rate: n/a%
- Stale tracked matches: 2
- Quota-degraded matches: 0
- Weak-price bets: 3
- Weak-board matches: 0
- Unusable-board matches: 1

## Warnings
- 2 tracked matches are using stale odds snapshots.
- 1 tracked matches were blocked by weak or unusable price boards.
- 3 forward bets come from weak price-quality conditions and should not be trusted like clean board bets.

## Market Priority
- Over / Under 2.5 (primary): This is the main forward-validation market.
- 1X2 (secondary): This stays conservative and calibrated.
- BTTS (experimental): This is tracked, but it should not be treated as core evidence yet.

## Validation Splits
- All tracked matches
  Tracked: 8
  Bets: 5
  No-bet rate: 37.5%
  Average edge: 24.08%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
- Strong-price only
  Tracked: 2
  Bets: 2
  No-bet rate: 0.0%
  Average edge: 17.2%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
- Usable-or-better only
  Tracked: 2
  Bets: 2
  No-bet rate: 0.0%
  Average edge: 17.2%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
- Settled bets only
  Tracked: 0
  Bets: 0
  No-bet rate: n/a%
  Average edge: n/a%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
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
  Tracked: 2
  Bets: 2
  No-bet rate: 0.0%
  Average edge: 20.81%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
- Strong-price O/U only
  Tracked: 0
  Bets: 0
  No-bet rate: n/a%
  Average edge: n/a%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
- Settled O/U bets only
  Tracked: 0
  Bets: 0
  No-bet rate: n/a%
  Average edge: n/a%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
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
  Bets: 2
  Passes: 0
  Average edge: 20.81%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
  Stale odds: 1
  Weak-price bets: 2
- 1X2 [secondary]
  Bets: 1
  Passes: 3
  Average edge: 44.38%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
  Stale odds: 1
  Weak-price bets: 1
- BTTS [experimental]
  Bets: 2
  Passes: 0
  Average edge: 17.2%
  Average ROI: n/a%
  Average CLV: n/a
  Beat close: n/a%
  Stale odds: 0
  Weak-price bets: 0

## By Confidence
- High
  Bets: 3
  Settled bets: 0
  Average ROI: n/a%
- Medium
  Bets: 2
  Settled bets: 0
  Average ROI: n/a%
- Low
  Bets: 0
  Settled bets: 0
  Average ROI: n/a%

## Price Quality
- Average odds freshness: 4035 minutes
- Average data completeness: 0.88
- Average source reliability: 0.74
- Average bookmaker depth: 8.9
- Usable board rate: 25%
- Strong board rate: 25%
- Strong-price bets: 2
- Weak-price bets: 3
- Fallback-used matches: 3
- Weak-board matches: 0
- Blocked due to unusable boards: 1
- Blocked due to weak boards: 0
- Blocked due to any price-quality rule: 2
- Quota-impacted collector runs: 0/30
- Board tiers:
  - strong: 2
  - usable: 5
  - weak: 0
  - unusable: 1
- Board providers:
  - odds-api: 7
  - unknown: 1
- Provider health:
  - odds-api: 7 matches, 2 strong, 2 usable+, 2 stale, 0 quota-degraded, reliability 0.85
  - unknown: 1 matches, 0 strong, 0 usable+, 0 stale, 0 quota-degraded, reliability 0
- Provider request health:
  - none: success 0%, quota-degraded 0%, fallback 0%, avg odds events 0
  - odds-api: success 100%, quota-degraded 0%, fallback 0%, avg odds events 2.1
- Source reliability bands:
  - High reliability: 4
  - Medium reliability: 0
  - Low reliability: 4
- Block reasons:
  - model-rejection: 1
  - stale-odds: 1
  - weak-board: 0
  - unusable-board: 1
  - quota-degraded: 0
  - missing-implied-probability: 1
  - missing-bookmaker-depth: 1

## Operational Diagnostics
- Aggregate tracked matches: 8
- Aggregate stale boards: 2
- Aggregate weak boards: 0
- Aggregate unusable boards: 1
- Aggregate usable-or-better boards: 2
- Aggregate strong boards: 2
- Aggregate quota-degraded boards: 0
- Aggregate fallback-used boards: 3
- Missing board_quality_tier: 0
- Missing market_probability: 1
- Missing bookmaker_count: 0
- Settled bets: 0
- Settled price-trustworthy bets: 0
- Settled usable-or-better bets: 0
- Settled strong-price bets: 0
- Freshness distribution:
  - count: 7
  - median: 13 min
  - p75: 7062.2 min
  - p90: 14094.3 min
- Bookmaker depth distribution:
  - count: 8
  - median: 9.5
  - p75: 14
  - p90: 14
- By provider/source:
  - odds-api / live: 4 tracked, 2 stale, 0 weak, 0 unusable, 2 usable+, 2 strong
  - odds-api / trusted_cache: 3 tracked, 0 stale, 0 weak, 0 unusable, 0 usable+, 0 strong
  - unknown / live: 1 tracked, 0 stale, 0 weak, 1 unusable, 0 usable+, 0 strong
- By provider:
  - odds-api: 7 tracked, 2 stale, 0 weak, 0 unusable, freshness median 13 min
  - unknown: 1 tracked, 0 stale, 0 weak, 1 unusable, freshness median n/a min
- By competition:
  - CL: 4 tracked, 0 stale, 0 weak, 0 unusable, freshness median 6.6 min
  - EL: 4 tracked, 2 stale, 0 weak, 1 unusable, freshness median 14094.2 min
- By provider and competition:
  - CL / odds-api: 4 tracked, 0 stale, 0 weak, 0 unusable
  - EL / odds-api: 3 tracked, 2 stale, 0 weak, 0 unusable
  - EL / unknown: 1 tracked, 0 stale, 0 weak, 1 unusable
- By kickoff window:
  - >24h: 6 tracked, 2 stale, 0 weak, 1 unusable, 1 usable+, 1 strong
  - 6-24h: 2 tracked, 0 stale, 0 weak, 0 unusable, 1 usable+, 1 strong
- Collector runs:
  - #135 running (background-start): tracked 0, stale 0, weak 0, unusable 0, usable+ 0, strong 0, quota 0, fallback 0
  - #134 success (background-scheduled): tracked 8, stale 2, weak 0, unusable 1, usable+ 2, strong 2, quota 0, fallback 3
  - #133 success (script): tracked 8, stale 2, weak 0, unusable 1, usable+ 2, strong 2, quota 0, fallback 3
  - #132 success (background-scheduled): tracked 8, stale 6, weak 0, unusable 1, usable+ 0, strong 0, quota 0, fallback 1
  - #131 failed (background-scheduled): tracked 8, stale 7, weak 0, unusable 1, usable+ 0, strong 0, quota 0, fallback 0
  - #130 failed (background-scheduled): tracked 8, stale 5, weak 0, unusable 1, usable+ 0, strong 0, quota 0, fallback 2
  - #129 success (background-scheduled): tracked 8, stale 5, weak 0, unusable 1, usable+ 0, strong 0, quota 0, fallback 2
  - #128 success (background-scheduled): tracked 8, stale 5, weak 0, unusable 1, usable+ 0, strong 0, quota 0, fallback 2
  - #127 success (background-scheduled): tracked 8, stale 5, weak 0, unusable 1, usable+ 0, strong 0, quota 0, fallback 2
  - #126 success (background-scheduled): tracked 8, stale 5, weak 0, unusable 1, usable+ 0, strong 0, quota 0, fallback 2
  - #125 success (background-scheduled): tracked 8, stale 5, weak 0, unusable 1, usable+ 0, strong 0, quota 0, fallback 2
  - #124 success (background-scheduled): tracked 8, stale 5, weak 0, unusable 1, usable+ 0, strong 0, quota 0, fallback 2
- Run/source diagnostics:
  - cache-hit with zero events: 0 entries across 0 runs
  - live fetch with zero events: 0 entries across 0 runs
  - quota-degraded entries: 0 across 0 runs
  - tracked entries with no fresh odds: 1 across 1 runs
- By request strategy:
  - cache-hit: 20 tracked matches, 20 odds events, 0 quota-degraded entries, 0 fallback entries, 0 no-fresh entries
  - targeted-events: 9 tracked matches, 9 odds events, 0 quota-degraded entries, 0 fallback entries, 0 no-fresh entries
  - no-usable-source: 4 tracked matches, 0 odds events, 0 quota-degraded entries, 0 fallback entries, 1 no-fresh entries
  - skipped-no-demand: 0 tracked matches, 0 odds events, 0 quota-degraded entries, 0 fallback entries, 0 no-fresh entries
- Worst latest snapshot ages:
  - EL Bologna vs Aston Villa: 14094.4 min, provider odds-api/live, tier usable
  - EL Porto vs Nottingham Forest: 14094.2 min, provider odds-api/live, tier usable
  - EL Sporting Braga vs Real Betis: 30.1 min, provider odds-api/trusted_cache, tier usable
  - CL FC Barcelona vs Atlético Madrid: 13 min, provider odds-api/trusted_cache, tier usable
  - CL Sporting CP vs Arsenal: 13 min, provider odds-api/trusted_cache, tier usable
  - CL Paris Saint Germain vs Liverpool: 0.1 min, provider odds-api/live, tier strong
  - CL Real Madrid vs FC Bayern München: 0.1 min, provider odds-api/live, tier strong
  - EL SC Freiburg vs Celtic: n/a min, provider unknown/live, tier unusable

## Edge Diagnosis
- Verdict: Average edge is not fully believable yet because price quality is still uneven.
- The sample is still tiny, so random noise can easily inflate edge averages.
- A large share of bets still comes from weak price-quality boards.
- Some tracked matches still relied on stale odds snapshots.
- Some older tracked rows still predate the new market-probability capture.
- The model is still capable of producing aggressive model-versus-market gaps.

## Calibration Audit
- Tracked rows: 8
- Bet rows: 5
- Settled bet rows: 0
- Settled bet probability buckets:
- By market:
  - Over / Under 2.5: 0 settled bets
  - 1X2: 0 settled bets
  - BTTS: 0 settled bets

## Edge Quality
- Tracked rows: 8
- Bet rows: 5
- Settled bet rows: 0
- Settled bet edge buckets:
- By market:
  - Over / Under 2.5: 0 settled bets
  - 1X2: 0 settled bets
  - BTTS: 0 settled bets
