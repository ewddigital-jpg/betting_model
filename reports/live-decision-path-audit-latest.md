# Betting Model Audit: Live Decision Path

**Scope:** `bettingEngine.js` — live path only (no fixes, diagnosis only)
**Key file:** `src/modules/analysis/bettingEngine.js`
**Missing dependency:** `../data/oddsBoardService.js` — imported at line 6, does not exist in repo

---

## 1. Step-by-step: How a board is selected from raw odds

**Entry:** `buildMarketAssessment()` → `buildBookmakerRows()` → `resolveBoardSelection()`

### Inside `resolveBoardSelection()` (line 411)

**Step 1 — Fetch live snapshots**
`latestSnapshotGroups(matchId, market)` queries `odds_snapshots` ordered by `retrieved_at DESC`.
`collapseLatestPerBookmaker()` deduplicates to one row per bookmaker (first encountered = most recent).

**Step 2 — Determine live source metadata**
`resolveBoardSource()` picks the dominant `source_provider` and `source_label` from live rows,
falling back to the persisted board record (`readOddsMarketBoard(..., "live")`).

**Step 3 — Check quota status**
`resolveSyncDiagnostics()` reads the latest `collector_runs` row for `OUT_OF_USAGE_CREDITS` errors.
`liveQuotaDegraded = quotaDegraded && provider === "odds-api"`.

**Step 4 — Score the live board**
`scoreOddsBoard(liveRows, market, { kickoffTime, quotaDegraded: liveQuotaDegraded, sourceMode: "live" })`
Returns: `{ tier, score, freshnessMinutes, acceptableFreshnessMinutes, refreshedRecently, coverageStatus, completenessScore, ... }`.

**Step 5 — Fetch and score the cached fallback board**
`readOddsMarketBoard(matchId, market, "trusted_cache")` → flatten rows → `scoreOddsBoard(cachedRows, ..., { quotaDegraded: false, sourceMode: "trusted_cache" })`.
**The cache is always scored with `quotaDegraded: false`.**

**Step 6 — Fallback decision** (lines 437–443)

```
useFallback = cachedQuality
  && cachedQuality.tier IN ["strong", "usable"]
  && (
       !liveRows.length                           // no live data at all
    || liveQuality.tier IN ["weak", "unusable"]  // live tier bad
    || liveQuality.score < cachedQuality.score   // ← pure score race
  )
```

**Step 7 — Return chosen board**
Live board OR cache board, with `fallbackUsed: true/false`.

### After board selection, back in `buildMarketAssessment()`

**Step 8 — Map bookmaker rows to option prices**
For `totals25`: `home_price` → Over 2.5, `away_price` → Under 2.5.
Edges calculated as `(modelProbability × bookmakerOdds − 1) × 100`.

**Step 9 — `bestOption` selected**
For `totals25`/`btts`: sorted purely by edge (highest wins).
`bookmakerOdds` uses `marketStats.bestOdds` — best price across **all** bookmakers on the board.

**Step 10 — `buildPriceQualityPackage()` classifies the board**
- Reads `board.quality` directly via `board?.quality ?? scoreOddsBoard(...)`.
- Extracts: `refreshedRecently`, `coverageStatus`, `tier`, `completenessScore`.
- Sets `forceNoBet = true` for: missing price data, stale odds (within 24 h), depth < 2 books, weak/unusable tier.
- Sets `downgradeLevels = 1` for: quota-degraded OR `fallbackUsed`.

**Step 11 — Three sequential gates applied**
1. `oneXTwoGuardrail()` — 1X2 only
2. `applyTrustGuardrail()` — trust score thresholds
3. `applyPriceQualityGuardrail()` — board quality blocks / downgrades

**Step 12 — Final action determined** (line 1840)
`action = oneXTwoGate → trustGate → priceGate → baseAction`

---

## 2. Where a GOOD board could be rejected

### 2a. Score race at fallback decision (`resolveBoardSelection` line 442)

A live board with tier "usable" is discarded if `liveQuality.score < cachedQuality.score`.
The live board is scored with `quotaDegraded: liveQuotaDegraded` (penalized when quota is hit).
The cache is scored with `quotaDegraded: false` (never penalized).
During any quota-degradation event, the cache always wins this comparison — regardless of cache age.

### 2b. Missing `oddsBoardService.js` makes freshness logic unverifiable

`refreshedRecently` comes from `scoreOddsBoard` in the missing module.
If that function miscalculates the freshness threshold, a fresh board could be wrongly classified as stale → `unusable` → `forceNoBet = true`.

### 2c. `blockReasons` and `forceNoBet` are inconsistent for 2-bookmaker boards

`coverageStatusForBookmakers(2)` returns `"partial"`.
Line 245: `if (bookmakerDepthMissing || coverageStatus !== "complete")` pushes `"missing-bookmaker-depth"` to `blockReasons`.
But `forceNoBet` at line 270 only checks `bookmakerDepthMissing` (count < 2), not `coverageStatus`.
A 2-book board gets a block reason logged but is NOT hard-rejected.
Conversely, if `scoreOddsBoard` returns an unexpected `coverageStatus` on a 3-book board, that board also picks up the block reason without being rejected — misleading diagnostic output.

---

## 3. Where a BAD or stale board could still be used

### 3a. `hoursToKickoff = null` disables all staleness protection

Line 229: `staleOdds && (hoursToKickoff ?? 999) <= 24`
Line 266: same guard gates `forceNoBet`.
When `features.context.hoursToKickoff` is null/undefined, the condition evaluates to `999 <= 24 = false`.
Stale odds never trigger a hard block. Any board — no matter how old — passes all guards silently.

### 3b. Stale odds pass freely outside the 24-hour window

With a valid `hoursToKickoff > 24`, stale odds are pushed to `blockReasons` only — no `forceNoBet`.
A match 25+ hours out can use odds that are many hours old and still receive a recommendation.

### 3c. Trusted cache bypasses the quota-degraded penalty

`resolveBoardSelection` always scores cached rows with `quotaDegraded: false`.
If the cache was originally built during a quota-degraded provider run, that provenance is invisible.
`board.quality.tier` for the cache reflects quality at collection time, not trustworthiness of the underlying feed.

### 3d. Pre-computed `board.quality` is trusted without re-verification

`buildPriceQualityPackage` does: `board?.quality ?? scoreOddsBoard(...)`.
When using a fallback board, `board.quality` was set by `resolveBoardSelection` against current kickoff time — but if `scoreOddsBoard` gives "usable" or "strong" to `sourceMode: "trusted_cache"` rows regardless of actual `retrieved_at` age, the tier classification does not protect against stale cache data.

### 3e. `priceTrustworthy = false` does not gate any action

```js
priceTrustworthy = ["strong","usable"].includes(tier)
  && refreshedRecently
  && hasMarketProbability
  && !bookmakerDepthMissing
  && dataCompletenessScore >= 0.9
```

`dataCompletenessScore < 0.9` sets `priceTrustworthy = false` but this flag has no `forceNoBet` path.
A board with 30% of bookmakers missing one leg's price can still produce a recommendation.

### 3f. Consensus is built from fewer bookmakers than board count implies

`buildConsensusProbabilities()` silently skips rows where any option's implied probability is `<= 0` or non-finite (line 688).
A board counted as having 5 bookmakers for depth purposes may produce consensus from only 2.
The depth check (`bookmakerCount = rows.length`) counts all rows, not just fully-priced ones.

---

## 4. Three most likely root causes of "ugly picks"

### Root Cause 1 — Stale cache wins the score race during quota degradation

**Location:** `resolveBoardSelection` lines 420–443

When the odds-api quota is degraded:
- Live board scored with `quotaDegraded: true` → composite score penalized
- Cache always scored with `quotaDegraded: false` → composite score unpenalized
- Third fallback condition `liveQuality.score < cachedQuality.score` triggers
- System silently uses cache rows that could be 12–48 hours old
- Cache enters `buildPriceQualityPackage` with `fallbackUsed: true` → only `downgradeLevels = 1` (not `forceNoBet`)
- A "Playable Edge" or "Small Edge" recommendation is still issued on ancient odds

This is the most direct path to ugly picks: adverse market conditions force fallback to a stale cache, but the recommendation is not blocked — only downgraded by one action level.

### Root Cause 2 — `hoursToKickoff = null` silently disables staleness protection

**Location:** `buildPriceQualityPackage` lines 229, 266

If the feature pipeline fails to populate `features.context.hoursToKickoff`:
- `(hoursToKickoff ?? 999) <= 24` is always `false`
- `staleOdds` never forces `forceNoBet`
- `staleOdds` never even appears in `blockReasons`
- Recommendation proceeds on arbitrarily old odds with no diagnostic trace

This is a silent failure: an absent field causes the check to silently pass, and the system issues bets on prices that may be from a prior day's market with no warning in the output.

### Root Cause 3 — `scoreOddsBoard` tier classification is opaque and missing from the repo

**Location:** `../data/oddsBoardService.js` (import at line 6, file does not exist)

The entire quality tier system (`strong / usable / weak / unusable`) is delegated to a function that is:
- Absent from the repository — its logic cannot be reviewed or verified
- Called with asymmetric flags for live vs. cache (`sourceMode: "live"` vs. `"trusted_cache"`, `quotaDegraded: true/false`)
- The single source of truth for all major guard decisions: fallback selection, `forceNoBet`, downgrade levels

If `scoreOddsBoard` assigns "usable" or "strong" to boards with thin coverage, old timestamps, or applies lenient rules for `sourceMode: "trusted_cache"`, every downstream guard is compromised. The tier is consumed without secondary verification — a lenient implementation makes all other guards decorative.

---

## Critical lines for follow-up

| Location | Lines | Issue |
|---|---|---|
| `resolveBoardSelection` | 437–443 | Fallback score race; asymmetric quota penalty |
| `buildPriceQualityPackage` | 229, 266 | `hoursToKickoff = null` bypasses all stale guards |
| `buildPriceQualityPackage` | 245 | `blockReasons` pushed but `forceNoBet` not set for partial coverage |
| `buildPriceQualityPackage` | 250–254 | `priceTrustworthy = false` has no action gate |
| `buildConsensusProbabilities` | 688 | Silent row exclusion inflates effective bookmaker count |
| `oddsBoardService.js` | — | Missing — tier logic entirely opaque |
