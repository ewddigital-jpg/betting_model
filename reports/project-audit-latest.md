# Project Audit

Generated: 2026-03-16T18:11:12.075Z

## Scoreboard
- Trust readiness: 40% / 80% target
- Blind lean accuracy: 51%
- Blind log loss: 1.002
- Settled forward bets: 0
- Historical odds coverage: 0/120
- Historical lineup coverage: 16/456

## Findings
- [P1] System credibility is still low: Trust readiness is 40% against an 80% target. The app is still in evidence-building mode, not proven mode.
  Action: Improve proof before adding more aggression: keep archiving odds, keep grading forward bets, and stay conservative on markets without late team-news clarity.
- [P1] Latest collector run is not fully clean: The latest collector status is running. Partial or failed syncs can poison confidence and stale the pre-match view.
  Action: Inspect the latest sync errors first and stabilize data freshness before changing the model logic.
- [P1] Historical odds coverage is still too thin: Only 0 of the last 120 finished matches have archived bookmaker prices.
  Action: Improve odds matching and pre-kickoff snapshot depth. Without historical prices, the betting layer cannot be trained honestly.
- [P1] Probability calibration is still loose: Average Brier score across supported markets is about 0.2436. The probabilities still read less sharply than they should.
  Action: Calibrate output probabilities and reduce confidence inflation in unstable bands.
- [P2] Historical lineup archive is incomplete: Only 16 of the last 456 finished matches have stored confirmed lineups.
  Action: Keep backfilling finished fixtures and improve source coverage for missing lineup rows.
- [P2] Forward graded bet sample is still small: Only 0 settled forward bets are graded in the live dashboard.
  Action: Keep collecting and grading. Do not overreact to short-term ROI noise yet.
- [P2] Separate decision policies are not promoted yet: The market-specific decision layer still has not earned promotion, which means 1X2, totals, and BTTS are still relying on conservative defaults.
  Action: Increase priced historical evidence and refine the policy trainer before trying to promote a market layer.

## Recommended Tasks
- [P1] System credibility is still low: Improve proof before adding more aggression: keep archiving odds, keep grading forward bets, and stay conservative on markets without late team-news clarity.
  Prompt: Review the trust-readiness blockers and tighten whichever factor is hurting the score most right now without making the model more reckless.
- [P1] Latest collector run is not fully clean: Inspect the latest sync errors first and stabilize data freshness before changing the model logic.
  Prompt: Inspect the latest collector summary, identify the failing provider or rate-limit issue, and make the data pipeline more robust without reducing coverage.
- [P1] Historical odds coverage is still too thin: Improve odds matching and pre-kickoff snapshot depth. Without historical prices, the betting layer cannot be trained honestly.
  Prompt: Audit why finished matches are missing odds snapshots and improve the odds-matching or snapshot strategy so more historical bets become trainable.
- [P1] Probability calibration is still loose: Calibrate output probabilities and reduce confidence inflation in unstable bands.
  Prompt: Audit the blind calibration buckets and tighten the most overconfident probability bands without flattening the entire model.
- [P2] Historical lineup archive is incomplete: Keep backfilling finished fixtures and improve source coverage for missing lineup rows.
  Prompt: Audit which finished competitions or teams still lack archived lineups and improve the historical lineup backfill coverage.