import { getDb } from "../../db/database.js";
import { round } from "../../lib/math.js";
import { isoNow } from "../../lib/time.js";

export const DEFAULT_MODEL_PARAMETERS = {
  baseline: {
    homeEloDivisor: 900,
    awayEloDivisor: 1100
  },
  home: {
    intercept: 0,
    opponentAdjustedForm: 0.2,
    shortAttack: 0.24,
    venueStrength: 0.18,
    momentum: 0.07,
    schedule: 0.07,
    xg: 0.16,
    availability: 0.08
  },
  away: {
    intercept: 0,
    opponentAdjustedForm: 0.12,
    shortDefense: 0.24,
    venueStrength: 0.18,
    momentum: 0.05,
    schedule: 0.05,
    xg: 0.16,
    availability: 0.08
  }
};

let activeParametersCache = null;

function mergeBranch(defaults, incoming = {}) {
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, incoming[key] ?? defaults[key]])
  );
}

export function normalizeModelParameters(parameters = {}) {
  return {
    baseline: mergeBranch(DEFAULT_MODEL_PARAMETERS.baseline, parameters.baseline),
    home: mergeBranch(DEFAULT_MODEL_PARAMETERS.home, parameters.home),
    away: mergeBranch(DEFAULT_MODEL_PARAMETERS.away, parameters.away)
  };
}

export function clearActiveModelParametersCache() {
  activeParametersCache = null;
}

export function getLatestActiveParameterSet() {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM model_parameter_sets
    WHERE is_active = 1
    ORDER BY datetime(trained_at) DESC, id DESC
    LIMIT 1
  `).get();
}

export function getActiveModelParameters(forceRefresh = false) {
  if (activeParametersCache && !forceRefresh) {
    return activeParametersCache;
  }

  const row = getLatestActiveParameterSet();

  activeParametersCache = {
    id: row?.id ?? null,
    source: row ? "trained" : "default",
    trainedAt: row?.trained_at ?? null,
    parameters: normalizeModelParameters(row?.parameters_json ? JSON.parse(row.parameters_json) : DEFAULT_MODEL_PARAMETERS),
    summary: row?.summary_json ? JSON.parse(row.summary_json) : null
  };

  return activeParametersCache;
}

export function setActiveParameterSet(parameterSetId) {
  const db = getDb();
  db.prepare("UPDATE model_parameter_sets SET is_active = 0 WHERE is_active = 1").run();
  db.prepare("UPDATE model_parameter_sets SET is_active = 1, status = 'active' WHERE id = ?").run(parameterSetId);
  clearActiveModelParametersCache();
}

export function saveModelParameterSet({
  modelName = "goal-adjustment-v1",
  parameters,
  sampleCount,
  holdoutCount,
  status = "candidate",
  isActive = 0,
  trainMetrics,
  holdoutMetrics,
  improvementVsActive = null,
  summary
}) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO model_parameter_sets (
      model_name, trained_at, sample_count, holdout_count, status, is_active,
      train_log_loss, holdout_log_loss, train_goal_mse, holdout_goal_mse,
      improvement_vs_active, parameters_json, summary_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    modelName,
    isoNow(),
    sampleCount,
    holdoutCount,
    status,
    isActive ? 1 : 0,
    trainMetrics?.logLoss ?? null,
    holdoutMetrics?.logLoss ?? null,
    trainMetrics?.goalMse ?? null,
    holdoutMetrics?.goalMse ?? null,
    improvementVsActive === null ? null : round(improvementVsActive, 4),
    JSON.stringify(normalizeModelParameters(parameters)),
    JSON.stringify(summary ?? {})
  );

  if (isActive) {
    setActiveParameterSet(result.id);
  }

  return result.id;
}

export function getModelTrainingStatus() {
  const db = getDb();
  const active = getLatestActiveParameterSet();
  const latest = db.prepare(`
    SELECT *
    FROM model_parameter_sets
    ORDER BY datetime(trained_at) DESC, id DESC
    LIMIT 1
  `).get();

  return {
    active: active
      ? {
          id: active.id,
          modelName: active.model_name,
          trainedAt: active.trained_at,
          sampleCount: active.sample_count,
          holdoutCount: active.holdout_count,
          holdoutLogLoss: active.holdout_log_loss,
          holdoutGoalMse: active.holdout_goal_mse,
          improvementVsActive: active.improvement_vs_active,
          summary: active.summary_json ? JSON.parse(active.summary_json) : null
        }
      : null,
    latest: latest
      ? {
          id: latest.id,
          modelName: latest.model_name,
          trainedAt: latest.trained_at,
          status: latest.status,
          sampleCount: latest.sample_count,
          holdoutCount: latest.holdout_count,
          holdoutLogLoss: latest.holdout_log_loss,
          holdoutGoalMse: latest.holdout_goal_mse,
          improvementVsActive: latest.improvement_vs_active,
          isActive: Boolean(latest.is_active),
          summary: latest.summary_json ? JSON.parse(latest.summary_json) : null
        }
      : null
  };
}
