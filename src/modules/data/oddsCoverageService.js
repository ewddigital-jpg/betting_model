import { getDb } from "../../db/database.js";
import { APP_COMPETITION_CODES, HISTORY_COMPETITION_CODES } from "../../config/leagues.js";
import { round } from "../../lib/math.js";

const SUPPORTED_CODES = [...APP_COMPETITION_CODES, ...HISTORY_COMPETITION_CODES];

function buildCoverageResult(stats) {
  const finishedCoverage = stats.totalFinishedMatches
    ? round((stats.finishedMatchesWithAnySnapshots / stats.totalFinishedMatches) * 100, 1)
    : 0;
  const preKickoffCoverage = stats.totalFinishedMatches
    ? round((stats.finishedMatchesWithPreKickoffOdds / stats.totalFinishedMatches) * 100, 1)
    : 0;
  const closingCoverage = stats.totalFinishedMatches
    ? round((stats.finishedMatchesWithClosingOdds / stats.totalFinishedMatches) * 100, 1)
    : 0;

  const reasons = [];
  if (stats.finishedMatchesWithAnySnapshots === 0) {
    reasons.push("Odds snapshots exist only for upcoming scheduled matches, not for finished matches.");
  }
  if (stats.totalSnapshots > 0 && stats.finishedSnapshots === 0) {
    reasons.push("The current odds collector is archiving live/upcoming boards only, so historical match prices were never stored before those matches finished.");
  }
  if (stats.totalSnapshots > 0 && stats.upcomingSnapshots === stats.totalSnapshots) {
    reasons.push("All stored snapshots belong to matches that are still scheduled, which means the archive started too late for historical validation.");
  }
  if ((stats.totalQuotes ?? 0) === 0) {
    reasons.push("Normalized quote history is still empty, so opening and closing line tracing only starts after the next live collector runs.");
  }

  return {
    ...stats,
    finishedCoveragePct: finishedCoverage,
    preKickoffCoveragePct: preKickoffCoverage,
    closingCoveragePct: closingCoverage,
    warnings: reasons
  };
}

export function getOddsCoverageDiagnostics() {
  const db = getDb();
  const placeholders = SUPPORTED_CODES.map(() => "?").join(", ");
  const row = db.prepare(`
    WITH snapshot_flags AS (
      SELECT
        os.id,
        os.match_id,
        os.market,
        os.bookmaker_key,
        os.retrieved_at,
        m.status,
        m.utc_date,
        CASE WHEN datetime(os.retrieved_at) <= datetime(m.utc_date) THEN 1 ELSE 0 END AS pre_kickoff,
        CASE WHEN datetime(os.retrieved_at) > datetime(m.utc_date) THEN 1 ELSE 0 END AS post_kickoff
      FROM odds_snapshots os
      JOIN matches m ON m.id = os.match_id
      WHERE m.competition_code IN (${placeholders})
    ),
    finished_match_snapshot_stats AS (
      SELECT
        match_id,
        MAX(pre_kickoff) AS has_pre,
        MIN(CASE WHEN pre_kickoff = 1 THEN retrieved_at END) AS opening_time,
        MAX(CASE WHEN pre_kickoff = 1 THEN retrieved_at END) AS closing_time
      FROM snapshot_flags
      WHERE status = 'FINISHED'
      GROUP BY match_id
    )
    SELECT
      (SELECT COUNT(*) FROM odds_snapshots os JOIN matches m ON m.id = os.match_id WHERE m.competition_code IN (${placeholders})) AS totalSnapshots,
      (SELECT COUNT(*) FROM odds_quote_history oqh JOIN matches m ON m.id = oqh.match_id WHERE m.competition_code IN (${placeholders})) AS totalQuotes,
      (SELECT COUNT(*) FROM snapshot_flags WHERE status != 'FINISHED') AS upcomingSnapshots,
      (SELECT COUNT(*) FROM snapshot_flags WHERE status = 'FINISHED') AS finishedSnapshots,
      (SELECT COUNT(*) FROM snapshot_flags WHERE pre_kickoff = 1) AS preKickoffSnapshots,
      (SELECT COUNT(*) FROM snapshot_flags WHERE post_kickoff = 1) AS postKickoffSnapshots,
      (SELECT COUNT(DISTINCT match_id) FROM snapshot_flags) AS matchesWithAnySnapshots,
      (SELECT COUNT(DISTINCT match_id) FROM snapshot_flags WHERE status = 'FINISHED') AS finishedMatchesWithAnySnapshots,
      (SELECT COUNT(*) FROM finished_match_snapshot_stats WHERE has_pre = 1) AS finishedMatchesWithPreKickoffOdds,
      (SELECT COUNT(*) FROM finished_match_snapshot_stats WHERE opening_time IS NOT NULL) AS finishedMatchesWithOpeningOdds,
      (SELECT COUNT(*) FROM finished_match_snapshot_stats WHERE closing_time IS NOT NULL) AS finishedMatchesWithClosingOdds,
      (SELECT COUNT(*) FROM matches WHERE status = 'FINISHED' AND home_score IS NOT NULL AND away_score IS NOT NULL AND competition_code IN (${placeholders})) AS totalFinishedMatches
  `).get(...SUPPORTED_CODES, ...SUPPORTED_CODES, ...SUPPORTED_CODES, ...SUPPORTED_CODES);

  return buildCoverageResult(row);
}
