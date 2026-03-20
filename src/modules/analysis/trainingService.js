import { APP_COMPETITION_CODES } from "../../config/leagues.js";
import { getDb } from "../../db/database.js";
import { clamp, round } from "../../lib/math.js";
import { isoNow } from "../../lib/time.js";
import { buildRatingsUntil } from "./eloEngine.js";
import { buildMatchFeatures } from "./featureBuilder.js";
import { calculateProbabilities, buildModelSignals } from "./probabilityModel.js";
import {
  DEFAULT_MODEL_PARAMETERS,
  getActiveModelParameters,
  getModelTrainingStatus,
  normalizeModelParameters,
  saveModelParameterSet
} from "./modelParameters.js";

const HOME_FEATURE_KEYS = [
  "intercept",
  "opponentAdjustedForm",
  "shortAttack",
  "venueStrength",
  "momentum",
  "schedule",
  "xg",
  "availability"
];

const AWAY_FEATURE_KEYS = [
  "intercept",
  "opponentAdjustedForm",
  "shortDefense",
  "venueStrength",
  "momentum",
  "schedule",
  "xg",
  "availability"
];

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

function buildRegressionRow(match, features) {
  const signals = buildModelSignals(features, DEFAULT_MODEL_PARAMETERS);

  return {
    matchId: match.id,
    utcDate: match.utc_date,
    features,
    homeGoals: match.home_score,
    awayGoals: match.away_score,
    homeVector: {
      intercept: 1,
      opponentAdjustedForm: signals.adjustments.opponentAdjustedFormDelta * signals.coverageBlend,
      shortAttack: signals.adjustments.shortAttackDelta * signals.coverageBlend,
      venueStrength: signals.adjustments.homeVenueStrengthDelta * signals.coverageBlend,
      momentum: signals.adjustments.momentumDelta * signals.coverageBlend,
      schedule: signals.adjustments.scheduleDelta,
      xg: signals.adjustments.xgHomeDelta * signals.coverageBlend,
      availability: signals.adjustments.availabilityDelta
    },
    awayVector: {
      intercept: 1,
      opponentAdjustedForm: (-signals.adjustments.opponentAdjustedFormDelta) * signals.coverageBlend,
      shortDefense: signals.adjustments.shortDefenseDelta * signals.coverageBlend,
      venueStrength: signals.adjustments.awayVenueStrengthDelta * signals.coverageBlend,
      momentum: (-signals.adjustments.momentumDelta) * signals.coverageBlend,
      schedule: (-signals.adjustments.scheduleDelta),
      xg: signals.adjustments.xgAwayDelta * signals.coverageBlend,
      availability: (-signals.adjustments.availabilityDelta)
    },
    baseline: {
      home: signals.baseline.home,
      away: signals.baseline.away
    }
  };
}

function buildTrainingRows(limit = 450) {
  const rows = finishedMatchRows();
  const sample = rows.slice(-Math.max(limit, 120));
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
    dataset.push(buildRegressionRow(match, features));
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

function trainLinearWeights(rows, targetKey, baselineKey, featureKeys, defaultWeights) {
  const weights = Object.fromEntries(featureKeys.map((key) => [key, defaultWeights[key] ?? 0]));
  const learningRate = 0.015;
  const regularization = 0.0015;
  const iterations = 1200;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = Object.fromEntries(featureKeys.map((key) => [key, 0]));

    for (const row of rows) {
      const baseline = row.baseline[baselineKey];
      const predicted = baseline + featureKeys.reduce((sum, key) => sum + (weights[key] * row[targetKey][key]), 0);
      const error = clamp(predicted, 0.2, 3.8) - row[baselineKey === "home" ? "homeGoals" : "awayGoals"];

      for (const key of featureKeys) {
        gradient[key] += (error * row[targetKey][key]) + (regularization * weights[key]);
      }
    }

    for (const key of featureKeys) {
      weights[key] -= learningRate * (gradient[key] / rows.length);
      const limit = key === "intercept" ? 0.5 : 0.45;
      weights[key] = clamp(weights[key], -limit, limit);
    }
  }

  return weights;
}

function evaluateParameterSet(rows, parameterSet) {
  if (!rows.length) {
    return {
      matches: 0,
      logLoss: null,
      goalMse: null
    };
  }

  let logLoss = 0;
  let goalMse = 0;

  for (const row of rows) {
    const model = calculateProbabilities(row.features, { parameters: parameterSet });
    const actualProbability =
      row.homeGoals > row.awayGoals
        ? model.probabilities.homeWin
        : row.homeGoals === row.awayGoals
          ? model.probabilities.draw
          : model.probabilities.awayWin;

    logLoss += -Math.log(Math.max(actualProbability, 0.01));
    goalMse += (((model.expectedGoals.home - row.homeGoals) ** 2) + ((model.expectedGoals.away - row.awayGoals) ** 2)) / 2;
  }

  return {
    matches: rows.length,
    logLoss: round(logLoss / rows.length, 4),
    goalMse: round(goalMse / rows.length, 4)
  };
}

function deriveCandidateParameters(rows, baseParameters) {
  const reference = normalizeModelParameters(baseParameters ?? DEFAULT_MODEL_PARAMETERS);
  const homeWeights = trainLinearWeights(rows, "homeVector", "home", HOME_FEATURE_KEYS, reference.home);
  const awayWeights = trainLinearWeights(rows, "awayVector", "away", AWAY_FEATURE_KEYS, reference.away);

  return normalizeModelParameters({
    baseline: reference.baseline,
    home: homeWeights,
    away: awayWeights
  });
}

function candidateSummary(trainMetrics, holdoutMetrics, activeMetrics, promoted) {
  return {
    trainMetrics,
    holdoutMetrics,
    activeHoldoutMetrics: activeMetrics,
    promoted,
    trainedAt: isoNow()
  };
}

function summarizeMetricSamples(samples, key) {
  const usable = samples.filter((entry) => Number.isFinite(entry?.[key]));
  if (!usable.length) {
    return null;
  }

  return round(usable.reduce((sum, entry) => sum + entry[key], 0) / usable.length, 4);
}

function summarizeWalkForwardSlices(slices) {
  return {
    slices: slices.length,
    matches: slices.reduce((sum, slice) => sum + (slice.matches ?? 0), 0),
    logLoss: summarizeMetricSamples(slices, "logLoss"),
    goalMse: summarizeMetricSamples(slices, "goalMse")
  };
}

function buildWalkForwardSlices(rows, {
  minTrainSize = 120,
  stepSize = 20,
  maxSlices = 6
} = {}) {
  const slices = [];

  for (let start = minTrainSize; start < rows.length; start += stepSize) {
    const trainRows = rows.slice(0, start);
    const evaluationRows = rows.slice(start, start + stepSize);

    if (!evaluationRows.length) {
      break;
    }

    slices.push({
      trainRows,
      evaluationRows,
      trainSize: trainRows.length,
      evaluationSize: evaluationRows.length
    });
  }

  return slices.slice(-maxSlices);
}

function evaluateWalkForwardParameterSets(rows, activeParameters, {
  minTrainSize = 120,
  stepSize = 20,
  maxSlices = 6
} = {}) {
  const slices = buildWalkForwardSlices(rows, { minTrainSize, stepSize, maxSlices });

  if (!slices.length) {
    return {
      candidate: {
        slices: 0,
        matches: 0,
        logLoss: null,
        goalMse: null
      },
      active: {
        slices: 0,
        matches: 0,
        logLoss: null,
        goalMse: null
      },
      deltaLogLoss: null,
      deltaGoalMse: null,
      windows: []
    };
  }

  const candidateWindows = [];
  const activeWindows = [];
  const windows = [];

  for (const slice of slices) {
    const candidateParameters = deriveCandidateParameters(slice.trainRows, activeParameters);
    const candidateMetrics = evaluateParameterSet(slice.evaluationRows, candidateParameters);
    const activeMetrics = evaluateParameterSet(slice.evaluationRows, activeParameters);

    candidateWindows.push(candidateMetrics);
    activeWindows.push(activeMetrics);
    windows.push({
      trainSize: slice.trainSize,
      evaluationSize: slice.evaluationSize,
      candidate: candidateMetrics,
      active: activeMetrics,
      deltaLogLoss: Number.isFinite(candidateMetrics.logLoss) && Number.isFinite(activeMetrics.logLoss)
        ? round(activeMetrics.logLoss - candidateMetrics.logLoss, 4)
        : null,
      deltaGoalMse: Number.isFinite(candidateMetrics.goalMse) && Number.isFinite(activeMetrics.goalMse)
        ? round(activeMetrics.goalMse - candidateMetrics.goalMse, 4)
        : null
    });
  }

  const candidateSummary = summarizeWalkForwardSlices(candidateWindows);
  const activeSummary = summarizeWalkForwardSlices(activeWindows);

  return {
    candidate: candidateSummary,
    active: activeSummary,
    deltaLogLoss: Number.isFinite(candidateSummary.logLoss) && Number.isFinite(activeSummary.logLoss)
      ? round(activeSummary.logLoss - candidateSummary.logLoss, 4)
      : null,
    deltaGoalMse: Number.isFinite(candidateSummary.goalMse) && Number.isFinite(activeSummary.goalMse)
      ? round(activeSummary.goalMse - candidateSummary.goalMse, 4)
      : null,
    windows
  };
}

export function trainModelParameters({ limit = 450, promoteThreshold = 0.005 } = {}) {
  const dataset = buildTrainingRows(limit);

  if (dataset.length < 120) {
    return {
      status: "skipped",
      reason: "Not enough historical matches to train safely.",
      sampleCount: dataset.length
    };
  }

  const split = splitDataset(dataset);
  const current = getActiveModelParameters().parameters;
  const candidate = deriveCandidateParameters(split.train, current);

  const trainMetrics = evaluateParameterSet(split.train, candidate);
  const holdoutMetrics = evaluateParameterSet(split.holdout, candidate);
  const activeHoldoutMetrics = evaluateParameterSet(split.holdout, current);
  const walkForward = evaluateWalkForwardParameterSets(dataset, current);
  const improvement = (activeHoldoutMetrics.logLoss ?? Number.POSITIVE_INFINITY) - (holdoutMetrics.logLoss ?? Number.POSITIVE_INFINITY);
  const walkForwardImprovement = walkForward.deltaLogLoss;
  const shouldPromote =
    (
      !Number.isFinite(activeHoldoutMetrics.logLoss) ||
      improvement > promoteThreshold
    ) &&
    (
      !Number.isFinite(walkForwardImprovement) ||
      walkForwardImprovement > 0
    );
  const summary = {
    ...candidateSummary(trainMetrics, holdoutMetrics, activeHoldoutMetrics, shouldPromote),
    walkForward
  };

  const parameterSetId = saveModelParameterSet({
    parameters: candidate,
    sampleCount: split.train.length,
    holdoutCount: split.holdout.length,
    status: shouldPromote ? "active" : "rejected",
    isActive: shouldPromote ? 1 : 0,
    trainMetrics,
    holdoutMetrics,
    improvementVsActive: Number.isFinite(improvement) ? improvement : null,
    summary
  });

  return {
    status: shouldPromote ? "promoted" : "rejected",
    parameterSetId,
    sampleCount: split.train.length,
    holdoutCount: split.holdout.length,
    trainMetrics,
    holdoutMetrics,
    activeHoldoutMetrics,
    walkForward,
    improvementVsActive: Number.isFinite(improvement) ? round(improvement, 4) : null
  };
}

export function maybeAutoTrainModel() {
  const status = getModelTrainingStatus();
  const rows = finishedMatchRows();
  const totalFinished = rows.length;
  const latestTrainingHours = status.latest?.trainedAt
    ? (Date.now() - new Date(status.latest.trainedAt).getTime()) / (1000 * 60 * 60)
    : null;

  if (totalFinished < 180) {
    return {
      status: "skipped",
      reason: "Not enough settled matches yet."
    };
  }

  if (latestTrainingHours !== null && latestTrainingHours < 12) {
    return {
      status: "skipped",
      reason: "Latest model training run is still fresh.",
      hoursSinceLatestTraining: round(latestTrainingHours, 1)
    };
  }

  if (!status.active) {
    return trainModelParameters();
  }

  const newFinishedMatches = rows.filter((row) => new Date(row.utc_date) > new Date(status.active.trainedAt)).length;

  if (newFinishedMatches < 12) {
    return {
      status: "skipped",
      reason: "Not enough new finished matches since the last active model.",
      newFinishedMatches
    };
  }

  return trainModelParameters();
}
