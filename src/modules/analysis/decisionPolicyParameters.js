import { getDb } from "../../db/database.js";
import { round } from "../../lib/math.js";
import { isoNow } from "../../lib/time.js";

export const DEFAULT_DECISION_POLICY = {
  oneXTwo: {
    minEdge: 7.25,
    playableEdge: 9.25,
    strongEdge: 13,
    minTrust: 64,
    minPlayableTrust: 72,
    minStrongTrust: 82
  },
  totals25: {
    minEdge: 3.25,
    playableEdge: 4.75,
    strongEdge: 7.5,
    minTrust: 52,
    minPlayableTrust: 60,
    minStrongTrust: 70
  },
  btts: {
    minEdge: 6.75,
    playableEdge: 8.75,
    strongEdge: 12.5,
    minTrust: 62,
    minPlayableTrust: 72,
    minStrongTrust: 82
  }
};

let activePolicyCache = null;

function normalizeBranch(defaults, incoming = {}) {
  return {
    minEdge: incoming.minEdge ?? defaults.minEdge,
    playableEdge: incoming.playableEdge ?? defaults.playableEdge,
    strongEdge: incoming.strongEdge ?? defaults.strongEdge,
    minTrust: incoming.minTrust ?? defaults.minTrust,
    minPlayableTrust: incoming.minPlayableTrust ?? defaults.minPlayableTrust,
    minStrongTrust: incoming.minStrongTrust ?? defaults.minStrongTrust
  };
}

export function normalizeDecisionPolicy(policy = {}) {
  return {
    oneXTwo: normalizeBranch(DEFAULT_DECISION_POLICY.oneXTwo, policy.oneXTwo),
    totals25: normalizeBranch(DEFAULT_DECISION_POLICY.totals25, policy.totals25),
    btts: normalizeBranch(DEFAULT_DECISION_POLICY.btts, policy.btts)
  };
}

export function clearActiveDecisionPolicyCache() {
  activePolicyCache = null;
}

function getLatestActiveDecisionPolicySet() {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM decision_policy_sets
    WHERE is_active = 1
    ORDER BY datetime(trained_at) DESC, id DESC
    LIMIT 1
  `).get();
}

export function getActiveDecisionPolicy(forceRefresh = false) {
  if (activePolicyCache && !forceRefresh) {
    return activePolicyCache;
  }

  const row = getLatestActiveDecisionPolicySet();

  activePolicyCache = {
    id: row?.id ?? null,
    source: row ? "trained" : "default",
    trainedAt: row?.trained_at ?? null,
    policy: normalizeDecisionPolicy(row?.policies_json ? JSON.parse(row.policies_json) : DEFAULT_DECISION_POLICY),
    summary: row?.summary_json ? JSON.parse(row.summary_json) : null
  };

  return activePolicyCache;
}

export function setActiveDecisionPolicySet(id) {
  const db = getDb();
  db.prepare("UPDATE decision_policy_sets SET is_active = 0 WHERE is_active = 1").run();
  db.prepare("UPDATE decision_policy_sets SET is_active = 1, status = 'active' WHERE id = ?").run(id);
  clearActiveDecisionPolicyCache();
}

export function saveDecisionPolicySet({
  policy,
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
    INSERT INTO decision_policy_sets (
      trained_at, sample_count, holdout_count, status, is_active,
      train_roi, holdout_roi, train_hit_rate, holdout_hit_rate, improvement_vs_active,
      policies_json, summary_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    isoNow(),
    sampleCount,
    holdoutCount,
    status,
    isActive ? 1 : 0,
    trainMetrics?.roi ?? null,
    holdoutMetrics?.roi ?? null,
    trainMetrics?.hitRate ?? null,
    holdoutMetrics?.hitRate ?? null,
    improvementVsActive === null ? null : round(improvementVsActive, 4),
    JSON.stringify(normalizeDecisionPolicy(policy)),
    JSON.stringify(summary ?? {})
  );

  if (isActive) {
    setActiveDecisionPolicySet(result.id);
  }

  return result.id;
}

export function getDecisionPolicyStatus() {
  const db = getDb();
  const active = getLatestActiveDecisionPolicySet();
  const latest = db.prepare(`
    SELECT *
    FROM decision_policy_sets
    ORDER BY datetime(trained_at) DESC, id DESC
    LIMIT 1
  `).get();

  const mapRow = (row) => row ? {
    id: row.id,
    trainedAt: row.trained_at,
    status: row.status,
    sampleCount: row.sample_count,
    holdoutCount: row.holdout_count,
    trainRoi: row.train_roi,
    holdoutRoi: row.holdout_roi,
    trainHitRate: row.train_hit_rate,
    holdoutHitRate: row.holdout_hit_rate,
    improvementVsActive: row.improvement_vs_active,
    isActive: Boolean(row.is_active),
    summary: row.summary_json ? JSON.parse(row.summary_json) : null
  } : null;

  return {
    active: mapRow(active),
    latest: mapRow(latest)
  };
}
