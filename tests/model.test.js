import test from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/db/database.js";
import { buildRatingsUntil } from "../src/modules/analysis/eloEngine.js";
import { calculateProbabilities } from "../src/modules/analysis/probabilityModel.js";
import { impliedProbability } from "../src/lib/math.js";
import { __bettingEngineTestables } from "../src/modules/analysis/bettingEngine.js";
import { __collectorTestables } from "../src/modules/data/collectorService.js";
import { __compliantOddsTestables } from "../src/modules/data/compliantOddsSourceService.js";
import { __featureBuilderTestables } from "../src/modules/analysis/featureBuilder.js";
import { __historicalOddsImporterTestables } from "../src/modules/data/importers/historicalOddsImporter.js";
import { __oddsMatchingTestables } from "../src/modules/data/syncService.js";
import { scoreOddsBoard, summarizeOddsBoardRows } from "../src/modules/data/oddsBoardService.js";
import { __teamIdentityTestables } from "../src/modules/data/teamIdentity.js";

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
