# UCL / UEL Betting Analysis App

A lightweight web app that collects UEFA Champions League and UEFA Europa League fixture data, stores it in SQLite, builds Elo-driven match probabilities, compares them to bookmaker odds, and explains the betting view in plain language.

The current version is also optimized for a strong free-data workflow: the UI remains UCL/UEL-focused, while the sync layer can pull extra domestic-league history in the background so Elo and feature engineering are not limited to a tiny European-only sample.

The project is intentionally practical:

- zero external runtime dependencies beyond Node.js 24+
- local SQLite database
- modular services for collection, modeling, betting logic, and reporting
- simple browser UI with clickable upcoming matches
- basic backtesting pipeline with clear limitations

## Recommended stack

- Backend: Node.js 24 native `http`, `fetch`, and `node:sqlite`
- Database: SQLite
- Frontend: server-served HTML, CSS, and vanilla JavaScript
- Data APIs:
  - [football-data.org](https://www.football-data.org/documentation/quickstart) for competitions, fixtures, results, standings, and teams
  - [The Odds API](https://the-odds-api.com/liveapi/guides/v4/) for bookmaker odds

Why this stack:

- It is fast to build and easy to maintain.
- It runs on the current machine without needing a framework toolchain.
- The architecture still leaves room to split modules further in v2.

## Architecture

The app uses four clear modules:

1. Data Collection Agent
   - `src/modules/data/footballDataClient.js`
   - `src/modules/data/oddsApiClient.js`
   - `src/modules/data/syncService.js`
   - `src/modules/data/importers/availabilityImporter.js`
   - `src/modules/data/publicSources/*`
   - Fetches UCL/UEL matches, standings, teams, and current odds and stores them locally.

2. Feature / Analysis Agent
   - `src/modules/analysis/featureBuilder.js`
   - Builds recent-form, home/away split, goals-trend, rest, and opponent-strength features.

3. Prediction Agent
   - `src/modules/analysis/eloEngine.js`
   - `src/modules/analysis/probabilityModel.js`
   - Maintains Elo ratings and converts model inputs into expected goals and 1X2 probabilities.

4. Report / UI Agent
   - `src/modules/analysis/bettingEngine.js`
   - `src/modules/reporting/explanationBuilder.js`
   - `src/modules/reporting/viewModels.js`
   - `src/routes/*`
   - Creates fair odds, edge calculations, written analysis, and the web UI responses.

More detail is in [docs/architecture.md](/Users/danie/OneDrive%20-%20SekII%20Z%C3%BCrich/Dokumente/Playground/docs/architecture.md).

## Project structure

```text
.
|-- .env.example
|-- package.json
|-- README.md
|-- docs/
|   `-- architecture.md
|-- public/
|   |-- app.js
|   `-- style.css
|-- scripts/
|   |-- backtest.js
|   |-- import-availability.js
|   `-- sync-data.js
|-- src/
|   |-- config/
|   |   |-- env.js
|   |   `-- leagues.js
|   |-- db/
|   |   |-- database.js
|   |   `-- schema.js
|   |-- lib/
|   |   |-- http.js
|   |   |-- logger.js
|   |   |-- math.js
|   |   `-- time.js
|   |-- modules/
|   |   |-- analysis/
|   |   |   |-- analysisService.js
|   |   |   |-- availabilityFeatures.js
|   |   |   |-- backtestService.js
|   |   |   |-- bettingEngine.js
|   |   |   |-- eloEngine.js
|   |   |   |-- featureBuilder.js
|   |   |   `-- probabilityModel.js
|   |   |-- data/
|   |   |   |-- footballDataClient.js
|   |   |   |-- importers/
|   |   |   |-- oddsApiClient.js
|   |   |   |-- publicSources/
|   |   |   `-- syncService.js
|   |   `-- reporting/
|   |       |-- explanationBuilder.js
|   |       `-- viewModels.js
|   |-- routes/
|   |   |-- apiRouter.js
|   |   `-- pageRouter.js
|   `-- server.js
`-- tests/
    `-- model.test.js
```

## Setup

1. Copy `.env.example` to `.env`.
2. Add your API keys:
   - `FOOTBALL_DATA_API_KEY`
   - `ODDS_API_KEY`
3. Start the app:

```bash
npm.cmd start
```

4. Open [http://localhost:3000](http://localhost:3000)
5. Click `Sync Data` in the UI, or run:

```bash
npm.cmd run sync
```

To run the full collector bot manually:

```bash
npm.cmd run collect
```

To import public availability data only:

```bash
npm.cmd run availability:import
```

To import local advanced stats / xG style data:

```bash
npm.cmd run xg:import
```

The importer reads `.csv` or `.json` files from `data/advanced-stats` by default. A ready-to-copy template lives at [data/advanced-stats.example.csv](/Users/danie/OneDrive%20-%20SekII%20Z%C3%BCrich/Dokumente/Playground/data/advanced-stats.example.csv).

To check for upcoming bet reminders inside the next two hours:

```bash
npm.cmd run reminders
```

If SMTP is configured, that reminder command also sends one email per new playable reminder and avoids duplicate sends for the same match, market, and selection.

To seed public text sources manually, copy `data/public-source-seeds.example.json` to `data/public-source-seeds.json` and add the relevant UEFA preview, lineup, or official club team-news URLs.

## Environment variables

See [.env.example](/Users/danie/OneDrive%20-%20SekII%20Z%C3%BCrich/Dokumente/Playground/.env.example).

- `PORT`: local web server port
- `DB_PATH`: SQLite database file
- `FOOTBALL_DATA_API_KEY`: football-data.org API token
- `FOOTBALL_DATA_BASE_URL`: football-data base URL
- `ODDS_API_KEY`: The Odds API token
- `ODDS_BASE_URL`: odds API base URL
- `ODDS_REGIONS`: bookmaker regions
- `PRIMARY_BOOKMAKER`: default bookmaker highlighted in the app
- `HISTORY_COMPETITION_CODES`: extra domestic competitions to sync for team-history enrichment without showing them in the app UI
- `PUBLIC_SOURCE_SEEDS_PATH`: JSON file with seeded UEFA or official-club text sources for injuries, suspensions, and expected lineups
- `ADVANCED_STATS_IMPORT_PATH`: folder containing local CSV or JSON advanced-stat files for xG, xGA, shots, and possession imports
- `EMAIL_PROVIDER`: reserved for reminder delivery integration
- `EMAIL_FROM`: sender address for reminder emails
- `EMAIL_TO`: reminder destination address
- `SMTP_HOST`: SMTP server host
- `SMTP_PORT`: SMTP server port
- `SMTP_SECURE`: whether SMTP uses implicit TLS
- `SMTP_USER`: SMTP username
- `SMTP_PASSWORD`: SMTP password or app password
- `SYNC_ON_START`: auto-sync when the server boots
- `AUTO_SYNC_STALE_MINUTES`: reserved for v2 stale-sync rules
- `AUTO_SYNC_LOOKAHEAD_HOURS`: reserved for v2 sync horizon rules

## How the prediction logic works

### 1. Elo rating

Each team starts with a base Elo.

- Finished matches update Elo sequentially
- Home advantage is added to the home team
- Knockout stages get a slightly higher weight
- Bigger goal margins increase rating movement modestly

### 2. Feature set

For each upcoming match, the model measures:

- current Elo difference
- recent form in points per game
- weighted goals scored and conceded
- home-only and away-only scoring/conceding splits
- average opponent Elo in recent matches
- rest-day difference
- competition-wide scoring baseline

### 3. Probability generation

The model converts those factors into expected goals for both teams.

Those expected goals are then translated into:

- home win probability
- draw probability
- away win probability

using a Poisson scoreline matrix.

### Free-data mode

To get the strongest possible model on a free budget:

- keep the UI focused on `CL` and `EL`
- sync extra domestic competitions for history using `HISTORY_COMPETITION_CODES`
- let the model shrink toward its Elo baseline when recent data coverage is weak

Default history competitions:

- `PL`
- `PD`
- `BL1`
- `SA`
- `FL1`

Collector behavior in free-data mode:

- runs the free-mode sync across app competitions plus configured domestic history competitions
- refreshes analysis for upcoming UCL/UEL matches
- stores a run log in SQLite
- exposes collector status through the UI and `/api/collector/status`

### 4. Why this is practical

- easy to explain
- numerically grounded
- strong enough for a first production version
- simple to extend with xG, injuries, lineups, and player-level features later

## How the betting logic works

For each match:

1. Pull the latest stored bookmaker odds
2. Convert model probabilities into fair odds using `1 / probability`
3. Compute expected-value edge with:

```text
edge % = (model_probability * bookmaker_odds - 1) * 100
```

4. Rank home/draw/away by edge
5. Return:
   - bookmaker odds
   - model probabilities
   - fair odds
   - edge %
   - value-bet assessment
   - confidence level
   - written explanation

The app never labels any bet as "safe". It always mentions uncertainty.

## Backtesting

Run:

```bash
npm.cmd run backtest
```

or:

```bash
node scripts/backtest.js CL
```

What it does:

- walks through completed matches in chronological order
- rebuilds ratings from earlier matches only
- reruns the model
- checks where the model would have flagged a value edge
- reports calibration and ROI where historical odds snapshots exist locally

Important limitation:

- if you did not store odds before kickoff, ROI is incomplete
- this means the calibration numbers are more reliable than the profit numbers

## Known limitations

- current version focuses on 1X2 market only
- no xG feed yet
- lineup, suspension, and injury context currently depends on API-Football plus seeded public text sources
- public-source availability data is only as good as the seeded URLs and API coverage
- no player-level adjustments yet
- cross-competition strength is inferred only through recent opponent quality inside stored data
- odds-event matching relies on team-name normalization and kickoff proximity
- live odds depend on API availability and your subscription tier

## Version 2 ideas

- add xG and shot-quality feeds
- add injuries, suspensions, and projected lineups
- include domestic-league matches for stronger cross-team Elo priors
- store time-series odds snapshots for better backtesting
- support totals and both-teams-to-score markets
- add scheduler-based background sync
- add model calibration plots and CLV tracking
- add bookmaker filters and staking suggestions with bankroll rules

## Disclaimer

This project is an analysis system, not a profit guarantee. Betting markets are noisy, limits vary, and odds can move quickly after news or lineup releases.
