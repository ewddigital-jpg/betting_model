import { APP_COMPETITION_CODES } from "../../config/leagues.js";
import { getDb } from "../../db/database.js";
import { round } from "../../lib/math.js";
import { buildRatingsUntil } from "./eloEngine.js";
import { buildMatchFeatures } from "./featureBuilder.js";
import { buildBettingAssessment } from "./bettingEngine.js";
import { actualOutcomeLabelForMarket } from "./marketOutcomeUtils.js";
import { DEFAULT_DECISION_POLICY, getActiveDecisionPolicy, getDecisionPolicyStatus, saveDecisionPolicySet } from "./decisionPolicyParameters.js";
import { calculateProbabilities } from "./probabilityModel.js";

const MARKET_KEYS = ["oneXTwo", "totals25", "btts"];

function finishedMatchRows() {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM matches
    WHERE status = 'FINISHED'
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND competition_code IN (${APP_COMPETITION_CODES.map(() => "?").join(", ")})
    ORDER BY datetime(utc_date) ASC, id ASC
  `).all(...APP_COMPETITION_CODES);
}

function candidatePolicies(defaults) {
  const minEdges = [Math.max(3, defaults.minEdge - 2), defaults.minEdge - 1, defaults.minEdge, defaults.minEdge + 1, defaults.minEdge + 2]
    .map((value) => round(Math.max(2.5, value), 1));
  const minTrusts = [defaults.minTrust - 6, defaults.minTrust - 3, defaults.minTrust, defaults.minTrust + 3, defaults.minTrust + 6]
    .map((value) => Math.max(40, Math.min(90, value)));

  const candidates = [];

  for (const minEdge of [...new Set(minEdges)]) {
    for (const minTrust of [...new Set(minTrusts)]) {
      const playableEdge = round(Math.max(minEdge + 1, defaults.playableEdge + (minEdge - defaults.minEdge)), 1);
      const strongEdge = round(Math.max(playableEdge + 2, defaults.strongEdge + (minTrust - defaults.minTrust) / 6), 1);
      const minPlayableTrust = Math.max(minTrust + 4, defaults.minPlayableTrust);
      const minStrongTrust = Math.max(minPlayableTrust + 8, defaults.minStrongTrust);

      candidates.push({
        minEdge,
        playableEdge,
        strongEdge,
        minTrust,
        minPlayableTrust,
        minStrongTrust
      });
    }
  }

  return candidates;
}

function buildHistoricalDataset(limit = 240) {
  const rows = finishedMatchRows();
  const sample = rows.slice(-Math.max(limit, 140));
  const historyRows = [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const dataset = [];

  for (const match of sample) {
    if (historyRows.length < 60) {
      historyRows.push(byId.get(match.id));
      continue;
    }

    const ratings = buildRatingsUntil(historyRows, match.utc_date);
    const features = buildMatchFeatures(match.id, ratings, { asOfTime: match.utc_date });
    const model = calculateProbabilities(features);
    dataset.push({ match, features, model });
    historyRows.push(byId.get(match.id));
  }

  return dataset;
}

function splitDataset(rows, holdoutRatio = 0.2) {
  const holdoutCount = Math.max(20, Math.floor(rows.length * holdoutRatio));
  return {
    train: rows.slice(0, Math.max(0, rows.length - holdoutCount)),
    holdout: rows.slice(-holdoutCount)
  };
}

function aggregatePolicyMetrics(rowsByMarket) {
  const roiRows = rowsByMarket.filter((row) => row.roi !== null && row.roi !== undefined);
  const hitRateRows = rowsByMarket.filter((row) => row.hitRate !== null && row.hitRate !== undefined);

  return {
    byMarket: rowsByMarket,
    totalBets: rowsByMarket.reduce((sum, row) => sum + (row.bets ?? 0), 0),
    roi: roiRows.length
      ? round(roiRows.reduce((sum, row) => sum + row.roi, 0) / roiRows.length, 2)
      : null,
    hitRate: hitRateRows.length
      ? round(hitRateRows.reduce((sum, row) => sum + row.hitRate, 0) / hitRateRows.length, 1)
      : null
  };
}

function summarizeMarketRows(rows, marketKey) {
  const marketName = rows[0]?.assessment?.markets?.[marketKey]?.name ?? marketKey;
  const actionable = rows.filter((row) => row.assessment.markets[marketKey].recommendation.action !== "No Bet");
  const settled = actionable.filter((row) => row.roi !== null);
  const wins = settled.filter((row) => row.result === "won");
  const roi = settled.length ? round((settled.reduce((sum, row) => sum + row.roi, 0) / settled.length) * 100, 2) : null;
  const hitRate = settled.length ? round((wins.length / settled.length) * 100, 1) : null;

  return {
    market: marketName,
    bets: actionable.length,
    settledBets: settled.length,
    wins: wins.length,
    hitRate,
    roi
  };
}

function evaluatePolicyForMarket(rows, marketKey, branch) {
  const policy = {
    ...DEFAULT_DECISION_POLICY,
    [marketKey]: branch
  };
  const assessed = rows.map(({ match, features, model }) => {
    const assessment = buildBettingAssessment(match.id, model, {
      beforeDate: match.utc_date,
      features,
      dataCoverageScore: features.context.dataCoverageScore,
      coverageBlend: model.diagnostics.coverageBlend,
      decisionPolicy: policy
    });
    const market = assessment.markets[marketKey];
    const selection = market.bestOption.shortLabel;
    const resultLabel = actualOutcomeLabelForMarket(market.name, match, features);
    const won = market.recommendation.action !== "No Bet" && selection === resultLabel;

    return {
      assessment,
      result: market.recommendation.action === "No Bet" ? "pass" : won ? "won" : "lost",
      roi: market.recommendation.action === "No Bet" || !market.bestOption.bookmakerOdds
        ? null
        : round(won ? market.bestOption.bookmakerOdds - 1 : -1, 4)
    };
  });

  const summary = summarizeMarketRows(assessed, marketKey);
  return {
    branch,
    summary
  };
}

function chooseBranch(trainRows, holdoutRows, marketKey, defaults) {
  const candidates = candidatePolicies(defaults);
  const ranked = candidates.map((branch) => {
    const train = evaluatePolicyForMarket(trainRows, marketKey, branch).summary;
    const holdout = evaluatePolicyForMarket(holdoutRows, marketKey, branch).summary;
    const score = (holdout.roi ?? -999) + ((holdout.hitRate ?? 0) / 100);

    return {
      branch,
      train,
      holdout,
      score
    };
  }).filter((entry) => entry.train.bets >= 6 && entry.holdout.bets >= 3)
    .sort((left, right) => right.score - left.score);

  return ranked[0] ?? {
    branch: defaults,
    train: evaluatePolicyForMarket(trainRows, marketKey, defaults).summary,
    holdout: evaluatePolicyForMarket(holdoutRows, marketKey, defaults).summary,
    score: -999
  };
}

export function trainDecisionPolicies({ limit = 240, promoteThreshold = 0.5 } = {}) {
  const dataset = buildHistoricalDataset(limit);

  if (dataset.length < 120) {
    return {
      status: "skipped",
      reason: "Not enough historical matches to train separate market policies safely.",
      sampleCount: dataset.length
    };
  }

  const split = splitDataset(dataset);
  const current = getActiveDecisionPolicy().policy;
  const selected = Object.fromEntries(
    MARKET_KEYS.map((marketKey) => [marketKey, chooseBranch(split.train, split.holdout, marketKey, current[marketKey])])
  );
  const candidatePolicy = {
    oneXTwo: selected.oneXTwo.branch,
    totals25: selected.totals25.branch,
    btts: selected.btts.branch
  };

  const trainMetrics = aggregatePolicyMetrics(
    MARKET_KEYS.map((marketKey) => ({ marketKey, ...selected[marketKey].train }))
  );
  const holdoutMetrics = aggregatePolicyMetrics(
    MARKET_KEYS.map((marketKey) => ({ marketKey, ...selected[marketKey].holdout }))
  );
  const hasEnoughPricedSample = holdoutMetrics.totalBets >= 8 && holdoutMetrics.byMarket.some((row) => (row.bets ?? 0) >= 3);

  if (!hasEnoughPricedSample) {
    return {
      status: "skipped",
      reason: "Not enough priced historical bets to train separate market policies honestly.",
      sampleCount: split.train.length,
      holdoutCount: split.holdout.length,
      trainMetrics,
      holdoutMetrics
    };
  }

  const activeStatus = getDecisionPolicyStatus();
  const activeHoldoutRoi = activeStatus.active?.holdoutRoi ?? null;
  const improvement = activeHoldoutRoi === null ? null : holdoutMetrics.roi - activeHoldoutRoi;
  const shouldPromote = activeHoldoutRoi === null || (holdoutMetrics.roi ?? -999) > (activeHoldoutRoi + promoteThreshold);

  const summary = {
    selectedPolicies: candidatePolicy,
    trainMetrics,
    holdoutMetrics,
    trainedAt: new Date().toISOString()
  };

  const parameterSetId = saveDecisionPolicySet({
    policy: candidatePolicy,
    sampleCount: split.train.length,
    holdoutCount: split.holdout.length,
    status: shouldPromote ? "active" : "rejected",
    isActive: shouldPromote ? 1 : 0,
    trainMetrics,
    holdoutMetrics,
    improvementVsActive: improvement,
    summary
  });

  return {
    status: shouldPromote ? "promoted" : "rejected",
    parameterSetId,
    sampleCount: split.train.length,
    holdoutCount: split.holdout.length,
    trainMetrics,
    holdoutMetrics,
    improvementVsActive: improvement === null ? null : round(improvement, 2)
  };
}

export function maybeAutoTrainDecisionPolicies() {
  const status = getDecisionPolicyStatus();
  const rows = finishedMatchRows();
  const totalFinished = rows.length;
  const latestHours = status.latest?.trainedAt
    ? (Date.now() - new Date(status.latest.trainedAt).getTime()) / (1000 * 60 * 60)
    : null;

  if (totalFinished < 180) {
    return {
      status: "skipped",
      reason: "Not enough settled matches yet for market policy training."
    };
  }

  if (latestHours !== null && latestHours < 12) {
    return {
      status: "skipped",
      reason: "Latest decision-policy training run is still fresh.",
      hoursSinceLatestTraining: round(latestHours, 1)
    };
  }

  return trainDecisionPolicies();
}
