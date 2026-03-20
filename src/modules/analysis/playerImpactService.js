import { getDb } from "../../db/database.js";
import { average, clamp, round } from "../../lib/math.js";

const ROLE_BUCKETS = {
  goalkeeper: "goalkeeper",
  defender: "defense",
  "center back": "defense",
  "centre back": "defense",
  midfielder: "midfield",
  "defensive midfield": "midfield",
  forward: "attack",
  striker: "attack"
};

const POSITION_MULTIPLIER = {
  goalkeeper: 1.3,
  defense: 1.1,
  midfield: 1,
  attack: 1.15,
  unknown: 0.9
};

function normalizePlayerName(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeRole(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z\s-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function roleBucket(role) {
  return ROLE_BUCKETS[normalizeRole(role)] ?? "unknown";
}

function readHistoricalStarterRows(matchId, teamId, asOfTime, matchLimit = 12) {
  const db = getDb();
  return db.prepare(`
    WITH prior_matches AS (
      SELECT id, utc_date
      FROM matches
      WHERE status = 'FINISHED'
        AND id != ?
        AND (home_team_id = ? OR away_team_id = ?)
        AND datetime(utc_date) < datetime(?)
        AND EXISTS (
          SELECT 1
          FROM expected_lineup_records elr
          WHERE elr.match_id = matches.id
            AND elr.team_id = ?
            AND elr.expected_start = 1
        )
      ORDER BY datetime(utc_date) DESC
      LIMIT ?
    )
    SELECT
      prior_matches.id AS historical_match_id,
      prior_matches.utc_date,
      elr.player_name,
      elr.player_role,
      elr.lineup_slot,
      elr.certainty_score
    FROM prior_matches
    JOIN expected_lineup_records elr
      ON elr.match_id = prior_matches.id
     AND elr.team_id = ?
     AND elr.expected_start = 1
    ORDER BY datetime(prior_matches.utc_date) DESC, elr.lineup_slot ASC, elr.player_name ASC
  `).all(matchId, teamId, teamId, asOfTime, teamId, matchLimit, teamId);
}

function groupByMatch(rows) {
  const ordered = [];
  const byMatch = new Map();

  for (const row of rows) {
    if (!byMatch.has(row.historical_match_id)) {
      const entry = {
        matchId: row.historical_match_id,
        utcDate: row.utc_date,
        starters: []
      };
      byMatch.set(row.historical_match_id, entry);
      ordered.push(entry);
    }

    byMatch.get(row.historical_match_id).starters.push(row);
  }

  return ordered;
}

function aggregatePlayerStats(matches) {
  const totalWeight = matches.reduce((sum, _match, index) => sum + Math.max(0.35, 1 - (index * 0.08)), 0);
  const stats = new Map();

  matches.forEach((match, index) => {
    const weight = Math.max(0.35, 1 - (index * 0.08));

    for (const starter of match.starters) {
      const key = normalizePlayerName(starter.player_name);
      if (!key) {
        continue;
      }

      const bucket = roleBucket(starter.player_role);
      const current = stats.get(key) ?? {
        key,
        player: starter.player_name,
        role: normalizeRole(starter.player_role) || null,
        bucket,
        starts: 0,
        weightedStarts: 0,
        recentStarts: 0
      };

      current.starts += 1;
      current.weightedStarts += weight;
      if (index < 5) {
        current.recentStarts += 1;
      }
      stats.set(key, current);
    }
  });

  return {
    totalWeight,
    players: [...stats.values()]
      .map((player) => {
        const multiplier = POSITION_MULTIPLIER[player.bucket] ?? POSITION_MULTIPLIER.unknown;
        const stability = clamp(player.weightedStarts / Math.max(totalWeight, 1), 0, 1);
        const recentBoost = clamp(player.recentStarts / 5, 0, 1) * 0.15;

        return {
          ...player,
          importanceScore: round(clamp((stability * multiplier) + recentBoost, 0, 1), 2)
        };
      })
      .sort((left, right) => right.importanceScore - left.importanceScore)
  };
}

function recentLineupOverlap(currentStarters, referenceMatch) {
  if (!referenceMatch?.starters?.length || !currentStarters.length) {
    return 0.5;
  }

  const currentSet = new Set(currentStarters.map((row) => normalizePlayerName(row.player_name)));
  const overlap = referenceMatch.starters
    .map((row) => normalizePlayerName(row.player_name))
    .filter((name) => currentSet.has(name))
    .length;

  return round(clamp(overlap / 11, 0, 1), 2);
}

function bucketLabel(bucket) {
  if (bucket === "goalkeeper") {
    return "goalkeeper";
  }

  if (bucket === "defense") {
    return "defense";
  }

  if (bucket === "midfield") {
    return "midfield";
  }

  if (bucket === "attack") {
    return "attack";
  }

  return "unknown";
}

export function buildPlayerImpactSummary({
  matchId,
  teamId,
  asOfTime,
  lineupRows = [],
  injuryRows = [],
  suspensionRows = []
}) {
  const historicalRows = readHistoricalStarterRows(matchId, teamId, asOfTime ?? new Date().toISOString());
  const historicalMatches = groupByMatch(historicalRows);

  if (!historicalMatches.length) {
    return {
      starterQualityScore: 0.5,
      starterStrengthDelta: 0,
      lineupContinuityScore: lineupRows.length ? 0.6 : 0.5,
      missingCoreStartersCount: 0,
      returningCoreStartersCount: 0,
      missingPrimaryGoalkeeper: false,
      missingBuckets: {
        defense: 0,
        midfield: 0,
        attack: 0
      },
      missingCorePlayers: [],
      corePlayers: []
    };
  }

  const aggregated = aggregatePlayerStats(historicalMatches);
  const currentStarters = lineupRows.filter((row) => row.expected_start);
  const currentStarterSet = new Set(currentStarters.map((row) => normalizePlayerName(row.player_name)));
  const unavailableSet = new Set([...injuryRows, ...suspensionRows].map((row) => normalizePlayerName(row.player_name)));
  const corePlayers = aggregated.players
    .filter((player) => player.importanceScore >= 0.32)
    .slice(0, 14);
  const typicalStarterQuality = average(corePlayers.slice(0, 11).map((player) => player.importanceScore), 0.5);
  const starterQualityScore = currentStarters.length
    ? average(
      currentStarters.map((row) => aggregated.players.find((player) => player.key === normalizePlayerName(row.player_name))?.importanceScore ?? 0.42),
      0.5
    )
    : 0.5;

  const missingCorePlayers = corePlayers
    .filter((player) => {
      if (currentStarters.length) {
        return !currentStarterSet.has(player.key);
      }

      return unavailableSet.has(player.key);
    })
    .map((player) => ({
      player: player.player,
      role: player.role,
      bucket: bucketLabel(player.bucket),
      importanceScore: player.importanceScore,
      unavailable: unavailableSet.has(player.key)
    }))
    .slice(0, 5);

  const returningCoreStartersCount = corePlayers.filter((player) => currentStarterSet.has(player.key)).length;
  const primaryGoalkeeper = aggregated.players.find((player) => player.bucket === "goalkeeper");
  const missingPrimaryGoalkeeper = Boolean(primaryGoalkeeper) && !currentStarterSet.has(primaryGoalkeeper.key);
  const missingBuckets = {
    defense: missingCorePlayers.filter((player) => player.bucket === "defense").length,
    midfield: missingCorePlayers.filter((player) => player.bucket === "midfield").length,
    attack: missingCorePlayers.filter((player) => player.bucket === "attack").length
  };

  return {
    starterQualityScore: round(clamp(starterQualityScore, 0.2, 1), 2),
    starterStrengthDelta: round(clamp(starterQualityScore - typicalStarterQuality, -0.5, 0.5), 2),
    lineupContinuityScore: recentLineupOverlap(currentStarters, historicalMatches[0]),
    missingCoreStartersCount: missingCorePlayers.length,
    returningCoreStartersCount,
    missingPrimaryGoalkeeper,
    missingBuckets,
    missingCorePlayers,
    corePlayers: corePlayers.slice(0, 11)
  };
}
