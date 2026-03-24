import { APP_COMPETITION_CODES } from "../../config/leagues.js";
import { getDb } from "../../db/database.js";
import { isResolvedFixtureTeams } from "../../lib/fixtures.js";
import { logger } from "../../lib/logger.js";
import { average, round } from "../../lib/math.js";
import { isoNow } from "../../lib/time.js";
import { analyzeMatch } from "../analysis/analysisService.js";
import { runBlindEvaluation } from "../analysis/backtestService.js";
import { getDecisionPolicyStatus } from "../analysis/decisionPolicyParameters.js";
import { getTeamRatingsMap, refreshTeamRatings } from "../analysis/eloEngine.js";
import { getModelTrainingStatus } from "../analysis/modelParameters.js";
import { saveSystemMetricSnapshot } from "../analysis/systemMetricsService.js";
import { buildTrustReadiness } from "../analysis/trustReadinessService.js";
import { maybeAutoTrainModel } from "../analysis/trainingService.js";
import { maybeAutoTrainDecisionPolicies } from "../analysis/decisionTrainingService.js";
import { syncFreeModeData } from "./syncService.js";
import { importAvailabilityData } from "./importers/availabilityImporter.js";
import { importNewsData } from "./importers/newsImporter.js";
import { getOddsCoverageDiagnostics } from "./oddsCoverageService.js";
import { importAdvancedStatsData } from "./importers/xgImporter.js";

const FORWARD_MARKET_ORDER = ["Over / Under 2.5", "1X2", "BTTS"];
const FORWARD_ELIGIBLE_STATUSES = new Set(["SCHEDULED", "TIMED"]);

function isEligibleForForwardRecommendation(match, now = new Date()) {
  const status = String(match?.status ?? "").toUpperCase();
  if (!FORWARD_ELIGIBLE_STATUSES.has(status)) {
    return false;
  }

  const kickoffTime = new Date(match?.utc_date ?? 0);
  if (Number.isNaN(kickoffTime.getTime())) {
    return false;
  }

  return kickoffTime.getTime() > now.getTime();
}

function snapshotMarketForRecommendation(bestMarket) {
  if (bestMarket === "Over / Under 2.5") {
    return "totals_2_5";
  }

  if (bestMarket === "BTTS") {
    return "btts";
  }

  return "h2h";
}

function marketKeyFromName(marketName) {
  if (marketName === "Over / Under 2.5") {
    return "totals25";
  }

  if (marketName === "BTTS") {
    return "btts";
  }

  return "oneXTwo";
}

function readClosingLineStats(snapshot, matchUtcDate = null) {
  const db = getDb();
  const market = snapshotMarketForRecommendation(snapshot.best_market);
  const rows = db.prepare(`
    SELECT bookmaker_key, home_price, draw_price, away_price, retrieved_at
    FROM odds_snapshots
    WHERE match_id = ?
      AND market = ?
      ${matchUtcDate ? "AND datetime(retrieved_at) <= datetime(?)" : ""}
    ORDER BY datetime(retrieved_at) ASC, id ASC
  `).all(...(matchUtcDate ? [snapshot.match_id ?? snapshot.matchId, market, matchUtcDate] : [snapshot.match_id ?? snapshot.matchId, market]));

  if (!rows.length) {
    return {
      openingOdds: null,
      closingOdds: null,
      closingLineValue: null
    };
  }

  const resolvePrice = (row) => {
    if (snapshot.best_market === "Over / Under 2.5") {
      return snapshot.selection_label === "Over 2.5" ? row.home_price : row.away_price;
    }

    if (snapshot.best_market === "BTTS") {
      return snapshot.selection_label === "BTTS Yes" ? row.home_price : row.away_price;
    }

    if (snapshot.selection_label === "Draw") {
      return row.draw_price;
    }

    if (snapshot.selection_label === snapshot.home_team_name || snapshot.selection_label === snapshot.homeTeam) {
      return row.home_price;
    }

    if (snapshot.selection_label === snapshot.away_team_name || snapshot.selection_label === snapshot.awayTeam) {
      return row.away_price;
    }

    return null;
  };

  const openingByBookmaker = new Map();
  const latestByBookmaker = new Map();

  for (const row of rows) {
    if (!openingByBookmaker.has(row.bookmaker_key)) {
      openingByBookmaker.set(row.bookmaker_key, row);
    }

    latestByBookmaker.set(row.bookmaker_key, row);
  }

  const openingPrices = [...openingByBookmaker.values()].map(resolvePrice).filter(Number.isFinite);
  const closingPrices = [...latestByBookmaker.values()].map(resolvePrice).filter(Number.isFinite);
  const openingOdds = openingPrices.length ? round(average(openingPrices, 0), 2) : null;
  const closingOdds = closingPrices.length ? round(average(closingPrices, 0), 2) : null;
  const placedOdds = snapshot.bookmaker_odds ?? null;

  return {
    openingOdds,
    closingOdds,
    closingLineValue: placedOdds && closingOdds
      ? round(closingOdds - placedOdds, 2)
      : null
  };
}

function recoverStaleRuns(db) {
  db.prepare(`
    UPDATE collector_runs
    SET finished_at = datetime('now'), status = 'failed', error_message = 'Run interrupted (process killed before completion)'
    WHERE status = 'running'
      AND datetime(started_at) < datetime('now', '-15 minutes')
  `).run();
}

function beginCollectorRun(triggerSource) {
  const db = getDb();
  recoverStaleRuns(db);
  const startedAt = isoNow();
  const result = db.prepare(`
    INSERT INTO collector_runs (started_at, finished_at, trigger_source, status, summary_json, error_message)
    VALUES (?, NULL, ?, 'running', '{}', NULL)
    RETURNING id
  `).get(startedAt, triggerSource);

  return {
    id: result.id,
    startedAt
  };
}

function finishCollectorRun(runId, status, summary, errorMessage = null) {
  const db = getDb();
  db.prepare(`
    UPDATE collector_runs
    SET finished_at = ?, status = ?, summary_json = ?, error_message = ?
    WHERE id = ?
  `).run(isoNow(), status, JSON.stringify(summary), errorMessage, runId);
}

function normalizeStoredRecommendationState(analysis) {
  const trackedMarketKey = analysis.betting.primaryMarket?.marketKey
    ?? analysis.betting.bestBet?.marketKey
    ?? "totals25";
  const topMarket = analysis.betting.markets[trackedMarketKey] ?? analysis.betting.markets.totals25 ?? analysis.betting.markets.oneXTwo;
  const bestOption = topMarket?.bestOption ?? null;
  const priceQuality = topMarket?.priceQuality ?? null;
  const primaryMarket = analysis.betting.primaryMarket ?? null;
  const primaryAction = primaryMarket?.action ?? topMarket?.recommendation.action ?? "No Bet";
  const hasValidPriceQuality = Boolean(priceQuality) &&
    typeof priceQuality === "object" &&
    priceQuality.boardQualityTier !== undefined;
  const forceSafeNoBet = !hasValidPriceQuality && primaryAction !== "No Bet";
  const action = forceSafeNoBet ? "No Bet" : primaryAction;
  const confidence = forceSafeNoBet
    ? "Low"
    : (primaryMarket?.confidence ?? topMarket?.recommendation.confidence ?? "Low");
  const trustLabel = forceSafeNoBet
    ? "Fragile"
    : (primaryMarket?.trust ?? topMarket?.recommendation.trustLabel ?? "Fragile");
  const trustScore = forceSafeNoBet ? 0 : (topMarket?.recommendation.trustScore ?? 0);
  const summary = forceSafeNoBet
    ? "No Bet. Price-quality metadata is missing for the tracked market, so this snapshot cannot be treated as actionable."
    : analysis.explanation.summary;

  return {
    trackedMarketKey,
    topMarket,
    bestOption,
    priceQuality,
    primaryMarket,
    action,
    confidence,
    trustLabel,
    trustScore,
    summary,
    recommendationDowngradeReason: forceSafeNoBet
      ? "Tracked market was missing price-quality metadata during snapshot persistence."
      : (topMarket?.recommendation?.recommendationDowngradeReason ?? null)
  };
}

function storeRecommendationSnapshot(runId, analysis) {
  const db = getDb();
  const match = analysis.features.match;
  const snapshotState = normalizeStoredRecommendationState(analysis);
  const topMarket = snapshotState.topMarket;
  const bestOption = snapshotState.bestOption;
  const priceQuality = snapshotState.priceQuality;
  const closingLineStats = bestOption
    ? readClosingLineStats({
        matchId: match.id,
        best_market: snapshotState.primaryMarket?.marketName ?? topMarket?.name ?? "Over / Under 2.5",
        selection_label: snapshotState.primaryMarket?.selectionLabel ?? topMarket?.recommendation.selectionLabel ?? "No Bet",
        bookmaker_odds: bestOption.bookmakerOdds,
        homeTeam: match.home_team_name,
        awayTeam: match.away_team_name
      })
    : { openingOdds: null, closingOdds: null, closingLineValue: null };

  db.prepare(`
    INSERT INTO recommendation_snapshots (
      collector_run_id, match_id, generated_at, competition_code, best_market, selection_label,
      action, confidence, trust_label, trust_score, edge, bookmaker_title, bookmaker_odds, odds_at_prediction, odds_snapshot_at,
      odds_freshness_minutes, odds_freshness_score, odds_refreshed_recently, odds_coverage_status, bookmaker_count, stale_odds_flag, quota_degraded_flag, data_completeness_score, price_quality_status, price_trustworthy_flag, price_block_reasons_json, recommendation_downgrade_reason,
      board_provider, board_source_label, board_source_mode, source_reliability_score, board_quality_tier, board_quality_score, fallback_used_flag,
      market_probability, opening_odds, closing_odds, closing_line_value,
      fair_odds, model_probability, has_odds, summary, probabilities_json, markets_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    match.id,
    isoNow(),
    match.competition_code,
    snapshotState.primaryMarket?.marketName ?? topMarket?.name ?? "Over / Under 2.5",
    snapshotState.primaryMarket?.selectionLabel ?? topMarket?.recommendation.selectionLabel ?? "No Bet",
    snapshotState.action,
    snapshotState.confidence,
    snapshotState.trustLabel,
    snapshotState.trustScore,
    bestOption?.edge ?? null,
    topMarket?.recommendation.bestBookmakerTitle ?? topMarket?.selectedBookmaker?.bookmakerTitle ?? null,
    bestOption?.bookmakerOdds ?? null,
    bestOption?.bookmakerOdds ?? null,
    topMarket?.selectedBookmaker?.retrievedAt ?? null,
    priceQuality?.ageMinutes ?? null,
    priceQuality?.freshnessScore ?? null,
    priceQuality?.refreshedRecently ? 1 : 0,
    priceQuality?.coverageStatus ?? null,
    priceQuality?.bookmakerCount ?? null,
    priceQuality?.staleOdds ? 1 : 0,
    priceQuality?.quotaDegraded ? 1 : 0,
    priceQuality?.dataCompletenessScore ?? null,
    priceQuality?.status ?? null,
    priceQuality?.priceTrustworthy ? 1 : 0,
    JSON.stringify(priceQuality?.blockReasons ?? []),
    snapshotState.recommendationDowngradeReason,
    priceQuality?.boardProvider ?? null,
    priceQuality?.boardSourceLabel ?? null,
    priceQuality?.boardSourceMode ?? null,
    priceQuality?.sourceReliabilityScore ?? null,
    priceQuality?.boardQualityTier ?? null,
    priceQuality?.boardQualityScore ?? null,
    priceQuality?.fallbackUsed ? 1 : 0,
    bestOption?.bookmakerMarginAdjustedProbability ?? bestOption?.consensusProbability ?? null,
    closingLineStats.openingOdds,
    closingLineStats.closingOdds,
    closingLineStats.closingLineValue,
    bestOption?.fairOdds ?? null,
    bestOption?.modelProbability ?? null,
    Object.values(analysis.betting.markets).some((market) => market.hasOdds) ? 1 : 0,
    snapshotState.summary,
    JSON.stringify(analysis.model.probabilities),
    JSON.stringify(analysis.betting.markets)
  );
}

function actualOutcomeLabel(snapshot, match) {
  const totalGoals = (match.home_score ?? 0) + (match.away_score ?? 0);
  const homeWon = (match.home_score ?? 0) > (match.away_score ?? 0);
  const awayWon = (match.away_score ?? 0) > (match.home_score ?? 0);

  if (snapshot.best_market === "Over / Under 2.5") {
    return totalGoals >= 3 ? "Over 2.5" : "Under 2.5";
  }

  if (snapshot.best_market === "BTTS") {
    return (match.home_score ?? 0) > 0 && (match.away_score ?? 0) > 0 ? "BTTS Yes" : "BTTS No";
  }

  if (homeWon) {
    return match.home_team_name;
  }

  if (awayWon) {
    return match.away_team_name;
  }

  return "Draw";
}

function gradeRecommendation(snapshot, match) {
  const outcomeLabel = actualOutcomeLabel(snapshot, match);

  if (snapshot.action === "No Bet") {
    return {
      outcomeLabel,
      betResult: "pass",
      isCorrect: null,
      roi: null,
      gradeNote: "No Bet held."
    };
  }

  const won = snapshot.selection_label === outcomeLabel;
  return {
    outcomeLabel,
    betResult: won ? "won" : "lost",
    isCorrect: won ? 1 : 0,
    roi: snapshot.bookmaker_odds ? round(won ? snapshot.bookmaker_odds - 1 : -1, 4) : null,
    gradeNote: won
      ? `Won on ${outcomeLabel}.`
      : `Lost. The game landed on ${outcomeLabel}.`
  };
}

export const __collectorTestables = {
  actualOutcomeLabel,
  gradeRecommendation,
  snapshotMarketForRecommendation,
  isEligibleForForwardRecommendation,
  normalizeStoredRecommendationState,
  buildNumericDistribution,
  buildTrustworthySampleSize,
  buildOperationalDiagnostics,
  summarizeRunSourceEntries
};

export function gradeRecommendationSnapshots() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      rs.id,
      rs.match_id,
      rs.action,
      rs.best_market,
      rs.selection_label,
      rs.bookmaker_odds,
      rs.opening_odds,
      matches.utc_date,
      matches.home_score,
      matches.away_score,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM recommendation_snapshots rs
    JOIN matches ON matches.id = rs.match_id
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE matches.status = 'FINISHED'
      AND matches.home_score IS NOT NULL
      AND matches.away_score IS NOT NULL
      AND rs.bet_result IS NULL
  `).all();

  const update = db.prepare(`
    UPDATE recommendation_snapshots
    SET settled_at = ?, outcome_label = ?, bet_result = ?, is_correct = ?, roi = ?, grade_note = ?, opening_odds = COALESCE(opening_odds, ?), closing_odds = ?, closing_line_value = ?
    WHERE id = ?
  `);

  for (const row of rows) {
    const graded = gradeRecommendation(row, row);
    const closingLine = readClosingLineStats(row, row.utc_date);
    update.run(
      isoNow(),
      graded.outcomeLabel,
      graded.betResult,
      graded.isCorrect,
      graded.roi,
      graded.gradeNote,
      closingLine.openingOdds,
      closingLine.closingOdds,
      closingLine.closingLineValue,
      row.id
    );
  }

  return rows.length;
}

function readUpcomingAppMatches() {
  const db = getDb();
  return db.prepare(`
    WITH ranked_matches AS (
      SELECT
        matches.id,
        matches.utc_date,
        matches.status,
        matches.last_synced_at,
        ROW_NUMBER() OVER (
          PARTITION BY
            matches.competition_code,
            datetime(matches.utc_date),
            lower(trim(home_team.name)),
            lower(trim(away_team.name))
          ORDER BY datetime(matches.last_synced_at) DESC, matches.id DESC
        ) AS rank_in_fixture
      FROM matches
      JOIN teams home_team ON home_team.id = matches.home_team_id
      JOIN teams away_team ON away_team.id = matches.away_team_id
      WHERE matches.competition_code IN (${APP_COMPETITION_CODES.map(() => "?").join(", ")})
        AND matches.status IN ('SCHEDULED', 'TIMED')
        AND datetime(matches.utc_date) > datetime('now')
        AND datetime(matches.utc_date) <= datetime('now', '+7 days')
        AND NOT (home_team.name = 'TBC' AND away_team.name = 'TBC')
    )
    SELECT ranked_matches.id, ranked_matches.utc_date, ranked_matches.status, home_team.name AS home_team_name, away_team.name AS away_team_name
    FROM ranked_matches
    JOIN matches ON matches.id = ranked_matches.id
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE rank_in_fixture = 1
    ORDER BY datetime(ranked_matches.utc_date) ASC
    LIMIT 60
  `).all(...APP_COMPETITION_CODES)
    .filter((match) => isEligibleForForwardRecommendation(match))
    .filter((match) => isResolvedFixtureTeams(match.home_team_name, match.away_team_name))
    .slice(0, 30);
}

function summarizeAnalysis(records) {
  const withOdds = records.filter((record) => record.hasOdds).length;
  const lowCoverage = records.filter((record) => (record.dataCoverageScore ?? 0) < 0.55).length;
  const lowConfidence = records.filter((record) => record.confidence === "Low").length;

  return {
    analyzedMatches: records.length,
    withOdds,
    withoutOdds: records.length - withOdds,
    lowCoverage,
    lowConfidence
  };
}

function averageOrNull(values, digits = 2) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? round(average(valid, 0), digits) : null;
}

function percentileOrNull(values, percentile, digits = 1) {
  const valid = values.filter(Number.isFinite).sort((left, right) => left - right);

  if (!valid.length) {
    return null;
  }

  if (valid.length === 1) {
    return round(valid[0], digits);
  }

  const bounded = Math.min(1, Math.max(0, percentile));
  const position = (valid.length - 1) * bounded;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) {
    return round(valid[lowerIndex], digits);
  }

  const weight = position - lowerIndex;
  const interpolated = valid[lowerIndex] + ((valid[upperIndex] - valid[lowerIndex]) * weight);
  return round(interpolated, digits);
}

function buildNumericDistribution(values, digits = 1) {
  const valid = values.filter(Number.isFinite);

  return {
    count: valid.length,
    min: valid.length ? round(Math.min(...valid), digits) : null,
    median: percentileOrNull(valid, 0.5, digits),
    p75: percentileOrNull(valid, 0.75, digits),
    p90: percentileOrNull(valid, 0.9, digits),
    max: valid.length ? round(Math.max(...valid), digits) : null
  };
}

function buildCollectorSummary(syncResults, analyzedMatches, availabilityImport = null, newsImport = null, advancedStatsImport = null) {
  const successfulSyncs = syncResults.filter((result) => !result.error).length;
  const failedSyncs = syncResults.filter((result) => result.error).length;

  return {
    syncedCompetitions: syncResults.length,
    successfulSyncs,
    failedSyncs,
    syncResults,
    analysis: summarizeAnalysis(analyzedMatches),
    oddsArchive: getOddsCoverageDiagnostics(),
    availability: availabilityImport,
    news: newsImport,
    advancedStats: advancedStatsImport
  };
}

export async function runCollector({ triggerSource = "manual" } = {}) {
  const run = beginCollectorRun(triggerSource);
  logger.info("Collector run started", { runId: run.id, triggerSource });

  try {
    const syncResults = await syncFreeModeData();
    let availabilityImport = null;
    let newsImport = null;
    let advancedStatsImport = null;

    try {
      availabilityImport = await importAvailabilityData();
    } catch (error) {
      logger.warn("Availability import failed", { runId: run.id, message: error.message });
    }

    try {
      newsImport = await importNewsData();
    } catch (error) {
      logger.warn("News import failed", { runId: run.id, message: error.message });
    }

    try {
      advancedStatsImport = importAdvancedStatsData();
    } catch (error) {
      logger.warn("Advanced stats import failed", { runId: run.id, message: error.message });
    }

    gradeRecommendationSnapshots();
    const training = maybeAutoTrainModel();
    const decisionTraining = maybeAutoTrainDecisionPolicies();
    refreshTeamRatings();
    const ratings = getTeamRatingsMap();
    const upcomingMatches = readUpcomingAppMatches();
    const analyzedMatches = [];

    for (const match of upcomingMatches) {
      try {
        const analysis = analyzeMatch(match.id, ratings, {
          storeReport: false,
          syncDiagnostics: syncResults
        });
        analyzedMatches.push({
          matchId: match.id,
          hasOdds: analysis.betting.market.hasOdds,
          confidence: analysis.betting.recommendation.confidence,
          dataCoverageScore: analysis.features.context.dataCoverageScore,
          trustScore: analysis.betting.bestBet?.hasBet
            ? Object.values(analysis.betting.markets).find((market) => market.name === analysis.betting.bestBet.marketName)?.trust?.score ?? null
            : analysis.betting.markets.oneXTwo.trust.score
        });
        storeRecommendationSnapshot(run.id, analysis);
      } catch (error) {
        logger.warn("Collector analysis failed", { matchId: match.id, message: error.message });
      }
    }

    const summary = {
      ...buildCollectorSummary(syncResults, analyzedMatches, availabilityImport, newsImport, advancedStatsImport),
      training,
      decisionTraining,
      systemReadiness: {
        all: snapshotSystemMetrics(null),
        cl: snapshotSystemMetrics("CL"),
        el: snapshotSystemMetrics("EL")
      }
    };
    const status = summary.failedSyncs && summary.successfulSyncs ? "partial" : summary.failedSyncs ? "failed" : "success";
    finishCollectorRun(run.id, status, summary);
    logger.info("Collector run finished", { runId: run.id, status });

    return {
      runId: run.id,
      status,
      summary
    };
  } catch (error) {
    finishCollectorRun(run.id, "failed", { syncedCompetitions: 0, analysis: summarizeAnalysis([]) }, error.message);
    logger.error("Collector run failed", { runId: run.id, message: error.message });
    throw error;
  }
}

export function getRecommendationHistory(limit = 50) {
  gradeRecommendationSnapshots();
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));

  return db.prepare(`
    SELECT
      rs.id,
      rs.generated_at,
      rs.competition_code,
      rs.best_market,
      rs.selection_label,
      rs.action,
      rs.confidence,
      rs.trust_label,
      rs.trust_score,
      rs.edge,
      rs.bookmaker_title,
      rs.bookmaker_odds,
      rs.odds_at_prediction,
      rs.odds_snapshot_at,
      rs.odds_freshness_minutes,
      rs.odds_freshness_score,
      rs.odds_refreshed_recently,
      rs.odds_coverage_status,
      rs.bookmaker_count,
      rs.stale_odds_flag,
      rs.quota_degraded_flag,
      rs.data_completeness_score,
      rs.board_provider,
      rs.board_source_label,
      rs.board_source_mode,
      rs.source_reliability_score,
      rs.board_quality_tier,
      rs.board_quality_score,
      rs.fallback_used_flag,
      rs.price_quality_status,
      rs.price_trustworthy_flag,
      rs.price_block_reasons_json,
      rs.recommendation_downgrade_reason,
      rs.market_probability,
      rs.opening_odds,
      rs.closing_odds,
      rs.closing_line_value,
      rs.fair_odds,
      rs.model_probability,
      rs.has_odds,
      rs.summary,
      rs.outcome_label,
      rs.bet_result,
      rs.is_correct,
      rs.roi,
      rs.grade_note,
      matches.utc_date,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM recommendation_snapshots rs
    JOIN matches ON matches.id = rs.match_id
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    ORDER BY datetime(rs.generated_at) DESC, rs.id DESC
    LIMIT ?
  `).all(safeLimit);
}

export function getRecommendationHistoryForMatch(matchId, limit = 8) {
  gradeRecommendationSnapshots();
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20));

  return db.prepare(`
    SELECT
      id,
      generated_at,
      best_market,
      selection_label,
      action,
      confidence,
      trust_label,
      trust_score,
      edge,
      bookmaker_title,
      bookmaker_odds,
      odds_at_prediction,
      odds_snapshot_at,
      odds_freshness_minutes,
      odds_freshness_score,
      odds_refreshed_recently,
      odds_coverage_status,
      bookmaker_count,
      stale_odds_flag,
      quota_degraded_flag,
      data_completeness_score,
      board_provider,
      board_source_mode,
      board_quality_tier,
      board_quality_score,
      fallback_used_flag,
      price_quality_status,
      price_trustworthy_flag,
      price_block_reasons_json,
      recommendation_downgrade_reason,
      market_probability,
      opening_odds,
      closing_odds,
      closing_line_value,
      fair_odds,
      model_probability,
      outcome_label,
      bet_result,
      is_correct,
      roi,
      grade_note
    FROM recommendation_snapshots
    WHERE match_id = ?
    ORDER BY datetime(generated_at) DESC, id DESC
    LIMIT ?
  `).all(matchId, safeLimit);
}

function summarizeSnapshotSet(rows) {
  const bets = rows.filter((row) => row.action !== "No Bet");
  const settledBets = bets.filter((row) => row.bet_result === "won" || row.bet_result === "lost");
  const wins = settledBets.filter((row) => row.bet_result === "won");
  const losses = settledBets.filter((row) => row.bet_result === "lost");
  const roiRows = settledBets.filter((row) => row.roi !== null && row.roi !== undefined);
  const clvRows = settledBets.filter((row) => row.closing_line_value !== null && row.closing_line_value !== undefined);
  const staleRows = rows.filter((row) => Number(row.stale_odds_flag) === 1);
  const quotaRows = rows.filter((row) => Number(row.quota_degraded_flag) === 1);
  const weakPriceRows = rows.filter((row) => Number(row.price_trustworthy_flag) !== 1);
  const strongPriceBets = bets.filter((row) => Number(row.price_trustworthy_flag) === 1);
  const weakPriceBets = bets.filter((row) => Number(row.price_trustworthy_flag) !== 1);
  const usableOrBetterMatches = rows.filter(isUsableOrBetterPriceRow);
  const strongPriceMatches = rows.filter(isStrongPriceRow);
  const reliableSourceRows = rows.filter((row) => Number.isFinite(row.source_reliability_score));

  return {
    trackedMatches: rows.length,
    bets: bets.length,
    passes: rows.length - bets.length,
    settledBets: settledBets.length,
    wins: wins.length,
    losses: losses.length,
    hitRate: settledBets.length ? round((wins.length / settledBets.length) * 100, 1) : null,
    averageEdge: bets.length ? round(average(bets.map((row) => row.edge).filter(Number.isFinite), 0), 2) : null,
    averageOdds: roiRows.length ? round(average(roiRows.map((row) => row.bookmaker_odds).filter(Number.isFinite), 0), 2) : null,
    roi: roiRows.length ? round((roiRows.reduce((sum, row) => sum + row.roi, 0) / roiRows.length) * 100, 2) : null,
    averageClv: clvRows.length ? round(average(clvRows.map((row) => row.closing_line_value).filter(Number.isFinite), 0), 2) : null,
    beatClosingLineRate: clvRows.length ? round((clvRows.filter((row) => row.closing_line_value < 0).length / clvRows.length) * 100, 1) : null,
    staleOddsMatches: staleRows.length,
    quotaDegradedMatches: quotaRows.length,
    weakPriceMatches: weakPriceRows.length,
    usableOrBetterMatches: usableOrBetterMatches.length,
    strongPriceMatches: strongPriceMatches.length,
    strongPriceBets: strongPriceBets.length,
    weakPriceBets: weakPriceBets.length,
    averageOddsFreshnessMinutes: averageOrNull(rows.map((row) => row.odds_freshness_minutes).filter(Number.isFinite), 1),
    averageDataCompletenessScore: averageOrNull(rows.map((row) => row.data_completeness_score).filter(Number.isFinite), 2),
    averageSourceReliabilityScore: reliableSourceRows.length
      ? averageOrNull(reliableSourceRows.map((row) => row.source_reliability_score).filter(Number.isFinite), 2)
      : null
  };
}

function buildProbabilityBuckets(rows) {
  const settledBets = rows.filter((row) =>
    (row.bet_result === "won" || row.bet_result === "lost") &&
    Number.isFinite(row.model_probability)
  );
  const buckets = Array.from({ length: 10 }, (_, index) => ({
    bucket: `${index * 10}-${index === 9 ? 100 : (index + 1) * 10}%`,
    lowerBound: round(index / 10, 2),
    upperBound: round(index === 9 ? 1 : (index + 1) / 10, 2),
    settledBets: 0,
    wins: 0,
    hitRate: null,
    averagePredictedProbability: null,
    averageMarketProbability: null
  }));

  for (const row of settledBets) {
    const probability = row.model_probability;
    const index = Math.min(9, Math.max(0, Math.floor(probability * 10)));
    const bucket = buckets[index];
    bucket.settledBets += 1;
    bucket.wins += row.bet_result === "won" ? 1 : 0;
    bucket.averagePredictedProbability = averageOrNull([
      ...(bucket.averagePredictedProbability === null ? [] : [bucket.averagePredictedProbability]),
      probability
    ], 4);
    if (Number.isFinite(row.market_probability)) {
      bucket.averageMarketProbability = averageOrNull([
        ...(bucket.averageMarketProbability === null ? [] : [bucket.averageMarketProbability]),
        row.market_probability
      ], 4);
    }
  }

  return buckets
    .map((bucket) => {
      const rowsInBucket = settledBets.filter((row) => {
        const probability = row.model_probability;
        const index = Math.min(9, Math.max(0, Math.floor(probability * 10)));
        return `${index * 10}-${index === 9 ? 100 : (index + 1) * 10}%` === bucket.bucket;
      });

      return {
        ...bucket,
        hitRate: bucket.settledBets ? round((bucket.wins / bucket.settledBets) * 100, 1) : null,
        averagePredictedProbability: averageOrNull(rowsInBucket.map((row) => row.model_probability).filter(Number.isFinite), 4),
        averageMarketProbability: averageOrNull(rowsInBucket.map((row) => row.market_probability).filter(Number.isFinite), 4)
      };
    })
    .filter((bucket) => bucket.settledBets > 0);
}

const EDGE_BUCKET_DEFINITIONS = [
  { label: "0-2%", min: 0, max: 2 },
  { label: "2-5%", min: 2, max: 5 },
  { label: "5-10%", min: 5, max: 10 },
  { label: "10%+", min: 10, max: Infinity }
];

function edgeBucketLabel(edge) {
  if (!Number.isFinite(edge) || edge < 0) {
    return null;
  }

  return EDGE_BUCKET_DEFINITIONS.find((bucket) => edge >= bucket.min && edge < bucket.max)?.label ?? null;
}

function buildEdgeBuckets(rows) {
  const settledBets = rows.filter((row) =>
    (row.bet_result === "won" || row.bet_result === "lost") &&
    Number.isFinite(row.edge)
  );

  return EDGE_BUCKET_DEFINITIONS.map((bucket) => {
    const bucketRows = settledBets.filter((row) => edgeBucketLabel(row.edge) === bucket.label);
    return {
      bucket: bucket.label,
      settledBets: bucketRows.length,
      hitRate: bucketRows.length
        ? round((bucketRows.filter((row) => row.bet_result === "won").length / bucketRows.length) * 100, 1)
        : null,
      averageEdge: averageOrNull(bucketRows.map((row) => row.edge).filter(Number.isFinite), 2),
      averageRoi: averageOrNull(bucketRows.map((row) => row.roi).filter(Number.isFinite), 2),
      averageClv: averageOrNull(bucketRows.map((row) => row.closing_line_value).filter(Number.isFinite), 2)
    };
  }).filter((bucket) => bucket.settledBets > 0);
}

function buildCalibrationAudit(rows) {
  const bets = rows.filter((row) => row.action !== "No Bet");
  const settledBets = bets.filter((row) => row.bet_result === "won" || row.bet_result === "lost");
  const markets = sortForwardMarkets(FORWARD_MARKET_ORDER.map((market) => ({
    market,
    settledBets: settledBets.filter((row) => row.best_market === market).length,
    probabilityBuckets: buildProbabilityBuckets(settledBets.filter((row) => row.best_market === market))
  })));

  return {
    samples: {
      trackedRows: rows.length,
      betRows: bets.length,
      settledBetRows: settledBets.length
    },
    settledBetProbabilityBuckets: buildProbabilityBuckets(settledBets),
    byMarket: markets
  };
}

function buildEdgeQualityAudit(rows) {
  const bets = rows.filter((row) => row.action !== "No Bet");
  const settledBets = bets.filter((row) => row.bet_result === "won" || row.bet_result === "lost");
  const markets = sortForwardMarkets(FORWARD_MARKET_ORDER.map((market) => ({
    market,
    settledBets: settledBets.filter((row) => row.best_market === market).length,
    edgeBuckets: buildEdgeBuckets(settledBets.filter((row) => row.best_market === market))
  })));

  return {
    samples: {
      trackedRows: rows.length,
      betRows: bets.length,
      settledBetRows: settledBets.length
    },
    settledBetEdgeBuckets: buildEdgeBuckets(settledBets),
    byMarket: markets
  };
}

function sortForwardMarkets(rows) {
  return [...rows].sort((left, right) => FORWARD_MARKET_ORDER.indexOf(left.market) - FORWARD_MARKET_ORDER.indexOf(right.market));
}

function groupByConfidence(rows, formatter) {
  return ["High", "Medium", "Low"].map((confidence) => ({
    confidence,
    ...formatter(rows.filter((row) => row.confidence === confidence))
  }));
}

function buildHistoricalValidationWarning(oddsCoverage) {
  const finishedMatchesWithPreKickoffOdds = oddsCoverage?.finishedMatchesWithPreKickoffOdds ?? 0;

  if (finishedMatchesWithPreKickoffOdds >= 100) {
    return null;
  }

  if (finishedMatchesWithPreKickoffOdds > 0) {
    return `Historical betting validation is still unavailable because only ${finishedMatchesWithPreKickoffOdds} finished matches have archived pre-kickoff odds.`;
  }

  return "Historical betting validation is still unavailable because no finished matches have archived pre-kickoff odds yet.";
}

function readQuotaImpactSummary(limit = 30) {
  const db = getDb();
  const runs = db.prepare(`
    SELECT id, started_at, status, summary_json, error_message
    FROM collector_runs
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT ?
  `).all(limit);

  let quotaImpactedRuns = 0;

  for (const run of runs) {
    const summary = run.summary_json ? JSON.parse(run.summary_json) : null;
    const syncResults = Array.isArray(summary?.syncResults) ? summary.syncResults : [];
    const runHadQuotaError = syncResults.some((entry) => String(entry?.error ?? "").includes("OUT_OF_USAGE_CREDITS") || String(entry?.error ?? "").includes("Usage quota has been reached"));

    if (runHadQuotaError) {
      quotaImpactedRuns += 1;
    }
  }

  return {
    checkedRuns: runs.length,
    quotaImpactedRuns
  };
}

function readProviderHealthSummary(limit = 30) {
  const db = getDb();
  const runs = db.prepare(`
    SELECT summary_json
    FROM collector_runs
    WHERE summary_json IS NOT NULL AND summary_json != '{}'
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT ?
  `).all(limit);
  const providers = new Map();

  for (const run of runs) {
    const summary = run.summary_json ? JSON.parse(run.summary_json) : null;
    const syncResults = Array.isArray(summary?.syncResults) ? summary.syncResults : [];

    for (const result of syncResults) {
      const diagnostics = result?.oddsDiagnostics ?? null;
      const provider = diagnostics?.provider ?? "none";
      const current = providers.get(provider) ?? {
        provider,
        requests: 0,
        successes: 0,
        quotaDegraded: 0,
        fallbacks: 0,
        oddsEvents: 0
      };

      current.requests += 1;
      if (!result?.error && provider !== "none") {
        current.successes += 1;
      }
      if (diagnostics?.quotaDegraded) {
        current.quotaDegraded += 1;
      }
      if (diagnostics?.fallbackUsed) {
        current.fallbacks += 1;
      }
      current.oddsEvents += Number(diagnostics?.oddsEvents ?? 0);

      providers.set(provider, current);
    }
  }

  return Array.from(providers.values())
    .map((entry) => ({
      provider: entry.provider,
      requests: entry.requests,
      successRate: entry.requests ? round((entry.successes / entry.requests) * 100, 1) : null,
      quotaDegradationRate: entry.requests ? round((entry.quotaDegraded / entry.requests) * 100, 1) : null,
      fallbackRate: entry.requests ? round((entry.fallbacks / entry.requests) * 100, 1) : null,
      averageOddsEvents: entry.requests ? round(entry.oddsEvents / entry.requests, 1) : null
    }))
    .sort((left, right) => right.requests - left.requests);
}

function diagnoseForwardEdgeRealism(rows) {
  const bets = rows.filter((row) => row.action !== "No Bet");
  const weakPriceBets = bets.filter((row) => Number(row.price_trustworthy_flag) !== 1);
  const usableOrBetterBets = bets.filter((row) => isUsableOrBetterPriceRow(row));
  const strongPriceBets = bets.filter((row) => isStrongPriceRow(row));
  const staleRows = rows.filter((row) => Number(row.stale_odds_flag) === 1);
  const quotaRows = rows.filter((row) => Number(row.quota_degraded_flag) === 1);
  const missingMarketProbabilityRows = rows.filter((row) => row.market_probability === null || row.market_probability === undefined);
  const averageEdge = averageOrNull(bets.map((row) => row.edge).filter(Number.isFinite), 2);
  const weakPriceRate = bets.length ? round((weakPriceBets.length / bets.length) * 100, 1) : null;
  const factors = [];

  if (bets.length < 25) {
    factors.push("The sample is still tiny, so random noise can easily inflate edge averages.");
  }

  if ((weakPriceRate ?? 0) >= 25) {
    factors.push("A large share of bets still comes from weak price-quality boards.");
  }

  if (staleRows.length > 0) {
    factors.push("Some tracked matches still relied on stale odds snapshots.");
  }

  if (quotaRows.length > 0) {
    factors.push("Provider quota limits degraded parts of the odds board.");
  }

  if (!usableOrBetterBets.length) {
    factors.push("There are still no bets backed by usable-or-better price boards.");
  } else if (!strongPriceBets.length) {
    factors.push("There are still no bets backed by truly strong price boards.");
  }

  if (missingMarketProbabilityRows.length > 0) {
    factors.push("Some older tracked rows still predate the new market-probability capture.");
  }

  if ((averageEdge ?? 0) >= 20) {
    factors.push("The model is still capable of producing aggressive model-versus-market gaps.");
  }

  let verdict = "Average edge looks fragile.";

  if (!bets.length) {
    verdict = "There are no live bets in the forward sample yet.";
  } else if (!usableOrBetterBets.length) {
    verdict = "Average edge is not believable yet because there are no clean usable-price bets in the sample.";
  } else if ((weakPriceRate ?? 0) >= 40 || staleRows.length > 0 || quotaRows.length > 0) {
    verdict = "Average edge is not fully believable yet because price quality is still uneven.";
  } else if (bets.length < 25) {
    verdict = "Average edge may be directionally useful, but the sample is still too small to trust.";
  } else {
    verdict = "Average edge looks more believable, but it still needs settled ROI and CLV proof.";
  }

  return {
    verdict,
    averageEdge,
    weakPriceBetRate: weakPriceRate,
    staleTrackedMatches: staleRows.length,
    quotaDegradedMatches: quotaRows.length,
    factors
  };
}

function parseJsonArray(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function hasMarketProbability(row) {
  return Number.isFinite(row.market_probability);
}

function hasBookmakerDepth(row) {
  if (Number.isFinite(row.bookmaker_count)) {
    return row.bookmaker_count >= 2;
  }

  return row.odds_coverage_status === "complete";
}

function isUsableOrBetterPriceRow(row) {
  return ["strong", "usable"].includes(String(row.board_quality_tier ?? "")) &&
    Number(row.stale_odds_flag) !== 1 &&
    hasMarketProbability(row) &&
    hasBookmakerDepth(row) &&
    Number(row.price_trustworthy_flag) === 1;
}

function isStrongPriceRow(row) {
  return row.board_quality_tier === "strong" &&
    Number(row.stale_odds_flag) !== 1 &&
    hasMarketProbability(row) &&
    hasBookmakerDepth(row) &&
    Number(row.price_trustworthy_flag) === 1;
}

function buildBlockReasons(row) {
  const reasons = parseJsonArray(row.price_block_reasons_json);

  if (Number(row.stale_odds_flag) === 1) {
    reasons.push("stale-odds");
  }

  if (row.board_quality_tier === "weak") {
    reasons.push("weak-board");
  }

  if (row.board_quality_tier === "unusable") {
    reasons.push("unusable-board");
  }

  if (Number(row.quota_degraded_flag) === 1) {
    reasons.push("quota-degraded");
  }

  if (!hasMarketProbability(row)) {
    reasons.push("missing-implied-probability");
  }

  if (!hasBookmakerDepth(row)) {
    reasons.push("missing-bookmaker-depth");
  }

  return [...new Set(reasons)];
}

function countBlockReasons(rows) {
  const counts = new Map();

  for (const row of rows) {
    const reasons = buildBlockReasons(row);

    if (!reasons.length) {
      counts.set("model-rejection", (counts.get("model-rejection") ?? 0) + 1);
    }

    for (const reason of reasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  return [
    "model-rejection",
    "stale-odds",
    "weak-board",
    "unusable-board",
    "quota-degraded",
    "missing-implied-probability",
    "missing-bookmaker-depth"
  ].map((reason) => ({
    reason,
    matches: counts.get(reason) ?? 0
  }));
}

function buildValidationSplit(label, rows) {
  return {
    label,
    ...summarizeSnapshotSet(rows)
  };
}

function buildOverUnderValidation(rows) {
  const totalsRows = rows.filter((row) => row.best_market === "Over / Under 2.5");
  const strongPriceRows = totalsRows.filter(isStrongPriceRow);
  const settledRows = totalsRows.filter((row) => row.bet_result === "won" || row.bet_result === "lost");
  const settledStrongPriceRows = strongPriceRows.filter((row) => row.bet_result === "won" || row.bet_result === "lost");

  return {
    allTracked: buildValidationSplit("All O/U tracked", totalsRows),
    strongPriceOnly: buildValidationSplit("Strong-price O/U only", strongPriceRows),
    settledBetsOnly: buildValidationSplit("Settled O/U bets only", settledRows),
    settledStrongPriceOnly: buildValidationSplit("Settled strong-price O/U only", settledStrongPriceRows)
  };
}

function boardTierCounts(rows) {
  return ["strong", "usable", "weak", "unusable"].map((tier) => ({
    tier,
    matches: rows.filter((row) => row.board_quality_tier === tier).length
  }));
}

function providerCounts(rows) {
  const counts = new Map();

  for (const row of rows) {
    const key = row.board_provider ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([provider, matches]) => ({ provider, matches }))
    .sort((left, right) => right.matches - left.matches);
}

function sourceReliabilityBands(rows) {
  const buckets = [
    { key: "high", min: 0.9, max: Infinity, label: "High reliability" },
    { key: "medium", min: 0.75, max: 0.9, label: "Medium reliability" },
    { key: "low", min: 0, max: 0.75, label: "Low reliability" }
  ];

  return buckets.map((bucket) => ({
    band: bucket.key,
    label: bucket.label,
    matches: rows.filter((row) => {
      const value = Number(row.source_reliability_score ?? -1);
      return value >= bucket.min && value < bucket.max;
    }).length
  }));
}

function settledBetRows(rows) {
  return rows.filter((row) =>
    row.action !== "No Bet" &&
    (row.bet_result === "won" || row.bet_result === "lost")
  );
}

function buildTrustworthySampleSize(rows) {
  const settledBets = settledBetRows(rows);

  return {
    settledBets: settledBets.length,
    settledPriceTrustworthyBets: settledBets.filter((row) => Number(row.price_trustworthy_flag) === 1).length,
    settledUsableOrBetterBets: settledBets.filter(isUsableOrBetterPriceRow).length,
    settledStrongPriceBets: settledBets.filter(isStrongPriceRow).length
  };
}

function buildMissingFieldCounts(rows) {
  return {
    missingBoardQualityTier: rows.filter((row) => row.board_quality_tier === null || row.board_quality_tier === undefined).length,
    missingMarketProbability: rows.filter((row) => !Number.isFinite(row.market_probability)).length,
    missingBookmakerCount: rows.filter((row) => !Number.isFinite(row.bookmaker_count)).length
  };
}

function summarizeOperationalSubset(rows) {
  return {
    trackedMatches: rows.length,
    staleBoards: rows.filter((row) => Number(row.stale_odds_flag) === 1).length,
    weakBoards: rows.filter((row) => row.board_quality_tier === "weak").length,
    unusableBoards: rows.filter((row) => row.board_quality_tier === "unusable").length,
    usableOrBetterBoards: rows.filter(isUsableOrBetterPriceRow).length,
    strongBoards: rows.filter(isStrongPriceRow).length,
    quotaDegradedBoards: rows.filter((row) => Number(row.quota_degraded_flag) === 1).length,
    fallbackUsedBoards: rows.filter((row) => Number(row.fallback_used_flag) === 1).length,
    freshnessDistribution: buildNumericDistribution(rows.map((row) => row.odds_freshness_minutes), 1),
    bookmakerDepthDistribution: buildNumericDistribution(rows.map((row) => row.bookmaker_count), 1),
    ...buildMissingFieldCounts(rows),
    ...buildTrustworthySampleSize(rows)
  };
}

function kickoffWindowBucket(row) {
  const generatedAt = row.generated_at ?? row.generatedAt ?? null;
  const kickoffTime = row.utc_date ?? row.utcDate ?? null;

  if (!generatedAt || !kickoffTime) {
    return "unknown";
  }

  const hours = (new Date(kickoffTime).getTime() - new Date(generatedAt).getTime()) / 3_600_000;

  if (!Number.isFinite(hours)) {
    return "unknown";
  }

  if (hours <= 1) {
    return "<=1h";
  }

  if (hours <= 3) {
    return "1-3h";
  }

  if (hours <= 6) {
    return "3-6h";
  }

  if (hours <= 24) {
    return "6-24h";
  }

  return ">24h";
}

function groupedOperationalBreakdown(rows, keys, keyName = "key") {
  const grouped = new Map();

  for (const row of rows) {
    const key = keys(row);
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }

  return Array.from(grouped.entries())
    .map(([key, subset]) => ({
      [keyName]: key,
      ...summarizeOperationalSubset(subset)
    }))
    .sort((left, right) => right.trackedMatches - left.trackedMatches || String(left[keyName]).localeCompare(String(right[keyName])));
}

function buildLatestSnapshotAgeByMatch(rows, limit = 25) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));

  return [...rows]
    .map((row) => ({
      matchId: row.match_id,
      competitionCode: row.competition_code,
      market: row.best_market,
      homeTeam: row.home_team_name,
      awayTeam: row.away_team_name,
      generatedAt: row.generated_at,
      kickoffTime: row.utc_date,
      oddsSnapshotAt: row.odds_snapshot_at,
      oddsFreshnessMinutes: row.odds_freshness_minutes,
      boardQualityTier: row.board_quality_tier,
      bookmakerCount: row.bookmaker_count,
      boardProvider: row.board_provider ?? "unknown",
      boardSourceMode: row.board_source_mode ?? "unknown",
      staleOdds: Number(row.stale_odds_flag) === 1,
      quotaDegraded: Number(row.quota_degraded_flag) === 1,
      fallbackUsed: Number(row.fallback_used_flag) === 1
    }))
    .sort((left, right) => {
      const leftFreshness = Number.isFinite(left.oddsFreshnessMinutes) ? left.oddsFreshnessMinutes : Number.NEGATIVE_INFINITY;
      const rightFreshness = Number.isFinite(right.oddsFreshnessMinutes) ? right.oddsFreshnessMinutes : Number.NEGATIVE_INFINITY;
      return rightFreshness - leftFreshness;
    })
    .slice(0, safeLimit);
}

function providerHealth(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const provider = row.board_provider ?? "unknown";
    const current = grouped.get(provider) ?? {
      provider,
      matches: 0,
      strong: 0,
      usableOrBetter: 0,
      stale: 0,
      quotaDegraded: 0,
      fallbackUsed: 0,
      averageReliability: []
    };

    current.matches += 1;
    if (row.board_quality_tier === "strong") {
      current.strong += 1;
    }
    if (isUsableOrBetterPriceRow(row)) {
      current.usableOrBetter += 1;
    }
    if (Number(row.stale_odds_flag) === 1) {
      current.stale += 1;
    }
    if (Number(row.quota_degraded_flag) === 1) {
      current.quotaDegraded += 1;
    }
    if (Number(row.fallback_used_flag) === 1) {
      current.fallbackUsed += 1;
    }
    if (Number.isFinite(row.source_reliability_score)) {
      current.averageReliability.push(row.source_reliability_score);
    }

    grouped.set(provider, current);
  }

  return Array.from(grouped.values())
    .map((entry) => ({
      provider: entry.provider,
      matches: entry.matches,
      strongBoards: entry.strong,
      usableOrBetterBoards: entry.usableOrBetter,
      staleBoards: entry.stale,
      quotaDegradedBoards: entry.quotaDegraded,
      fallbackBoards: entry.fallbackUsed,
      averageReliability: entry.averageReliability.length
        ? averageOrNull(entry.averageReliability, 2)
        : null
    }))
    .sort((left, right) => right.matches - left.matches);
}

function readCollectorRunDiagnostics(limit = 12) {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 30));
  const runs = db.prepare(`
    SELECT id, started_at, finished_at, trigger_source, status
    FROM collector_runs
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT ?
  `).all(safeLimit);
  const rowsByRun = db.prepare(`
    SELECT action, board_quality_tier, stale_odds_flag, quota_degraded_flag, fallback_used_flag,
           market_probability, bookmaker_count, price_trustworthy_flag, bet_result
    FROM recommendation_snapshots
    WHERE collector_run_id = ?
  `);

  return runs.map((run) => ({
    runId: run.id,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    triggerSource: run.trigger_source,
    status: run.status,
    ...summarizeOperationalSubset(rowsByRun.all(run.id))
  }));
}

function summarizeRunSourceEntries(entries) {
  const cacheHitZeroEventsEntries = entries.filter((entry) =>
    entry.requestStrategy === "cache-hit" &&
    Number(entry.oddsEvents ?? 0) === 0
  );
  const liveFetchZeroEventsEntries = entries.filter((entry) =>
    entry.sourceMode === "live" &&
    Number(entry.oddsEvents ?? 0) === 0
  );
  const quotaDegradedEntries = entries.filter((entry) => entry.quotaDegraded);
  const noFreshOddsForTrackedEntries = entries.filter((entry) =>
    Number(entry.trackedMatchCount ?? 0) > 0 &&
    Number(entry.oddsEvents ?? 0) === 0
  );
  const distinctRunCount = (subset) => new Set(subset.map((entry) => entry.runId)).size;
  const groupRunEntries = (keySelector, keyName) => {
    const grouped = new Map();

    for (const entry of entries) {
      const key = keySelector(entry);
      const current = grouped.get(key) ?? {
        [keyName]: key,
        entries: 0,
        trackedMatchCount: 0,
        oddsEvents: 0,
        quotaDegradedEntries: 0,
        fallbackUsedEntries: 0,
        noFreshOddsEntries: 0
      };

      current.entries += 1;
      current.trackedMatchCount += Number(entry.trackedMatchCount ?? 0);
      current.oddsEvents += Number(entry.oddsEvents ?? 0);
      if (entry.quotaDegraded) {
        current.quotaDegradedEntries += 1;
      }
      if (entry.fallbackUsed) {
        current.fallbackUsedEntries += 1;
      }
      if (Number(entry.trackedMatchCount ?? 0) > 0 && Number(entry.oddsEvents ?? 0) === 0) {
        current.noFreshOddsEntries += 1;
      }

      grouped.set(key, current);
    }

    return Array.from(grouped.values())
      .sort((left, right) => right.trackedMatchCount - left.trackedMatchCount || String(left[keyName]).localeCompare(String(right[keyName])));
  };

  return {
    totalEntries: entries.length,
    cacheHitZeroEventsEntries: cacheHitZeroEventsEntries.length,
    cacheHitZeroEventsRuns: distinctRunCount(cacheHitZeroEventsEntries),
    liveFetchZeroEventsEntries: liveFetchZeroEventsEntries.length,
    liveFetchZeroEventsRuns: distinctRunCount(liveFetchZeroEventsEntries),
    quotaDegradedEntries: quotaDegradedEntries.length,
    quotaDegradedRuns: distinctRunCount(quotaDegradedEntries),
    noFreshOddsForTrackedEntries: noFreshOddsForTrackedEntries.length,
    noFreshOddsForTrackedRuns: distinctRunCount(noFreshOddsForTrackedEntries),
    byRequestStrategy: groupRunEntries((entry) => entry.requestStrategy ?? "unknown", "requestStrategy"),
    byCompetition: groupRunEntries((entry) => entry.competitionCode ?? "unknown", "competitionCode")
  };
}

function readCollectorRunSourceDiagnostics(limit = 30) {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 60));
  const runs = db.prepare(`
    SELECT id, started_at, finished_at, trigger_source, status, summary_json
    FROM collector_runs
    WHERE summary_json IS NOT NULL AND summary_json != '{}'
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT ?
  `).all(safeLimit);

  const entries = runs.flatMap((run) => {
    const summary = run.summary_json ? JSON.parse(run.summary_json) : null;
    const syncResults = Array.isArray(summary?.syncResults) ? summary.syncResults : [];

    return syncResults
      .filter((result) => result?.oddsDiagnostics)
      .map((result) => {
        const diagnostics = result.oddsDiagnostics;
        return {
          runId: run.id,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          triggerSource: run.trigger_source,
          runStatus: run.status,
          competitionCode: result.competition ?? "unknown",
          provider: diagnostics.provider ?? "unknown",
          sourceLabel: diagnostics.sourceLabel ?? null,
          sourceMode: diagnostics.sourceMode ?? "unknown",
          requestStrategy: diagnostics.requestStrategy ?? "unknown",
          trackedMatchCount: Number(diagnostics.trackedMatchCount ?? 0),
          oddsEvents: Number(diagnostics.oddsEvents ?? 0),
          quotaDegraded: Boolean(diagnostics.quotaDegraded),
          fallbackUsed: Boolean(diagnostics.fallbackUsed),
          fromCache: Boolean(diagnostics.fromCache),
          staleCache: Boolean(diagnostics.staleCache)
        };
      });
  });

  return {
    summary: summarizeRunSourceEntries(entries),
    recentEntries: entries.slice(0, 40)
  };
}

function buildOperationalDiagnostics(rows) {
  return {
    aggregate: summarizeOperationalSubset(rows),
    freshnessDistribution: buildNumericDistribution(rows.map((row) => row.odds_freshness_minutes), 1),
    bookmakerDepthDistribution: buildNumericDistribution(rows.map((row) => row.bookmaker_count), 1),
    missingFieldCounts: buildMissingFieldCounts(rows),
    trustworthySampleSize: buildTrustworthySampleSize(rows),
    byMarket: sortForwardMarkets(FORWARD_MARKET_ORDER.map((market) => ({
      market,
      ...summarizeOperationalSubset(rows.filter((row) => row.best_market === market))
    }))),
    byProvider: groupedOperationalBreakdown(rows, (row) => row.board_provider ?? "unknown", "provider"),
    byCompetition: groupedOperationalBreakdown(rows, (row) => row.competition_code ?? "unknown", "competitionCode"),
    byProviderSource: groupedOperationalBreakdown(rows, (row) => {
      const provider = row.board_provider ?? "unknown";
      const sourceMode = row.board_source_mode ?? "unknown";
      return `${provider} / ${sourceMode}`;
    }, "providerSource"),
    byProviderCompetition: groupedOperationalBreakdown(rows, (row) => {
      const competition = row.competition_code ?? "unknown";
      const provider = row.board_provider ?? "unknown";
      return `${competition} / ${provider}`;
    }, "providerCompetition"),
    byKickoffWindow: groupedOperationalBreakdown(rows, kickoffWindowBucket, "kickoffWindow"),
    latestSnapshotAgeByMatch: buildLatestSnapshotAgeByMatch(rows),
    recentCollectorRuns: readCollectorRunDiagnostics(),
    runSourceDiagnostics: readCollectorRunSourceDiagnostics()
  };
}

function readLatestForwardRows(limit = 300, competitionCode = null) {
  const db = getDb();
  const safeLimit = Math.max(50, Math.min(Number(limit) || 300, 1000));
  const competitionClause = competitionCode ? "AND rs.competition_code = ?" : "";
  const semanticPriceContextSql = `
    CASE
      WHEN rs.board_quality_tier IS NOT NULL
        AND (
          rs.market_probability IS NOT NULL
          OR rs.bookmaker_count IS NOT NULL
          OR rs.odds_coverage_status IS NOT NULL
          OR rs.board_provider IS NOT NULL
        )
      THEN 1
      ELSE 0
    END
  `;

  return db.prepare(`
      WITH latest_pre_kickoff AS (
        SELECT
          rs.*,
          matches.utc_date,
          home_team.name AS home_team_name,
          away_team.name AS away_team_name,
          ROW_NUMBER() OVER (
            PARTITION BY rs.match_id
            ORDER BY ${semanticPriceContextSql} DESC, datetime(rs.generated_at) DESC, rs.id DESC
          ) AS rank_per_match
        FROM recommendation_snapshots rs
        JOIN matches ON matches.id = rs.match_id
        JOIN teams home_team ON home_team.id = matches.home_team_id
      JOIN teams away_team ON away_team.id = matches.away_team_id
      WHERE datetime(rs.generated_at) <= datetime(matches.utc_date)
        ${competitionClause}
    )
    SELECT *
    FROM latest_pre_kickoff
    WHERE rank_per_match = 1
    ORDER BY datetime(generated_at) DESC, id DESC
    LIMIT ?
  `).all(...(competitionCode ? [competitionCode, safeLimit] : [safeLimit]));
}

export function getForwardValidationReport(limit = 300, competitionCode = null) {
  gradeRecommendationSnapshots();
  const rows = readLatestForwardRows(limit, competitionCode);
  const strongPriceRows = rows.filter(isStrongPriceRow);
  const usableOrBetterRows = rows.filter(isUsableOrBetterPriceRow);
  const bets = rows.filter((row) => row.action !== "No Bet");
  const settledBets = bets.filter((row) => row.bet_result === "won" || row.bet_result === "lost");
  const settledStrongPriceBets = settledBets.filter(isStrongPriceRow);
  const oddsCoverage = getOddsCoverageDiagnostics();
  const historicalValidationWarning = buildHistoricalValidationWarning(oddsCoverage);
  const quotaImpact = readQuotaImpactSummary();
  const providerRequestHealth = readProviderHealthSummary();
  const edgeDiagnosis = diagnoseForwardEdgeRealism(rows);
  const allTrackedSummary = summarizeSnapshotSet(rows);
  const strongPriceSummary = summarizeSnapshotSet(strongPriceRows);
  const usableOrBetterSummary = summarizeSnapshotSet(usableOrBetterRows);
  const calibrationAudit = buildCalibrationAudit(rows);
  const edgeQualityAudit = buildEdgeQualityAudit(rows);
  const operationalDiagnostics = buildOperationalDiagnostics(rows);
  const byMarket = sortForwardMarkets(FORWARD_MARKET_ORDER.map((market) => ({
    market,
    marketRole: market === "Over / Under 2.5" ? "primary" : market === "BTTS" ? "experimental" : "secondary",
    ...summarizeSnapshotSet(rows.filter((row) => row.best_market === market))
  })));
  const byConfidence = groupByConfidence(rows, summarizeSnapshotSet);
  const staleTrackedMatches = allTrackedSummary.staleOddsMatches;
  const quotaDegradedMatches = allTrackedSummary.quotaDegradedMatches;
  const weakPriceMatches = allTrackedSummary.weakPriceMatches;
  const unusableBoardMatches = rows.filter((row) => String(row.board_quality_tier ?? "") === "unusable").length;
  const weakBoardMatches = rows.filter((row) => String(row.board_quality_tier ?? "") === "weak").length;
  const strongPriceBets = allTrackedSummary.strongPriceBets;
  const weakPriceBets = allTrackedSummary.weakPriceBets;
  const blockDiagnostics = countBlockReasons(rows.filter((row) => row.action === "No Bet"));
  const warnings = [
    ...(historicalValidationWarning ? [historicalValidationWarning] : []),
    ...((oddsCoverage?.warnings ?? []).filter((warning) => !historicalValidationWarning || warning !== historicalValidationWarning))
  ];

  if (staleTrackedMatches > 0) {
    warnings.push(`${staleTrackedMatches} tracked matches are using stale odds snapshots.`);
  }

  if (quotaDegradedMatches > 0) {
    warnings.push(`${quotaDegradedMatches} tracked matches were captured under quota-degraded odds coverage.`);
  }

  if ((weakBoardMatches + unusableBoardMatches) > 0) {
    warnings.push(`${weakBoardMatches + unusableBoardMatches} tracked matches were blocked by weak or unusable price boards.`);
  }

  if (weakPriceBets > 0) {
    warnings.push(`${weakPriceBets} forward bets come from weak price-quality conditions and should not be trusted like clean board bets.`);
  }

  if (!strongPriceSummary.bets) {
    warnings.push("There are still no strong-price betting opportunities in the tracked forward sample.");
  }

  return {
    generatedAt: isoNow(),
    sampleSize: rows.length,
    historicalValidationAvailable: !historicalValidationWarning,
    warnings,
    marketPriority: [
      { market: "Over / Under 2.5", role: "primary", note: "This is the main forward-validation market." },
      { market: "1X2", role: "secondary", note: "This stays conservative and calibrated." },
      { market: "BTTS", role: "experimental", note: "This is tracked, but it should not be treated as core evidence yet." }
    ],
    summary: {
      ...allTrackedSummary,
      averageImpliedMarketProbability: averageOrNull(rows.map((row) => row.market_probability).filter(Number.isFinite), 4),
      averageModelProbability: averageOrNull(rows.map((row) => row.model_probability).filter(Number.isFinite), 4),
      weakBoardMatches,
      unusableBoardMatches,
      blockedByPriceQuality: rows.filter((row) => row.action === "No Bet" && buildBlockReasons(row).length > 0).length
    },
    validationSplits: {
      allTracked: buildValidationSplit("All tracked matches", rows),
      strongPriceOnly: buildValidationSplit("Strong-price only", strongPriceRows),
      usableOrBetterOnly: buildValidationSplit("Usable-or-better only", usableOrBetterRows),
      settledOnly: buildValidationSplit("Settled bets only", settledBets),
      settledStrongPriceOnly: buildValidationSplit("Settled strong-price bets only", settledStrongPriceBets)
    },
    overUnderValidation: buildOverUnderValidation(rows),
    priceQuality: {
      staleTrackedMatches,
      quotaDegradedMatches,
      weakPriceMatches,
      weakBoardMatches,
      unusableBoardMatches,
      strongPriceBets,
      weakPriceBets,
      averageOddsFreshnessMinutes: averageOrNull(rows.map((row) => row.odds_freshness_minutes).filter(Number.isFinite), 1),
      averageDataCompletenessScore: averageOrNull(rows.map((row) => row.data_completeness_score).filter(Number.isFinite), 2),
      averageSourceReliabilityScore: averageOrNull(rows.map((row) => row.source_reliability_score).filter(Number.isFinite), 2),
      averageBookmakerDepth: averageOrNull(rows.map((row) => row.bookmaker_count).filter(Number.isFinite), 1),
      usableBoardRate: rows.length ? round((usableOrBetterRows.length / rows.length) * 100, 1) : null,
      strongBoardRate: rows.length ? round((strongPriceRows.length / rows.length) * 100, 1) : null,
      boardQualityTiers: boardTierCounts(rows),
      providers: providerCounts(rows),
      providerHealth: providerHealth(rows),
      providerRequestHealth,
      sourceReliabilityBands: sourceReliabilityBands(rows),
      fallbackUsedMatches: rows.filter((row) => Number(row.fallback_used_flag) === 1).length,
      blockedMatchesDueToUnusableBoards: unusableBoardMatches,
      blockedMatchesDueToWeakBoards: weakBoardMatches,
      blockedMatchesDueToPriceQuality: rows.filter((row) => row.action === "No Bet" && buildBlockReasons(row).length > 0).length,
      quotaImpactedCollectorRuns: quotaImpact.quotaImpactedRuns,
      checkedCollectorRuns: quotaImpact.checkedRuns
    },
      blockDiagnostics: {
        blockedMatches: rows.filter((row) => row.action === "No Bet").length,
        counts: blockDiagnostics
      },
      operationalDiagnostics,
      calibrationAudit,
      edgeDiagnosis,
      edgeQualityAudit,
    byMarket,
    byConfidence,
    recent: rows.slice(0, 20).map((row) => ({
      id: row.id,
      matchId: row.match_id,
      generatedAt: row.generated_at,
      kickoffTime: row.utc_date,
      competitionCode: row.competition_code,
      homeTeam: row.home_team_name,
      awayTeam: row.away_team_name,
      market: row.best_market,
      recommendationTier: row.action,
      selectionLabel: row.selection_label,
      confidence: row.confidence,
      trustLabel: row.trust_label,
      trustScore: row.trust_score,
      edge: row.edge,
      bookmakerOddsAtPrediction: row.odds_at_prediction,
      bookmakerTitle: row.bookmaker_title,
      impliedMarketProbability: row.market_probability,
      modelProbability: row.model_probability,
      oddsFreshnessMinutes: row.odds_freshness_minutes,
      oddsFreshnessScore: row.odds_freshness_score,
      oddsRefreshedRecently: Boolean(row.odds_refreshed_recently),
      oddsCoverageStatus: row.odds_coverage_status,
      bookmakerCount: row.bookmaker_count,
      staleOdds: Boolean(row.stale_odds_flag),
      quotaDegraded: Boolean(row.quota_degraded_flag),
      dataCompletenessScore: row.data_completeness_score,
      boardProvider: row.board_provider,
      boardSourceLabel: row.board_source_label,
      boardSourceMode: row.board_source_mode,
      sourceReliabilityScore: row.source_reliability_score,
      boardQualityTier: row.board_quality_tier,
      boardQualityScore: row.board_quality_score,
      fallbackUsed: Boolean(row.fallback_used_flag),
      priceQualityStatus: row.price_quality_status,
      priceTrustworthy: Boolean(row.price_trustworthy_flag),
      blockReasons: buildBlockReasons(row),
      recommendationDowngradeReason: row.recommendation_downgrade_reason,
      openingOdds: row.opening_odds,
      closingOdds: row.closing_odds,
      closingLineValue: row.closing_line_value,
      result: row.outcome_label,
      roi: row.roi
    })),
    oddsArchive: {
      historicalValidationAvailable: !historicalValidationWarning,
      finishedMatchesWithPreKickoffOdds: oddsCoverage.finishedMatchesWithPreKickoffOdds,
      finishedMatchesWithClosingOdds: oddsCoverage.finishedMatchesWithClosingOdds,
      finishedCoveragePct: oddsCoverage.finishedCoveragePct,
      closingCoveragePct: oddsCoverage.closingCoveragePct
    }
  };
}

function snapshotSystemMetrics(competitionCode = null) {
  const dashboard = getPerformanceDashboard(100, competitionCode);
  const blindTest = runBlindEvaluation(competitionCode, 150);
  const modelStatus = getModelTrainingStatus();
  const decisionPolicyStatus = getDecisionPolicyStatus();
  const trustReadiness = buildTrustReadiness({
    competitionCode,
    dashboard,
    blindTest,
    modelStatus,
    decisionPolicyStatus
  });

  saveSystemMetricSnapshot({
    scope: competitionCode ? "competition" : "all",
    competitionCode,
    trustReadiness,
    dashboard,
    blindTest
  });

  return trustReadiness;
}

export function getPerformanceDashboard(limit = 100, competitionCode = null) {
  gradeRecommendationSnapshots();
  const db = getDb();
  const safeLimit = Math.max(20, Math.min(Number(limit) || 100, 300));
  const competitionClause = competitionCode ? "AND rs.competition_code = ?" : "";
  const rows = db.prepare(`
    WITH latest_pre_kickoff AS (
      SELECT
        rs.*,
        matches.utc_date,
        home_team.name AS home_team_name,
        away_team.name AS away_team_name,
        ROW_NUMBER() OVER (
          PARTITION BY rs.match_id
          ORDER BY datetime(rs.generated_at) DESC, rs.id DESC
        ) AS rank_per_match
      FROM recommendation_snapshots rs
      JOIN matches ON matches.id = rs.match_id
      JOIN teams home_team ON home_team.id = matches.home_team_id
      JOIN teams away_team ON away_team.id = matches.away_team_id
      WHERE matches.status = 'FINISHED'
        AND matches.home_score IS NOT NULL
        AND matches.away_score IS NOT NULL
        AND rs.bet_result IS NOT NULL
        AND datetime(rs.generated_at) <= datetime(matches.utc_date)
        ${competitionClause}
    )
    SELECT *
    FROM latest_pre_kickoff
    WHERE rank_per_match = 1
    ORDER BY datetime(utc_date) DESC, id DESC
    LIMIT ?
  `).all(...(competitionCode ? [competitionCode, safeLimit] : [safeLimit]));

  const byMarket = sortForwardMarkets(FORWARD_MARKET_ORDER.map((marketName) => ({
    market: marketName,
    ...summarizeSnapshotSet(rows.filter((row) => row.best_market === marketName))
  })));
  const byTrust = ["Strong", "Fair", "Fragile"].map((trustLabel) => ({
    trustLabel,
    ...summarizeSnapshotSet(rows.filter((row) => row.trust_label === trustLabel))
  }));

  return {
    summary: summarizeSnapshotSet(rows),
    forwardValidationWarning: buildHistoricalValidationWarning(getOddsCoverageDiagnostics()),
    byMarket,
    byTrust,
    recent: rows.slice(0, 12).map((row) => ({
      id: row.id,
      matchId: row.match_id,
      utcDate: row.utc_date,
      homeTeam: row.home_team_name,
      awayTeam: row.away_team_name,
      market: row.best_market,
      selection: row.selection_label,
      action: row.action,
      confidence: row.confidence,
      trustLabel: row.trust_label,
      edge: row.edge,
      bookmakerTitle: row.bookmaker_title,
      bookmakerOdds: row.bookmaker_odds,
      oddsAtPrediction: row.odds_at_prediction,
      oddsSnapshotAt: row.odds_snapshot_at,
      marketProbability: row.market_probability,
      openingOdds: row.opening_odds,
      closingOdds: row.closing_odds,
      closingLineValue: row.closing_line_value,
      outcomeLabel: row.outcome_label,
      betResult: row.bet_result,
      roi: row.roi,
      gradeNote: row.grade_note
    }))
  };
}

export function getCollectorStatus() {
  const db = getDb();
  const latestRun = db.prepare(`
    SELECT *
    FROM collector_runs
    ORDER BY datetime(started_at) DESC
    LIMIT 1
  `).get();

  const summary = latestRun?.summary_json ? JSON.parse(latestRun.summary_json) : null;
  const totalRuns = db.prepare("SELECT COUNT(*) AS count FROM collector_runs").get().count;

  return {
    latestRun: latestRun
      ? {
          id: latestRun.id,
          startedAt: latestRun.started_at,
          finishedAt: latestRun.finished_at,
          triggerSource: latestRun.trigger_source,
          status: latestRun.status,
          errorMessage: latestRun.error_message,
          summary
        }
      : null,
    totalRuns
  };
}
