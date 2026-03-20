import { getDb } from "../../db/database.js";
import { round } from "../../lib/math.js";
import { isoNow } from "../../lib/time.js";

function averageBrier(calibration) {
  const values = [
    calibration?.oneXTwo?.brier,
    calibration?.totals25?.brier,
    calibration?.btts?.brier
  ].filter(Number.isFinite);

  if (!values.length) {
    return null;
  }

  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 4);
}

export function saveSystemMetricSnapshot({
  scope = "all",
  competitionCode = null,
  trustReadiness,
  dashboard,
  blindTest
}) {
  const db = getDb();
  const upcoming = trustReadiness?.components ?? {};
  const likelyCurrent = trustReadiness?.components?.lineupCoverage?.current ?? "";
  const lineupMatch = /(\d+)\s+confirmed,\s+(\d+)\s+likely/u.exec(String(likelyCurrent));
  const confirmedLineups = lineupMatch ? Number(lineupMatch[1]) : 0;
  const likelyLineups = lineupMatch ? Number(lineupMatch[2]) : 0;
  const oddsCurrent = trustReadiness?.components?.oddsCoverage?.current ?? "";
  const oddsMatch = /(\d+)\/(\d+)/u.exec(String(oddsCurrent));
  const upcomingWithOdds = oddsMatch ? Number(oddsMatch[1]) : 0;
  const upcomingMatches = oddsMatch ? Number(oddsMatch[2]) : 0;

  db.prepare(`
    INSERT INTO system_metric_snapshots (
      scope, competition_code, generated_at, trust_percent, blind_brier_avg,
      blind_modeled_matches, forward_tracked_matches, forward_settled_bets,
      upcoming_matches, upcoming_with_odds, likely_lineups, confirmed_lineups, summary_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scope,
    competitionCode,
    isoNow(),
    trustReadiness?.trustPercent ?? null,
    averageBrier(blindTest?.calibration),
    blindTest?.summary?.modeledMatches ?? 0,
    dashboard?.summary?.trackedMatches ?? 0,
    dashboard?.summary?.settledBets ?? 0,
    upcomingMatches,
    upcomingWithOdds,
    likelyLineups,
    confirmedLineups,
    JSON.stringify({
      trustReadiness,
      dashboardSummary: dashboard?.summary ?? null,
      blindSummary: blindTest?.summary ?? null
    })
  );
}

export function getLatestSystemMetricSnapshot(scope = "all", competitionCode = null) {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM system_metric_snapshots
    WHERE scope = ?
      AND ${competitionCode ? "competition_code = ?" : "competition_code IS NULL"}
    ORDER BY datetime(generated_at) DESC, id DESC
    LIMIT 1
  `).get(...(competitionCode ? [scope, competitionCode] : [scope]));

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    scope: row.scope,
    competitionCode: row.competition_code,
    generatedAt: row.generated_at,
    trustPercent: row.trust_percent,
    blindBrierAvg: row.blind_brier_avg,
    blindModeledMatches: row.blind_modeled_matches,
    forwardTrackedMatches: row.forward_tracked_matches,
    forwardSettledBets: row.forward_settled_bets,
    upcomingMatches: row.upcoming_matches,
    upcomingWithOdds: row.upcoming_with_odds,
    likelyLineups: row.likely_lineups,
    confirmedLineups: row.confirmed_lineups,
    summary: row.summary_json ? JSON.parse(row.summary_json) : null
  };
}
