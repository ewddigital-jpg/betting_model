# Forensic Audit: 20 Most Unrealistic Recommendations

Generated at: 2026-03-19T11:29:04.588Z

## Headline

The dominant failure is stale or weak price data being allowed to drive totals recommendations. The Barcelona-style under picks were mostly price-quality failures, not a raw Over/Under mapping inversion.

## Root Causes

- stale odds / bad board: 18
- post-kickoff collector bug: 2

## Before vs Now

- Original suspicious recommendations reviewed: 20
- Original actionable recommendations among these 20: 20
- Stored after kickoff: 2
- Current replay now blocked as No Bet: 20
- Current replay still actionable: 0

## Top 20 Cases

| Snapshot | Match | Original | Replay | Cause | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1679 | FC Bayern München vs Atalanta | Under 2.5 (Playable) | FC Bayern München (No Bet) | post-kickoff collector bug | stored 1.35h after kickoff |
| 1678 | FC Barcelona vs Newcastle United FC | Under 2.5 (Playable) | FC Barcelona (No Bet) | post-kickoff collector bug | stored 3.6h after kickoff |
| 1667 | FC Bayern München vs Atalanta | Under 2.5 (Playable) | FC Bayern München (No Bet) | stale odds / bad board | price age 28.06h; replay board unusable |
| 1666 | FC Barcelona vs Newcastle United FC | Under 2.5 (Playable) | FC Barcelona (No Bet) | stale odds / bad board | price age 28.05h; replay board unusable |
| 1655 | FC Bayern München vs Atalanta | Under 2.5 (Playable) | FC Bayern München (No Bet) | stale odds / bad board | price age 28.05h; replay board unusable |
| 1654 | FC Barcelona vs Newcastle United FC | Under 2.5 (Playable) | FC Barcelona (No Bet) | stale odds / bad board | price age 28.04h; replay board unusable |
| 1643 | FC Bayern München vs Atalanta | Under 2.5 (Playable) | FC Bayern München (No Bet) | stale odds / bad board | price age 27.03h; replay board unusable |
| 1642 | FC Barcelona vs Newcastle United FC | Under 2.5 (Playable) | FC Barcelona (No Bet) | stale odds / bad board | price age 27.03h; replay board unusable |
| 1631 | FC Bayern München vs Atalanta | Under 2.5 (Playable) | FC Bayern München (No Bet) | stale odds / bad board | price age 26.88h; replay board unusable |
| 1630 | FC Barcelona vs Newcastle United FC | Under 2.5 (Playable) | FC Barcelona (No Bet) | stale odds / bad board | price age 26.87h; replay board unusable |
| 1607 | FC Bayern München vs Atalanta | Under 2.5 (Playable) | FC Bayern München (No Bet) | stale odds / bad board | price age 26.7h; replay board unusable |
| 1606 | FC Barcelona vs Newcastle United FC | Under 2.5 (Playable) | FC Barcelona (No Bet) | stale odds / bad board | price age 26.69h; replay board unusable |
| 1571 | FC Bayern München vs Atalanta | Under 2.5 (Playable) | FC Bayern München (No Bet) | stale odds / bad board | price age 26.26h; replay board unusable |
| 1570 | FC Barcelona vs Newcastle United FC | Under 2.5 (Playable) | FC Barcelona (No Bet) | stale odds / bad board | price age 26.25h; replay board unusable |
| 1559 | FC Bayern München vs Atalanta | Under 2.5 (Playable) | FC Bayern München (No Bet) | stale odds / bad board | price age 26.09h; replay board unusable |
| 1558 | FC Barcelona vs Newcastle United FC | Under 2.5 (Playable) | FC Barcelona (No Bet) | stale odds / bad board | price age 26.08h; replay board unusable |
| 1547 | FC Bayern München vs Atalanta | Under 2.5 (Playable) | FC Bayern München (No Bet) | stale odds / bad board | price age 25.76h; replay board unusable |
| 1546 | FC Barcelona vs Newcastle United FC | Under 2.5 (Playable) | FC Barcelona (No Bet) | stale odds / bad board | price age 25.75h; replay board unusable |
| 1535 | FC Bayern München vs Atalanta | Under 2.5 (Playable) | FC Bayern München (No Bet) | stale odds / bad board | price age 25.43h; replay board unusable |
| 1534 | FC Barcelona vs Newcastle United FC | Under 2.5 (Playable) | FC Barcelona (No Bet) | stale odds / bad board | price age 25.42h; replay board unusable |

## Dominant Flaw

Most of the ugliest recommendations were emitted on boards that were already too old or too thin to support a real bet. Current replay blocks those same cases as No Bet.

## Remaining Risks

- Archived odds rows keep provider metadata but not raw source-side team labels, so source-team reconciliation for old price boards is still limited.
- Per-snapshot rating state is not archived, so historical replay still uses the current active rating map for the rating component.
- Historical finished-match odds coverage is still thin, so this audit is about recommendation logic, not proven historical ROI.

## Artifacts

- JSON: forensic-unrealistic-recommendations-latest.json
- This markdown: forensic-unrealistic-recommendations-latest.md
