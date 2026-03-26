/**
 * Derive predicted lineups for upcoming CL/EL matches from the most
 * recent historical lineup data for each team.
 *
 * We look at the last N confirmed lineups per team (from FINISHED matches)
 * and vote on which players are most likely to start, weighted by recency.
 * The result is stored in expected_lineup_records with source_provider =
 * 'historical-predict' and a reduced certainty_score (0.65).
 *
 * This lets the trust-readiness lineup component see "Predicted" status
 * for upcoming matches even before official lineups drop.
 */

import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";

const RECENCY_MATCHES = 4;    // how many recent matches per team to look back
const CERTAINTY_SCORE = 0.65; // lower than confirmed (0.98), higher than unknown (0.5)
const MIN_STARTERS = 9;       // minimum players to consider a "predicted XI"
const SOURCE_PROVIDER = "historical-predict";

getDb();
const db = getDb();

function getUpcomingMatches() {
  return db.prepare(`
    SELECT m.id, m.competition_code, m.utc_date,
           m.home_team_id, m.away_team_id,
           t1.name AS home_name, t2.name AS away_name
    FROM matches m
    JOIN teams t1 ON t1.id = m.home_team_id
    JOIN teams t2 ON t2.id = m.away_team_id
    WHERE m.status IN ('TIMED', 'SCHEDULED')
      AND m.competition_code IN ('CL', 'EL')
      AND t1.name != 'TBC'
      AND t2.name != 'TBC'
    ORDER BY datetime(m.utc_date) ASC
    LIMIT 60
  `).all();
}

function getRecentLineups(teamId, limit = RECENCY_MATCHES) {
  // Collect the most recent N matches for this team that have lineup data
  const matches = db.prepare(`
    SELECT DISTINCT m.id, m.utc_date
    FROM matches m
    JOIN expected_lineup_records elr ON elr.match_id = m.id AND elr.team_id = ?
    WHERE m.status = 'FINISHED'
    ORDER BY datetime(m.utc_date) DESC
    LIMIT ?
  `).all(teamId, limit);

  if (!matches.length) {
    return [];
  }

  const matchIds = matches.map((m) => m.id);
  const placeholders = matchIds.map(() => "?").join(", ");

  return db.prepare(`
    SELECT elr.player_name, elr.player_role, elr.lineup_slot, m.utc_date
    FROM expected_lineup_records elr
    JOIN matches m ON m.id = elr.match_id
    WHERE elr.match_id IN (${placeholders})
      AND elr.team_id = ?
      AND elr.expected_start = 1
    ORDER BY datetime(m.utc_date) DESC
  `).all(...matchIds, teamId);
}

function voteMostLikelyStarters(lineupRows, matchCount) {
  if (!lineupRows.length || !matchCount) {
    return [];
  }

  // Score each player by recency-weighted appearances
  const playerScores = new Map();
  const datesSorted = [...new Set(lineupRows.map((r) => r.utc_date))].sort().reverse();

  for (const row of lineupRows) {
    const rank = datesSorted.indexOf(row.utc_date); // 0 = most recent
    const weight = 1 / (rank + 1); // 1, 0.5, 0.33, 0.25...
    const name = row.player_name;

    const current = playerScores.get(name) ?? {
      player_name: name,
      player_role: row.player_role,
      lineup_slot: row.lineup_slot,
      score: 0
    };
    current.score += weight;
    playerScores.set(name, current);
  }

  // Take the 11 highest-scoring players (likely starters)
  return [...playerScores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 11);
}

function existingPredictedCount(matchId, teamId) {
  return db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM expected_lineup_records
    WHERE match_id = ? AND team_id = ? AND source_provider = ?
  `).get(matchId, teamId, SOURCE_PROVIDER).cnt;
}

function insertPredictedLineup(matchId, teamId, players) {
  // Remove stale predictions first
  db.prepare(`
    DELETE FROM expected_lineup_records
    WHERE match_id = ? AND team_id = ? AND source_provider = ?
  `).run(matchId, teamId, SOURCE_PROVIDER);

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO expected_lineup_records
      (match_id, team_id, player_name, player_role, lineup_slot,
       expected_start, certainty_score, source_provider, source_url, extracted_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)
  `);

  for (const [i, player] of players.entries()) {
    stmt.run(
      matchId,
      teamId,
      player.player_name,
      player.player_role ?? null,
      player.lineup_slot ?? (i + 1),
      CERTAINTY_SCORE,
      SOURCE_PROVIDER,
      now
    );
  }
}

const upcomingMatches = getUpcomingMatches();
logger.info(`Processing ${upcomingMatches.length} upcoming matches`);

let totalInserted = 0;
let matchesWithPrediction = 0;

for (const match of upcomingMatches) {
  const sides = [
    { teamId: match.home_team_id, name: match.home_name },
    { teamId: match.away_team_id, name: match.away_name }
  ];
  let matchPredicted = 0;

  for (const { teamId, name } of sides) {
    const recentLineups = getRecentLineups(teamId);
    const predicted = voteMostLikelyStarters(recentLineups, RECENCY_MATCHES);

    if (predicted.length < MIN_STARTERS) {
      logger.warn(`Not enough historical lineup data for ${name} (${predicted.length} players found)`);
      continue;
    }

    insertPredictedLineup(match.id, teamId, predicted);
    totalInserted += predicted.length;
    matchPredicted += 1;
    logger.info(`${name}: inserted ${predicted.length} predicted starters for ${match.utc_date.split("T")[0]}`);
  }

  if (matchPredicted === 2) {
    matchesWithPrediction += 1;
  }
}

logger.info("Predicted lineup generation complete", {
  upcomingMatches: upcomingMatches.length,
  matchesWithPrediction,
  totalInserted
});

console.log(JSON.stringify({ matchesWithPrediction, totalInserted }, null, 2));
