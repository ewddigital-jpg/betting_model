import { getDb } from "../../db/database.js";
import { average, impliedProbability, round } from "../../lib/math.js";
import { isoNow } from "../../lib/time.js";

function sourceReliabilityScore(provider, sourceMode = "live") {
  if (provider === "odds-api" && sourceMode === "live") {
    return 0.94;
  }

  if (provider === "odds-api" && sourceMode === "cache") {
    return 0.84;
  }

  if (provider === "sportmonks-odds" && sourceMode === "live") {
    return 0.92;
  }

  if (provider === "local-export" || sourceMode === "licensed-import") {
    return 0.87;
  }

  if (provider === "trusted-cache" || sourceMode === "trusted_cache" || sourceMode === "cache") {
    return 0.72;
  }

  return 0;
}

function requiredPriceCount(market) {
  return market === "h2h" ? 3 : 2;
}

function acceptableFreshnessMinutes(kickoffTime, now = isoNow()) {
  if (!kickoffTime) {
    return 180;
  }

  const hoursToKickoff = Math.max(0, (new Date(kickoffTime).getTime() - new Date(now).getTime()) / 3_600_000);

  if (hoursToKickoff <= 1) {
    return 3;
  }

  if (hoursToKickoff <= 2) {
    return 5;
  }

  if (hoursToKickoff <= 3) {
    return 8;
  }

  if (hoursToKickoff <= 6) {
    return 12;
  }

  if (hoursToKickoff <= 24) {
    return 30;
  }

  return 180;
}

function completenessForRow(row, market) {
  const priceFields = market === "h2h"
    ? [row.home_price, row.draw_price, row.away_price]
    : [row.home_price, row.away_price];
  const present = priceFields.filter((value) => Number.isFinite(value) && value > 0).length;

  return present / requiredPriceCount(market);
}

function normalizedProbabilities(row, market) {
  const raw = market === "h2h"
    ? [row.home_price, row.draw_price, row.away_price]
    : [row.home_price, row.away_price];
  const implied = raw.map((price) => impliedProbability(price)).filter((value) => Number.isFinite(value) && value > 0);

  if (implied.length !== requiredPriceCount(market)) {
    return null;
  }

  const total = implied.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }

  return implied.map((value) => value / total);
}

function impliedConsistencyScore(rows, market) {
  const normalized = rows.map((row) => normalizedProbabilities(row, market)).filter(Boolean);

  if (!normalized.length) {
    return 0;
  }

  if (normalized.length === 1) {
    return 0.35;
  }

  const dimensions = requiredPriceCount(market);
  const deviations = [];

  for (let index = 0; index < dimensions; index += 1) {
    const values = normalized.map((entry) => entry[index]);
    const mean = average(values, 0);
    const avgDeviation = average(values.map((value) => Math.abs(value - mean)), 0);
    deviations.push(avgDeviation);
  }

  const avgDeviation = average(deviations, 0);
  return Math.max(0, round(1 - Math.min(1, avgDeviation / 0.12), 2));
}

function bookmakerDepthScore(bookmakerCount) {
  if (bookmakerCount >= 4) {
    return 1;
  }

  if (bookmakerCount === 3) {
    return 0.82;
  }

  if (bookmakerCount === 2) {
    return 0.58;
  }

  if (bookmakerCount === 1) {
    return 0.2;
  }

  return 0;
}

function rowSourceReliability(rows, fallbackProvider, fallbackMode) {
  const values = rows.map((row) => sourceReliabilityScore(
    row.source_provider ?? row.sourceProvider ?? fallbackProvider,
    row.source_mode ?? row.sourceMode ?? fallbackMode
  )).filter(Number.isFinite);

  return values.length ? round(average(values, 0), 2) : sourceReliabilityScore(fallbackProvider, fallbackMode);
}

function boardTierRank(tier) {
  if (tier === "strong") {
    return 4;
  }

  if (tier === "usable") {
    return 3;
  }

  if (tier === "weak") {
    return 2;
  }

  if (tier === "unusable") {
    return 1;
  }

  return 0;
}

function selectionDefinitions(market) {
  if (market === "h2h") {
    return [
      { key: "home", priceField: "home_price" },
      { key: "draw", priceField: "draw_price" },
      { key: "away", priceField: "away_price" }
    ];
  }

  return [
    { key: "home", priceField: "home_price" },
    { key: "away", priceField: "away_price" }
  ];
}

export function summarizeOddsBoardRows(rows, market) {
  const selections = selectionDefinitions(market).map((selection) => {
    const prices = rows
      .map((row) => row?.[selection.priceField] ?? null)
      .filter((value) => Number.isFinite(value) && value > 0);
    const averagePrice = prices.length ? round(average(prices, 0), 2) : null;
    const bestPrice = prices.length ? round(Math.max(...prices), 2) : null;

    return {
      selection: selection.key,
      bestPrice,
      averagePrice,
      impliedProbability: averagePrice ? round(impliedProbability(averagePrice), 4) : null
    };
  });

  return {
    selections,
    bestPrice: selections.reduce((best, selection) => {
      if (!Number.isFinite(selection.bestPrice)) {
        return best;
      }

      return best === null ? selection.bestPrice : Math.max(best, selection.bestPrice);
    }, null),
    averagePrice: averageOrNull(selections.map((selection) => selection.averagePrice).filter(Number.isFinite), 2),
    impliedProbability: averageOrNull(selections.map((selection) => selection.impliedProbability).filter(Number.isFinite), 4)
  };
}

function averageOrNull(values, digits = 2) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? round(average(valid, 0), digits) : null;
}

export function shouldPromoteBoard(candidateBoard, existingBoard) {
  if (!candidateBoard) {
    return false;
  }

  if (!existingBoard) {
    return true;
  }

  const candidateTier = boardTierRank(candidateBoard.boardQualityTier ?? candidateBoard.tier);
  const existingTier = boardTierRank(existingBoard.board_quality_tier ?? existingBoard.boardQualityTier ?? existingBoard.tier);

  if (candidateTier !== existingTier) {
    return candidateTier > existingTier;
  }

  const candidateScore = Number(candidateBoard.boardQualityScore ?? candidateBoard.score ?? 0);
  const existingScore = Number(existingBoard.board_quality_score ?? existingBoard.boardQualityScore ?? existingBoard.score ?? 0);

  if (candidateScore > existingScore + 0.03) {
    return true;
  }

  const candidateRecordedAt = candidateBoard.boardRecordedAt ?? candidateBoard.board_recorded_at ?? null;
  const existingRecordedAt = existingBoard.board_recorded_at ?? existingBoard.boardRecordedAt ?? null;

  if (!candidateRecordedAt) {
    return false;
  }

  if (!existingRecordedAt) {
    return true;
  }

  return new Date(candidateRecordedAt).getTime() > new Date(existingRecordedAt).getTime() &&
    candidateScore >= existingScore - 0.02;
}

export function scoreOddsBoard(rows, market, options = {}) {
  const kickoffTime = options.kickoffTime ?? null;
  const now = options.now ?? isoNow();
  const quotaDegraded = Boolean(options.quotaDegraded);
  const sourceProvider = options.sourceProvider ?? "unknown";
  const sourceMode = options.sourceMode ?? "live";
  const bookmakerCount = rows.length;

  if (!bookmakerCount) {
    return {
      tier: "unusable",
      score: 0,
      bookmakerCount: 0,
      freshnessMinutes: null,
      completenessScore: 0,
      impliedConsistencyScore: 0,
      sourceReliabilityScore: sourceReliabilityScore(sourceProvider, sourceMode),
      refreshedRecently: false,
      acceptableFreshnessMinutes: acceptableFreshnessMinutes(kickoffTime, now),
      coverageStatus: "missing"
    };
  }

  const freshnessTarget = acceptableFreshnessMinutes(kickoffTime, now);
  const ages = rows
    .map((row) => row.retrieved_at ?? row.retrievedAt ?? null)
    .filter(Boolean)
    .map((value) => Math.max(0, (new Date(now).getTime() - new Date(value).getTime()) / 60000));
  const freshnessMinutes = ages.length ? round(average(ages, 0), 1) : null;
  const freshnessScore = freshnessMinutes === null
    ? 0
    : freshnessMinutes <= freshnessTarget
      ? 1
      : freshnessMinutes <= freshnessTarget * 2
        ? 0.55
        : freshnessMinutes <= freshnessTarget * 4
          ? 0.25
          : 0;
  const completenessScore = round(average(rows.map((row) => completenessForRow(row, market)), 0), 2);
  const consistencyScore = impliedConsistencyScore(rows, market);
  const coverageScore = bookmakerDepthScore(bookmakerCount);
  const reliabilityScore = rowSourceReliability(rows, sourceProvider, sourceMode);
  const coverageStatus = bookmakerCount >= 3 ? "complete" : bookmakerCount >= 1 ? "partial" : "missing";
  const quotaPenalty = quotaDegraded ? 0.2 : 0;
  const score = Math.max(
    0,
    round(
      (coverageScore * 0.25) +
      (freshnessScore * 0.3) +
      (completenessScore * 0.2) +
      (consistencyScore * 0.15) +
      (reliabilityScore * 0.1) -
      quotaPenalty,
      2
    )
  );
  const refreshedRecently = freshnessMinutes !== null && freshnessMinutes <= freshnessTarget;
  const completenessCap = completenessScore < 0.75
    ? "unusable"
    : completenessScore < 0.95
      ? "weak"
      : null;
  const baseTier = bookmakerCount < 2
    ? score >= 0.72
      ? "weak"
      : "unusable"
    : score >= 0.82
      ? "strong"
      : score >= 0.62
        ? "usable"
        : score >= 0.45
          ? "weak"
          : "unusable";
  const tier = completenessCap
    ? boardTierRank(completenessCap) < boardTierRank(baseTier)
      ? completenessCap
      : baseTier
    : baseTier;

  return {
    tier,
    score,
    bookmakerCount,
    freshnessMinutes,
    completenessScore,
    impliedConsistencyScore: consistencyScore,
    sourceReliabilityScore: reliabilityScore,
    refreshedRecently,
    acceptableFreshnessMinutes: freshnessTarget,
    coverageStatus
  };
}

export function upsertOddsMarketBoard(board) {
  const db = getDb();
  db.prepare(`
    INSERT INTO odds_market_boards (
      match_id, market, source_provider, source_label, source_mode, source_reliability_score, board_quality_tier, board_quality_score,
      bookmaker_count, freshness_minutes, completeness_score, implied_consistency_score,
      quota_degraded_flag, board_recorded_at, board_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, market, source_mode) DO UPDATE SET
      source_provider = excluded.source_provider,
      source_label = excluded.source_label,
      source_reliability_score = excluded.source_reliability_score,
      board_quality_tier = excluded.board_quality_tier,
      board_quality_score = excluded.board_quality_score,
      bookmaker_count = excluded.bookmaker_count,
      freshness_minutes = excluded.freshness_minutes,
      completeness_score = excluded.completeness_score,
      implied_consistency_score = excluded.implied_consistency_score,
      quota_degraded_flag = excluded.quota_degraded_flag,
      board_recorded_at = excluded.board_recorded_at,
      board_json = excluded.board_json,
      updated_at = excluded.updated_at
  `).run(
    board.matchId,
    board.market,
    board.sourceProvider,
    board.sourceLabel ?? null,
    board.sourceMode,
    board.sourceReliabilityScore ?? null,
    board.boardQualityTier,
    board.boardQualityScore,
    board.bookmakerCount,
    board.freshnessMinutes,
    board.completenessScore,
    board.impliedConsistencyScore,
    board.quotaDegraded ? 1 : 0,
    board.boardRecordedAt ?? null,
    JSON.stringify(board.rows),
    isoNow()
  );
}

export function readOddsMarketBoard(matchId, market, sourceMode = "trusted_cache") {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM odds_market_boards
    WHERE match_id = ?
      AND market = ?
      AND source_mode = ?
    LIMIT 1
  `).get(matchId, market, sourceMode);

  if (!row) {
    return null;
  }

  return {
    ...row,
    rows: JSON.parse(row.board_json),
    boardSummary: summarizeOddsBoardRows(JSON.parse(row.board_json), market)
  };
}
