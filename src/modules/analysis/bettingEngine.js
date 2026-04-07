import { env } from "../../config/env.js";
import { getDb } from "../../db/database.js";
import { isResolvedFixtureTeams } from "../../lib/fixtures.js";
import { average, impliedProbability, round } from "../../lib/math.js";
import { hoursBetween } from "../../lib/time.js";
import { readOddsMarketBoard, scoreOddsBoard } from "../data/oddsBoardService.js";
import { getActiveDecisionPolicy, normalizeDecisionPolicy } from "./decisionPolicyParameters.js";
import { getLatestSystemMetricSnapshot } from "./systemMetricsService.js";

const MARKET_DEFINITIONS = {
  oneXTwo: {
    key: "oneXTwo",
    name: "1X2",
    snapshotMarket: "h2h",
    role: "secondary"
  },
  totals25: {
    key: "totals25",
    name: "Over / Under 2.5",
    snapshotMarket: "totals_2_5",
    role: "primary"
  },
  btts: {
    key: "btts",
    name: "BTTS",
    snapshotMarket: "btts",
    role: "experimental"
  }
};

function resolveDecisionPolicy(overrides = null) {
  if (overrides) {
    return normalizeDecisionPolicy(overrides);
  }

  return getActiveDecisionPolicy().policy;
}

function fairOdds(probability) {
  return Number.isFinite(probability) && probability > 0 && probability <= 1
    ? round(1 / probability, 2)
    : null;
}

function confidenceFromScore(score) {
  if (score >= 3) {
    return "High";
  }

  if (score >= 1) {
    return "Medium";
  }

  return "Low";
}

function downgradeConfidenceLabel(label, steps = 1) {
  const scale = ["Low", "Medium", "High"];
  const index = scale.indexOf(label);

  if (index === -1) {
    return label;
  }

  return scale[Math.max(0, index - steps)];
}

function downgradeAction(action, steps = 1) {
  const scale = ["No Bet", "Small Edge", "Playable Edge", "Strong Value"];
  const index = scale.indexOf(action);

  if (index === -1) {
    return action;
  }

  return scale[Math.max(0, index - steps)];
}

function acceptableOddsAgeMinutes(hoursToKickoff) {
  if (hoursToKickoff !== null && hoursToKickoff <= 1) {
    return 3;
  }

  if (hoursToKickoff !== null && hoursToKickoff <= 2) {
    return 5;
  }

  if (hoursToKickoff !== null && hoursToKickoff <= 3) {
    return 8;
  }

  if (hoursToKickoff !== null && hoursToKickoff <= 6) {
    return 12;
  }

  if (hoursToKickoff !== null && hoursToKickoff <= 24) {
    return 30;
  }

  return 180;
}

function coverageStatusForBookmakers(bookmakerCount) {
  if (bookmakerCount >= 3) {
    return "complete";
  }

  if (bookmakerCount >= 1) {
    return "partial";
  }

  return "missing";
}

function minimumBookmakerDepth(marketKey) {
  return marketKey === "oneXTwo" ? 2 : 2;
}

function readLatestCollectorSyncDiagnostics(competitionCode) {
  const db = getDb();
  const latestRun = db.prepare(`
    SELECT summary_json
    FROM collector_runs
    WHERE summary_json IS NOT NULL AND summary_json != '{}'
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT 1
  `).get();

  if (!latestRun?.summary_json) {
    return {
      quotaDegraded: false,
      syncFailed: false,
      providerError: null
    };
  }

  try {
    const summary = JSON.parse(latestRun.summary_json);
    const syncResults = Array.isArray(summary?.syncResults) ? summary.syncResults : [];
    const result = syncResults.find((entry) => entry?.competition === competitionCode) ?? null;
    const errorText = String(result?.error ?? "");
    const quotaDegraded = errorText.includes("OUT_OF_USAGE_CREDITS") || errorText.includes("Usage quota has been reached");

    return {
      quotaDegraded,
      syncFailed: Boolean(result?.error),
      providerError: result?.error ?? null
    };
  } catch {
    return {
      quotaDegraded: false,
      syncFailed: false,
      providerError: null
    };
  }
}

function resolveSyncDiagnostics(competitionCode, syncDiagnostics = null) {
  if (Array.isArray(syncDiagnostics)) {
    const result = syncDiagnostics.find((entry) => entry?.competition === competitionCode) ?? null;
    const errorText = String(result?.error ?? "");

    return {
      quotaDegraded: errorText.includes("OUT_OF_USAGE_CREDITS") || errorText.includes("Usage quota has been reached"),
      syncFailed: Boolean(result?.error),
      providerError: result?.error ?? null
    };
  }

  return readLatestCollectorSyncDiagnostics(competitionCode);
}

function quotaPenaltyAppliesToBoard(syncDiagnostics, board = null) {
  if (!syncDiagnostics?.quotaDegraded) {
    return false;
  }

  const provider = board?.provider ?? "odds-api";
  const sourceMode = board?.sourceMode ?? "live";

  return provider === "odds-api" && sourceMode === "live";
}

function buildPriceQualityPackage(marketKey, bestOption, rows, selectedBookmaker, context, features, board = null) {
  const bookmakerCount = rows.length;
  const hoursToKickoff = features?.context?.hoursToKickoff ?? null;
  const syncDiagnostics = resolveSyncDiagnostics(features?.match?.competition_code, context.syncDiagnostics);
  const boardQuotaDegraded = quotaPenaltyAppliesToBoard(syncDiagnostics, board);
  const liveBoardQuality = board?.quality ?? scoreOddsBoard(
    collapseLatestPerBookmaker(rows.map((row) => ({
      bookmaker_key: row.bookmakerKey,
      bookmaker_title: row.bookmakerTitle,
      source_provider: row.sourceProvider ?? null,
      source_label: row.sourceLabel ?? null,
      home_price: row.homeOdds,
      draw_price: row.drawOdds,
      away_price: row.awayOdds,
      is_live: row.isLive ? 1 : 0,
      retrieved_at: row.retrievedAt
    }))),
    MARKET_DEFINITIONS[marketKey].snapshotMarket,
    {
      kickoffTime: features?.match?.utc_date ?? null,
      quotaDegraded: boardQuotaDegraded
    }
  );
  const ageMinutes = liveBoardQuality.freshnessMinutes;
  const freshnessTargetMinutes = liveBoardQuality.acceptableFreshnessMinutes;
  const refreshedRecently = liveBoardQuality.refreshedRecently;
  const coverageStatus = liveBoardQuality.coverageStatus;
  const hasBookmakerOdds = Number.isFinite(bestOption?.bookmakerOdds) && bestOption.bookmakerOdds > 0;
  const hasMarketProbability = Number.isFinite(bestOption?.bookmakerMarginAdjustedProbability ?? bestOption?.consensusProbability);
  const dataCompletenessScore = liveBoardQuality.completenessScore;
  const freshnessScore = Math.round(liveBoardQuality.score * 100);
  const isHistoricalMode = board?.isHistoricalMode ?? false;
  const staleOdds = !isHistoricalMode && hasBookmakerOdds && !refreshedRecently;
  const missingPriceData = !hasBookmakerOdds || !hasMarketProbability;
  const boardQualityTier = liveBoardQuality.tier;
  const bookmakerDepthMissing = !isHistoricalMode && bookmakerCount < minimumBookmakerDepth(marketKey);
  const blockReasons = [];

  if (!hasBookmakerOdds) {
    blockReasons.push("missing-bookmaker-odds");
  }

  if (!hasMarketProbability) {
    blockReasons.push("missing-implied-probability");
  }

  if (staleOdds && (hoursToKickoff ?? 0) <= 24) {
    blockReasons.push("stale-odds");
  }

  if (boardQualityTier === "weak") {
    blockReasons.push("weak-board");
  }

  if (boardQualityTier === "unusable") {
    blockReasons.push("unusable-board");
  }

  if (boardQuotaDegraded) {
    blockReasons.push("quota-degraded");
  }

  if (bookmakerDepthMissing) {
    blockReasons.push("missing-bookmaker-depth");
  }

  const uniqueBlockReasons = [...new Set(blockReasons)];
  const priceTrustworthy = ["strong", "usable"].includes(boardQualityTier) &&
    refreshedRecently &&
    hasMarketProbability &&
    !boardQuotaDegraded &&
    !board?.fallbackUsed &&
    !bookmakerDepthMissing &&
    dataCompletenessScore >= 0.9;
  let status = boardQualityTier;
  let downgradeLevels = 0;
  let forceNoBet = false;
  let downgradeReason = null;

  if (missingPriceData) {
    status = "unusable";
    forceNoBet = true;
    downgradeReason = !hasMarketProbability
      ? "Implied market probability is missing from the price board."
      : "Bookmaker data is missing or incomplete.";
  } else if (staleOdds && (hoursToKickoff ?? 0) <= 24) {
    status = "unusable";
    forceNoBet = true;
    downgradeReason = "Stored odds are too old for the current kickoff window.";
  } else if (bookmakerDepthMissing) {
    status = "unusable";
    forceNoBet = true;
    downgradeReason = "Bookmaker depth is too thin to trust the board.";
  } else if (["weak", "unusable"].includes(boardQualityTier)) {
    status = boardQualityTier;
    forceNoBet = true;
    downgradeReason = "Board quality is too weak to trust the edge.";
  } else if (boardQuotaDegraded || board?.fallbackUsed) {
    status = boardQualityTier;
    downgradeLevels = 1;
    downgradeReason = boardQuotaDegraded
      ? "Provider quota degraded the price board."
      : "A cached fallback board is being used instead of a clean live board.";
  }

  return {
    ageMinutes,
    freshnessTargetMinutes,
    freshnessScore,
    refreshedRecently,
    coverageStatus,
    bookmakerCount,
    dataCompletenessScore,
    staleOdds,
    missingPriceData,
    quotaDegraded: boardQuotaDegraded,
    syncFailed: syncDiagnostics.syncFailed,
    providerError: syncDiagnostics.providerError,
    priceTrustworthy,
    bookmakerDepthMissing,
    boardProvider: board?.provider ?? "odds-api",
    boardSourceLabel: board?.sourceLabel ?? null,
    boardSourceMode: board?.sourceMode ?? "live",
    sourceReliabilityScore: board?.sourceReliabilityScore ?? liveBoardQuality.sourceReliabilityScore ?? 0,
    fallbackUsed: Boolean(board?.fallbackUsed),
    boardQualityTier,
    boardQualityScore: liveBoardQuality.score,
    impliedConsistencyScore: liveBoardQuality.impliedConsistencyScore,
    status,
    downgradeLevels,
    forceNoBet,
    downgradeReason,
    blockReasons: uniqueBlockReasons
  };
}

function edgePercent(probability, odds) {
  if (!odds || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    return null;
  }

  return round(((probability * odds) - 1) * 100, 2);
}

function requiredOddsForEdge(probability, edge) {
  if (!probability || probability <= 0) {
    return null;
  }

  return round((1 + (edge / 100)) / probability, 2);
}

function latestSnapshotGroups(matchId, marketKey, beforeDate = null) {
  const db = getDb();
  const statement = db.prepare(`
    SELECT bookmaker_key, bookmaker_title, source_provider, source_label, home_price, draw_price, away_price, is_live, retrieved_at
    FROM odds_snapshots
    WHERE match_id = ?
      AND market = ?
      ${beforeDate ? "AND datetime(retrieved_at) <= datetime(?)" : ""}
    ORDER BY datetime(retrieved_at) DESC
  `);

  return statement.all(...(beforeDate ? [matchId, marketKey, beforeDate] : [matchId, marketKey]));
}

function collapseLatestPerBookmaker(rows) {
  const latestPerBookmaker = new Map();

  for (const row of rows) {
    const key = row.bookmaker_key ?? row.bookmakerKey;
    if (!latestPerBookmaker.has(key)) {
      latestPerBookmaker.set(key, row);
    }
  }

  return Array.from(latestPerBookmaker.values()).map((row) => ({
    bookmaker_key: row.bookmaker_key ?? row.bookmakerKey,
    bookmaker_title: row.bookmaker_title ?? row.bookmakerTitle,
    source_provider: row.source_provider ?? row.sourceProvider ?? null,
    source_label: row.source_label ?? row.sourceLabel ?? null,
    home_price: row.home_price ?? row.homeOdds ?? null,
    draw_price: row.draw_price ?? row.drawOdds ?? null,
    away_price: row.away_price ?? row.awayOdds ?? null,
    is_live: row.is_live ?? row.isLive ?? 0,
    retrieved_at: row.retrieved_at ?? row.retrievedAt ?? null
  }));
}

function filterRowsBeforeDate(rows, beforeDate = null) {
  if (!beforeDate) {
    return rows;
  }

  const cutoff = new Date(beforeDate).getTime();
  if (!Number.isFinite(cutoff)) {
    return rows;
  }

  return rows.filter((row) => {
    const retrievedAt = row.retrieved_at ?? row.retrievedAt ?? null;
    if (!retrievedAt) {
      return false;
    }

    const timestamp = new Date(retrievedAt).getTime();
    return Number.isFinite(timestamp) && timestamp <= cutoff;
  });
}

function resolveBoardSource(rows, fallbackProvider = "unknown", fallbackLabel = null) {
  const providerCounts = new Map();
  const labelCounts = new Map();

  for (const row of rows) {
    const provider = row.source_provider ?? row.sourceProvider ?? fallbackProvider;
    const label = row.source_label ?? row.sourceLabel ?? fallbackLabel;
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);

    if (label) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }

  return {
    provider: Array.from(providerCounts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? fallbackProvider,
    sourceLabel: Array.from(labelCounts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? fallbackLabel
  };
}

function isUsableBoardTier(quality) {
  return ["strong", "usable"].includes(quality?.tier);
}

function isSafetyPreferredFallback(liveQuality, cachedQuality) {
  if (!cachedQuality?.refreshedRecently) {
    return false;
  }

  if (!liveQuality) {
    return true;
  }

  if (!liveQuality.refreshedRecently) {
    return true;
  }

  if ((cachedQuality.completenessScore ?? 0) > (liveQuality.completenessScore ?? 0)) {
    return true;
  }

  if ((cachedQuality.bookmakerCount ?? 0) > (liveQuality.bookmakerCount ?? 0)) {
    return true;
  }

  if ((cachedQuality.sourceReliabilityScore ?? 0) > (liveQuality.sourceReliabilityScore ?? 0)) {
    return true;
  }

  return false;
}

function resolveBoardSelection(matchId, definition, context, features, beforeDate = null) {
  // When evaluating a historical match (beforeDate is in the past), use beforeDate as "now"
  // so that freshness/staleness checks are relative to the snapshot time, not today.
  const isHistoricalMode = Boolean(beforeDate) && new Date(beforeDate).getTime() < Date.now() - 60 * 60 * 1000;
  const boardNow = isHistoricalMode ? beforeDate : undefined;

  const liveRows = collapseLatestPerBookmaker(latestSnapshotGroups(matchId, definition.snapshotMarket, beforeDate));
  const persistedLiveBoard = readOddsMarketBoard(matchId, definition.snapshotMarket, "live");
  const liveSource = resolveBoardSource(
    liveRows,
    persistedLiveBoard?.source_provider ?? "unknown",
    persistedLiveBoard?.source_label ?? null
  );
  const syncDiagnostics = resolveSyncDiagnostics(features?.match?.competition_code, context.syncDiagnostics);
  const liveQuotaDegraded = Boolean(syncDiagnostics.quotaDegraded) && liveSource.provider === "odds-api";
  const liveQuality = scoreOddsBoard(liveRows, definition.snapshotMarket, {
    kickoffTime: features?.match?.utc_date ?? null,
    quotaDegraded: liveQuotaDegraded,
    sourceProvider: liveSource.provider,
    sourceMode: "live",
    isHistoricalMode,
    ...(boardNow ? { now: boardNow } : {})
  });
  const cachedBoard = readOddsMarketBoard(matchId, definition.snapshotMarket, "trusted_cache");
  const cachedRows = collapseLatestPerBookmaker(filterRowsBeforeDate(cachedBoard?.rows ?? [], beforeDate));
  const cachedQuality = cachedRows.length
    ? scoreOddsBoard(cachedRows, definition.snapshotMarket, {
        kickoffTime: features?.match?.utc_date ?? null,
        quotaDegraded: false,
        sourceProvider: cachedBoard?.source_provider ?? "trusted-cache",
        sourceMode: cachedBoard?.source_mode ?? "trusted_cache",
        isHistoricalMode,
        ...(boardNow ? { now: boardNow } : {})
      })
    : null;
  const liveHealthy = liveRows.length > 0 && isUsableBoardTier(liveQuality) && liveQuality.refreshedRecently;
  const useFallback = Boolean(
    cachedQuality &&
    isUsableBoardTier(cachedQuality) &&
    cachedQuality.refreshedRecently &&
    (
      !liveRows.length ||
      ["weak", "unusable"].includes(liveQuality.tier) ||
      (!liveHealthy && isSafetyPreferredFallback(liveQuality, cachedQuality))
    )
  );

  if (useFallback) {
    return {
      rows: cachedRows,
      quality: cachedQuality,
      provider: cachedBoard?.source_provider ?? "trusted-cache",
      sourceLabel: cachedBoard?.source_label ?? null,
      sourceMode: "trusted_cache",
      fallbackUsed: true,
      sourceReliabilityScore: cachedBoard?.source_reliability_score ?? cachedQuality?.sourceReliabilityScore ?? 0,
      isHistoricalMode
    };
  }

  return {
    rows: liveRows,
    quality: liveQuality,
    provider: liveSource.provider,
    sourceLabel: liveSource.sourceLabel,
    sourceMode: "live",
    fallbackUsed: false,
    sourceReliabilityScore: persistedLiveBoard?.source_reliability_score ?? liveQuality.sourceReliabilityScore ?? 0,
    isHistoricalMode
  };
}

function confidenceLabel(score) {
  if (score >= 5) {
    return "High";
  }

  if (score >= 2) {
    return "Medium";
  }

  return "Low";
}

function firstFinite(values, fallback = 0) {
  const value = values.find((item) => Number.isFinite(item));
  return Number.isFinite(value) ? value : fallback;
}

function logit(probability) {
  const safe = Math.min(0.999, Math.max(0.001, probability ?? 0.5));
  return Math.log(safe / (1 - safe));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function calibratedBinaryProbability(rawProbability, marketKey, features, model) {
  const lineupUncertainty = (
    (features?.home?.lineupUncertainty ?? 0.5) +
    (features?.away?.lineupUncertainty ?? 0.5)
  ) / 2;
  const coverageScore = features?.context?.dataCoverageScore ?? 0.35;
  const xgCoverageScore = Math.min(
    features?.home?.xgCoverageScore ?? 0,
    features?.away?.xgCoverageScore ?? 0
  );
  const lowerAttack = Math.min(model.expectedGoals.home, model.expectedGoals.away);
  const attackEfficiencyGap = Math.abs(
    (features?.home?.recentAttackingEfficiency ?? 1) -
    (features?.away?.recentAttackingEfficiency ?? 1)
  );
  const xgMomentumGap = Math.abs(
    (features?.home?.xgTrendMomentum ?? 0) -
    (features?.away?.xgTrendMomentum ?? 0)
  );

  let shrink = marketKey === "btts" ? 0.17 : 0.07;
  shrink += Math.max(0, lineupUncertainty - 0.4) * 0.18;
  shrink += Math.max(0, 0.6 - coverageScore) * 0.08;

  if (marketKey === "btts") {
    if (lowerAttack < 0.95) {
      shrink += 0.05;
    }
  } else if (xgCoverageScore >= 0.55) {
    shrink -= 0.03;
  }

  shrink = Math.min(Math.max(shrink, marketKey === "btts" ? 0.12 : 0.05), marketKey === "btts" ? 0.3 : 0.18);
  const temperature = Math.min(
    marketKey === "btts" ? 1.32 : 1.22,
    Math.max(
      marketKey === "btts" ? 1.1 : 1.03,
      1.04 +
      Math.max(0, lineupUncertainty - 0.38) * 0.35 +
      Math.max(0, 0.58 - coverageScore) * 0.18 +
      Math.max(0, attackEfficiencyGap - 0.08) * 0.22 +
      Math.max(0, xgMomentumGap - 0.08) * 0.2
    )
  );
  const temperatureScaled = sigmoid(logit(rawProbability) / temperature);
  return round(0.5 + ((temperatureScaled - 0.5) * (1 - shrink)), 4);
}

function buildOptionDefinitions(marketKey, teams, modelProbabilities, model) {
  if (marketKey === "oneXTwo") {
    return [
      { key: "home", label: `${teams.home} win`, shortLabel: teams.home, probability: modelProbabilities.homeWin, priceField: "home_price" },
      { key: "draw", label: "Draw", shortLabel: "Draw", probability: modelProbabilities.draw, priceField: "draw_price" },
      { key: "away", label: `${teams.away} win`, shortLabel: teams.away, probability: modelProbabilities.awayWin, priceField: "away_price" }
    ];
  }

  if (marketKey === "totals25") {
    const rawOverProbability = round(
      model.scoreMatrix
        .filter((entry) => (entry.homeGoals + entry.awayGoals) >= 3)
        .reduce((sum, entry) => sum + entry.probability, 0),
      4
    );
    const overProbability = calibratedBinaryProbability(rawOverProbability, "totals25", model.features, model);

    return [
      { key: "over", label: "Over 2.5", shortLabel: "Over 2.5", probability: overProbability, priceField: "home_price" },
      { key: "under", label: "Under 2.5", shortLabel: "Under 2.5", probability: round(1 - overProbability, 4), priceField: "away_price" }
    ];
  }

  const rawYesProbability = round(
    model.scoreMatrix
      .filter((entry) => entry.homeGoals > 0 && entry.awayGoals > 0)
      .reduce((sum, entry) => sum + entry.probability, 0),
    4
  );
  const yesProbability = calibratedBinaryProbability(rawYesProbability, "btts", model.features, model);

  return [
    { key: "yes", label: "BTTS Yes", shortLabel: "BTTS Yes", probability: yesProbability, priceField: "home_price" },
    { key: "no", label: "BTTS No", shortLabel: "BTTS No", probability: round(1 - yesProbability, 4), priceField: "away_price" }
  ];
}

function buildBookmakerRows(matchId, definition, optionDefinitions, context, features, beforeDate) {
  const boardSelection = resolveBoardSelection(matchId, definition, context, features, beforeDate);

  if (!boardSelection.rows.length) {
    return {
      rows: [],
      board: {
        provider: boardSelection.provider,
        sourceMode: boardSelection.sourceMode,
        fallbackUsed: boardSelection.fallbackUsed,
        quality: boardSelection.quality
      }
    };
  }

  const rows = boardSelection.rows.map((row) => {
    const options = optionDefinitions.map((option) => {
      const bookmakerOdds = row[option.priceField] ?? null;
      return {
        key: option.key,
        label: option.label,
        shortLabel: option.shortLabel,
        modelProbability: option.probability,
        fairOdds: fairOdds(option.probability),
        bookmakerOdds,
        impliedProbability: round(impliedProbability(bookmakerOdds), 4),
        edge: edgePercent(option.probability, bookmakerOdds)
      };
    });

    const byKey = Object.fromEntries(options.map((option) => [option.key, option]));

    return {
      bookmakerKey: row.bookmaker_key,
      bookmakerTitle: row.bookmaker_title,
      isLive: Boolean(row.is_live),
      retrievedAt: row.retrieved_at,
      options,
      byKey,
      homeOdds: byKey.home?.bookmakerOdds ?? byKey.over?.bookmakerOdds ?? byKey.yes?.bookmakerOdds ?? null,
      drawOdds: byKey.draw?.bookmakerOdds ?? null,
      awayOdds: byKey.away?.bookmakerOdds ?? byKey.under?.bookmakerOdds ?? byKey.no?.bookmakerOdds ?? null,
      edgeHome: byKey.home?.edge ?? byKey.over?.edge ?? byKey.yes?.edge ?? null,
      edgeDraw: byKey.draw?.edge ?? null,
      edgeAway: byKey.away?.edge ?? byKey.under?.edge ?? byKey.no?.edge ?? null
    };
  });

  return {
    rows,
    board: {
      provider: boardSelection.provider,
      sourceMode: boardSelection.sourceMode,
      fallbackUsed: boardSelection.fallbackUsed,
      quality: boardSelection.quality,
      isHistoricalMode: boardSelection.isHistoricalMode
    }
  };
}

function summarizeOptionMarket(rows, optionKey) {
  const pricedRows = rows
    .map((row) => ({
      bookmakerKey: row.bookmakerKey,
      bookmakerTitle: row.bookmakerTitle,
      retrievedAt: row.retrievedAt,
      option: row.byKey?.[optionKey] ?? null
    }))
    .filter((row) => Number.isFinite(row.option?.bookmakerOdds) && row.option.bookmakerOdds > 0);

  if (!pricedRows.length) {
    return {
      bestOdds: null,
      bestBookmakerTitle: null,
      averageOdds: null,
      impliedProbability: null,
      movement: null
    };
  }

  const bestPrice = [...pricedRows].sort((left, right) => right.option.bookmakerOdds - left.option.bookmakerOdds)[0];
  const orderedByTime = [...pricedRows].sort((left, right) => new Date(left.retrievedAt).getTime() - new Date(right.retrievedAt).getTime());
  const firstPrice = orderedByTime[0].option.bookmakerOdds;
  const lastPrice = orderedByTime[orderedByTime.length - 1].option.bookmakerOdds;

  return {
    bestOdds: bestPrice.option.bookmakerOdds,
    bestBookmakerTitle: bestPrice.bookmakerTitle,
    averageOdds: round(average(pricedRows.map((row) => row.option.bookmakerOdds), 0), 2),
    impliedProbability: round(average(pricedRows.map((row) => impliedProbability(row.option.bookmakerOdds)), 0), 4),
    movement: round(lastPrice - firstPrice, 2)
  };
}

function buildMarketOptionStats(rows, optionDefinitions) {
  return Object.fromEntries(optionDefinitions.map((option) => [option.key, summarizeOptionMarket(rows, option.key)]));
}

function buildConsensusProbabilities(rows) {
  if (!rows.length) {
    return null;
  }

  const optionCount = rows[0]?.options?.length ?? 0;
  const sums = new Array(optionCount).fill(0);
  let countedRows = 0;

  for (const row of rows) {
    const implied = row.options.map((option) => impliedProbability(option.bookmakerOdds));
    if (implied.some((value) => !Number.isFinite(value) || value <= 0)) {
      continue;
    }

    const total = implied.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) {
      continue;
    }

    countedRows += 1;
    implied.forEach((value, index) => {
      sums[index] += value / total;
    });
  }

  if (!countedRows) {
    return null;
  }

  const consensus = rows[0].options.reduce((accumulator, option, index) => {
    accumulator[option.key] = round(sums[index] / countedRows, 4);
    return accumulator;
  }, {});

  const values = Object.values(consensus);
  const total = values.reduce((sum, value) => sum + value, 0);

  if (
    values.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
    !Number.isFinite(total) ||
    Math.abs(total - 1) > 0.02
  ) {
    return null;
  }

  return consensus;
}

function buildConfidenceReasons(bestOption, context, hasStoredOdds, clarityScore) {
  const reasons = [];
  const coverageScore = context.dataCoverageScore ?? 0.35;
  const coverageBlend = context.coverageBlend ?? 0.5;
  const hoursToKickoff = context.hoursToKickoff ?? null;
  const confirmedLineups = Boolean(context.confirmedLineups);

  reasons.push(
    coverageScore >= 0.8
      ? "Data is solid."
      : coverageScore >= 0.55
        ? "Data is usable."
        : "Sample is light."
  );

  reasons.push(
    bestOption.edge === null
      ? "No book price."
      : bestOption.edge >= 6
        ? "Price is clearly off."
        : bestOption.edge >= 2
          ? "There is still some value."
          : "No edge at this price."
  );

  reasons.push(
    clarityScore >= 0.12
      ? "The match leans one way."
      : "This match is tight."
  );

  if (coverageBlend < 0.45) {
    reasons.push("Form is being toned down.");
  } else if (!hasStoredOdds) {
    reasons.push("No live number to hit.");
  }

  if (hoursToKickoff !== null && hoursToKickoff <= 3 && !confirmedLineups) {
    reasons.push("Lineups are still pending.");
  } else if (confirmedLineups) {
    reasons.push("The projected XIs look strong, but they are not automatically official.");
  }

  return reasons.slice(0, 2);
}

function trustLabel(score) {
  if (score >= 75) {
    return "Strong";
  }

  if (score >= 55) {
    return "Fair";
  }

  return "Fragile";
}

function uclLiveEvidenceRelief({
  marketKey,
  bestOption,
  coverageScore,
  availabilityCoverageScore,
  bookmakerCount,
  snapshotHours,
  confirmedLineups,
  hoursToKickoff,
  competitionCode
}) {
  if (competitionCode !== "CL") {
    return 1;
  }

  let evidence = 0;

  if (coverageScore >= 0.8) {
    evidence += 1;
  }

  if (availabilityCoverageScore >= 0.5) {
    evidence += 1;
  }

  if (bookmakerCount >= 3) {
    evidence += 1;
  }

  if (snapshotHours !== null && snapshotHours <= 12) {
    evidence += 1;
  } else if (snapshotHours !== null && snapshotHours <= 24) {
    evidence += 0.5;
  }

  if (confirmedLineups || hoursToKickoff === null || hoursToKickoff > 2) {
    evidence += 1;
  }

  const locallyStrong = evidence >= 3.5;
  if (!locallyStrong) {
    return 1;
  }

  if (marketKey === "oneXTwo") {
    if ((bestOption?.modelProbability ?? 0) < 0.4) {
      return 0.75;
    }

    return 0.55;
  }

  return 0.4;
}

function applyScaledSystemPenalty(score, reasons, condition, penalty, reason, reliefFactor) {
  if (!condition) {
    return score;
  }

  const adjustedPenalty = Math.max(1, Math.round(penalty * reliefFactor));
  reasons.push(reason);
  return score - adjustedPenalty;
}

function buildTrustPackage(marketKey, bestOption, rows, selectedBookmaker, context, teams, model, features, priceQuality) {
  const reasons = [];
  let score = 50;
  const fixtureResolved = isResolvedFixtureTeams(teams.home, teams.away);
  const coverageScore = context.dataCoverageScore ?? 0.35;
  const coverageBlend = context.coverageBlend ?? 0.5;
  const availabilityCoverageScore = features?.context?.availabilityCoverageScore ?? 0;
  const bookmakerCount = priceQuality.bookmakerCount;
  const hoursToKickoff = features?.context?.hoursToKickoff ?? null;
  const snapshotHours = priceQuality.ageMinutes === null ? null : priceQuality.ageMinutes / 60;
  const homeMissing = features?.home?.missingStartersCount ?? 0;
  const awayMissing = features?.away?.missingStartersCount ?? 0;
  const homeCoreMissing = features?.home?.missingCoreStartersCount ?? 0;
  const awayCoreMissing = features?.away?.missingCoreStartersCount ?? 0;
  const homeLineupCertainty = features?.home?.lineupCertaintyScore ?? 0.5;
  const awayLineupCertainty = features?.away?.lineupCertaintyScore ?? 0.5;
  const homeStructuredLineup = Boolean(features?.home?.structuredLineupSource);
  const awayStructuredLineup = Boolean(features?.away?.structuredLineupSource);
  const homeStructuredAbsence = Boolean(features?.home?.structuredAbsenceSource);
  const awayStructuredAbsence = Boolean(features?.away?.structuredAbsenceSource);
  const availabilityConflictScore = Math.max(features?.home?.sourceConflictScore ?? 0, features?.away?.sourceConflictScore ?? 0);
  const lineupContinuityGap = Math.abs((features?.home?.lineupContinuityScore ?? 0.5) - (features?.away?.lineupContinuityScore ?? 0.5));
  const confirmedLineups = (features?.home?.expectedLineup?.length ?? 0) >= 9 && (features?.away?.expectedLineup?.length ?? 0) >= 9;
  const systemMetrics = getLatestSystemMetricSnapshot("competition", features?.match?.competition_code)
    ?? getLatestSystemMetricSnapshot("all", null);
  const systemPenaltyRelief = uclLiveEvidenceRelief({
    marketKey,
    bestOption,
    coverageScore,
    availabilityCoverageScore,
    bookmakerCount,
    snapshotHours,
    confirmedLineups,
    hoursToKickoff,
    competitionCode: features?.match?.competition_code
  });

  if (!fixtureResolved) {
    score -= 35;
    reasons.push("Fixture is not fully resolved yet.");
  } else {
    reasons.push("Teams are confirmed.");
  }

  if (priceQuality.missingPriceData) {
    score -= 25;
    reasons.push("No trustworthy bookmaker price is stored.");
  } else if (priceQuality.staleOdds) {
    score -= 14;
    reasons.push("Stored odds are stale for this kickoff window.");
  } else if (priceQuality.refreshedRecently) {
    score += 10;
    reasons.push("Price snapshot is fresh.");
  } else if (snapshotHours !== null && snapshotHours <= 24) {
    score += 3;
    reasons.push("Price snapshot is recent enough.");
  }

  if (priceQuality.coverageStatus === "complete") {
    score += 10;
    reasons.push("Several books are on the board.");
  } else if (bookmakerCount === 2) {
    score += 5;
  } else if (priceQuality.coverageStatus === "partial") {
    score -= 4;
    reasons.push("The bookmaker board is still thin.");
  } else {
    score -= 12;
    reasons.push("Bookmaker coverage is missing.");
  }

  if (priceQuality.quotaDegraded) {
    score -= 8;
    reasons.push("Provider quota degraded the odds board.");
  } else if (priceQuality.syncFailed) {
    score -= 5;
    reasons.push("The latest odds sync did not finish cleanly.");
  }

  if (priceQuality.dataCompletenessScore >= 0.85) {
    score += 4;
  } else if (priceQuality.dataCompletenessScore < 0.7) {
    score -= 6;
    reasons.push("Price data is incomplete.");
  }

  if (coverageScore >= 0.8) {
    score += 10;
    reasons.push("Recent sample is strong.");
  } else if (coverageScore >= 0.6) {
    score += 5;
  } else if (coverageScore < 0.45) {
    score -= 10;
    reasons.push("Recent sample is thin.");
  }

  if (coverageBlend >= 0.7) {
    score += 5;
  } else if (coverageBlend < 0.45) {
    score -= 5;
    reasons.push("Model is leaning back to baseline.");
  }

  if (availabilityCoverageScore >= 0.65) {
    score += 6;
    reasons.push("Availability read is usable.");
  } else if (availabilityCoverageScore > 0 && availabilityCoverageScore < 0.35) {
    score -= 6;
    reasons.push("Availability read is still patchy.");
  }

  if (homeStructuredLineup && awayStructuredLineup) {
    score += 5;
    reasons.push("Lineup read is coming from stronger sources.");
  }

  if (homeStructuredAbsence || awayStructuredAbsence) {
    score += 3;
  }

  if (availabilityConflictScore >= 0.2) {
    score -= 8;
    reasons.push("Availability sources are not fully agreeing.");
  } else if (availabilityConflictScore >= 0.1) {
    score -= 4;
    reasons.push("There is some source conflict in the team news.");
  }

  if (homeLineupCertainty < 0.6 || awayLineupCertainty < 0.6) {
    score -= 6;
    reasons.push("Expected lineups are not fully settled.");
  }

  if (confirmedLineups) {
    score += 10;
    reasons.push("Projected lineups are strong enough to help the read.");
  }

  if (hoursToKickoff !== null && hoursToKickoff <= 3 && !confirmedLineups) {
    score -= 16;
    reasons.push("Kickoff is close and lineups are still not confirmed.");
  } else if (hoursToKickoff !== null && hoursToKickoff <= 6 && !confirmedLineups) {
    score -= 8;
    reasons.push("Lineups are still pending inside the pre-match window.");
  }

  if (homeCoreMissing >= 2 || awayCoreMissing >= 2) {
    score -= 7;
    reasons.push("One side is missing too much of its usual core.");
  } else if (homeMissing >= 2 || awayMissing >= 2) {
    score -= 4;
    reasons.push("One side could be missing several likely starters.");
  }

  if (lineupContinuityGap >= 0.25) {
    score += 2;
    reasons.push("One side brings a more settled XI.");
  }

  if (marketKey === "oneXTwo" && bestOption.modelProbability < 0.35) {
    score -= 10;
    reasons.push("The match-result angle is still fragile.");
  }

  if (marketKey === "oneXTwo" && bestOption.disagreement !== null && bestOption.disagreement > 0.18) {
    score -= 14;
    reasons.push("The market is much colder on this side than the model.");
  } else if (marketKey === "oneXTwo" && bestOption.disagreement !== null && bestOption.disagreement > 0.1) {
    score -= 7;
    reasons.push("The market still leans away from this result.");
  }

  if (
    marketKey === "oneXTwo" &&
    (bestOption.bookmakerOdds ?? 0) >= 4.5 &&
    (bestOption.disagreement ?? 0) > 0.12
  ) {
    score -= 8;
    reasons.push("This 1X2 angle is more longshot than core leg.");
  }

  if (bestOption.edge !== null && Math.abs(bestOption.edge) > 18) {
    score -= 5;
    reasons.push("The model-market gap is unusually wide.");
  }

  if (systemMetrics?.trustPercent !== null && systemMetrics?.trustPercent !== undefined) {
    if (systemMetrics.trustPercent < 50) {
      score = applyScaledSystemPenalty(
        score,
        reasons,
        true,
        8,
        "The wider system proof is still building.",
        systemPenaltyRelief
      );
    } else if (systemMetrics.trustPercent < 65) {
      score = applyScaledSystemPenalty(
        score,
        reasons,
        true,
        4,
        "The wider system still needs more proof.",
        systemPenaltyRelief
      );
    } else if (systemMetrics.trustPercent >= 75) {
      score += 4;
      reasons.push("The wider system evidence is supporting the call.");
    }
  }

  if ((systemMetrics?.blindBrierAvg ?? 1) > 0.23) {
    score = applyScaledSystemPenalty(
      score,
      reasons,
      true,
      4,
      "Calibration is still looser than ideal.",
      systemPenaltyRelief
    );
  } else if ((systemMetrics?.blindBrierAvg ?? 1) > 0 && systemMetrics.blindBrierAvg < 0.2) {
    score += 3;
    reasons.push("Calibration is holding up well.");
  }

  if ((systemMetrics?.forwardSettledBets ?? 0) < 20) {
    score = applyScaledSystemPenalty(
      score,
      reasons,
      true,
      4,
      "There are still too few settled forward bets.",
      systemPenaltyRelief
    );
  }

  if (marketKey === "totals25") {
    score += 5;
    reasons.push("Totals is the most reliable market in the current review.");
  }

  if (marketKey === "totals25" && (model.expectedGoals.home + model.expectedGoals.away) >= 3 && bestOption.key === "under") {
    score -= 10;
    reasons.push("The goal projection still runs high for an under.");
  }

  if (marketKey === "totals25" && Math.abs((features?.home?.xgTrendMomentum ?? 0) - (features?.away?.xgTrendMomentum ?? 0)) >= 0.18) {
    score += 2;
    reasons.push("Recent chance-quality momentum is giving the total a clearer shape.");
  }

  if (marketKey === "btts" && Math.min(model.expectedGoals.home, model.expectedGoals.away) < 0.75 && bestOption.key === "yes") {
    score -= 10;
    reasons.push("One side may not create enough for BTTS.");
  }

  if (marketKey === "btts") {
    score -= 6;
    reasons.push("BTTS is still the weakest market in the review sample.");
  }

  const boundedScore = Math.max(0, Math.min(100, score));

  return {
    score: boundedScore,
    label: trustLabel(boundedScore),
    reasons: [...new Set(reasons)].slice(0, 3),
    fixtureResolved,
    confirmedLineups,
    bookmakerCount,
    snapshotHours: snapshotHours === null ? null : round(snapshotHours, 1),
    oddsFreshnessMinutes: priceQuality.ageMinutes,
    oddsFreshnessScore: priceQuality.freshnessScore,
    oddsRefreshedRecently: priceQuality.refreshedRecently,
    oddsCoverageStatus: priceQuality.coverageStatus,
    dataCompletenessScore: priceQuality.dataCompletenessScore,
    priceTrustworthy: priceQuality.priceTrustworthy,
    priceQualityStatus: priceQuality.status,
    staleOdds: priceQuality.staleOdds,
    quotaDegraded: priceQuality.quotaDegraded,
    hoursToKickoff: hoursToKickoff === null ? null : round(hoursToKickoff, 1),
    systemTrustPercent: systemMetrics?.trustPercent ?? null,
    blindBrierAvg: systemMetrics?.blindBrierAvg ?? null,
    forwardSettledBets: systemMetrics?.forwardSettledBets ?? 0
  };
}

function credibilityLabel(score) {
  if (score >= 80) {
    return "High";
  }

  if (score >= 65) {
    return "Good";
  }

  if (score >= 50) {
    return "Moderate";
  }

  return "Fragile";
}

function buildCredibilityPackage(trust, features) {
  const lineupBoost = trust.confirmedLineups ? 8 : (features?.context?.hoursToKickoff ?? 99) <= 2 ? -6 : 0;
  const systemBase = trust.systemTrustPercent ?? 45;
  const score = Math.max(0, Math.min(100, round((trust.score * 0.7) + (systemBase * 0.3) + lineupBoost, 0)));
  const reasons = [];

  if (trust.confirmedLineups) {
    reasons.push("An official or very strong projected XI removes a major late risk.");
  } else if ((features?.context?.hoursToKickoff ?? 99) <= 2) {
    reasons.push("Kickoff is close and lineup certainty is still incomplete.");
  }

  if ((trust.systemTrustPercent ?? 0) < 50) {
    reasons.push("The wider system still needs more proven forward history.");
  } else if ((trust.systemTrustPercent ?? 0) >= 65) {
    reasons.push("The wider system evidence is starting to support the call.");
  }

  if ((trust.blindBrierAvg ?? 1) > 0.23) {
    reasons.push("Calibration still needs to tighten.");
  }

  return {
    score,
    label: credibilityLabel(score),
    reasons: reasons.slice(0, 3),
    systemTrustPercent: trust.systemTrustPercent ?? null
  };
}

function buildConfidencePackage(bestOption, context, hasStoredOdds, clarityScore, features, priceQuality) {
  let score = 0;

  if (bestOption.edge !== null) {
    if (bestOption.edge >= 6) {
      score += 3;
    } else if (bestOption.edge >= 3) {
      score += 2;
    } else if (bestOption.edge >= 2) {
      score += 1;
    }
  }

  if ((context.dataCoverageScore ?? 0.35) >= 0.8) {
    score += 2;
  } else if ((context.dataCoverageScore ?? 0.35) >= 0.6) {
    score += 1;
  } else {
    score -= 1;
  }

  if ((context.coverageBlend ?? 0.5) >= 0.7) {
    score += 1;
  } else if ((context.coverageBlend ?? 0.5) < 0.45) {
    score -= 1;
  }

  if (clarityScore >= 0.12) {
    score += 1;
  } else if (clarityScore < 0.06) {
    score -= 1;
  }

  if (!hasStoredOdds) {
    score -= 1;
  }

  if (priceQuality.missingPriceData || priceQuality.staleOdds) {
    score -= 2;
  } else if (priceQuality.coverageStatus === "partial" || priceQuality.quotaDegraded || priceQuality.dataCompletenessScore < 0.7) {
    score -= 1;
  } else if (priceQuality.priceTrustworthy) {
    score += 1;
  }

  const availabilityCoverage = features?.context?.availabilityCoverageScore ?? 0;
  const lineupUncertain = (features?.home?.lineupCertaintyScore ?? 0.5) < 0.6 || (features?.away?.lineupCertaintyScore ?? 0.5) < 0.6;
  const confirmedLineups = (features?.home?.expectedLineup?.length ?? 0) >= 9 && (features?.away?.expectedLineup?.length ?? 0) >= 9;
  const hoursToKickoff = features?.context?.hoursToKickoff ?? null;

  if (availabilityCoverage >= 0.35 && lineupUncertain) {
    score -= 1;
  }

  if (confirmedLineups) {
    score += 1;
  } else if (hoursToKickoff !== null && hoursToKickoff <= 3) {
    score -= 2;
  }

  const label = confidenceFromScore(score);
  const penaltySteps = priceQuality.forceNoBet ? 2 : priceQuality.downgradeLevels > 0 ? 1 : 0;

  return {
    label: downgradeConfidenceLabel(label, penaltySteps),
    reasons: buildConfidenceReasons(bestOption, {
      ...context,
      hoursToKickoff,
      confirmedLineups
    }, hasStoredOdds, clarityScore)
  };
}

function buildOneXTwoReason(selectedKey, features, model, teams) {
  if (selectedKey === "draw") {
    return `The game still grades tight enough for the draw, with ${teams.home} at ${round(model.probabilities.homeWin * 100, 1)}% and ${teams.away} at ${round(model.probabilities.awayWin * 100, 1)}%.`;
  }

  const selectedTeam = selectedKey === "home" ? teams.home : teams.away;
  const selected = selectedKey === "home" ? features.home : features.away;
  const other = selectedKey === "home" ? features.away : features.home;
  const reasons = [];

  if (selected.elo - other.elo > 20) {
    reasons.push(`${selectedTeam} carries the stronger long-term quality number.`);
  }

  if (selected.recentFormPpg - other.recentFormPpg > 0.2) {
    reasons.push(`${selectedTeam} is the stronger recent form side at ${round(selected.recentFormPpg, 2)} points per game.`);
  }

  if (selected.avgGoalsLast5 - other.avgGoalsLast5 > 0.2) {
    reasons.push(`${selectedTeam} is scoring ${round(selected.avgGoalsLast5, 2)} per game across the last five.`);
  }

  if ((other.missingStartersCount ?? 0) > (selected.missingStartersCount ?? 0) && (other.missingStartersCount ?? 0) >= 1) {
    reasons.push(`${selectedKey === "home" ? teams.away : teams.home} looks less settled on team news.`);
  }

  if ((other.missingCoreStartersCount ?? 0) > (selected.missingCoreStartersCount ?? 0) && (other.missingCoreStartersCount ?? 0) >= 1) {
    reasons.push(`${selectedKey === "home" ? teams.away : teams.home} looks lighter in its usual core XI.`);
  }

  if (other.avgConcededLast5 - selected.avgConcededLast5 > 0.2) {
    reasons.push(`${selectedKey === "home" ? teams.away : teams.home} has been conceding more lately.`);
  }

  if ((selected.starterStrengthDelta ?? 0) - (other.starterStrengthDelta ?? 0) > 0.08) {
    reasons.push(`${selectedTeam} is expected to field the stronger XI on the night.`);
  }

  if ((selected.lineupContinuityScore ?? 0.5) - (other.lineupContinuityScore ?? 0.5) > 0.15) {
    reasons.push(`${selectedTeam} comes in with the more settled lineup pattern.`);
  }

  if ((selectedKey === "home" ? selected.sideRecord?.played : selected.sideRecord?.played) >= 5) {
    reasons.push(
      selectedKey === "home"
        ? `${selectedTeam} has gone ${selected.sideRecord.wins}-${selected.sideRecord.draws}-${selected.sideRecord.losses} across the last ${selected.sideRecord.played} home matches.`
        : `${selectedTeam} has gone ${selected.sideRecord.wins}-${selected.sideRecord.draws}-${selected.sideRecord.losses} across the last ${selected.sideRecord.played} away matches.`
    );
  }

  if (!reasons.length) {
    reasons.push(`${selectedTeam} has the slight overall edge.`);
  }

  return reasons.slice(0, 2).join(" ");
}

function buildOneXTwoRisk(selectedKey, features, model, teams) {
  if (selectedKey === "draw") {
    return "One moment can break the draw script.";
  }

  if (selectedKey === "away") {
    return `${teams.home} still has home edge.`;
  }

  if ((features.home.lineupCertaintyScore ?? 0.5) < 0.6 || (features.away.lineupCertaintyScore ?? 0.5) < 0.6) {
    return "Lineups are not fully settled yet.";
  }

  if ((selectedKey === "home" ? features.home.missingCoreStartersCount : features.away.missingCoreStartersCount) >= 2) {
    return "The preferred side is still missing too much of its usual core.";
  }

  if (Math.abs(model.expectedGoals.home - model.expectedGoals.away) < 0.25) {
    return "The gap is still narrow.";
  }

  return "This is not a wide mismatch.";
}

function buildTotalsReason(selectedKey, features, model) {
  const totalGoals = model.expectedGoals.home + model.expectedGoals.away;
  const home = features.home;
  const away = features.away;

  if (selectedKey === "over") {
    if ((features.home.missingStartersCount ?? 0) >= 2 || (features.away.missingStartersCount ?? 0) >= 2) {
      return "The over is still live, but team news makes the attacking read less clean.";
    }

    if ((features.home.missingPrimaryGoalkeeper ?? false) || (features.away.missingPrimaryGoalkeeper ?? false)) {
      return "A likely goalkeeper change makes a messy high-event game easier to believe.";
    }

    if (Math.min(model.expectedGoals.home, model.expectedGoals.away) >= 0.95 && home.avgGoalsLast5 >= 1.4 && away.avgGoalsLast5 >= 1.2) {
      return `${home.name} and ${away.name} are both clearing a believable scoring line, with recent attacks strong enough to push this above 2.5.`;
    }

    return `The total still projects around ${round(totalGoals, 2)} goals, which keeps Over 2.5 live.`;
  }

  if (totalGoals <= 2.2) {
    return `This sets up as a lower-volume game, with the total only projecting around ${round(totalGoals, 2)} goals.`;
  }

  if (totalGoals >= 2.9) {
    return "The total is still a touch rich for a match that can spend long spells under control.";
  }

  if (Math.min(model.expectedGoals.home, model.expectedGoals.away) < 0.8) {
    const quieterSide = model.expectedGoals.home < model.expectedGoals.away ? home.name : away.name;
    return `${quieterSide} looks the likelier side to fall short in attack, which keeps the under alive.`;
  }

  if ((home.lineupContinuityScore ?? 0.5) < 0.45 || (away.lineupContinuityScore ?? 0.5) < 0.45) {
    return "One side is changing too much of its XI to trust a fully open script.";
  }

  return "The under still has a small pricing edge.";
}

function buildTotalsRisk(selectedKey, features, model) {
  const stage = String(features.match.stage ?? "").toLowerCase();

  if (selectedKey === "over") {
    if (stage.includes("quarter") || stage.includes("semi") || stage.includes("play-off")) {
      return "The stage can still slow the game down.";
    }

    return "A slow start can still kill the over.";
  }

  if ((features.home.missingStartersCount ?? 0) === 0 && (features.away.missingStartersCount ?? 0) === 0 && (features.home.lineupCertaintyScore ?? 0.5) >= 0.7 && (features.away.lineupCertaintyScore ?? 0.5) >= 0.7) {
    return "Both attacks still have enough quality to break an under.";
  }

  return "An early goal would hurt the under fast.";
}

function buildBttsReason(selectedKey, features, model) {
  if (selectedKey === "yes") {
    if ((features.home.missingStartersCount ?? 0) >= 2 || (features.away.missingStartersCount ?? 0) >= 2) {
      return "BTTS is still live, but team news makes one of the attacks less trustworthy.";
    }

    if ((features.home.missingPrimaryGoalkeeper ?? false) || (features.away.missingPrimaryGoalkeeper ?? false)) {
      return "A likely goalkeeper change makes both teams to score easier to trust.";
    }

    return Math.min(model.expectedGoals.home, model.expectedGoals.away) >= 0.95
      ? `${features.home.name} and ${features.away.name} both clear a usable scoring threshold on the model.`
      : "The matchup still gives both sides a live path to a goal.";
  }

  const teamAtRisk = model.expectedGoals.home < model.expectedGoals.away ? features.home.name : features.away.name;
  return `${teamAtRisk} looks the likelier side to blank.`;
}

function buildBttsRisk(selectedKey, features) {
  if ((features.home.lineupCertaintyScore ?? 0.5) < 0.6 || (features.away.lineupCertaintyScore ?? 0.5) < 0.6) {
    return "Lineup uncertainty still clouds the BTTS read.";
  }

  return selectedKey === "yes"
    ? `${features.home.name} or ${features.away.name} can still waste the volume it creates.`
    : "One early goal can open this up more than the price expects.";
}

function buildMarketReason(marketKey, selectedKey, features, model, teams) {
  if (marketKey === "oneXTwo") {
    return buildOneXTwoReason(selectedKey, features, model, teams);
  }

  if (marketKey === "totals25") {
    return buildTotalsReason(selectedKey, features, model);
  }

  return buildBttsReason(selectedKey, features, model);
}

function buildMarketRisk(marketKey, selectedKey, features, model, teams) {
  if (marketKey === "oneXTwo") {
    return buildOneXTwoRisk(selectedKey, features, model, teams);
  }

  if (marketKey === "totals25") {
    return buildTotalsRisk(selectedKey, features, model);
  }

  return buildBttsRisk(selectedKey, features);
}

function buildRecommendationAction(edge, policy) {
  if (edge === null || edge < policy.minEdge) {
    return "No Bet";
  }

  if (edge >= policy.strongEdge) {
    return "Strong Value";
  }

  if (edge >= policy.playableEdge) {
    return "Playable Edge";
  }

  return "Small Edge";
}

function buildRecommendationHeadline(marketName, optionLabel, action) {
  if (action === "No Bet") {
    return "No Bet";
  }

  return optionLabel;
}

function buildNoBetReason(bestOption, hasStoredOdds, policy) {
  if (!hasStoredOdds) {
    return bestOption.targetOdds
      ? `No price on the board. This only becomes playable around ${bestOption.targetOdds} or bigger.`
      : "No price on the board.";
  }

  if ((bestOption.edge ?? 0) < 0) {
    return bestOption.targetOdds
      ? `The market is already ahead of the model. A bet only comes back into play near ${bestOption.targetOdds}.`
      : "The market is already ahead of the model.";
  }

  return bestOption.targetOdds
    ? `There is a lean, but not enough to bet. You would want at least ${bestOption.targetOdds}.`
    : "There is a lean, but not enough to bet.";
}

function buildTriggerNote(marketKey, action, bestOption, trust, features, selectedBookmaker) {
  const hoursToKickoff = features?.context?.hoursToKickoff ?? null;
  const confirmedLineups = trust.confirmedLineups;

  if (action !== "No Bet") {
    if (!confirmedLineups && hoursToKickoff !== null && hoursToKickoff <= 6) {
      return "Re-check once the projected lineups or official XIs are firmer.";
    }

    if (selectedBookmaker?.retrievedAt) {
      return "Worth re-checking near kickoff in case the price improves again.";
    }

    return "Playable now, but still re-check the late team news.";
  }

  if (!confirmedLineups && hoursToKickoff !== null && hoursToKickoff <= 6) {
    return "This only upgrades if the projected lineups firm up or the official XIs land.";
  }

  if (bestOption.targetOdds) {
    return `This only becomes interesting at ${bestOption.targetOdds} or better.`;
  }

  if (!selectedBookmaker) {
    return "Wait for a usable bookmaker price before revisiting it.";
  }

  if ((trust.bookmakerCount ?? 0) <= 1) {
    return "Wait for a deeper bookmaker board before trusting this market.";
  }

  return "Leave it alone unless either the price or the team news moves your way.";
}

function primaryTrustWarning(trust) {
  return trust.reasons.find((reason) => reason !== "Teams are confirmed.") ?? "This market does not have enough support.";
}

function applyTrustGuardrail(marketKey, trust, action, policy) {
  if (!trust.fixtureResolved) {
    return {
      forceNoBet: true,
      reason: "No Bet until both teams are confirmed.",
      risk: "Bracket placeholders are not bettable."
    };
  }

  if (!trust.confirmedLineups && trust.hoursToKickoff !== null && trust.hoursToKickoff <= 2) {
    return {
      forceNoBet: true,
      reason: "No Bet until the projected lineups are clearer.",
      risk: "This is too close to kickoff to force a bet without a cleaner team-news read."
    };
  }

  if (trust.score < 45) {
    return {
      forceNoBet: true,
      reason: "No Bet. The setup is too fragile.",
      risk: primaryTrustWarning(trust)
    };
  }

  if (trust.score < policy.minTrust) {
    return {
      forceNoBet: true,
      reason: "No Bet. The trust score is not strong enough.",
      risk: primaryTrustWarning(trust)
    };
  }

  if (action === "Strong Value" && trust.score < policy.minStrongTrust) {
    return {
      forceNoBet: false,
      downgradeAction: "Playable Edge"
    };
  }

  if (action === "Playable Edge" && trust.score < policy.minPlayableTrust) {
    return {
      forceNoBet: false,
      downgradeAction: "Small Edge"
    };
  }

  if (action === "Small Edge" && trust.score < policy.minTrust) {
    return {
      forceNoBet: true,
      reason: "No Bet. The edge is too thin.",
      risk: "This is not strong enough once trust is priced in."
    };
  }

  return {
    forceNoBet: false,
    downgradeAction: null
  };
}

function applyPriceQualityGuardrail(marketKey, priceQuality, action) {
  if (priceQuality.forceNoBet) {
    return {
      forceNoBet: true,
      downgradeAction: null,
      reason: `No Bet. ${priceQuality.downgradeReason}`,
      risk: priceQuality.quotaDegraded
        ? "The price board is too weak after a quota-degraded odds sync."
        : "The stored bookmaker prices are not trustworthy enough for a real pre-match bet."
    };
  }

  if (action === "No Bet" || priceQuality.downgradeLevels <= 0) {
    return {
      forceNoBet: false,
      downgradeAction: null,
      reason: null,
      risk: null
    };
  }

  const downgraded = downgradeAction(action, priceQuality.downgradeLevels);

  if (downgraded === action) {
    return {
      forceNoBet: false,
      downgradeAction: null,
      reason: null,
      risk: null
    };
  }

  if (downgraded === "No Bet") {
    return {
      forceNoBet: true,
      downgradeAction: null,
      reason: `No Bet. ${priceQuality.downgradeReason}`,
      risk: "The price board is too thin to trust the edge."
    };
  }

  return {
    forceNoBet: false,
    downgradeAction: downgraded,
    reason: priceQuality.downgradeReason,
    risk: "The edge is being downgraded because the price board is weaker than it should be."
  };
}

function oneXTwoGuardrail(bestOption, optionDefinitions, rows) {
  const sortedByProbability = [...optionDefinitions].sort((left, right) => right.probability - left.probability);
  const topModelOption = sortedByProbability[0];
  const selectedGap = topModelOption.probability - bestOption.modelProbability;
  const consensus = buildConsensusProbabilities(rows);
  const consensusProbability = consensus?.[bestOption.key] ?? null;
  const topConsensusKey = consensus
    ? Object.entries(consensus).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
    : null;
  const topConsensusProbability = topConsensusKey ? consensus?.[topConsensusKey] ?? null : null;
  const favoriteConsensus =
    topConsensusKey !== null &&
    topModelOption.key === topConsensusKey &&
    topModelOption.key !== "draw" &&
    topModelOption.probability >= 0.48 &&
    (topConsensusProbability ?? 0) >= 0.55;
  const disagreement = consensusProbability === null ? null : bestOption.modelProbability - consensusProbability;
  const isLongshot = bestOption.modelProbability < 0.28;
  const isNotTopModel = bestOption.key !== topModelOption.key;
  const speculativePrice = (bestOption.bookmakerOdds ?? 0) >= 4.2;

  if (favoriteConsensus && isNotTopModel && bestOption.modelProbability < 0.42) {
    return {
      forceNoBet: true,
      reason: `${topModelOption.shortLabel} is still the main 1X2 result.`,
      risk: "The outsider price is interesting, but both the model and the market still point to the favorite."
    };
  }

  if (isNotTopModel && isLongshot) {
    return {
      forceNoBet: true,
      reason: "The price is big, but the win chance is still too low.",
      risk: `${topModelOption.shortLabel} is still the stronger result on the model.`
    };
  }

  if (isNotTopModel && selectedGap > 0.08) {
    return {
      forceNoBet: true,
      reason: "The other side still comes out ahead on the model.",
      risk: "This price is tempting, but the core call points elsewhere."
    };
  }

  if (isNotTopModel && disagreement !== null && disagreement > 0.12 && bestOption.modelProbability < 0.35) {
    return {
      forceNoBet: true,
      reason: "The gap versus market is too wide to trust blindly.",
      risk: "This looks more like model overreach than clean value."
    };
  }

  if (!isNotTopModel && disagreement !== null && disagreement > 0.18 && speculativePrice && bestOption.modelProbability < 0.46) {
    return {
      forceNoBet: true,
      reason: "The price is huge, but the market is still much colder on this side than the model.",
      risk: "Treat this as a longshot opinion, not a clean core bet."
    };
  }

  if (!isNotTopModel && disagreement !== null && disagreement > 0.14 && speculativePrice && bestOption.modelProbability < 0.42) {
    return {
      forceNoBet: true,
      reason: "This still looks more like a price-shot than a disciplined 1X2 bet.",
      risk: "Wait for official lineups or leave the longshot alone."
    };
  }

  return {
    forceNoBet: false,
    reason: null,
    risk: null
  };
}

function rankOneXTwoOption(option, optionDefinitions, consensus) {
  const topModelOption = [...optionDefinitions].sort((left, right) => right.probability - left.probability)[0];
  const topConsensusEntry = consensus
    ? Object.entries(consensus).sort((left, right) => right[1] - left[1])[0] ?? null
    : null;
  const topConsensusKey = topConsensusEntry?.[0] ?? null;
  const topConsensusProbability = topConsensusEntry?.[1] ?? null;
  const favoriteConsensus =
    topConsensusKey !== null &&
    topModelOption.key === topConsensusKey &&
    topModelOption.key !== "draw" &&
    topModelOption.probability >= 0.48 &&
    (topConsensusProbability ?? 0) >= 0.55;
  const selectedGap = topModelOption.probability - option.modelProbability;
  const consensusProbability = option.consensusProbability ?? null;
  let score = (option.edge ?? -12);

  score += option.modelProbability * 18;
  score -= Math.abs(option.disagreement ?? 0) * 14;

  if (option.key === topModelOption.key) {
    score += 3.5;
  }

  if (favoriteConsensus && option.key === topModelOption.key) {
    score += 4;
  }

  if (favoriteConsensus && option.key !== topModelOption.key) {
    score -= Math.max(0, selectedGap) * 82;
    score -= Math.max(0, (topConsensusProbability ?? 0) - (consensusProbability ?? 0)) * 36;

    if ((option.bookmakerOdds ?? 0) >= 4) {
      score -= 5;
    }

    if (option.modelProbability < 0.34) {
      score -= 7;
    }

    if (topModelOption.probability >= 0.58 && option.modelProbability < 0.25) {
      score -= 12;
    }
  }

  if (option.key === "draw" && favoriteConsensus && option.modelProbability < 0.28) {
    score -= 3;
  }

  return score;
}

function buildMarketAssessment(matchId, marketKey, teams, features, model, context, beforeDate = null) {
  const definition = MARKET_DEFINITIONS[marketKey];
  const policy = context.decisionPolicy[marketKey];
  const optionDefinitions = buildOptionDefinitions(marketKey, teams, model.probabilities, model);
  const boardSelection = buildBookmakerRows(matchId, definition, optionDefinitions, context, features, beforeDate);
  const rows = boardSelection.rows;
  const optionStats = buildMarketOptionStats(rows, optionDefinitions);
  const consensus = buildConsensusProbabilities(rows);
  const selectedBookmaker =
    rows.find((row) => row.bookmakerKey === env.primaryBookmaker) ??
    rows[0] ??
    null;
  const rankedOptions = [...optionDefinitions].map((option) => {
    const selectedMarketOption = selectedBookmaker?.byKey?.[option.key] ?? null;
    const marketStats = optionStats[option.key] ?? {};
    const marketOption = selectedMarketOption ?? {
      label: option.label,
      shortLabel: option.shortLabel,
      modelProbability: option.probability,
      fairOdds: fairOdds(option.probability),
      bookmakerOdds: null,
      impliedProbability: 0,
      edge: null
    };

    return {
      key: option.key,
      label: option.label,
      shortLabel: option.shortLabel,
      modelProbability: option.probability,
      fairOdds: fairOdds(option.probability),
      bookmakerOdds: marketStats.bestOdds ?? marketOption.bookmakerOdds ?? null,
      impliedProbability: marketStats.impliedProbability ?? marketOption.impliedProbability ?? 0,
      bookmakerImpliedProbability: marketStats.impliedProbability ?? marketOption.impliedProbability ?? 0,
      bookmakerMarginAdjustedProbability: consensus?.[option.key] ?? null,
      edge: edgePercent(option.probability, marketStats.bestOdds ?? marketOption.bookmakerOdds ?? null),
      averageEdge: edgePercent(option.probability, marketStats.averageOdds ?? marketStats.bestOdds ?? marketOption.bookmakerOdds ?? null),
      targetOdds: requiredOddsForEdge(option.probability, policy.minEdge),
      bestBookmakerTitle: marketStats.bestBookmakerTitle ?? null,
      averageOdds: marketStats.averageOdds ?? null,
      movement: marketStats.movement ?? null,
      consensusProbability: consensus?.[option.key] ?? null,
      disagreement: consensus?.[option.key] === undefined ? null : round(option.probability - consensus[option.key], 4),
      modelVsMarketDisagreement: consensus?.[option.key] === undefined ? null : round(option.probability - consensus[option.key], 4)
    };
  });
  const bestOption = [...rankedOptions].sort((left, right) => {
    if (marketKey === "oneXTwo") {
      const scoreGap = rankOneXTwoOption(right, optionDefinitions, consensus) -
        rankOneXTwoOption(left, optionDefinitions, consensus);

      if (scoreGap !== 0) {
        return scoreGap;
      }
    }

    const edgeGap = (right.edge ?? -999) - (left.edge ?? -999);

    if (edgeGap !== 0) {
      return edgeGap;
    }

    return right.modelProbability - left.modelProbability;
  })[0];
  const probabilityValues = optionDefinitions.map((option) => option.probability).sort((left, right) => right - left);
  const clarityScore = probabilityValues.length > 1 ? probabilityValues[0] - probabilityValues[1] : probabilityValues[0];
  const oneXTwoGate = marketKey === "oneXTwo"
    ? oneXTwoGuardrail(bestOption, optionDefinitions, rows)
    : { forceNoBet: false, reason: null, risk: null };
  const priceQuality = buildPriceQualityPackage(marketKey, bestOption, rows, selectedBookmaker, context, features, boardSelection.board);
  const trust = buildTrustPackage(marketKey, bestOption, rows, selectedBookmaker, context, teams, model, features, priceQuality);
  // Use averageEdge (consensus market) for action qualification — bestEdge is kept
  // for display only. This prevents a single soft bookmaker from inflating the edge
  // enough to cross the policy minimum while the consensus line offers no real value.
  const baseAction = oneXTwoGate.forceNoBet ? "No Bet" : buildRecommendationAction(bestOption.averageEdge ?? bestOption.edge, policy);
  // In backtest mode skip system-level trust guardrails — they reflect current state, not historical.
  const trustGate = context.backtestMode
    ? { forceNoBet: false, downgradeAction: null }
    : applyTrustGuardrail(marketKey, trust, baseAction, policy);
  const priceGate = applyPriceQualityGuardrail(marketKey, priceQuality, trustGate.forceNoBet ? "No Bet" : (trustGate.downgradeAction ?? baseAction));
  const action = oneXTwoGate.forceNoBet
    ? "No Bet"
    : trustGate.forceNoBet
      ? "No Bet"
      : priceGate.forceNoBet
        ? "No Bet"
        : (priceGate.downgradeAction ?? trustGate.downgradeAction ?? baseAction);
  const confidence = buildConfidencePackage(bestOption, context, Boolean(selectedBookmaker), clarityScore, features, priceQuality);
  const credibility = buildCredibilityPackage(trust, features);
  const shortReason = action === "No Bet"
    ? (oneXTwoGate.reason ?? trustGate.reason ?? priceGate.reason ?? buildNoBetReason(bestOption, Boolean(selectedBookmaker), policy))
    : buildMarketReason(marketKey, bestOption.key, features, model, teams);
  const riskNote = action === "No Bet"
    ? (oneXTwoGate.risk ?? trustGate.risk ?? priceGate.risk ?? "Pass unless the line moves.")
    : buildMarketRisk(marketKey, bestOption.key, features, model, teams);
  const triggerNote = buildTriggerNote(marketKey, action, bestOption, trust, features, selectedBookmaker);
  const averageMarket = {
    optionA: round(average(rows.map((row) => firstFinite([row.options[0]?.bookmakerOdds], 0)).filter(Boolean), 0), 2),
    optionB: round(average(rows.map((row) => firstFinite([row.options[1]?.bookmakerOdds], 0)).filter(Boolean), 0), 2),
    optionC: rows[0]?.options[2] ? round(average(rows.map((row) => firstFinite([row.options[2]?.bookmakerOdds], 0)).filter(Boolean), 0), 2) : null
  };

  return {
    key: definition.key,
    name: definition.name,
    policy,
    hasOdds: Boolean(selectedBookmaker),
    selectedBookmaker,
    rows,
    averageMarket,
    optionStats,
    consensus,
    bestOption,
    recommendation: {
      action,
      baseAction,
      marketRole: definition.role,
      headline: buildRecommendationHeadline(definition.name, bestOption.shortLabel, action),
      confidence: confidence.label,
      confidenceReasons: confidence.reasons,
      credibilityScore: credibility.score,
      credibilityLabel: credibility.label,
      credibilityReasons: credibility.reasons,
      priceQualityStatus: priceQuality.status,
      priceTrustworthy: priceQuality.priceTrustworthy,
      oddsFreshnessMinutes: priceQuality.ageMinutes,
      oddsFreshnessScore: priceQuality.freshnessScore,
      oddsCoverageStatus: priceQuality.coverageStatus,
      dataCompletenessScore: priceQuality.dataCompletenessScore,
      quotaDegraded: priceQuality.quotaDegraded,
      boardProvider: priceQuality.boardProvider,
      boardSourceMode: priceQuality.boardSourceMode,
      fallbackUsed: priceQuality.fallbackUsed,
      boardQualityTier: priceQuality.boardQualityTier,
      boardQualityScore: priceQuality.boardQualityScore,
      staleOdds: priceQuality.staleOdds,
      recommendationDowngradeReason: oneXTwoGate.reason ? null : (priceGate.reason ?? null),
      shortReason,
      riskNote,
      triggerNote,
      selectionLabel: bestOption.shortLabel,
      isNoBet: action === "No Bet",
      trustScore: trust.score,
      trustLabel: trust.label,
      trustReasons: trust.reasons,
      bestBookmakerTitle: bestOption.bestBookmakerTitle ?? null
    },
    trust,
    priceQuality,
    board: boardSelection.board
  };
}

function buildBestBet(markets, backtestMode = false) {
  const marketRankScore = (market) => {
    const bestOdds = market.bestOption.bookmakerOdds ?? null;
    const avgOdds = market.bestOption.averageOdds ?? bestOdds;
    const rankingEdge = avgOdds != null
      ? edgePercent(market.bestOption.modelProbability, avgOdds)
      : (market.bestOption.edge ?? -12);
    const rankingAction = market.recommendation.baseAction ?? market.recommendation.action;
    const actionBoost = rankingAction === "Strong Value"
      ? 5
      : rankingAction === "Playable Edge"
        ? 3
        : rankingAction === "Small Edge"
          ? 1
          : 0;
    const outlierPenalty = (bestOdds != null && avgOdds != null && avgOdds > 0)
      ? Math.max(0, ((bestOdds / avgOdds) - 1.12) * 18)
      : 0;
    let score = rankingEdge + (market.trust?.score ?? 0) * 0.06 + (market.recommendation.credibilityScore ?? 0) * 0.03 + actionBoost - outlierPenalty;

    if (market.key === "totals25") {
      score += 3.6;
    } else if (market.key === "oneXTwo") {
      score -= 0.8;
      score -= Math.max(0, (market.bestOption.disagreement ?? 0) * 8);
    } else if (market.key === "btts") {
      score -= 6.0;
    }

    return score;
  };

  const candidates = Object.values(markets)
    .filter((market) => {
      const policy = market.policy;
      // In backtest mode skip system-level trust filter — it reflects current state, not historical.
      const trustOk = backtestMode || (market.trust?.score ?? 0) >= policy.minTrust;
      const avgEdge = market.bestOption.averageEdge ?? market.bestOption.edge ?? -999;
      return !market.recommendation.isNoBet &&
        avgEdge >= policy.minEdge &&
        trustOk;
    })
    .sort((left, right) => marketRankScore(right) - marketRankScore(left));

  const strongest = candidates[0];

  if (!strongest || strongest.recommendation.isNoBet) {
    return {
      hasBet: false,
      headline: "No Bet across the three main markets."
    };
  }

  return {
    hasBet: true,
    marketKey: strongest.key,
    marketName: strongest.name,
    selectionLabel: strongest.bestOption.shortLabel,
    edge: strongest.bestOption.edge,
    confidence: strongest.recommendation.confidence,
    trust: strongest.recommendation.trustLabel,
    credibility: strongest.recommendation.credibilityLabel,
    credibilityScore: strongest.recommendation.credibilityScore,
    headline: strongest.bestOption.shortLabel,
    reason: strongest.recommendation.shortReason
  };
}

function primaryMarketScore(market) {
  const bestOdds = market.bestOption.bookmakerOdds ?? null;
  const avgOdds = market.bestOption.averageOdds ?? bestOdds;
  const rankingEdge = avgOdds != null
    ? edgePercent(market.bestOption.modelProbability, avgOdds)
    : (market.bestOption.edge ?? -12);
  const rankingAction = market.recommendation.baseAction ?? market.recommendation.action;
  const actionBoost = rankingAction === "Strong Value"
    ? 5
    : rankingAction === "Playable Edge"
      ? 3
      : rankingAction === "Small Edge"
        ? 1
        : 0;
  const outlierPenalty = (bestOdds != null && avgOdds != null && avgOdds > 0)
    ? Math.max(0, ((bestOdds / avgOdds) - 1.12) * 18)
    : 0;
  const trustScore = market.trust?.score ?? 0;
  const credibilityScore = market.recommendation.credibilityScore ?? 0;

  let score = rankingEdge + (trustScore * 0.06) + (credibilityScore * 0.03) + actionBoost - outlierPenalty;

  if (market.key === "totals25") {
    score += 3.6;
  } else if (market.key === "oneXTwo") {
    score -= 0.8;
    score -= Math.max(0, (market.bestOption.disagreement ?? 0) * 8);
  } else if (market.key === "btts") {
    score -= 6.0;
  }

  return score;
}

function buildPrimaryMarket(markets) {
  const actionable = Object.values(markets)
    .filter((market) => !market.recommendation.isNoBet)
    .sort((left, right) => primaryMarketScore(right) - primaryMarketScore(left));
  const preferredNoBetReference = markets.oneXTwo ?? markets.totals25 ?? markets.btts;
  const primary = actionable[0] ?? preferredNoBetReference ?? markets.totals25 ?? markets.oneXTwo ?? markets.btts;

  if (!primary) {
    return null;
  }

  if (!actionable.length) {
    return {
      marketKey: primary.key,
      marketName: primary.name,
      role: MARKET_DEFINITIONS[primary.key]?.role ?? "secondary",
      selectionLabel: primary.bestOption.shortLabel,
      action: "No Bet",
      confidence: primary.recommendation.confidence,
      trust: primary.recommendation.trustLabel,
      credibility: primary.recommendation.credibilityLabel,
      edge: primary.bestOption.edge,
      reason: "No Bet across the three main markets."
    };
  }

  return {
    marketKey: primary.key,
    marketName: primary.name,
    role: MARKET_DEFINITIONS[primary.key]?.role ?? "secondary",
    selectionLabel: primary.bestOption.shortLabel,
    action: primary.recommendation.action,
    confidence: primary.recommendation.confidence,
    trust: primary.recommendation.trustLabel,
    credibility: primary.recommendation.credibilityLabel,
    edge: primary.bestOption.edge,
    reason: primary.recommendation.shortReason
  };
}

export const __bettingEngineTestables = {
  buildOptionDefinitions,
  buildBestBet,
  buildPrimaryMarket,
  buildPrimaryMarketLegacy,
  applyPriceQualityGuardrail,
  buildConsensusProbabilities,
  edgePercent,
  fairOdds,
  buildPriceQualityPackage,
  resolveBoardSelection,
  filterRowsBeforeDate
};

function buildPrimaryMarketLegacy(markets) {
  const marketRankScore = (market) => {
    const bestOdds = market.bestOption.bookmakerOdds ?? null;
    const avgOdds = market.bestOption.averageOdds ?? bestOdds;
    // Use consensus (average) odds for ranking to avoid outlier bookmaker lines
    // inflating edge. If averageOdds is unavailable, fall back to bestOdds.
    const rankingEdge = avgOdds != null
      ? edgePercent(market.bestOption.modelProbability, avgOdds)
      : (market.bestOption.edge ?? -12);
    const trustScore = market.trust?.score ?? 0;
    const credibilityScore = market.recommendation.credibilityScore ?? 0;
    // Use baseAction (pre-guardrail) for ranking so that a stale-odds or
    // fallback-board downgrade on one market doesn't unfairly suppress it.
    const rankingAction = market.recommendation.baseAction ?? market.recommendation.action;
    const actionBoost = rankingAction === "Strong Value"
      ? 5
      : rankingAction === "Playable Edge"
        ? 3
        : rankingAction === "Small Edge"
          ? 1
          : 0;

    // Penalise outlier bookmaker lines: if best odds are >12% above average odds
    // the line is likely soft and the edge is not reliably realisable.
    const outlierPenalty = (bestOdds != null && avgOdds != null && avgOdds > 0)
      ? Math.max(0, ((bestOdds / avgOdds) - 1.12) * 18)
      : 0;

    let score = rankingEdge + (trustScore * 0.06) + (credibilityScore * 0.03) + actionBoost - outlierPenalty;

    if (market.key === "totals25") {
      score += 3.6;
    } else if (market.key === "oneXTwo") {
      score -= 0.8;
      score -= Math.max(0, (market.bestOption.disagreement ?? 0) * 8);
    } else if (market.key === "btts") {
      score -= 6.0;
    }

    return score;
  };

  const ranked = Object.values(markets)
    .sort((left, right) => marketRankScore(right) - marketRankScore(left));
  const primary = ranked[0] ?? markets.totals25 ?? markets.oneXTwo ?? markets.btts;

  return primary
    ? {
        marketKey: primary.key,
        marketName: primary.name,
        role: MARKET_DEFINITIONS[primary.key]?.role ?? "secondary",
        selectionLabel: primary.bestOption.shortLabel,
        action: primary.recommendation.action,
        confidence: primary.recommendation.confidence,
        trust: primary.recommendation.trustLabel,
        credibility: primary.recommendation.credibilityLabel,
        edge: primary.bestOption.edge,
        reason: primary.recommendation.shortReason
      }
    : null;
}

export function buildBettingAssessment(matchId, model, options = {}) {
  const beforeDate = options.beforeDate ?? null;
  const backtestMode = Boolean(options.backtestMode);
  const decisionPolicy = resolveDecisionPolicy(options.decisionPolicy ?? null);
  const context = {
    dataCoverageScore: options.dataCoverageScore ?? 0.35,
    coverageBlend: options.coverageBlend ?? 0.5,
    decisionPolicy,
    backtestMode
  };
  const features = options.features;
  const teams = {
    home: features?.home?.name ?? "Home team",
    away: features?.away?.name ?? "Away team"
  };
  const modelWithFeatures = {
    ...model,
    features
  };

  const markets = {
    oneXTwo: buildMarketAssessment(matchId, "oneXTwo", teams, features, modelWithFeatures, context, beforeDate),
    totals25: buildMarketAssessment(matchId, "totals25", teams, features, modelWithFeatures, context, beforeDate),
    btts: buildMarketAssessment(matchId, "btts", teams, features, modelWithFeatures, context, beforeDate)
  };
  const oneXTwo = markets.oneXTwo;
  const legacySelected = oneXTwo.selectedBookmaker;
  const fair = {
    homeOdds: fairOdds(model.probabilities.homeWin),
    drawOdds: fairOdds(model.probabilities.draw),
    awayOdds: fairOdds(model.probabilities.awayWin)
  };
  const edges = {
    home: oneXTwo.bestOption.key === "home" ? oneXTwo.bestOption.edge : legacySelected?.byKey?.home?.edge ?? null,
    draw: oneXTwo.bestOption.key === "draw" ? oneXTwo.bestOption.edge : legacySelected?.byKey?.draw?.edge ?? null,
    away: oneXTwo.bestOption.key === "away" ? oneXTwo.bestOption.edge : legacySelected?.byKey?.away?.edge ?? null
  };

  return {
    markets,
    primaryMarket: buildPrimaryMarket(markets),
    bestBet: buildBestBet(markets, backtestMode),
    market: {
      hasOdds: oneXTwo.hasOdds,
      selectedBookmaker: legacySelected,
      averageMarket: oneXTwo.averageMarket,
      rows: oneXTwo.rows
    },
    fair,
    edges,
    recommendation: {
      outcome: oneXTwo.bestOption.shortLabel,
      edge: oneXTwo.bestOption.edge,
      bookmakerOdds: oneXTwo.bestOption.bookmakerOdds,
      fairOdds: oneXTwo.bestOption.fairOdds,
      modelProbability: oneXTwo.bestOption.modelProbability,
      assessment: oneXTwo.recommendation.headline,
      confidence: oneXTwo.recommendation.confidence
    }
  };
}

export function compareToImplied(probabilities, market) {
  const selected = market?.selectedBookmaker;

  if (!selected?.byKey) {
    return null;
  }

  return {
    home: round(probabilities.homeWin - (selected.byKey.home?.impliedProbability ?? 0), 4),
    draw: round(probabilities.draw - (selected.byKey.draw?.impliedProbability ?? 0), 4),
    away: round(probabilities.awayWin - (selected.byKey.away?.impliedProbability ?? 0), 4)
  };
}
