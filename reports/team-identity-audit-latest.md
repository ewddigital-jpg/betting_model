# Team Identity Audit

Generated at: 2026-03-19T11:12:04.118Z

## Matching Logic

- odds ingestion and event matching: `src/modules/data/syncService.js` -> teamNameSimilarity, matchOddsEvent, pickOutcomePrice, mapBookmakerMarketRows
- historical enrichment and team normalization: `src/modules/data/historicalCrawlerService.js` -> resolveTeamCandidates, resolveMatch, scoreCandidate, repairKnownIdentityIssues
- shared source-side normalization: `src/modules/data/publicSources/historicalCrawlShared.js` -> normalizeName, namesShareCoreTokens
- availability import team assignment: `src/modules/data/importers/availabilityImporter.js` -> teamIdForName
- news import team assignment: `src/modules/data/importers/newsImporter.js` -> teamIdForName
- advanced stats import matching: `src/modules/data/importers/xgImporter.js` -> resolveMatch, resolveTeamId
- historical odds import matching: `src/modules/data/importers/historicalOddsImporter.js` -> resolveMatch, normalizeOutcomeKey
- shared safe team-side resolution: `src/modules/data/teamIdentity.js` -> resolveMatchTeamSide, resolveMatchTeamId

## Severity Summary

- HIGH: TLA collisions make abbreviation-based matching unsafe (5)
  FCB: FC Bayern München | FC Barcelona | FC Bayern München; ATA: Atalanta BC | Atalanta; BRE: Stade Brestois 29 | Brentford; PSG: Paris Saint Germain | Paris Saint-Germain FC; VIL: Villarreal CF | Villarreal

## Repair Result

- Brentford/Brest repair applied: no
- Matches repaired: 0
- Advanced-stat rows repaired: 0

## Post-Repair Validation

- Advanced stats on non-match teams: 0
- Domestic competition leaks remaining: 0

## Example Mismatches


## Remaining Risks

- Historical enrichment previously allowed exact TLA matching, which is unsafe for collisions like BRE and FCB. This audit removed TLA from exact historical team matching.
- Odds rows do not preserve source-side team labels, so odds-side identity validation is limited to event linkage and not raw source labels.
- Provider-specific source IDs are still stored in a single teams.source_team_id column, which limits multi-provider identity provenance.
