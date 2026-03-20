# Architecture Notes

## Request flow

1. Browser loads the shell from `src/routes/pageRouter.js`
2. Frontend requests `/api/matches`
3. The API builds match list view models from SQLite
4. Each match analysis is generated through:
   - Elo refresh
   - feature build
   - probability model
   - betting comparison
   - explanation builder
5. The browser renders odds, fair prices, edges, factor bars, and written analysis

## Storage model

- `competitions`: supported tournaments and sync timestamps
- `teams`: normalized team records from football-data
- `matches`: fixtures and results
- `standings_rows`: latest standings snapshot per sync
- `team_ratings`: current Elo table
- `odds_snapshots`: bookmaker h2h prices over time
- `analysis_reports`: last generated view for each match

## Why the modules are split this way

- Collection logic changes for API integrations
- Feature logic changes for model improvements
- Prediction logic changes for math and calibration
- Reporting logic changes for UI and narrative output

That separation makes v2 upgrades easier without turning the app into an overengineered system.
