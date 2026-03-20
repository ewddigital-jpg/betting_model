# Live Recommendation Audit

Generated at: 2026-03-19

## Scope

This audit focused on the current recommendation pipeline, not just historical replay.

Priority order used:
1. Over / Under 2.5 side mapping
2. odds outcome mapping into normalized selections
3. edge calculation using the correct side and price
4. board-quality classification false rejections
5. team / event identity mismatches

The working assumption was that something in current live decision generation is still broken.

## What I traced

I used two sources of evidence:

1. The existing 20-case forensic trace:
- [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\reports\forensic-unrealistic-recommendations-latest.json](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\reports\forensic-unrealistic-recommendations-latest.json)
- [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\reports\forensic-unrealistic-recommendations-latest.md](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\reports\forensic-unrealistic-recommendations-latest.md)

2. Current upcoming `recommendation_snapshots` compared against direct `analyzeMatch(...)` replays from the checked-in code.

## Easiest proven bug

The easiest proven bug was not an O/U side flip.

It was a persistence-integrity bug:
- the repository did not enforce a hard invariant that actionable stored recommendations must have real price-quality metadata
- this allowed contradictory rows to exist in `recommendation_snapshots`

Observed live examples:
- snapshot `1738`: `FC Metz`, `Playable`, `board_quality_tier = null`, `price_trustworthy_flag = 0`
- snapshot `1744`: `Under 2.5`, `Strong value`, `board_quality_tier = null`, `price_trustworthy_flag = 0`

Those are not semantically safe rows. A betting snapshot should not be actionable if the tracked market has no persisted price-quality package.

## Most likely root cause of unrealistic picks

The strongest current root cause is still bad price state, not a proven market-side inversion.

The 20-case forensic trace still says:
- `18/20` were stale odds / bad board
- `2/20` were post-kickoff collector contamination

Direct live replay on current code for matches like:
- `7703`
- `7668`
- `7697`
- `7871`

now returns:
- `primaryMarket.action = "No Bet"`
- `boardTier = "unusable"`
- block reasons including stale odds, unusable board, quota degradation

So the current checked-in engine says `No Bet`.

But the database still contained newer actionable rows for some of those same matches. That means the repository needed an extra persistence-layer safeguard even if the market engine itself was already stricter.

## What I changed

Changed files:
- [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\src\modules\data\collectorService.js](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\src\modules\data\collectorService.js)
- [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\tests\model.test.js](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\tests\model.test.js)

I added `normalizeStoredRecommendationState(...)` in the collector layer.

New behavior:
- if the tracked market is actionable but its `priceQuality` package is missing or malformed, the stored snapshot is forced to:
  - `action = "No Bet"`
  - `confidence = "Low"`
  - `trust = "Fragile"`
  - a non-actionable summary
  - an explicit downgrade reason

This is a correctness guard.
It does not tune the model.
It does not loosen thresholds.
It only prevents semantically contradictory snapshot rows.

## Tests added

Added deterministic regression test:
- `snapshot persistence coerces actionable picks to No Bet when price-quality metadata is missing`

That test proves the persistence layer no longer stores a fake actionable recommendation when the tracked market has no price-quality package.

Verification:
- `npm.cmd run test`
- result: `25/25` passing

## What I did not prove

I did **not** prove any of the following in this loop:

1. A raw Over / Under 2.5 side inversion in the current pipeline
- previous targeted audit and tests still point against that

2. A bookmaker outcome-order bug in current live parsing
- current odds mapping tests still pass

3. A wrong-side edge calculation in the checked-in betting engine
- current odds / implied-probability tests still pass

4. A board-quality false-rejection bug large enough to explain the ugly picks
- the latest board-quality audit still points to weak supply, not mass false negatives

5. An active team identity poisoning bug in the current checked-in state
- the identity audit is currently clean after the earlier repair

## What still looks suspicious

1. The long-running background process is almost certainly stale.
- `collector_runs.id = 147` is still marked `running`
- newer rows with null price-quality fields look like they were written by an older in-memory collector build
- that is an operational problem, not necessarily a repository logic bug

2. Live odds supply is still weak.
- quota degradation still exists
- stale boards still dominate
- that still explains many ugly recommendations better than a market mapping bug

3. Snapshot history now contains a mix of:
- older contradictory actionable rows
- newer strict no-bet rows

That makes raw report interpretation noisy unless old rows are filtered or the running process is restarted.

## Bottom line

The easiest proven live bug was:
- the database was allowed to store actionable recommendations without a valid price-quality package

The most likely root cause of unrealistic picks is still:
- stale / weak / quota-damaged boards

What remains unproven:
- a current Over / Under semantic inversion
- a current wrong-side odds-to-edge mapping bug
- a current team identity merge bug causing the live ugly picks

## Confidence

- Persistence-integrity bug was real: **High**
- The implemented collector guard fixes that exact bug: **High**
- Current unrealistic picks are still mainly driven by weak price state: **High**
- O/U side mapping is currently flipped in live code: **Low**
- Edge calculation uses the wrong side in live code: **Low**
- Team identity mismatch is still the main live culprit: **Low**
