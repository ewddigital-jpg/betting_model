# Quant Review

- Generated at: 2026-03-18T10:39:56.980Z
- Requested sample: 1000
- Evaluated matches: 1000
- Test window: 2025-11-22T12:30:00Z to 2026-03-16T20:00:00Z

## Overall Summary
- Total modeled matches: 1000
- Total market opportunities: 3000
- Total bets: 0
- No-bet frequency: 100%
- Average edge: n/a%
- Average ROI: n/a%
- Net units: n/a
- Finished matches with pre-kickoff odds: 0/1869 (0%)

## Warnings
- Historical price archive missing - betting performance cannot be validated.
- Odds snapshots exist only for upcoming scheduled matches, not for finished matches.
- The current odds collector is archiving live/upcoming boards only, so historical match prices were never stored before those matches finished.
- All stored snapshots belong to matches that are still scheduled, which means the archive started too late for historical validation.
- The current historical replay generated zero bets, so ROI and CLV conclusions are not yet available.

## Final Diagnosis
- This review used 1000 historical matches and 3000 market opportunities.
- The model barely bet at all, which means the betting layer is still too thin to validate seriously.
- No market stood out positively.
- No market had enough bets to rank.
- The current model reads more like noise plus bookmaker anchoring than a robust betting edge.

## Top 5 Improvements
1. Archive much deeper historical odds so the betting layer is not judged on thin price coverage.
2. Import real xG data into team_match_advanced_stats so the new xG hooks stop running on neutral fallbacks.
3. Improve lineup quality near kickoff and keep penalizing uncertain lineups hard.
4. Retune the 1X2 decision policy separately from totals and BTTS, because those markets behave differently.
5. Build a larger forward tracked sample and grade it; historical replay alone is not enough proof.

