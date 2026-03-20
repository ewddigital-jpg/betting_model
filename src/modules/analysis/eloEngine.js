import { getDb } from "../../db/database.js";
import { clamp } from "../../lib/math.js";
import { isoNow } from "../../lib/time.js";

const BASE_RATING = 1500;
const HOME_ADVANTAGE = 55;

function expectedScore(homeRating, awayRating) {
  return 1 / (1 + 10 ** ((awayRating - homeRating) / 400));
}

function actualResult(match) {
  if (match.home_score > match.away_score) {
    return 1;
  }

  if (match.home_score === match.away_score) {
    return 0.5;
  }

  return 0;
}

function stageWeight(stage) {
  if (["SEMI_FINALS", "FINAL", "QUARTER_FINALS"].includes(stage)) {
    return 1.2;
  }

  if (["LAST_16", "PLAYOFFS", "QUALIFICATION"].includes(stage)) {
    return 1.1;
  }

  return 1;
}

function goalDifferenceMultiplier(homeGoals, awayGoals) {
  const goalDifference = Math.abs((homeGoals ?? 0) - (awayGoals ?? 0));
  return 1 + (Math.min(goalDifference, 4) * 0.08);
}

export function buildRatingsUntil(matches, cutoffDate = null) {
  const ratings = new Map();

  for (const match of matches) {
    if (cutoffDate && new Date(match.utc_date) >= new Date(cutoffDate)) {
      break;
    }

    if (match.home_score === null || match.away_score === null) {
      continue;
    }

    const homeEntry = ratings.get(match.home_team_id) ?? { elo: BASE_RATING, matchesPlayed: 0 };
    const awayEntry = ratings.get(match.away_team_id) ?? { elo: BASE_RATING, matchesPlayed: 0 };
    const expectedHome = expectedScore(homeEntry.elo + HOME_ADVANTAGE, awayEntry.elo);
    const actualHome = actualResult(match);
    const kFactor = 24 * stageWeight(match.stage) * goalDifferenceMultiplier(match.home_score, match.away_score);
    const delta = kFactor * (actualHome - expectedHome);

    ratings.set(match.home_team_id, {
      elo: clamp(homeEntry.elo + delta, 1200, 1900),
      matchesPlayed: homeEntry.matchesPlayed + 1
    });
    ratings.set(match.away_team_id, {
      elo: clamp(awayEntry.elo - delta, 1200, 1900),
      matchesPlayed: awayEntry.matchesPlayed + 1
    });
  }

  return ratings;
}

export function refreshTeamRatings() {
  const db = getDb();
  const matches = db.prepare(`
    SELECT home_team_id, away_team_id, home_score, away_score, utc_date, stage
    FROM matches
    WHERE status = 'FINISHED'
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
    ORDER BY datetime(utc_date) ASC
  `).all();

  const ratings = buildRatingsUntil(matches);
  const replaceStatement = db.prepare(`
    INSERT INTO team_ratings (team_id, elo, matches_played, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(team_id) DO UPDATE SET
      elo = excluded.elo,
      matches_played = excluded.matches_played,
      updated_at = excluded.updated_at
  `);

  const now = isoNow();
  db.prepare("DELETE FROM team_ratings").run();

  for (const [teamId, rating] of ratings.entries()) {
    replaceStatement.run(teamId, rating.elo, rating.matchesPlayed, now);
  }

  return ratings;
}

export function getTeamRatingsMap() {
  const db = getDb();
  const rows = db.prepare("SELECT team_id, elo, matches_played FROM team_ratings").all();
  const map = new Map();

  for (const row of rows) {
    map.set(row.team_id, {
      elo: row.elo,
      matchesPlayed: row.matches_played
    });
  }

  return map;
}

export { BASE_RATING, HOME_ADVANTAGE };
