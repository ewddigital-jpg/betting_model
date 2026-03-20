# Live Over/Under 2.5 Integrity Audit

Date: 2026-03-19

## Scope

This audit covers the live recommendation path only:

1. raw odds ingestion
2. market normalization
3. `Over / Under 2.5` side mapping
4. probability binding
5. edge calculation
6. final recommendation semantics

Historical replay was intentionally ignored in this loop.

## Functions traced

Raw odds ingestion and normalization:

- [syncService.js](C:/Users/danie/OneDrive%20-%20SekII%20Z%C3%BCrich/Dokumente/Playground/src/modules/data/syncService.js)
  - `buildMarketLookup`
  - `extractTotalsMarket`
  - `parseGoalLineValue`
  - `extractGoalLineFromOutcome`
  - `isTotalsOutcome`
  - `mapBookmakerMarketRows`

Licensed feed normalization:

- [compliantOddsSourceService.js](C:/Users/danie/OneDrive%20-%20SekII%20Z%C3%BCrich/Dokumente/Playground/src/modules/data/compliantOddsSourceService.js)
  - `normalizeCsvMarket`
  - `normalizeCsvSelection`

Live betting semantics:

- [bettingEngine.js](C:/Users/danie/OneDrive%20-%20SekII%20Z%C3%BCrich/Dokumente/Playground/src/modules/analysis/bettingEngine.js)
  - `buildOptionDefinitions`
  - `buildBookmakerRows`
  - `summarizeOptionMarket`
  - `buildConsensusProbabilities`
  - `edgePercent`

Settlement reference check:

- [collectorService.js](C:/Users/danie/OneDrive%20-%20SekII%20Z%C3%BCrich/Dokumente/Playground/src/modules/data/collectorService.js)
  - `actualOutcomeLabel`

## What the code currently does

Live O/U mapping is label-driven, not order-driven.

In ingestion:

- `Over` is identified by `isTotalsOutcome(outcome, "over", 2.5)`
- `Under` is identified by `isTotalsOutcome(outcome, "under", 2.5)`
- `mapBookmakerMarketRows` stores:
  - `homePrice = over.price`
  - `awayPrice = under.price`

In the betting engine:

- `buildOptionDefinitions("totals25", ...)` creates:
  - `over -> priceField = "home_price"`
  - `under -> priceField = "away_price"`
- `buildBookmakerRows` then reads the selected side's price from that exact field.

That means the live path is internally consistent if ingestion is correct.

## Proof points

### 1. Over and Under are not taken from bookmaker array position

The mapper uses `find(...)` by normalized label and line, not `outcomes[0]` / `outcomes[1]`.

That means these payloads both map correctly:

- `Over` before `Under`
- `Under` before `Over`

### 2. Line parsing accepts the expected 2.5 variants

`parseGoalLineValue` and `extractGoalLineFromOutcome` correctly accept:

- `2.5`
- `2,5`
- `2.50`

and reject a different embedded line like `3.5` when matching `2.5`.

### 3. Edge is computed on the selected side's actual odds

For totals:

- `Over 2.5` edge uses the stored `home_price`
- `Under 2.5` edge uses the stored `away_price`

There is no evidence in the current live path that `Under` can accidentally use `Over` odds or vice versa.

## Tests added

Added in [model.test.js](C:/Users/danie/OneDrive%20-%20SekII%20Z%C3%BCrich/Dokumente/Playground/tests/model.test.js):

- `live totals mapping does not depend on bookmaker outcome order`
- `live totals mapping accepts mixed labels and line formatting variants`
- `live totals recommendation semantics keep over and under tied to their own prices`

These tests cover:

- `Over` listed before `Under`
- `Under` listed before `Over`
- `Over 2.5` / `Under 2,5` / `Over 2.50`
- rejection of `Over 3.5` when matching `2.5`
- side-specific edge binding

## Verdict

No live-path `Over / Under 2.5` flip was proven in this audit.

The current code path appears semantically correct for:

- raw totals outcome recognition
- `2.5` line parsing
- side mapping
- side-specific odds binding
- side-specific edge calculation

## What remains unproven

This audit does not prove the recommendations are good. It only proves this narrower point:

- the current live O/U path does not show evidence of a direct `Over`/`Under` inversion

Ugly live recommendations are still more plausibly explained by:

- stale boards
- weak boards
- quota-degraded boards
- old persisted snapshots
- model behavior

but not by a proven live O/U side flip in the current code.
