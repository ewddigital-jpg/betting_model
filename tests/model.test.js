import test from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/db/database.js";
import { __databaseTestables } from "../src/db/database.js";
import { buildRatingsUntil } from "../src/modules/analysis/eloEngine.js";
import { calculateProbabilities } from "../src/modules/analysis/probabilityModel.js";
import { impliedProbability } from "../src/lib/math.js";
import { __bettingEngineTestables } from "../src/modules/analysis/bettingEngine.js";
import { __collectorTestables, getForwardValidationReport } from "../src/modules/data/collectorService.js";
import { __compliantOddsTestables } from "../src/modules/data/compliantOddsSourceService.js";
import { hasCompetitionLiveOddsPath } from "../src/config/leagues.js";
import { __featureBuilderTestables } from "../src/modules/analysis/featureBuilder.js";
import { __historicalOddsImporterTestables } from "../src/modules/data/importers/historicalOddsImporter.js";
import { __oddsMatchingTestables } from "../src/modules/data/syncService.js";
import { scoreOddsBoard, summarizeOddsBoardRows } from "../src/modules/data/oddsBoardService.js";
import { buildForwardValidationLogEntry } from "../src/modules/runtime/operationsLogService.js";
import { __teamIdentityTestables } from "../src/modules/data/teamIdentity.js";

function clearBoardSelectionFixtures(matchId) {
  const db = getDb();
  db.prepare("DELETE FROM analysis_reports WHERE match_id = ?").run(matchId);
  db.prepare("DELETE FROM recommendation_snapshots WHERE match_id = ?").run(matchId);
  db.prepare("DELETE FROM match_context WHERE match_id = ?").run(matchId);
  db.prepare("DELETE FROM team_match_advanced_stats WHERE match_id = ?").run(matchId);
  db.prepare("DELETE FROM odds_quote_history WHERE match_id = ?").run(matchId);
  db.prepare("DELETE FROM odds_snapshots WHERE match_id = ?").run(matchId);
  db.prepare("DELETE FROM odds_market_boards WHERE match_id = ?").run(matchId);
  db.prepare("DELETE FROM matches WHERE id = ?").run(matchId);
  db.prepare("DELETE FROM teams WHERE id IN (?, ?)").run(matchId * 10 + 1, matchId * 10 + 2);
}

function ensureBoardSelectionFixtureMatch(matchId, kickoffTime, competitionCode = "EL") {
  const db = getDb();
  const homeTeamId = matchId * 10 + 1;
  const awayTeamId = matchId * 10 + 2;
  const now = "2026-03-23T12:00:00Z";

  ensureCompetition(competitionCode);

  db.prepare(`
    INSERT INTO teams (id, source_team_id, name, short_name, tla, crest, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(homeTeamId, homeTeamId, `Test Home ${matchId}`, `Home ${matchId}`, `H${matchId}`.slice(0, 3), null, now, now);
  db.prepare(`
    INSERT INTO teams (id, source_team_id, name, short_name, tla, crest, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(awayTeamId, awayTeamId, `Test Away ${matchId}`, `Away ${matchId}`, `A${matchId}`.slice(0, 3), null, now, now);
  db.prepare(`
    INSERT INTO matches (
      id, source_match_id, competition_code, season, utc_date, status, matchday, stage, group_name,
      home_team_id, away_team_id, home_score, away_score, winner, odds_event_id, last_synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(matchId, matchId, competitionCode, 2026, kickoffTime, "SCHEDULED", null, null, null, homeTeamId, awayTeamId, null, null, null, null, now);
}

function insertLiveSnapshotRows(matchId, market, rows) {
  const db = getDb();
  const statement = db.prepare(`
    INSERT INTO odds_snapshots (
      match_id, bookmaker_key, bookmaker_title, source_provider, source_label, market,
      home_price, draw_price, away_price, is_live, retrieved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    statement.run(
      matchId,
      row.bookmaker_key,
      row.bookmaker_title ?? row.bookmaker_key,
      row.source_provider ?? "odds-api",
      row.source_label ?? null,
      market,
      row.home_price ?? null,
      row.draw_price ?? null,
      row.away_price ?? null,
      0,
      row.retrieved_at ?? null
    );
  }
}

function insertTrustedCacheBoard(matchId, market, rows, options = {}) {
  const db = getDb();
  const quality = scoreOddsBoard(rows, market, {
    kickoffTime: options.kickoffTime,
    now: options.now,
    quotaDegraded: false,
    sourceProvider: options.sourceProvider ?? "trusted-cache",
    sourceMode: "trusted_cache"
  });

  db.prepare(`
    INSERT INTO odds_market_boards (
      match_id, market, source_provider, source_mode, board_quality_tier, board_quality_score,
      bookmaker_count, freshness_minutes, completeness_score, implied_consistency_score,
      quota_degraded_flag, board_recorded_at, board_json, updated_at, source_reliability_score, source_label
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, market, source_mode) DO UPDATE SET
      source_provider = excluded.source_provider,
      board_quality_tier = excluded.board_quality_tier,
      board_quality_score = excluded.board_quality_score,
      bookmaker_count = excluded.bookmaker_count,
      freshness_minutes = excluded.freshness_minutes,
      completeness_score = excluded.completeness_score,
      implied_consistency_score = excluded.implied_consistency_score,
      quota_degraded_flag = excluded.quota_degraded_flag,
      board_recorded_at = excluded.board_recorded_at,
      board_json = excluded.board_json,
      updated_at = excluded.updated_at,
      source_reliability_score = excluded.source_reliability_score,
      source_label = excluded.source_label
  `).run(
    matchId,
    market,
    options.sourceProvider ?? "trusted-cache",
    "trusted_cache",
    quality.tier,
    quality.score,
    quality.bookmakerCount,
    quality.freshnessMinutes,
    quality.completenessScore,
    quality.impliedConsistencyScore,
    0,
    rows.map((row) => row.retrieved_at).filter(Boolean).sort().at(-1) ?? null,
    JSON.stringify(rows),
    options.now,
    quality.sourceReliabilityScore,
    options.sourceLabel ?? null
  );

  return quality;
}

function clearRecommendationFixtures(matchId) {
  const db = getDb();
  db.prepare("DELETE FROM recommendation_snapshots WHERE match_id = ?").run(matchId);
  db.prepare("DELETE FROM odds_snapshots WHERE match_id = ?").run(matchId);
  db.prepare("DELETE FROM odds_market_boards WHERE match_id = ?").run(matchId);
  db.prepare("DELETE FROM matches WHERE id = ?").run(matchId);
  db.prepare("DELETE FROM teams WHERE id IN (?, ?)").run(matchId * 10 + 1, matchId * 10 + 2);
}

function ensureCompetition(code) {
  const db = getDb();
  db.prepare(`
    INSERT INTO competitions (code, name, sport_key, last_synced_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(code) DO NOTHING
  `).run(code, `Test Competition ${code}`, `soccer_${code.toLowerCase()}`, "2026-03-23T12:00:00Z");
}

function ensureFinishedRecommendationFixture(matchId, kickoffTime, homeScore = 2, awayScore = 1, competitionCode = "CL") {
  const db = getDb();
  const homeTeamId = matchId * 10 + 1;
  const awayTeamId = matchId * 10 + 2;
  const now = "2026-03-23T12:00:00Z";

  ensureCompetition(competitionCode);

  db.prepare(`
    INSERT INTO teams (id, source_team_id, name, short_name, tla, crest, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(homeTeamId, homeTeamId, `Finished Home ${matchId}`, `FHome ${matchId}`, `FH${matchId}`.slice(0, 3), null, now, now);
  db.prepare(`
    INSERT INTO teams (id, source_team_id, name, short_name, tla, crest, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(awayTeamId, awayTeamId, `Finished Away ${matchId}`, `FAway ${matchId}`, `FA${matchId}`.slice(0, 3), null, now, now);
  db.prepare(`
    INSERT INTO matches (
      id, source_match_id, competition_code, season, utc_date, status, matchday, stage, group_name,
      home_team_id, away_team_id, home_score, away_score, winner, odds_event_id, last_synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    matchId,
    matchId,
    competitionCode,
    2026,
    kickoffTime,
    "FINISHED",
    null,
    null,
    null,
    homeTeamId,
    awayTeamId,
    homeScore,
    awayScore,
    homeScore > awayScore ? "HOME_TEAM" : awayScore > homeScore ? "AWAY_TEAM" : "DRAW",
    null,
    now
  );
}

function insertRecommendationSnapshot(matchId, values = {}) {
  const db = getDb();
  const defaults = {
    collector_run_id: null,
    generated_at: "2026-03-23T10:00:00Z",
    competition_code: "CL",
    best_market: "Over / Under 2.5",
    selection_label: "Over 2.5",
    action: "Playable Edge",
    confidence: "Medium",
    trust_label: "Fair",
    trust_score: 68,
    edge: 4.2,
    bookmaker_title: "Book A",
    bookmaker_odds: 2.05,
    odds_at_prediction: 2.05,
    odds_snapshot_at: "2026-03-23T09:58:00Z",
    odds_freshness_minutes: 2,
    odds_freshness_score: 90,
    odds_refreshed_recently: 1,
    odds_coverage_status: "complete",
    bookmaker_count: 3,
    stale_odds_flag: 0,
    quota_degraded_flag: 0,
    data_completeness_score: 1,
    price_quality_status: "strong",
    price_trustworthy_flag: 1,
    price_block_reasons_json: "[]",
    recommendation_downgrade_reason: null,
    board_provider: "odds-api",
    board_source_label: "live-board",
    board_source_mode: "live",
    source_reliability_score: 1,
    board_quality_tier: "strong",
    board_quality_score: 0.92,
    fallback_used_flag: 0,
    market_probability: 0.49,
    opening_odds: 2.1,
    closing_odds: 1.98,
    closing_line_value: -0.07,
    fair_odds: 1.98,
    model_probability: 0.505,
    has_odds: 1,
    summary: "Test snapshot",
    probabilities_json: "{}",
    markets_json: "{}",
    settled_at: "2026-03-23T21:30:00Z",
    outcome_label: "Over 2.5",
    bet_result: "won",
    is_correct: 1,
    roi: 1.05,
    grade_note: "Won on Over 2.5."
  };
  const row = { ...defaults, ...values };
  const columns = [
    "collector_run_id", "match_id", "generated_at", "competition_code", "best_market", "selection_label",
    "action", "confidence", "trust_label", "trust_score", "edge", "bookmaker_title", "bookmaker_odds", "odds_at_prediction", "odds_snapshot_at",
    "odds_freshness_minutes", "odds_freshness_score", "odds_refreshed_recently", "odds_coverage_status", "bookmaker_count", "stale_odds_flag", "quota_degraded_flag", "data_completeness_score", "price_quality_status", "price_trustworthy_flag", "price_block_reasons_json", "recommendation_downgrade_reason",
    "board_provider", "board_source_label", "board_source_mode", "source_reliability_score", "board_quality_tier", "board_quality_score", "fallback_used_flag",
    "market_probability", "opening_odds", "closing_odds", "closing_line_value",
    "fair_odds", "model_probability", "has_odds", "summary", "probabilities_json", "markets_json",
    "settled_at", "outcome_label", "bet_result", "is_correct", "roi", "grade_note"
  ];
  const valuesList = [
    row.collector_run_id, matchId, row.generated_at, row.competition_code, row.best_market, row.selection_label,
    row.action, row.confidence, row.trust_label, row.trust_score, row.edge, row.bookmaker_title, row.bookmaker_odds, row.odds_at_prediction, row.odds_snapshot_at,
    row.odds_freshness_minutes, row.odds_freshness_score, row.odds_refreshed_recently, row.odds_coverage_status, row.bookmaker_count, row.stale_odds_flag, row.quota_degraded_flag, row.data_completeness_score, row.price_quality_status, row.price_trustworthy_flag, row.price_block_reasons_json, row.recommendation_downgrade_reason,
    row.board_provider, row.board_source_label, row.board_source_mode, row.source_reliability_score, row.board_quality_tier, row.board_quality_score, row.fallback_used_flag,
    row.market_probability, row.opening_odds, row.closing_odds, row.closing_line_value,
    row.fair_odds, row.model_probability, row.has_odds, row.summary, row.probabilities_json, row.markets_json,
    row.settled_at, row.outcome_label, row.bet_result, row.is_correct, row.roi, row.grade_note
  ];

  db.prepare(`
    INSERT INTO recommendation_snapshots (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `).run(...valuesList);
}

test("probabilities add up to roughly one", () => {
  const result = calculateProbabilities({
    competitionAverages: {
      avgHomeGoals: 1.4,
      avgAwayGoals: 1.1
    },
    home: {
      elo: 1540,
      recentFormPpg: 2.1,
      opponentAdjustedForm: 2.2,
      weightedGoalsFor: 1.8,
      weightedGoalsAgainst: 0.9,
      avgGoalsLast5: 1.9,
      avgConcededLast5: 0.8,
      goalDiffLast5: 1.1,
      splitGoalsFor: 1.9,
      splitGoalsAgainst: 0.8,
      homeAttackStrength: 1.18,
      homeDefenseStrength: 0.84,
      opponentStrength: 1510,
      restDays: 6
    },
    away: {
      elo: 1490,
      recentFormPpg: 1.4,
      opponentAdjustedForm: 1.3,
      weightedGoalsFor: 1.2,
      weightedGoalsAgainst: 1.4,
      avgGoalsLast5: 1.1,
      avgConcededLast5: 1.5,
      goalDiffLast5: -0.4,
      splitGoalsFor: 1.1,
      splitGoalsAgainst: 1.5,
      awayAttackStrength: 0.92,
      awayDefenseStrength: 1.14,
      opponentStrength: 1485,
      restDays: 4
    },
    context: {
      homeRestEdge: 0.28,
      dataCoverageScore: 0.88
    }
  });

  const total = result.probabilities.homeWin + result.probabilities.draw + result.probabilities.awayWin;
  assert.ok(total > 0.99 && total < 1.01);
  assert.ok(Array.isArray(result.factors));
  assert.ok(Array.isArray(result.positiveDrivers));
  assert.ok(Array.isArray(result.negativeDrivers));
  assert.ok(Array.isArray(result.risks));
  assert.ok(typeof result.diagnostics.dataCoverageScore === "number");
  assert.ok(typeof result.diagnostics.coverageBlend === "number");
});

test("low coverage shrinks model toward elo baseline", () => {
  const shared = {
    competitionAverages: {
      avgHomeGoals: 1.4,
      avgAwayGoals: 1.1
    },
    home: {
      elo: 1540,
      recentFormPpg: 2.4,
      opponentAdjustedForm: 2.5,
      weightedGoalsFor: 2.0,
      weightedGoalsAgainst: 0.8,
      avgGoalsLast5: 2.2,
      avgConcededLast5: 0.7,
      goalDiffLast5: 1.4,
      homeAttackStrength: 1.25,
      homeDefenseStrength: 0.8,
      restDays: 6
    },
    away: {
      elo: 1490,
      recentFormPpg: 1.0,
      opponentAdjustedForm: 0.9,
      weightedGoalsFor: 0.9,
      weightedGoalsAgainst: 1.7,
      avgGoalsLast5: 0.8,
      avgConcededLast5: 1.8,
      goalDiffLast5: -1.1,
      awayAttackStrength: 0.85,
      awayDefenseStrength: 1.25,
      restDays: 4
    }
  };

  const highCoverage = calculateProbabilities({
    ...shared,
    context: {
      homeRestEdge: 0.28,
      dataCoverageScore: 0.9
    }
  });
  const lowCoverage = calculateProbabilities({
    ...shared,
    context: {
      homeRestEdge: 0.28,
      dataCoverageScore: 0.2
    }
  });

  const highGap = Math.abs(highCoverage.expectedGoals.home - highCoverage.diagnostics.baselineExpectedGoals.home);
  const lowGap = Math.abs(lowCoverage.expectedGoals.home - lowCoverage.diagnostics.baselineExpectedGoals.home);

  assert.ok(lowGap < highGap);
});

test("bookmaker baseline tempers raw probabilities when a real market is available", () => {
  const withMarket = calculateProbabilities({
    competitionAverages: {
      avgHomeGoals: 1.4,
      avgAwayGoals: 1.1
    },
    home: {
      elo: 1600,
      recentFormPpg: 2.2,
      opponentAdjustedForm: 2.1,
      weightedGoalsFor: 1.9,
      weightedGoalsAgainst: 0.9,
      avgGoalsLast5: 1.8,
      avgConcededLast5: 0.9,
      avgXgLast5: 1.7,
      avgXgaLast5: 0.95,
      xgDifferenceLast5: 0.75,
      homeAttackStrength: 1.15,
      homeDefenseStrength: 0.88,
      expectedLineupStrength: 0.12,
      lineupUncertainty: 0.2,
      missingKeyPlayers: 0,
      restDays: 6
    },
    away: {
      elo: 1500,
      recentFormPpg: 1.1,
      opponentAdjustedForm: 1.2,
      weightedGoalsFor: 1.0,
      weightedGoalsAgainst: 1.6,
      avgGoalsLast5: 0.9,
      avgConcededLast5: 1.5,
      avgXgLast5: 1.0,
      avgXgaLast5: 1.45,
      xgDifferenceLast5: -0.45,
      awayAttackStrength: 0.9,
      awayDefenseStrength: 1.14,
      expectedLineupStrength: -0.05,
      lineupUncertainty: 0.35,
      missingKeyPlayers: 1,
      restDays: 4
    },
    context: {
      homeRestEdge: 0.28,
      dataCoverageScore: 0.9,
      marketBaseline: {
        bookmakerCount: 5,
        latestRetrievedAt: new Date().toISOString(),
        bookmakerMarginAdjustedProbability: {
          home: 0.49,
          draw: 0.27,
          away: 0.24
        },
        bookmakerImpliedProbability: {
          home: 0.53,
          draw: 0.29,
          away: 0.26
        }
      }
    }
  });

  assert.ok(withMarket.diagnostics.marketBaselineWeight > 0);
  assert.ok(withMarket.diagnostics.modelVsMarketDisagreement > 0);
  assert.ok(withMarket.probabilities.homeWin < withMarket.diagnostics.rawProbabilities.homeWin);
});

test("elo builder rewards a home win", () => {
  const ratings = buildRatingsUntil([
    {
      home_team_id: 1,
      away_team_id: 2,
      home_score: 2,
      away_score: 0,
      utc_date: "2026-01-01T20:00:00Z",
      stage: "LEAGUE_STAGE"
    }
  ]);

  assert.ok(ratings.get(1).elo > ratings.get(2).elo);
});

test("odds matcher recognizes common football aliases", () => {
  const { teamNameSimilarity } = __oddsMatchingTestables;

  assert.ok(teamNameSimilarity("Paris Saint-Germain FC", "PSG") >= 0.75);
  assert.ok(teamNameSimilarity("Manchester City FC", "Man City") >= 0.75);
  assert.ok(teamNameSimilarity("FC Barcelona", "Barca") >= 0.75);
  assert.ok(teamNameSimilarity("Bayer 04 Leverkusen", "Leverkusen") >= 0.75);
  assert.ok(teamNameSimilarity("Sporting CP", "Sporting") >= 0.75);
});

test("bookmaker market rows keep h2h, totals, and BTTS mappings stable", () => {
  const { mapBookmakerMarketRows } = __oddsMatchingTestables;
  const rows = mapBookmakerMarketRows(
    {
      home_team_name: "FC Barcelona",
      away_team_name: "Newcastle United FC"
    },
    {
      h2h: {
        key: "h2h",
        outcomes: [
          { name: "FC Barcelona", price: 1.6 },
          { name: "Draw", price: 4.8 },
          { name: "Newcastle United", price: 5.4 }
        ]
      },
      totals: {
        key: "totals",
        outcomes: [
          { name: "Over", point: 2.5, price: 1.4 },
          { name: "Under", point: 2.5, price: 3.35 }
        ]
      },
      btts: {
        key: "btts",
        outcomes: [
          { name: "Yes", price: 1.65 },
          { name: "No", price: 2.2 }
        ]
      }
    }
  );

  assert.deepEqual(rows, [
    { marketKey: "h2h", homePrice: 1.6, drawPrice: 4.8, awayPrice: 5.4 },
    { marketKey: "totals_2_5", homePrice: 1.4, drawPrice: null, awayPrice: 3.35 },
    { marketKey: "btts", homePrice: 1.65, drawPrice: null, awayPrice: 2.2 }
  ]);
});

test("totals mapping accepts over/under labels with embedded goal lines", () => {
  const { mapBookmakerMarketRows, parseGoalLineValue, isTotalsOutcome } = __oddsMatchingTestables;
  const rows = mapBookmakerMarketRows(
    {
      home_team_name: "FC Barcelona",
      away_team_name: "Newcastle United FC"
    },
    {
      totals: {
        key: "totals",
        outcomes: [
          { name: "Over 2.50", point: "2.50", price: 1.42 },
          { name: "Under 2,5", point: "2,5", price: 3.2 }
        ]
      }
    }
  );

  assert.equal(parseGoalLineValue("2,5"), 2.5);
  assert.equal(parseGoalLineValue("2.50"), 2.5);
  assert.equal(isTotalsOutcome({ name: "Over 2.5", point: null }, "over", 2.5), true);
  assert.equal(isTotalsOutcome({ name: "Under 2,5", point: null }, "under", 2.5), true);
  assert.deepEqual(rows, [
    { marketKey: "totals_2_5", homePrice: 1.42, drawPrice: null, awayPrice: 3.2 }
  ]);
});

test("live totals mapping does not depend on bookmaker outcome order", () => {
  const { mapBookmakerMarketRows } = __oddsMatchingTestables;
  const rows = mapBookmakerMarketRows(
    {
      home_team_name: "FC Barcelona",
      away_team_name: "Newcastle United FC"
    },
    {
      totals: {
        key: "totals",
        outcomes: [
          { name: "Under", point: 2.5, price: 2.04 },
          { name: "Over", point: 2.5, price: 1.84 }
        ]
      }
    }
  );

  assert.deepEqual(rows, [
    { marketKey: "totals_2_5", homePrice: 1.84, drawPrice: null, awayPrice: 2.04 }
  ]);
});

test("live totals mapping accepts mixed labels and line formatting variants", () => {
  const { mapBookmakerMarketRows, isTotalsOutcome } = __oddsMatchingTestables;
  const rows = mapBookmakerMarketRows(
    {
      home_team_name: "Liverpool FC",
      away_team_name: "Galatasaray"
    },
    {
      totals_alt: {
        key: "totals_alt",
        outcomes: [
          { name: "Under 2,5", point: null, price: 2.18 },
          { name: "Over 2.50", point: null, price: 1.74 },
          { name: "Over 3.5", point: null, price: 2.8 }
        ]
      }
    }
  );

  assert.equal(isTotalsOutcome({ name: "Over 3.5", point: null }, "over", 2.5), false);
  assert.deepEqual(rows, [
    { marketKey: "totals_2_5", homePrice: 1.74, drawPrice: null, awayPrice: 2.18 }
  ]);
});

test("licensed totals feed normalizes over and under labels consistently", () => {
  const { normalizeCsvMarket, normalizeCsvSelection } = __compliantOddsTestables;

  assert.equal(normalizeCsvMarket("ou25"), "totals_2_5");
  assert.equal(normalizeCsvSelection("Over 2.5", "totals_2_5"), "Over");
  assert.equal(normalizeCsvSelection("Under 2,5", "totals_2_5"), "Under");
});

test("fresh cache helper rejects empty or failed cache entries", () => {
  const { isUsableFreshCache } = __compliantOddsTestables;

  assert.equal(isUsableFreshCache({
    isFresh: true,
    request_status: "success",
    payload: []
  }), false);
  assert.equal(isUsableFreshCache({
    isFresh: true,
    request_status: "failed",
    payload: [{ id: "event-1" }]
  }), false);
  assert.equal(isUsableFreshCache({
    isFresh: false,
    request_status: "success",
    payload: [{ id: "event-1" }]
  }), false);
  assert.equal(isUsableFreshCache({
    isFresh: true,
    request_status: "success",
    payload: [{ id: "event-1" }]
  }), true);
});

test("only competitions with a real sport key count as live-odds capable", () => {
  assert.equal(hasCompetitionLiveOddsPath("CL"), true);
  assert.equal(hasCompetitionLiveOddsPath("EL"), true);
  assert.equal(hasCompetitionLiveOddsPath("PL"), false);
  assert.equal(hasCompetitionLiveOddsPath("PD"), false);
});

test("competitions without live odds path do not generate urgent odds demand context", () => {
  const { buildLiveOddsDemandContext } = __compliantOddsTestables;

  const noLivePath = buildLiveOddsDemandContext({
    code: "PL",
    sportKey: "",
    hasLiveOddsPath: false
  });
  const livePath = buildLiveOddsDemandContext({
    code: "CL",
    sportKey: "soccer_uefa_champs_league",
    hasLiveOddsPath: true
  });

  assert.equal(noLivePath.liveOddsEnabled, false);
  assert.deepEqual(noLivePath.demand, {
    within6Hours: 0,
    within24Hours: 0,
    within48Hours: 0
  });
  assert.deepEqual(noLivePath.trackedMatches, []);
  assert.equal(livePath.liveOddsEnabled, true);
});

test("forward-validation operations log entry keeps only the key operational fields", () => {
  const entry = buildForwardValidationLogEntry({
    generatedAt: "2026-03-23T07:00:00.000Z",
    summary: {
      trackedMatches: 16,
      bets: 4,
      settledBets: 2,
      staleOddsMatches: 9,
      weakBoardMatches: 8,
      unusableBoardMatches: 4
    },
    validationSplits: {
      usableOrBetterOnly: { trackedMatches: 1 },
      strongPriceOnly: { trackedMatches: 0 }
    },
    operationalDiagnostics: {
      freshnessDistribution: {
        median: 4071.24,
        p75: 5541.31,
        p90: 5622.18
      },
      trustworthySampleSize: {
        settledPriceTrustworthyBets: 0,
        settledUsableOrBetterBets: 0,
        settledStrongPriceBets: 0
      }
    }
  });

  assert.deepEqual(entry, {
    generatedAt: "2026-03-23T07:00:00.000Z",
    trackedMatches: 16,
    bets: 4,
    settledBets: 2,
    staleBoards: 9,
    weakBoards: 8,
    unusableBoards: 4,
    usableOrBetterMatches: 1,
    strongPriceMatches: 0,
    settledPriceTrustworthyBets: 0,
    settledUsableOrBetterBets: 0,
    settledStrongPriceBets: 0,
    freshnessMedianMinutes: 4071.2,
    freshnessP75Minutes: 5541.3,
    freshnessP90Minutes: 5622.2
  });
});

test("database maintenance skip flag is only enabled for explicit report-mode runs", () => {
  assert.equal(__databaseTestables.shouldSkipDbMaintenance("true"), true);
  assert.equal(__databaseTestables.shouldSkipDbMaintenance("TRUE"), true);
  assert.equal(__databaseTestables.shouldSkipDbMaintenance("false"), false);
  assert.equal(__databaseTestables.shouldSkipDbMaintenance(undefined), false);
});

test("implied probability conversion stays aligned with decimal odds", () => {
  assert.equal(impliedProbability(2), 0.5);
  assert.equal(impliedProbability(4), 0.25);
  assert.equal(impliedProbability(1.25), 0.8);
  assert.equal(impliedProbability(1), 0);
});

test("1X2 vig removal and edge calculation stay mathematically consistent", () => {
  const { averageImpliedOddsProbabilities } = __featureBuilderTestables;
  const { buildConsensusProbabilities, edgePercent, fairOdds } = __bettingEngineTestables;
  const rows = [
    {
      home_price: 2.0,
      draw_price: 3.6,
      away_price: 4.2
    },
    {
      home_price: 2.1,
      draw_price: 3.5,
      away_price: 4.0
    }
  ];
  const baseline = averageImpliedOddsProbabilities(rows);

  assert.ok(baseline);
  assert.ok(Math.abs(baseline.raw.home - 0.4881) < 0.0001);
  assert.ok(Math.abs(baseline.raw.draw - 0.2817) < 0.0001);
  assert.ok(Math.abs(baseline.raw.away - 0.244) < 0.0001);
  assert.ok(Math.abs(baseline.marginAdjusted.home - 0.4814) < 0.0001);
  assert.ok(Math.abs(baseline.marginAdjusted.draw - 0.2779) < 0.0001);
  assert.ok(Math.abs(baseline.marginAdjusted.away - 0.2407) < 0.0001);
  assert.ok(Math.abs(baseline.margin - 0.0139) < 0.0001);

  const consensus = buildConsensusProbabilities([
    {
      options: [
        { key: "home", bookmakerOdds: 2.0 },
        { key: "draw", bookmakerOdds: 3.6 },
        { key: "away", bookmakerOdds: 4.2 }
      ]
    },
    {
      options: [
        { key: "home", bookmakerOdds: 2.1 },
        { key: "draw", bookmakerOdds: 3.5 },
        { key: "away", bookmakerOdds: 4.0 }
      ]
    }
  ]);

  assert.ok(Math.abs(consensus.home - baseline.marginAdjusted.home) < 0.0001);
  assert.ok(Math.abs(consensus.draw - baseline.marginAdjusted.draw) < 0.0001);
  assert.ok(Math.abs(consensus.away - baseline.marginAdjusted.away) < 0.0001);
  const total = Object.values(consensus).reduce((sum, value) => sum + value, 0);
  assert.ok(total > 0.999 && total < 1.001);

  assert.equal(fairOdds(0.5), 2);
  assert.equal(edgePercent(0.55, 2), 10);
  assert.equal(edgePercent(0.45, 2), -10);
});

test("totals and BTTS books preserve side mapping and fair probabilities", () => {
  const { buildConsensusProbabilities, edgePercent } = __bettingEngineTestables;

  const totalsConsensus = buildConsensusProbabilities([
    {
      options: [
        { key: "over", bookmakerOdds: 1.8 },
        { key: "under", bookmakerOdds: 2.1 }
      ]
    }
  ]);
  assert.deepEqual(totalsConsensus, { over: 0.5385, under: 0.4615 });
  assert.ok(Math.abs(totalsConsensus.over + totalsConsensus.under - 1) < 0.001);
  assert.equal(edgePercent(0.56, 1.8), 0.8);
  assert.equal(edgePercent(0.44, 2.1), -7.6);

  const bttsConsensus = buildConsensusProbabilities([
    {
      options: [
        { key: "yes", bookmakerOdds: 1.7 },
        { key: "no", bookmakerOdds: 2.2 }
      ]
    }
  ]);
  assert.deepEqual(bttsConsensus, { yes: 0.5641, no: 0.4359 });
  assert.ok(Math.abs(bttsConsensus.yes + bttsConsensus.no - 1) < 0.001);
  assert.equal(edgePercent(0.62, 1.7), 5.4);
  assert.equal(edgePercent(0.38, 2.2), -16.4);
});

test("odds board summaries keep raw implied probabilities inside valid bounds", () => {
  const summary = summarizeOddsBoardRows([
    { home_price: 1.8, away_price: 2.1 },
    { home_price: 1.82, away_price: 2.08 }
  ], "totals_2_5");

  assert.equal(summary.selections[0].selection, "home");
  assert.equal(summary.selections[0].bestPrice, 1.82);
  assert.equal(summary.selections[1].bestPrice, 2.1);
  for (const selection of summary.selections) {
    assert.ok(selection.impliedProbability >= 0 && selection.impliedProbability <= 1);
  }
});

test("historical and licensed feed outcome normalization preserve betting semantics", () => {
  const { normalizeOutcomeKey } = __historicalOddsImporterTestables;
  const { normalizeCsvSelection } = __compliantOddsTestables;

  assert.equal(normalizeOutcomeKey({ market: "1x2", outcome: "1" }), "home");
  assert.equal(normalizeOutcomeKey({ market: "1x2", outcome: "x" }), "draw");
  assert.equal(normalizeOutcomeKey({ market: "1x2", outcome: "2" }), "away");
  assert.equal(normalizeOutcomeKey({ market: "ou25", outcome: "over_2_5" }), "home");
  assert.equal(normalizeOutcomeKey({ market: "ou25", outcome: "under_2_5" }), "away");
  assert.equal(normalizeOutcomeKey({ market: "btts", outcome: "btts_yes" }), "home");
  assert.equal(normalizeOutcomeKey({ market: "btts", outcome: "btts_no" }), "away");

  assert.equal(normalizeCsvSelection("Over 2.5", "totals_2_5"), "Over");
  assert.equal(normalizeCsvSelection("Under 2,5", "totals_2_5"), "Under");
  assert.equal(normalizeCsvSelection("Yes", "btts"), "Yes");
  assert.equal(normalizeCsvSelection("No", "btts"), "No");
});

test("fresh multi-bookmaker board scores as strong", () => {
  const now = "2026-03-19T10:00:00Z";
  const board = scoreOddsBoard([
    { bookmaker_key: "a", home_price: 1.9, away_price: 1.95, retrieved_at: "2026-03-19T09:59:00Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "b", home_price: 1.91, away_price: 1.94, retrieved_at: "2026-03-19T09:58:30Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "c", home_price: 1.89, away_price: 1.96, retrieved_at: "2026-03-19T09:59:20Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "d", home_price: 1.92, away_price: 1.93, retrieved_at: "2026-03-19T09:58:50Z", source_provider: "odds-api", source_mode: "live" }
  ], "totals_2_5", {
    kickoffTime: "2026-03-19T12:00:00Z",
    now
  });

  assert.equal(board.tier, "strong");
  assert.equal(board.refreshedRecently, true);
  assert.ok(board.bookmakerCount >= 4);
});

test("stale near-kickoff board becomes unusable in price-quality package", () => {
  const { buildPriceQualityPackage } = __bettingEngineTestables;
  const priceQuality = buildPriceQualityPackage(
    "totals25",
    { bookmakerOdds: 1.95, bookmakerMarginAdjustedProbability: 0.51 },
    [
      {
        bookmakerKey: "a",
        bookmakerTitle: "Book A",
        homeOdds: 1.95,
        drawOdds: null,
        awayOdds: 1.95,
        retrievedAt: "2026-03-19T10:00:00Z",
        isLive: false
      },
      {
        bookmakerKey: "b",
        bookmakerTitle: "Book B",
        homeOdds: 1.94,
        drawOdds: null,
        awayOdds: 1.96,
        retrievedAt: "2026-03-19T09:59:30Z",
        isLive: false
      }
    ],
    null,
    { syncDiagnostics: [] },
    {
      match: { competition_code: "CL", utc_date: "2026-03-19T10:04:00Z" },
      context: { hoursToKickoff: 0.06 }
    },
    {
      quality: scoreOddsBoard([
        { bookmaker_key: "a", home_price: 1.95, away_price: 1.95, retrieved_at: "2026-03-19T10:00:00Z", source_provider: "odds-api", source_mode: "live" },
        { bookmaker_key: "b", home_price: 1.94, away_price: 1.96, retrieved_at: "2026-03-19T09:59:30Z", source_provider: "odds-api", source_mode: "live" }
      ], "totals_2_5", {
        kickoffTime: "2026-03-19T10:04:00Z",
        now: "2026-03-19T10:10:00Z"
      }),
      provider: "odds-api",
      sourceMode: "live",
      fallbackUsed: false
    }
  );

  assert.equal(priceQuality.forceNoBet, true);
  assert.equal(priceQuality.status, "unusable");
  assert.match(priceQuality.downgradeReason, /too old/i);
});

test("quota degraded board is downgraded but not auto-blocked when otherwise usable", () => {
  const { buildPriceQualityPackage } = __bettingEngineTestables;
  const boardRows = [
    { bookmaker_key: "a", home_price: 2.05, away_price: 1.82, retrieved_at: "2026-03-19T09:59:00Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "b", home_price: 2.04, away_price: 1.83, retrieved_at: "2026-03-19T09:58:40Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "c", home_price: 2.06, away_price: 1.81, retrieved_at: "2026-03-19T09:59:20Z", source_provider: "odds-api", source_mode: "live" }
  ];
  const quality = scoreOddsBoard(boardRows, "totals_2_5", {
    kickoffTime: "2026-03-19T16:00:00Z",
    now: "2026-03-19T10:00:00Z",
    quotaDegraded: true
  });
  const priceQuality = buildPriceQualityPackage(
    "totals25",
    { bookmakerOdds: 2.06, bookmakerMarginAdjustedProbability: 0.47 },
    [
      { bookmakerKey: "a", bookmakerTitle: "Book A", homeOdds: 2.05, awayOdds: 1.82, retrievedAt: "2026-03-19T09:59:00Z", isLive: false },
      { bookmakerKey: "b", bookmakerTitle: "Book B", homeOdds: 2.04, awayOdds: 1.83, retrievedAt: "2026-03-19T09:58:40Z", isLive: false },
      { bookmakerKey: "c", bookmakerTitle: "Book C", homeOdds: 2.06, awayOdds: 1.81, retrievedAt: "2026-03-19T09:59:20Z", isLive: false }
    ],
    null,
    { syncDiagnostics: [{ competition: "CL", error: "OUT_OF_USAGE_CREDITS" }] },
    {
      match: { competition_code: "CL", utc_date: "2026-03-19T16:00:00Z" },
      context: { hoursToKickoff: 6 }
    },
    {
      quality,
      provider: "odds-api",
      sourceMode: "live",
      fallbackUsed: false
    }
  );

  assert.equal(priceQuality.forceNoBet, false);
  assert.equal(priceQuality.downgradeLevels, 1);
  assert.equal(priceQuality.quotaDegraded, true);
});

test("single-book or missing-price boards stay weak or unusable", () => {
  const singleBook = scoreOddsBoard([
    { bookmaker_key: "solo", home_price: 2.1, away_price: 1.78, retrieved_at: "2026-03-19T09:59:00Z", source_provider: "odds-api", source_mode: "live" }
  ], "totals_2_5", {
    kickoffTime: "2026-03-19T14:00:00Z",
    now: "2026-03-19T10:00:00Z"
  });
  const missingSide = scoreOddsBoard([
    { bookmaker_key: "a", home_price: 2.1, away_price: null, retrieved_at: "2026-03-19T09:59:00Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "b", home_price: 2.08, away_price: null, retrieved_at: "2026-03-19T09:59:10Z", source_provider: "odds-api", source_mode: "live" }
  ], "totals_2_5", {
    kickoffTime: "2026-03-19T14:00:00Z",
    now: "2026-03-19T10:00:00Z"
  });

  assert.ok(["weak", "unusable"].includes(singleBook.tier));
  assert.equal(missingSide.tier, "unusable");
  assert.ok(missingSide.completenessScore < 1);
});

test("board scoring should not let one stale bookmaker row hide behind fresh averages", () => {
  const board = scoreOddsBoard([
    { bookmaker_key: "a", home_price: 1.91, away_price: 1.93, retrieved_at: "2026-03-23T11:59:00Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "b", home_price: 1.92, away_price: 1.92, retrieved_at: "2026-03-23T11:58:30Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "c", home_price: 1.9, away_price: 1.94, retrieved_at: "2026-03-23T11:59:15Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "d", home_price: 1.89, away_price: 1.95, retrieved_at: "2026-03-23T11:50:00Z", source_provider: "odds-api", source_mode: "live" }
  ], "totals_2_5", {
    kickoffTime: "2026-03-23T13:00:00Z",
    now: "2026-03-23T12:00:00Z"
  });

  assert.equal(board.freshnessMinutes, 10);
  assert.equal(board.refreshedRecently, false);
  assert.notEqual(board.tier, "strong");
});

test("board scoring should not classify unknown-age boards as usable", () => {
  const board = scoreOddsBoard([
    { bookmaker_key: "a", home_price: 1.9, away_price: 1.95, retrieved_at: null, source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "b", home_price: 1.91, away_price: 1.94, retrieved_at: null, source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "c", home_price: 1.92, away_price: 1.93, retrieved_at: null, source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "d", home_price: 1.89, away_price: 1.96, retrieved_at: null, source_provider: "odds-api", source_mode: "live" }
  ], "totals_2_5", {
    kickoffTime: "2026-03-23T16:00:00Z",
    now: "2026-03-23T12:00:00Z"
  });

  assert.equal(board.refreshedRecently, false);
  assert.equal(board.tier, "unusable");
});

test("two-bookmaker boards should not be classified as strong", () => {
  const board = scoreOddsBoard([
    { bookmaker_key: "a", home_price: 1.83, away_price: 2.04, retrieved_at: "2026-03-23T11:59:00Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "b", home_price: 1.84, away_price: 2.03, retrieved_at: "2026-03-23T11:58:40Z", source_provider: "odds-api", source_mode: "live" }
  ], "totals_2_5", {
    kickoffTime: "2026-03-23T15:00:00Z",
    now: "2026-03-23T12:00:00Z"
  });

  assert.notEqual(board.tier, "strong");
});

test("trusted-cache boards should not score as strong as equivalent live boards", () => {
  const liveBoard = scoreOddsBoard([
    { bookmaker_key: "a", home_price: 1.88, away_price: 1.98, retrieved_at: "2026-03-23T11:59:00Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "b", home_price: 1.89, away_price: 1.97, retrieved_at: "2026-03-23T11:58:30Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "c", home_price: 1.9, away_price: 1.96, retrieved_at: "2026-03-23T11:59:10Z", source_provider: "odds-api", source_mode: "live" },
    { bookmaker_key: "d", home_price: 1.87, away_price: 1.99, retrieved_at: "2026-03-23T11:58:50Z", source_provider: "odds-api", source_mode: "live" }
  ], "totals_2_5", {
    kickoffTime: "2026-03-23T15:00:00Z",
    now: "2026-03-23T12:00:00Z"
  });
  const cachedBoard = scoreOddsBoard([
    { bookmaker_key: "a", home_price: 1.88, away_price: 1.98, retrieved_at: "2026-03-23T11:59:00Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "b", home_price: 1.89, away_price: 1.97, retrieved_at: "2026-03-23T11:58:30Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "c", home_price: 1.9, away_price: 1.96, retrieved_at: "2026-03-23T11:59:10Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "d", home_price: 1.87, away_price: 1.99, retrieved_at: "2026-03-23T11:58:50Z", source_provider: "trusted-cache", source_mode: "trusted_cache" }
  ], "totals_2_5", {
    kickoffTime: "2026-03-23T15:00:00Z",
    now: "2026-03-23T12:00:00Z"
  });

  assert.equal(liveBoard.tier, "strong");
  assert.notEqual(cachedBoard.tier, "strong");
});

test("downstream price-quality logic does not call sufficient 2-book depth missing", () => {
  const { buildPriceQualityPackage } = __bettingEngineTestables;
  const rows = [
    {
      bookmakerKey: "a",
      bookmakerTitle: "Book A",
      homeOdds: 1.83,
      drawOdds: null,
      awayOdds: 2.04,
      retrievedAt: "2026-03-23T11:59:00Z",
      isLive: false
    },
    {
      bookmakerKey: "b",
      bookmakerTitle: "Book B",
      homeOdds: 1.84,
      drawOdds: null,
      awayOdds: 2.03,
      retrievedAt: "2026-03-23T11:58:40Z",
      isLive: false
    }
  ];
  const board = {
    provider: "odds-api",
    sourceMode: "live",
    fallbackUsed: false,
    quality: scoreOddsBoard([
      { bookmaker_key: "a", home_price: 1.83, away_price: 2.04, retrieved_at: "2026-03-23T11:59:00Z", source_provider: "odds-api", source_mode: "live" },
      { bookmaker_key: "b", home_price: 1.84, away_price: 2.03, retrieved_at: "2026-03-23T11:58:40Z", source_provider: "odds-api", source_mode: "live" }
    ], "totals_2_5", {
      kickoffTime: "2026-03-23T15:00:00Z",
      now: "2026-03-23T12:00:00Z"
    })
  };
  const priceQuality = buildPriceQualityPackage(
    "totals25",
    { bookmakerOdds: 2.04, bookmakerMarginAdjustedProbability: 0.47 },
    rows,
    rows[0],
    { syncDiagnostics: [] },
    {
      match: { competition_code: "EL", utc_date: "2026-03-23T15:00:00Z" },
      context: { hoursToKickoff: 3 }
    },
    board
  );

  assert.notEqual(board.quality.tier, "strong");
  assert.equal(priceQuality.bookmakerDepthMissing, false);
  assert.ok(!priceQuality.blockReasons.includes("missing-bookmaker-depth"));
});

test("quota-degraded live boards are not marked price-trustworthy", () => {
  const { buildPriceQualityPackage } = __bettingEngineTestables;

  const priceQuality = buildPriceQualityPackage(
    "totals25",
    {
      bookmakerOdds: 1.95,
      bookmakerMarginAdjustedProbability: 0.52
    },
    [
      { bookmakerKey: "a" },
      { bookmakerKey: "b" },
      { bookmakerKey: "c" }
    ],
    null,
    {
      syncDiagnostics: [
        {
          competition: "CL",
          error: "OUT_OF_USAGE_CREDITS"
        }
      ]
    },
    {
      match: {
        utc_date: "2026-03-24T20:00:00Z",
        competition_code: "CL"
      },
      context: {
        hoursToKickoff: 4
      }
    },
    {
      provider: "odds-api",
      sourceMode: "live",
      fallbackUsed: false,
      quality: {
        freshnessMinutes: 2,
        acceptableFreshnessMinutes: 12,
        refreshedRecently: true,
        coverageStatus: "complete",
        completenessScore: 1,
        tier: "strong",
        score: 0.9,
        sourceReliabilityScore: 1,
        impliedConsistencyScore: 1
      }
    }
  );

  assert.ok(priceQuality.blockReasons.includes("quota-degraded"));
  assert.equal(priceQuality.priceTrustworthy, false);
});

test("cached fallback boards are not marked price-trustworthy", () => {
  const { buildPriceQualityPackage } = __bettingEngineTestables;

  const priceQuality = buildPriceQualityPackage(
    "totals25",
    {
      bookmakerOdds: 1.95,
      bookmakerMarginAdjustedProbability: 0.52
    },
    [
      { bookmakerKey: "a" },
      { bookmakerKey: "b" },
      { bookmakerKey: "c" }
    ],
    null,
    {
      syncDiagnostics: null
    },
    {
      match: {
        utc_date: "2026-03-24T20:00:00Z",
        competition_code: "CL"
      },
      context: {
        hoursToKickoff: 4
      }
    },
    {
      provider: "trusted-cache",
      sourceMode: "trusted_cache",
      fallbackUsed: true,
      quality: {
        freshnessMinutes: 2,
        acceptableFreshnessMinutes: 12,
        refreshedRecently: true,
        coverageStatus: "complete",
        completenessScore: 1,
        tier: "usable",
        score: 0.82,
        sourceReliabilityScore: 0.45,
        impliedConsistencyScore: 1
      }
    }
  );

  assert.equal(priceQuality.fallbackUsed, true);
  assert.equal(priceQuality.priceTrustworthy, false);
});

test("resolveBoardSelection should keep a fresh usable live board over a merely higher-scoring trusted cache", () => {
  const { resolveBoardSelection } = __bettingEngineTestables;
  const matchId = 990001;
  const market = "totals_2_5";
  const kickoffTime = "2026-03-23T15:00:00Z";
  const now = "2026-03-23T12:00:00Z";

  clearBoardSelectionFixtures(matchId);
  ensureBoardSelectionFixtureMatch(matchId, kickoffTime);
  insertLiveSnapshotRows(matchId, market, [
    { bookmaker_key: "live-a", home_price: 1.83, away_price: 2.04, retrieved_at: "2026-03-23T11:59:00Z", source_provider: "odds-api" },
    { bookmaker_key: "live-b", home_price: 1.84, away_price: 2.03, retrieved_at: "2026-03-23T11:58:40Z", source_provider: "odds-api" }
  ]);
  insertTrustedCacheBoard(matchId, market, [
    { bookmaker_key: "cache-a", home_price: 1.85, away_price: 2.01, retrieved_at: "2026-03-23T11:54:00Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "cache-b", home_price: 1.86, away_price: 2.0, retrieved_at: "2026-03-23T11:53:40Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "cache-c", home_price: 1.84, away_price: 2.02, retrieved_at: "2026-03-23T11:54:20Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "cache-d", home_price: 1.87, away_price: 1.99, retrieved_at: "2026-03-23T11:53:50Z", source_provider: "trusted-cache", source_mode: "trusted_cache" }
  ], { kickoffTime, now });

  const selection = resolveBoardSelection(
    matchId,
    { snapshotMarket: market },
    { syncDiagnostics: [] },
    { match: { competition_code: "EL", utc_date: kickoffTime } }
  );

  assert.equal(selection.sourceMode, "live");
  assert.equal(selection.fallbackUsed, false);
});

test("resolveBoardSelection should not let quota degradation alone force cache over a fresh live board", () => {
  const { resolveBoardSelection } = __bettingEngineTestables;
  const matchId = 990002;
  const market = "totals_2_5";
  const kickoffTime = "2026-03-23T15:00:00Z";
  const now = "2026-03-23T12:00:00Z";

  clearBoardSelectionFixtures(matchId);
  ensureBoardSelectionFixtureMatch(matchId, kickoffTime);
  insertLiveSnapshotRows(matchId, market, [
    { bookmaker_key: "live-a", home_price: 1.88, away_price: 1.98, retrieved_at: "2026-03-23T11:59:00Z", source_provider: "odds-api" },
    { bookmaker_key: "live-b", home_price: 1.89, away_price: 1.97, retrieved_at: "2026-03-23T11:58:30Z", source_provider: "odds-api" },
    { bookmaker_key: "live-c", home_price: 1.9, away_price: 1.96, retrieved_at: "2026-03-23T11:59:10Z", source_provider: "odds-api" },
    { bookmaker_key: "live-d", home_price: 1.87, away_price: 1.99, retrieved_at: "2026-03-23T11:58:50Z", source_provider: "odds-api" }
  ]);
  insertTrustedCacheBoard(matchId, market, [
    { bookmaker_key: "cache-a", home_price: 1.88, away_price: 1.98, retrieved_at: "2026-03-23T11:58:00Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "cache-b", home_price: 1.89, away_price: 1.97, retrieved_at: "2026-03-23T11:57:30Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "cache-c", home_price: 1.9, away_price: 1.96, retrieved_at: "2026-03-23T11:58:10Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "cache-d", home_price: 1.87, away_price: 1.99, retrieved_at: "2026-03-23T11:57:50Z", source_provider: "trusted-cache", source_mode: "trusted_cache" }
  ], { kickoffTime, now });

  const selection = resolveBoardSelection(
    matchId,
    { snapshotMarket: market },
    { syncDiagnostics: [{ competition: "EL", error: "OUT_OF_USAGE_CREDITS" }] },
    { match: { competition_code: "EL", utc_date: kickoffTime } }
  );

  assert.equal(selection.sourceMode, "live");
  assert.equal(selection.fallbackUsed, false);
});

test("resolveBoardSelection should not pick a stale trusted cache just because it still scores usable", () => {
  const { resolveBoardSelection } = __bettingEngineTestables;
  const matchId = 990003;
  const market = "totals_2_5";
  const kickoffTime = "2026-03-23T15:00:00Z";
  const now = "2026-03-23T12:00:00Z";

  clearBoardSelectionFixtures(matchId);
  ensureBoardSelectionFixtureMatch(matchId, kickoffTime);
  insertLiveSnapshotRows(matchId, market, [
    { bookmaker_key: "live-a", home_price: 1.83, away_price: 2.02, retrieved_at: "2026-03-23T10:20:00Z", source_provider: "odds-api" },
    { bookmaker_key: "live-b", home_price: null, away_price: 2.01, retrieved_at: "2026-03-23T10:19:30Z", source_provider: "odds-api" }
  ]);
  insertTrustedCacheBoard(matchId, market, [
    { bookmaker_key: "cache-a", home_price: 1.86, away_price: 1.98, retrieved_at: "2026-03-23T10:49:00Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "cache-b", home_price: 1.87, away_price: 1.97, retrieved_at: "2026-03-23T10:48:30Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "cache-c", home_price: 1.85, away_price: 1.99, retrieved_at: "2026-03-23T10:49:10Z", source_provider: "trusted-cache", source_mode: "trusted_cache" },
    { bookmaker_key: "cache-d", home_price: 1.88, away_price: 1.96, retrieved_at: "2026-03-23T10:48:50Z", source_provider: "trusted-cache", source_mode: "trusted_cache" }
  ], { kickoffTime, now });

  const selection = resolveBoardSelection(
    matchId,
    { snapshotMarket: market },
    { syncDiagnostics: [] },
    { match: { competition_code: "EL", utc_date: kickoffTime } }
  );

  assert.equal(selection.sourceMode, "live");
  assert.equal(selection.fallbackUsed, false);
});

test("settlement logic maps market outcomes deterministically", () => {
  const { actualOutcomeLabel, gradeRecommendation } = __collectorTestables;
  const openMatch = {
    home_score: 2,
    away_score: 1,
    home_team_name: "FC Barcelona",
    away_team_name: "Newcastle United FC"
  };

  assert.equal(actualOutcomeLabel({ best_market: "Over / Under 2.5" }, { ...openMatch, home_score: 0, away_score: 0 }), "Under 2.5");
  assert.equal(actualOutcomeLabel({ best_market: "Over / Under 2.5" }, { ...openMatch, home_score: 1, away_score: 1 }), "Under 2.5");
  assert.equal(actualOutcomeLabel({ best_market: "Over / Under 2.5" }, openMatch), "Over 2.5");
  assert.equal(actualOutcomeLabel({ best_market: "Over / Under 2.5" }, { ...openMatch, home_score: 3, away_score: 0 }), "Over 2.5");
  assert.equal(actualOutcomeLabel({ best_market: "BTTS" }, openMatch), "BTTS Yes");
  assert.equal(actualOutcomeLabel({ best_market: "1X2" }, openMatch), "FC Barcelona");

  assert.deepEqual(
    gradeRecommendation(
      {
        best_market: "Over / Under 2.5",
        selection_label: "Under 2.5",
        action: "Playable Edge",
        bookmaker_odds: 3.35
      },
      openMatch
    ),
    {
      outcomeLabel: "Over 2.5",
      betResult: "lost",
      isCorrect: 0,
      roi: -1,
      gradeNote: "Lost. The game landed on Over 2.5."
    }
  );
});

test("over and under probabilities sum to one", () => {
  const model = calculateProbabilities({
    competitionAverages: {
      avgHomeGoals: 1.4,
      avgAwayGoals: 1.1
    },
    home: {
      elo: 1540,
      recentFormPpg: 2.1,
      opponentAdjustedForm: 2.2,
      weightedGoalsFor: 1.8,
      weightedGoalsAgainst: 0.9,
      avgGoalsLast5: 1.9,
      avgConcededLast5: 0.8,
      goalDiffLast5: 1.1,
      splitGoalsFor: 1.9,
      splitGoalsAgainst: 0.8,
      homeAttackStrength: 1.18,
      homeDefenseStrength: 0.84,
      opponentStrength: 1510,
      restDays: 6
    },
    away: {
      elo: 1490,
      recentFormPpg: 1.4,
      opponentAdjustedForm: 1.3,
      weightedGoalsFor: 1.2,
      weightedGoalsAgainst: 1.4,
      avgGoalsLast5: 1.1,
      avgConcededLast5: 1.5,
      goalDiffLast5: -0.4,
      splitGoalsFor: 1.1,
      splitGoalsAgainst: 1.5,
      awayAttackStrength: 0.92,
      awayDefenseStrength: 1.14,
      opponentStrength: 1485,
      restDays: 4
    },
    context: {
      homeRestEdge: 0.28,
      dataCoverageScore: 0.88
    }
  });

  const totalsOptions = __bettingEngineTestables.buildOptionDefinitions(
    "totals25",
    { home: "Home", away: "Away" },
    model.probabilities,
    { ...model, features: { home: {}, away: {}, context: {} } }
  );
  const totalProbability = totalsOptions.reduce((sum, option) => sum + option.probability, 0);

  assert.ok(totalProbability > 0.999 && totalProbability < 1.001);
});

test("live totals recommendation semantics keep over and under tied to their own prices", () => {
  const { mapBookmakerMarketRows } = __oddsMatchingTestables;
  const { buildOptionDefinitions, edgePercent } = __bettingEngineTestables;
  const mappedRow = mapBookmakerMarketRows(
    {
      home_team_name: "FC Barcelona",
      away_team_name: "Newcastle United FC"
    },
    {
      totals: {
        key: "totals",
        outcomes: [
          { name: "Under 2.5", point: 2.5, price: 2.12 },
          { name: "Over 2.5", point: 2.5, price: 1.76 }
        ]
      }
    }
  )[0];

  const optionDefinitions = buildOptionDefinitions(
    "totals25",
    { home: "FC Barcelona", away: "Newcastle United FC" },
    {},
    {
      expectedGoals: {
        home: 1.78,
        away: 1.12
      },
      scoreMatrix: [
        { homeGoals: 2, awayGoals: 1, probability: 0.31 },
        { homeGoals: 2, awayGoals: 2, probability: 0.14 },
        { homeGoals: 1, awayGoals: 1, probability: 0.18 },
        { homeGoals: 1, awayGoals: 0, probability: 0.11 },
        { homeGoals: 0, awayGoals: 1, probability: 0.1 },
        { homeGoals: 0, awayGoals: 0, probability: 0.16 }
      ],
      features: {
        home: { lineupUncertainty: 0.18, recentAttackingEfficiency: 1.04, xgTrendMomentum: 0.08 },
        away: { lineupUncertainty: 0.24, recentAttackingEfficiency: 0.97, xgTrendMomentum: -0.02 },
        context: { dataCoverageScore: 0.78 }
      }
    }
  );

  const boundOptions = optionDefinitions.map((option) => {
    const bookmakerOdds = option.priceField === "home_price" ? mappedRow.homePrice : mappedRow.awayPrice;
    return {
      key: option.key,
      bookmakerOdds,
      edge: edgePercent(option.probability, bookmakerOdds)
    };
  });
  const over = boundOptions.find((option) => option.key === "over");
  const under = boundOptions.find((option) => option.key === "under");

  assert.equal(optionDefinitions.find((option) => option.key === "over").priceField, "home_price");
  assert.equal(optionDefinitions.find((option) => option.key === "under").priceField, "away_price");
  assert.equal(over.bookmakerOdds, 1.76);
  assert.equal(under.bookmakerOdds, 2.12);
  assert.equal(over.edge, edgePercent(optionDefinitions.find((option) => option.key === "over").probability, 1.76));
  assert.equal(under.edge, edgePercent(optionDefinitions.find((option) => option.key === "under").probability, 2.12));
});

test("no-bet lead market falls back to 1X2 reference instead of speculative totals", () => {
  const { buildPrimaryMarket, buildPrimaryMarketLegacy } = __bettingEngineTestables;
  const markets = {
    oneXTwo: {
      key: "oneXTwo",
      name: "1X2",
      bestOption: {
        shortLabel: "FC Barcelona",
        edge: -2.11,
        disagreement: 0.01
      },
      trust: { score: 74, label: "Fair" },
      recommendation: {
        action: "No Bet",
        isNoBet: true,
        confidence: "Low",
        trustLabel: "Fair",
        credibilityLabel: "Fair",
        credibilityScore: 70,
        shortReason: "No Bet."
      }
    },
    totals25: {
      key: "totals25",
      name: "Over / Under 2.5",
      bestOption: {
        shortLabel: "Under 2.5",
        edge: 34.1,
        disagreement: 0
      },
      trust: { score: 43, label: "Fragile" },
      recommendation: {
        action: "No Bet",
        isNoBet: true,
        confidence: "Low",
        trustLabel: "Fragile",
        credibilityLabel: "Fragile",
        credibilityScore: 41,
        shortReason: "No Bet. The setup is too fragile."
      }
    },
    btts: {
      key: "btts",
      name: "BTTS",
      bestOption: {
        shortLabel: "BTTS Yes",
        edge: 8.5,
        disagreement: 0
      },
      trust: { score: 38, label: "Fragile" },
      recommendation: {
        action: "No Bet",
        isNoBet: true,
        confidence: "Low",
        trustLabel: "Fragile",
        credibilityLabel: "Fragile",
        credibilityScore: 35,
        shortReason: "No Bet. The setup is too fragile."
      }
    }
  };

  assert.equal(buildPrimaryMarketLegacy(markets).selectionLabel, "Under 2.5");
  const primary = buildPrimaryMarket(markets);
  assert.equal(primary.marketKey, "oneXTwo");
  assert.equal(primary.selectionLabel, "FC Barcelona");
  assert.equal(primary.action, "No Bet");
});

test("stale totals boards cannot stay playable even when the edge looks huge", () => {
  const { applyPriceQualityGuardrail } = __bettingEngineTestables;

  const priceGate = applyPriceQualityGuardrail("totals25", {
    forceNoBet: true,
    downgradeLevels: 0,
    downgradeReason: "Stored odds are too old for the current kickoff window.",
    quotaDegraded: true
  }, "Strong Value");

  assert.equal(priceGate.forceNoBet, true);
  assert.equal(priceGate.downgradeAction, null);
  assert.match(priceGate.reason, /too old/i);
});

test("forward recommendation eligibility rejects live or post-kickoff fixtures", () => {
  const { isEligibleForForwardRecommendation } = __collectorTestables;
  const now = new Date("2026-03-19T18:00:00Z");

  assert.equal(
    isEligibleForForwardRecommendation({ status: "SCHEDULED", utc_date: "2026-03-19T19:00:00Z" }, now),
    true
  );
  assert.equal(
    isEligibleForForwardRecommendation({ status: "TIMED", utc_date: "2026-03-19T19:00:00Z" }, now),
    true
  );
  assert.equal(
    isEligibleForForwardRecommendation({ status: "LIVE", utc_date: "2026-03-19T17:45:00Z" }, now),
    false
  );
  assert.equal(
    isEligibleForForwardRecommendation({ status: "SCHEDULED", utc_date: "2026-03-19T17:45:00Z" }, now),
    false
  );
  assert.equal(
    isEligibleForForwardRecommendation({ status: "FINISHED", utc_date: "2026-03-19T17:45:00Z" }, now),
    false
  );
});

test("snapshot persistence coerces actionable picks to No Bet when price-quality metadata is missing", () => {
  const { normalizeStoredRecommendationState } = __collectorTestables;

  const state = normalizeStoredRecommendationState({
    explanation: {
      summary: "FC Metz is the cleanest match-result angle. The football case and the price are still pointing the same way."
    },
    betting: {
      primaryMarket: {
        marketKey: "oneXTwo",
        marketName: "1X2",
        selectionLabel: "FC Metz",
        action: "Playable",
        confidence: "High",
        trust: "Strong"
      },
      bestBet: {
        marketKey: "oneXTwo"
      },
      markets: {
        oneXTwo: {
          name: "1X2",
          bestOption: {
            shortLabel: "FC Metz",
            bookmakerOdds: 3.65,
            fairOdds: 2.51,
            modelProbability: 0.3959,
            edge: 44.5
          },
          recommendation: {
            action: "Playable",
            confidence: "High",
            trustLabel: "Strong",
            trustScore: 81,
            selectionLabel: "FC Metz"
          },
          priceQuality: null
        }
      }
    }
  });

  assert.equal(state.action, "No Bet");
  assert.equal(state.confidence, "Low");
  assert.equal(state.trustLabel, "Fragile");
  assert.match(state.summary, /Price-quality metadata is missing/i);
  assert.match(state.recommendationDowngradeReason, /missing price-quality metadata/i);
});

test("historical board selection ignores trusted-cache rows newer than beforeDate", () => {
  const { resolveBoardSelection } = __bettingEngineTestables;
  const db = getDb();
  const now = new Date().toISOString();
  const unique = Date.now();

  db.prepare(`
    INSERT INTO teams (source_team_id, name, short_name, tla, crest, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(9_000_100 + unique, `Home ${unique}`, `Home ${unique}`, "HGT", null, now, now);
  db.prepare(`
    INSERT INTO teams (source_team_id, name, short_name, tla, crest, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(9_100_100 + unique, `Away ${unique}`, `Away ${unique}`, "AGT", null, now, now);

  const homeTeamId = db.prepare("SELECT id FROM teams WHERE source_team_id = ?").get(9_000_100 + unique).id;
  const awayTeamId = db.prepare("SELECT id FROM teams WHERE source_team_id = ?").get(9_100_100 + unique).id;

  db.prepare(`
    INSERT INTO matches (
      source_match_id, competition_code, season, utc_date, status, matchday, stage, group_name,
      home_team_id, away_team_id, home_score, away_score, winner, odds_event_id, last_synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    9_200_100 + unique,
    "CL",
    2026,
    "2026-03-10T20:00:00Z",
    "SCHEDULED",
    1,
    "LEAGUE_STAGE",
    null,
    homeTeamId,
    awayTeamId,
    null,
    null,
    null,
    null,
    now
  );

  const matchId = db.prepare("SELECT id FROM matches WHERE source_match_id = ?").get(9_200_100 + unique).id;

  db.prepare(`
    INSERT INTO odds_market_boards (
      match_id, market, source_provider, source_label, source_mode, source_reliability_score, board_quality_tier,
      board_quality_score, bookmaker_count, freshness_minutes, completeness_score, implied_consistency_score,
      quota_degraded_flag, board_recorded_at, board_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    matchId,
    "totals_2_5",
    "odds-api",
    "future-board",
    "trusted_cache",
    0.95,
    "strong",
    0.91,
    2,
    1,
    1,
    1,
    0,
    "2026-03-10T18:00:00Z",
    JSON.stringify([
      {
        bookmaker_key: "bet365",
        bookmaker_title: "bet365",
        source_provider: "odds-api",
        source_label: "future-board",
        home_price: 1.8,
        draw_price: null,
        away_price: 2.05,
        is_live: 0,
        retrieved_at: "2026-03-10T18:00:00Z"
      }
    ]),
    now
  );

  try {
    const selection = resolveBoardSelection(
      matchId,
      { snapshotMarket: "totals_2_5" },
      { syncDiagnostics: null },
      {
        match: {
          utc_date: "2026-03-10T20:00:00Z",
          competition_code: "CL"
        }
      },
      "2026-03-09T12:00:00Z"
    );

    assert.equal(selection.fallbackUsed, false);
    assert.equal(selection.rows.length, 0);
    assert.equal(selection.sourceMode, "live");
  } finally {
    db.prepare("DELETE FROM odds_market_boards WHERE match_id = ?").run(matchId);
    db.prepare("DELETE FROM matches WHERE id = ?").run(matchId);
    db.prepare("DELETE FROM teams WHERE id = ?").run(homeTeamId);
    db.prepare("DELETE FROM teams WHERE id = ?").run(awayTeamId);
  }
});

test("usable-or-better validation split should not include quota-degraded bets that are not price-trustworthy", () => {
  const matchId = 990101;
  const competitionCode = "ZZU";
  const kickoffTime = "2026-03-23T20:00:00Z";
  const generatedAt = "2026-03-23T10:00:00Z";

  clearRecommendationFixtures(matchId);
  ensureFinishedRecommendationFixture(matchId, kickoffTime, 2, 1, competitionCode);
  insertRecommendationSnapshot(matchId, {
    generated_at: generatedAt,
    competition_code: competitionCode,
    action: "Playable Edge",
    board_quality_tier: "usable",
    price_trustworthy_flag: 0,
    quota_degraded_flag: 1,
    price_block_reasons_json: JSON.stringify(["quota-degraded"]),
    best_market: "Over / Under 2.5",
    bet_result: "won",
    roi: 1.05
  });

  try {
    const report = getForwardValidationReport(1000, competitionCode);
    assert.equal(report.summary.bets >= 1, true);
    assert.equal(report.validationSplits.usableOrBetterOnly.bets, 0);
  } finally {
    clearRecommendationFixtures(matchId);
  }
});

test("all-tracked CLV should not include no-bet rows", () => {
  const matchId = 990102;
  const competitionCode = "ZZN";
  const kickoffTime = "2026-03-24T20:00:00Z";
  const generatedAt = "2026-03-24T10:00:00Z";

  clearRecommendationFixtures(matchId);
  ensureFinishedRecommendationFixture(matchId, kickoffTime, 1, 1, competitionCode);
  insertRecommendationSnapshot(matchId, {
    generated_at: generatedAt,
    competition_code: competitionCode,
    action: "No Bet",
    selection_label: "Under 2.5",
    best_market: "Over / Under 2.5",
    bet_result: "pass",
    roi: null,
    closing_line_value: -0.3,
    price_trustworthy_flag: 1,
    board_quality_tier: "strong"
  });

  try {
    const report = getForwardValidationReport(1000, competitionCode);
    assert.equal(report.summary.bets, 0);
    assert.equal(report.summary.averageClv, null);
    assert.equal(report.summary.beatClosingLineRate, null);
  } finally {
    clearRecommendationFixtures(matchId);
  }
});

test("usable-or-better validation split should not include fallback bets that are not price-trustworthy", () => {
  const matchId = 990103;
  const competitionCode = "ZZF";

  clearRecommendationFixtures(matchId);
  ensureFinishedRecommendationFixture(matchId, "2026-03-25T20:00:00Z", 3, 1, competitionCode);
  insertRecommendationSnapshot(matchId, {
    competition_code: competitionCode,
    generated_at: "2026-03-25T10:00:00Z",
    action: "Playable Edge",
    board_quality_tier: "usable",
    price_trustworthy_flag: 0,
    fallback_used_flag: 1,
    board_source_mode: "trusted_cache",
    price_block_reasons_json: JSON.stringify([]),
    best_market: "Over / Under 2.5",
    bet_result: "won",
    roi: 1.05
  });

  try {
    const report = getForwardValidationReport(1000, competitionCode);
    assert.equal(report.summary.bets >= 1, true);
    assert.equal(report.validationSplits.usableOrBetterOnly.bets, 0);
  } finally {
    clearRecommendationFixtures(matchId);
  }
});

test("forward validation selects the latest pre-kickoff snapshot and excludes post-kickoff rows", () => {
  const matchId = 990104;
  const competitionCode = "ZZP";

  clearRecommendationFixtures(matchId);
  ensureFinishedRecommendationFixture(matchId, "2026-03-26T20:00:00Z", 2, 1, competitionCode);
  insertRecommendationSnapshot(matchId, {
    competition_code: competitionCode,
    generated_at: "2026-03-26T18:00:00Z",
    action: "Playable Edge",
    selection_label: "Over 2.5",
    best_market: "Over / Under 2.5"
  });
  insertRecommendationSnapshot(matchId, {
    competition_code: competitionCode,
    generated_at: "2026-03-26T19:30:00Z",
    action: "No Bet",
    selection_label: "Under 2.5",
    best_market: "Over / Under 2.5"
  });
  insertRecommendationSnapshot(matchId, {
    competition_code: competitionCode,
    generated_at: "2026-03-26T20:15:00Z",
    action: "Strong Value",
    selection_label: "Under 2.5",
    best_market: "Over / Under 2.5"
  });

  try {
    const report = getForwardValidationReport(1000, competitionCode);
    assert.equal(report.sampleSize, 1);
    assert.equal(report.recent[0].recommendationTier, "No Bet");
    assert.equal(report.recent[0].selectionLabel, "Under 2.5");
  } finally {
    clearRecommendationFixtures(matchId);
  }
});

test("forward validation should prefer the latest semantically complete pre-kickoff snapshot over a later null-context row", () => {
  const matchId = 990108;
  const competitionCode = "ZZL";

  clearRecommendationFixtures(matchId);
  ensureFinishedRecommendationFixture(matchId, "2026-03-26T20:00:00Z", 1, 0, competitionCode);
  insertRecommendationSnapshot(matchId, {
    competition_code: competitionCode,
    generated_at: "2026-03-26T18:00:00Z",
    action: "No Bet",
    best_market: "Over / Under 2.5",
    selection_label: "Under 2.5",
    board_quality_tier: "weak",
    bookmaker_count: 13,
    market_probability: 0.46,
    board_provider: "odds-api",
    odds_coverage_status: "complete",
    price_trustworthy_flag: 0
  });
  insertRecommendationSnapshot(matchId, {
    competition_code: competitionCode,
    generated_at: "2026-03-26T19:00:00Z",
    action: "No Bet",
    best_market: "Over / Under 2.5",
    selection_label: "Under 2.5",
    board_quality_tier: null,
    bookmaker_count: null,
    market_probability: null,
    board_provider: null,
    odds_coverage_status: null,
    price_trustworthy_flag: 0
  });

  try {
    const report = getForwardValidationReport(1000, competitionCode);
    assert.equal(report.sampleSize, 1);
    assert.equal(report.recent[0].boardQualityTier, "weak");
    assert.equal(report.recent[0].bookmakerCount, 13);
    assert.equal(report.recent[0].impliedMarketProbability ?? report.recent[0].marketProbability, 0.46);
    assert.equal(report.recent[0].action ?? report.recent[0].recommendationTier, "No Bet");
  } finally {
    clearRecommendationFixtures(matchId);
  }
});

test("later actionable pre-kickoff snapshot with null board context should not displace an earlier complete row", () => {
  const matchId = 990109;
  const competitionCode = "ZZM";

  clearRecommendationFixtures(matchId);
  ensureFinishedRecommendationFixture(matchId, "2026-03-27T20:00:00Z", 2, 1, competitionCode);
  insertRecommendationSnapshot(matchId, {
    competition_code: competitionCode,
    generated_at: "2026-03-27T18:00:00Z",
    action: "No Bet",
    best_market: "1X2",
    selection_label: `Finished Home ${matchId}`,
    board_quality_tier: "weak",
    bookmaker_count: 17,
    market_probability: 0.62,
    board_provider: "unknown",
    odds_coverage_status: "complete",
    price_trustworthy_flag: 0,
    price_block_reasons_json: JSON.stringify(["weak-board"])
  });
  insertRecommendationSnapshot(matchId, {
    competition_code: competitionCode,
    generated_at: "2026-03-27T19:00:00Z",
    action: "Playable Edge",
    best_market: "Over / Under 2.5",
    selection_label: "Over 2.5",
    board_quality_tier: null,
    bookmaker_count: null,
    market_probability: null,
    board_provider: null,
    odds_coverage_status: null,
    price_trustworthy_flag: 0,
    price_block_reasons_json: "[]"
  });

  try {
    const report = getForwardValidationReport(1000, competitionCode);
    assert.equal(report.sampleSize, 1);
    assert.equal(report.recent[0].action ?? report.recent[0].recommendationTier, "No Bet");
    assert.equal(report.recent[0].boardQualityTier, "weak");
    assert.equal(report.recent[0].impliedMarketProbability ?? report.recent[0].marketProbability, 0.62);
    assert.equal(report.summary.bets, 0);
  } finally {
    clearRecommendationFixtures(matchId);
  }
});

test("forward validation CLV metrics should not use unsettled bets with provisional closing values", () => {
  const matchId = 990105;
  const competitionCode = "ZZC";
  const kickoffTime = "2098-03-27T20:00:00Z";

  clearRecommendationFixtures(matchId);
  ensureCompetition(competitionCode);
  ensureBoardSelectionFixtureMatch(matchId, kickoffTime, competitionCode);
  insertRecommendationSnapshot(matchId, {
    competition_code: competitionCode,
    generated_at: "2098-03-27T18:00:00Z",
    action: "Playable Edge",
    bet_result: null,
    settled_at: null,
    is_correct: null,
    roi: null,
    closing_odds: 1.95,
    closing_line_value: -0.18
  });

  try {
    const report = getForwardValidationReport(1000, competitionCode);
    assert.equal(report.summary.bets, 1);
    assert.equal(report.summary.settledBets, 0);
    assert.equal(report.summary.averageClv, null);
    assert.equal(report.summary.beatClosingLineRate, null);
  } finally {
    clearRecommendationFixtures(matchId);
  }
});

test("calibration audit uses settled bet rows only and keeps markets separated", () => {
  const matchIdA = 990106;
  const matchIdB = 990107;
  const matchIdC = 990108;
  const competitionCode = "ZZK";

  clearRecommendationFixtures(matchIdA);
  clearRecommendationFixtures(matchIdB);
  clearRecommendationFixtures(matchIdC);
  ensureFinishedRecommendationFixture(matchIdA, "2026-03-28T20:00:00Z", 2, 1, competitionCode);
  ensureFinishedRecommendationFixture(matchIdB, "2026-03-29T20:00:00Z", 1, 0, competitionCode);
  ensureFinishedRecommendationFixture(matchIdC, "2026-03-30T20:00:00Z", 0, 0, competitionCode);

  insertRecommendationSnapshot(matchIdA, {
    competition_code: competitionCode,
    generated_at: "2026-03-28T18:00:00Z",
    best_market: "Over / Under 2.5",
    selection_label: "Over 2.5",
    action: "Playable Edge",
    model_probability: 0.64,
    market_probability: 0.55,
    bet_result: "won",
    is_correct: 1
  });
  insertRecommendationSnapshot(matchIdB, {
    competition_code: competitionCode,
    generated_at: "2026-03-29T18:00:00Z",
    best_market: "1X2",
    selection_label: `Finished Home ${matchIdB}`,
    action: "Playable Edge",
    model_probability: 0.57,
    market_probability: 0.49,
    bet_result: "won",
    is_correct: 1
  });
  insertRecommendationSnapshot(matchIdC, {
    competition_code: competitionCode,
    generated_at: "2026-03-30T18:00:00Z",
    best_market: "BTTS",
    selection_label: "BTTS Yes",
    action: "No Bet",
    model_probability: 0.93,
    market_probability: 0.51,
    bet_result: "pass",
    is_correct: null,
    roi: null
  });

  try {
    const report = getForwardValidationReport(1000, competitionCode);
    assert.equal(report.calibrationAudit.samples.trackedRows, 3);
    assert.equal(report.calibrationAudit.samples.betRows, 2);
    assert.equal(report.calibrationAudit.samples.settledBetRows, 2);
    assert.equal(report.calibrationAudit.settledBetProbabilityBuckets.reduce((sum, row) => sum + row.settledBets, 0), 2);

    const totalsMarket = report.calibrationAudit.byMarket.find((entry) => entry.market === "Over / Under 2.5");
    const oneXTwoMarket = report.calibrationAudit.byMarket.find((entry) => entry.market === "1X2");
    const bttsMarket = report.calibrationAudit.byMarket.find((entry) => entry.market === "BTTS");

    assert.equal(totalsMarket.settledBets, 1);
    assert.equal(oneXTwoMarket.settledBets, 1);
    assert.equal(bttsMarket.settledBets, 0);
  } finally {
    clearRecommendationFixtures(matchIdA);
    clearRecommendationFixtures(matchIdB);
    clearRecommendationFixtures(matchIdC);
  }
});

test("edge quality audit uses settled bets only and excludes open bets from edge and CLV buckets", () => {
  const matchIdA = 990109;
  const matchIdB = 990110;
  const matchIdC = 990111;
  const competitionCode = "ZZE";

  clearRecommendationFixtures(matchIdA);
  clearRecommendationFixtures(matchIdB);
  clearRecommendationFixtures(matchIdC);
  ensureFinishedRecommendationFixture(matchIdA, "2026-03-31T20:00:00Z", 2, 1, competitionCode);
  ensureFinishedRecommendationFixture(matchIdB, "2026-04-01T20:00:00Z", 1, 3, competitionCode);
  ensureBoardSelectionFixtureMatch(matchIdC, "2098-04-02T20:00:00Z", competitionCode);

  insertRecommendationSnapshot(matchIdA, {
    competition_code: competitionCode,
    generated_at: "2026-03-31T18:00:00Z",
    action: "Playable Edge",
    edge: 3.4,
    closing_line_value: -0.11,
    bet_result: "won",
    roi: 1.02
  });
  insertRecommendationSnapshot(matchIdB, {
    competition_code: competitionCode,
    generated_at: "2026-04-01T18:00:00Z",
    action: "Strong Value",
    edge: 11.6,
    closing_line_value: 0.18,
    bet_result: "lost",
    roi: -1
  });
  insertRecommendationSnapshot(matchIdC, {
    competition_code: competitionCode,
    generated_at: "2098-04-02T18:00:00Z",
    action: "Strong Value",
    edge: 12.4,
    closing_line_value: -0.5,
    bet_result: null,
    settled_at: null,
    is_correct: null,
    roi: null
  });

  try {
    const report = getForwardValidationReport(1000, competitionCode);
    assert.equal(report.edgeQualityAudit.samples.trackedRows, 3);
    assert.equal(report.edgeQualityAudit.samples.betRows, 3);
    assert.equal(report.edgeQualityAudit.samples.settledBetRows, 2);
    assert.equal(report.edgeQualityAudit.settledBetEdgeBuckets.reduce((sum, row) => sum + row.settledBets, 0), 2);

    const highEdgeBucket = report.edgeQualityAudit.settledBetEdgeBuckets.find((entry) => entry.bucket === "10%+");
    assert.equal(highEdgeBucket.settledBets, 1);
    assert.equal(highEdgeBucket.averageClv, 0.18);
  } finally {
    clearRecommendationFixtures(matchIdA);
    clearRecommendationFixtures(matchIdB);
    clearRecommendationFixtures(matchIdC);
  }
});

test("operational diagnostics compute freshness and depth distributions deterministically", () => {
  const { buildOperationalDiagnostics } = __collectorTestables;
  const rows = [
      {
        competition_code: "EL",
        generated_at: "2026-03-23T18:30:00Z",
        utc_date: "2026-03-23T19:00:00Z",
        action: "No Bet",
      board_quality_tier: "weak",
      odds_freshness_minutes: 10,
      bookmaker_count: 2,
      stale_odds_flag: 1,
      quota_degraded_flag: 0,
      fallback_used_flag: 0,
      market_probability: 0.41,
      price_trustworthy_flag: 0,
      bet_result: "pass",
      board_provider: "odds-api",
      board_source_mode: "live"
    },
    {
      generated_at: "2026-03-23T16:00:00Z",
      utc_date: "2026-03-23T20:00:00Z",
      action: "Playable Edge",
      board_quality_tier: "usable",
      odds_freshness_minutes: 20,
      bookmaker_count: 3,
      stale_odds_flag: 0,
      quota_degraded_flag: 0,
      fallback_used_flag: 0,
      market_probability: 0.48,
      price_trustworthy_flag: 1,
      bet_result: "won",
      board_provider: "odds-api",
      board_source_mode: "live"
    },
    {
      generated_at: "2026-03-23T10:00:00Z",
      utc_date: "2026-03-24T12:00:00Z",
      action: "Playable Edge",
      board_quality_tier: "strong",
      odds_freshness_minutes: 40,
      bookmaker_count: 4,
      stale_odds_flag: 0,
      quota_degraded_flag: 0,
      fallback_used_flag: 0,
      market_probability: 0.53,
      price_trustworthy_flag: 1,
      bet_result: "lost",
      board_provider: "licensed-feed",
      board_source_mode: "licensed-import"
    },
    {
      generated_at: "2026-03-23T12:00:00Z",
      utc_date: "2026-03-23T14:00:00Z",
      action: "No Bet",
      board_quality_tier: null,
      odds_freshness_minutes: 80,
      bookmaker_count: null,
      stale_odds_flag: 0,
      quota_degraded_flag: 1,
      fallback_used_flag: 1,
      market_probability: null,
      price_trustworthy_flag: 0,
      bet_result: "pass",
      board_provider: null,
      board_source_mode: null
    }
  ];

  const diagnostics = buildOperationalDiagnostics(rows);

  assert.equal(diagnostics.aggregate.trackedMatches, 4);
  assert.equal(diagnostics.aggregate.staleBoards, 1);
  assert.equal(diagnostics.aggregate.weakBoards, 1);
  assert.equal(diagnostics.aggregate.usableOrBetterBoards, 2);
  assert.equal(diagnostics.aggregate.strongBoards, 1);
  assert.equal(diagnostics.aggregate.quotaDegradedBoards, 1);
  assert.equal(diagnostics.aggregate.fallbackUsedBoards, 1);
  assert.equal(diagnostics.missingFieldCounts.missingBoardQualityTier, 1);
  assert.equal(diagnostics.missingFieldCounts.missingMarketProbability, 1);
  assert.equal(diagnostics.missingFieldCounts.missingBookmakerCount, 1);
  assert.equal(diagnostics.freshnessDistribution.median, 30);
  assert.equal(diagnostics.freshnessDistribution.p75, 50);
  assert.equal(diagnostics.freshnessDistribution.p90, 68);
  assert.equal(diagnostics.bookmakerDepthDistribution.median, 3);
  assert.equal(diagnostics.trustworthySampleSize.settledBets, 2);
  assert.equal(diagnostics.trustworthySampleSize.settledPriceTrustworthyBets, 2);
  assert.equal(diagnostics.trustworthySampleSize.settledUsableOrBetterBets, 2);
  assert.equal(diagnostics.trustworthySampleSize.settledStrongPriceBets, 1);
});

test("operational diagnostics group rows by provider-source and kickoff window", () => {
  const { buildOperationalDiagnostics } = __collectorTestables;
  const rows = [
    {
      competition_code: "EL",
      generated_at: "2026-03-23T18:30:00Z",
      utc_date: "2026-03-23T19:00:00Z",
      action: "No Bet",
      board_quality_tier: "weak",
      odds_freshness_minutes: 12,
      bookmaker_count: 2,
      stale_odds_flag: 1,
      quota_degraded_flag: 0,
      fallback_used_flag: 0,
      market_probability: 0.41,
      price_trustworthy_flag: 0,
      bet_result: "pass",
      board_provider: "odds-api",
      board_source_mode: "live",
      best_market: "Over / Under 2.5"
    },
      {
        competition_code: "CL",
        generated_at: "2026-03-23T16:30:00Z",
        utc_date: "2026-03-23T20:00:00Z",
        action: "No Bet",
      board_quality_tier: "unusable",
      odds_freshness_minutes: null,
      bookmaker_count: 0,
      stale_odds_flag: 0,
      quota_degraded_flag: 1,
      fallback_used_flag: 0,
      market_probability: null,
      price_trustworthy_flag: 0,
      bet_result: "pass",
      board_provider: "odds-api",
      board_source_mode: "live",
      best_market: "1X2"
    },
      {
        competition_code: "EL",
        generated_at: "2026-03-23T10:00:00Z",
        utc_date: "2026-03-24T12:00:00Z",
        action: "Playable Edge",
      board_quality_tier: "strong",
      odds_freshness_minutes: 35,
      bookmaker_count: 4,
      stale_odds_flag: 0,
      quota_degraded_flag: 0,
      fallback_used_flag: 0,
      market_probability: 0.55,
      price_trustworthy_flag: 1,
      bet_result: "won",
      board_provider: "licensed-feed",
      board_source_mode: "licensed-import",
      best_market: "Over / Under 2.5"
    }
  ];

  const diagnostics = buildOperationalDiagnostics(rows);
  const liveProvider = diagnostics.byProviderSource.find((entry) => entry.providerSource === "odds-api / live");
  const licensedProvider = diagnostics.byProviderSource.find((entry) => entry.providerSource === "licensed-feed / licensed-import");
  const finalHour = diagnostics.byKickoffWindow.find((entry) => entry.kickoffWindow === "<=1h");
  const threeToSix = diagnostics.byKickoffWindow.find((entry) => entry.kickoffWindow === "3-6h");
  const overDay = diagnostics.byKickoffWindow.find((entry) => entry.kickoffWindow === ">24h");

  assert.equal(liveProvider.trackedMatches, 2);
  assert.equal(liveProvider.staleBoards, 1);
  assert.equal(liveProvider.unusableBoards, 1);
  assert.equal(licensedProvider.strongBoards, 1);
  assert.equal(finalHour.trackedMatches, 1);
  assert.equal(threeToSix.trackedMatches, 1);
  assert.equal(overDay.trackedMatches, 1);
  assert.equal(diagnostics.byProvider.find((entry) => entry.provider === "odds-api").freshnessDistribution.median, 12);
  assert.equal(diagnostics.byCompetition.find((entry) => entry.competitionCode === "EL").trackedMatches, 2);
});

test("run source diagnostics count cache-hit and zero-event failures deterministically", () => {
  const { summarizeRunSourceEntries } = __collectorTestables;
  const entries = [
    {
      runId: 149,
      competitionCode: "EL",
      requestStrategy: "cache-hit",
      sourceMode: "cache",
      trackedMatchCount: 7,
      oddsEvents: 0,
      quotaDegraded: false,
      fallbackUsed: false,
      stale_odds_flag: 0,
      quota_degraded_flag: 0,
      fallback_used_flag: 0,
      board_quality_tier: null,
      market_probability: null,
      bookmaker_count: null,
      price_trustworthy_flag: 0,
      action: "No Bet",
      bet_result: "pass"
    },
    {
      runId: 150,
      competitionCode: "CL",
      requestStrategy: "targeted-events",
      sourceMode: "live",
      trackedMatchCount: 3,
      oddsEvents: 0,
      quotaDegraded: true,
      fallbackUsed: false,
      stale_odds_flag: 0,
      quota_degraded_flag: 1,
      fallback_used_flag: 0,
      board_quality_tier: "unusable",
      market_probability: null,
      bookmaker_count: 0,
      price_trustworthy_flag: 0,
      action: "No Bet",
      bet_result: "pass"
    },
    {
      runId: 151,
      competitionCode: "EL",
      requestStrategy: "competition-poll",
      sourceMode: "live",
      trackedMatchCount: 5,
      oddsEvents: 4,
      quotaDegraded: false,
      fallbackUsed: false,
      stale_odds_flag: 1,
      quota_degraded_flag: 0,
      fallback_used_flag: 0,
      board_quality_tier: "weak",
      market_probability: 0.45,
      bookmaker_count: 2,
      price_trustworthy_flag: 0,
      action: "No Bet",
      bet_result: "pass"
    }
  ];

  const diagnostics = summarizeRunSourceEntries(entries);

  assert.equal(diagnostics.cacheHitZeroEventsEntries, 1);
  assert.equal(diagnostics.cacheHitZeroEventsRuns, 1);
  assert.equal(diagnostics.liveFetchZeroEventsEntries, 1);
  assert.equal(diagnostics.liveFetchZeroEventsRuns, 1);
  assert.equal(diagnostics.quotaDegradedEntries, 1);
  assert.equal(diagnostics.quotaDegradedRuns, 1);
  assert.equal(diagnostics.noFreshOddsForTrackedEntries, 2);
  assert.equal(diagnostics.noFreshOddsForTrackedRuns, 2);
  assert.equal(diagnostics.byRequestStrategy.find((entry) => entry.requestStrategy === "cache-hit").trackedMatchCount, 7);
  assert.equal(diagnostics.byCompetition.find((entry) => entry.competitionCode === "EL").trackedMatchCount, 12);
});

test("team identity resolver handles tricky aliases and rejects unsafe collisions", () => {
  const { resolveMatchTeamSide } = __teamIdentityTestables;
  const match = {
    homeTeamName: "Paris Saint Germain",
    awayTeamName: "Tottenham Hotspur FC"
  };

  assert.equal(resolveMatchTeamSide(match, "PSG"), "home");
  assert.equal(resolveMatchTeamSide(match, "Spurs"), "away");
  assert.equal(resolveMatchTeamSide({ homeTeamName: "Brentford", awayTeamName: "Arsenal FC" }, "Brest"), null);
  assert.equal(resolveMatchTeamSide({ homeTeamName: "FC Barcelona", awayTeamName: "FC Bayern München" }, "FCB"), null);
  assert.equal(resolveMatchTeamSide({ homeTeamName: "FC Barcelona", awayTeamName: "Newcastle United FC" }, "Barcelona Women"), null);
});
