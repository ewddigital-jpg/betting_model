# Engineering Correctness Loop Report

Generated at: 2026-03-19

## 1. What I inspected

- Historical board selection in [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\src\modules\analysis\bettingEngine.js](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\src\modules\analysis\bettingEngine.js)
- Odds-board scoring and trusted-cache behavior in [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\src\modules\data\oddsBoardService.js](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\src\modules\data\oddsBoardService.js)
- Odds snapshot filtering in [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\src\modules\data\syncService.js](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\src\modules\data\syncService.js)
- Existing semantic tests in [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\tests\model.test.js](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\tests\model.test.js)

I focused on correctness only:
- market mapping
- board selection
- time filtering
- settlement
- historical replay semantics

I did not tune thresholds, add features, or change model math in this loop.

## 2. Most likely root cause

The highest-confidence correctness flaw was historical price leakage through the trusted-cache fallback path.

In plain terms:
- live snapshot rows respected `beforeDate`
- trusted cached board rows did not
- so a historical replay could use a board created after the replay cutoff

That is a real betting-semantics bug because it contaminates backtests with future information.

## 3. Evidence

The relevant code path before the fix was in [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\src\modules\analysis\bettingEngine.js](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\src\modules\analysis\bettingEngine.js):

- `latestSnapshotGroups(matchId, marketKey, beforeDate)` filtered `odds_snapshots` by `retrieved_at <= beforeDate`
- `resolveBoardSelection(...)` then loaded `trusted_cache` with `readOddsMarketBoard(...)`
- `cachedBoard?.rows` were used directly
- no equivalent time filter was applied to cached rows

That means the replay path was asymmetric:
- live path: time-filtered
- trusted cache path: not time-filtered

I added a deterministic regression test proving the issue:
- create a synthetic match
- create a `trusted_cache` board whose row timestamp is newer than `beforeDate`
- call `resolveBoardSelection(...)` with that earlier `beforeDate`
- assert the cached board is ignored

That test now passes. On the old logic, it would have failed.

## 4. What I changed

Changed files:
- [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\src\modules\analysis\bettingEngine.js](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\src\modules\analysis\bettingEngine.js)
- [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\tests\model.test.js](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\tests\model.test.js)

Fix:
- added `filterRowsBeforeDate(rows, beforeDate)`
- applied it to `cachedBoard?.rows` inside `resolveBoardSelection(...)`

Result:
- trusted-cache fallback now respects historical replay cutoffs
- future cached boards cannot silently leak into a historical betting decision

## 5. Tests added

Added in [C:\Users\danie\OneDrive - SekII Zürich\Dokumente\Playground\tests\model.test.js](C:\Users\danie\OneDrive%20-%20SekII%20Z%C3%BCrich\Dokumente\Playground\tests\model.test.js):

- `historical board selection ignores trusted-cache rows newer than beforeDate`

Verification:
- `npm.cmd run test`
- result: `24/24` passing

The new test sits alongside the existing semantic checks for:
- O/U mapping
- BTTS mapping
- implied probability conversion
- settlement logic
- stale-board no-bet behavior
- forward eligibility
- team identity safety

## 6. What still looks suspicious

These are still suspicious, but not proven enough in this loop to justify another fix:

1. Historical replay still uses the current structural pipeline, not a frozen historical state for every non-odds input.
- Example risk: some derived state may still be better aligned with current DB state than with the exact historical moment.
- I do not have proof of another leak at the same confidence level as the cache bug.

2. `odds_market_boards` is often empty or stale in practice.
- That is an operational weakness, not automatically a logic bug.
- It can still distort what the app surfaces, but the primary issue there looks like input scarcity, not incorrect code.

3. Legacy forward rows remain in history.
- Some older `recommendation_snapshots` were created before the latest price-quality instrumentation.
- They can muddy report interpretation.
- That is a reporting hygiene issue, not necessarily a semantics bug.

4. Backtest trust is still constrained by odds coverage.
- Even with the logic fix, historical betting validation is still thin because finished-match pre-kickoff odds are sparse.
- That means correctness is stronger now, but business trust is still limited.

## 7. What should be done next

1. Audit the rest of the historical replay path for time leakage beyond odds boards.
- Target:
  - any feature using current-state tables instead of `asOfTime`
  - any cached derived artifact reused across dates

2. Build one small golden validation dataset.
- Purpose:
  - lock event identity, market mapping, settlement, and board selection into deterministic fixtures
  - catch future semantic regressions earlier

3. Separate legacy forward rows from current-instrumented rows in reporting.
- Otherwise the validation reports can still look cleaner or dirtier than the current system really is.

4. Only after that, revisit calibration or price-quality interpretation.
- Not before.
- Correctness has to stay ahead of optimization.

## 8. Confidence level for each conclusion

- Historical trusted-cache replay leakage was a real bug: **High**
- The implemented fix addresses that exact bug: **High**
- The new regression test would have failed before the fix: **High**
- Historical replay is now fully leakage-free: **Low**
- Current remaining problems are mainly operational/data-quality, not core semantics: **Medium**
- Another high-confidence correctness bug remains right now: **Low**

## Bottom line

One real semantics bug was present and is now fixed.

The repository is safer than before because historical backtests can no longer reuse future trusted-cache boards through that path.

What I cannot honestly claim:
- that the whole replay system is now perfect
- that betting validation is now trustworthy end to end
- that the remaining weaknesses are all data problems

The strongest proven conclusion is narrower:
- one concrete future-information leak existed
- it is now covered by code and by test
