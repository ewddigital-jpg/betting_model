import { getDb } from "../../db/database.js";
import { average, clamp, round, safeDivide, weightedAverage } from "../../lib/math.js";
import { daysBetween } from "../../lib/time.js";
import { buildAvailabilityFeatures } from "./availabilityFeatures.js";
import { BASE_RATING } from "./eloEngine.js";

const HISTORY_LIMIT = 20;
const ADVANCED_HISTORY_LIMIT = 12;

function averageImpliedOddsProbabilities(rows) {
  const validRows = rows
    .map((row) => {
      const home = safeDivide(1, row.home_price, null);
      const draw = safeDivide(1, row.draw_price, null);
      const away = safeDivide(1, row.away_price, null);

      if (![home, draw, away].every((value) => Number.isFinite(value) && value > 0)) {
        return null;
      }

      return { home, draw, away, total: home + draw + away };
    })
    .filter(Boolean);

  if (!validRows.length) {
    return null;
  }

  return {
    raw: {
      home: average(validRows.map((row) => row.home), 0),
      draw: average(validRows.map((row) => row.draw), 0),
      away: average(validRows.map((row) => row.away), 0)
    },
    marginAdjusted: {
      home: average(validRows.map((row) => row.home / row.total), 0),
      draw: average(validRows.map((row) => row.draw / row.total), 0),
      away: average(validRows.map((row) => row.away / row.total), 0)
    },
    margin: average(validRows.map((row) => row.total - 1), 0)
  };
}

export const __featureBuilderTestables = {
  averageImpliedOddsProbabilities
};

function getFinishedMatchesBefore(matchId, beforeDate, teamId) {
  const db = getDb();

  return db.prepare(`
    SELECT
      matches.*,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE matches.id != ?
      AND matches.status = 'FINISHED'
      AND datetime(matches.utc_date) < datetime(?)
      AND (matches.home_team_id = ? OR matches.away_team_id = ?)
    ORDER BY datetime(matches.utc_date) DESC
    LIMIT ?
  `).all(matchId, beforeDate, teamId, teamId, HISTORY_LIMIT);
}

function getCompetitionMatchesBefore(matchId, beforeDate, teamId, competitionCode, requireHomeSide, limit = 10) {
  const db = getDb();

  return db.prepare(`
    SELECT
      matches.*,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE matches.id != ?
      AND matches.status = 'FINISHED'
      AND matches.competition_code = ?
      AND datetime(matches.utc_date) < datetime(?)
      AND datetime(matches.utc_date) >= datetime(?, '-730 days')
      AND (matches.home_team_id = ? OR matches.away_team_id = ?)
      AND (
        (? = 1 AND matches.home_team_id = ?)
        OR
        (? = 0 AND matches.away_team_id = ?)
      )
    ORDER BY datetime(matches.utc_date) DESC
    LIMIT ?
  `).all(
    matchId,
    competitionCode,
    beforeDate,
    beforeDate,
    teamId,
    teamId,
    requireHomeSide ? 1 : 0,
    teamId,
    requireHomeSide ? 1 : 0,
    teamId,
    limit
  );
}

function getCompetitionAverages(beforeDate) {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      AVG(home_score) AS avg_home_goals,
      AVG(away_score) AS avg_away_goals
    FROM matches
    WHERE status = 'FINISHED'
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND datetime(utc_date) < datetime(?)
  `).get(beforeDate);

  return {
    avgHomeGoals: clamp(row?.avg_home_goals ?? 1.45, 0.8, 2.4),
    avgAwayGoals: clamp(row?.avg_away_goals ?? 1.18, 0.6, 2.1)
  };
}

function readAdvancedStatsBefore(matchId, beforeDate, teamId, limit = ADVANCED_HISTORY_LIMIT) {
  const db = getDb();

  return db.prepare(`
    SELECT
      team_match_advanced_stats.*,
      matches.utc_date
    FROM team_match_advanced_stats
    JOIN matches ON matches.id = team_match_advanced_stats.match_id
    WHERE team_match_advanced_stats.match_id != ?
      AND team_match_advanced_stats.team_id = ?
      AND matches.status = 'FINISHED'
      AND datetime(matches.utc_date) < datetime(?)
    ORDER BY datetime(matches.utc_date) DESC, datetime(team_match_advanced_stats.extracted_at) DESC
    LIMIT ?
  `).all(matchId, teamId, beforeDate, limit * 3);
}

function dedupeAdvancedRows(rows) {
  const latestByMatch = new Map();

  for (const row of rows) {
    const current = latestByMatch.get(row.match_id);
    if (!current || new Date(row.extracted_at).getTime() > new Date(current.extracted_at).getTime()) {
      latestByMatch.set(row.match_id, row);
    }
  }

  return [...latestByMatch.values()]
    .sort((left, right) => new Date(right.utc_date).getTime() - new Date(left.utc_date).getTime())
    .slice(0, ADVANCED_HISTORY_LIMIT);
}

function readMarketBaseline(matchId, beforeDate = null) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT bookmaker_key, bookmaker_title, home_price, draw_price, away_price, retrieved_at
    FROM odds_snapshots
    WHERE match_id = ?
      AND market = 'h2h'
      ${beforeDate ? "AND datetime(retrieved_at) <= datetime(?)" : ""}
    ORDER BY datetime(retrieved_at) ASC, id ASC
  `).all(...(beforeDate ? [matchId, beforeDate] : [matchId]));

  if (!rows.length) {
    return {
      bookmakerCount: 0,
      openingOdds: null,
      latestOdds: null,
      bookmakerImpliedProbability: null,
      bookmakerMarginAdjustedProbability: null,
      bookmakerMargin: null,
      openingRetrievedAt: null,
      latestRetrievedAt: null
    };
  }

  const openingByBookmaker = new Map();
  const latestByBookmaker = new Map();

  for (const row of rows) {
    if (!openingByBookmaker.has(row.bookmaker_key)) {
      openingByBookmaker.set(row.bookmaker_key, row);
    }
    latestByBookmaker.set(row.bookmaker_key, row);
  }

  const openingRows = [...openingByBookmaker.values()];
  const latestRows = [...latestByBookmaker.values()];
  const openingProbabilities = averageImpliedOddsProbabilities(openingRows);
  const latestProbabilities = averageImpliedOddsProbabilities(latestRows);

  return {
    bookmakerCount: latestRows.length,
    openingOdds: openingRows.length
      ? {
          home: round(average(openingRows.map((row) => row.home_price).filter(Number.isFinite), 0), 2),
          draw: round(average(openingRows.map((row) => row.draw_price).filter(Number.isFinite), 0), 2),
          away: round(average(openingRows.map((row) => row.away_price).filter(Number.isFinite), 0), 2)
        }
      : null,
    latestOdds: latestRows.length
      ? {
          home: round(average(latestRows.map((row) => row.home_price).filter(Number.isFinite), 0), 2),
          draw: round(average(latestRows.map((row) => row.draw_price).filter(Number.isFinite), 0), 2),
          away: round(average(latestRows.map((row) => row.away_price).filter(Number.isFinite), 0), 2)
        }
      : null,
    bookmakerImpliedProbability: latestProbabilities?.raw
      ? {
          home: round(latestProbabilities.raw.home, 4),
          draw: round(latestProbabilities.raw.draw, 4),
          away: round(latestProbabilities.raw.away, 4)
        }
      : null,
    bookmakerMarginAdjustedProbability: latestProbabilities?.marginAdjusted
      ? {
          home: round(latestProbabilities.marginAdjusted.home, 4),
          draw: round(latestProbabilities.marginAdjusted.draw, 4),
          away: round(latestProbabilities.marginAdjusted.away, 4)
        }
      : null,
    bookmakerMargin: latestProbabilities ? round(latestProbabilities.margin, 4) : null,
    openingRetrievedAt: openingRows[0]?.retrieved_at ?? null,
    latestRetrievedAt: latestRows[latestRows.length - 1]?.retrieved_at ?? null
  };
}

function summarizeAdvancedMetrics(rows, requireHomeSide, competitionAverages) {
  const dedupedRows = dedupeAdvancedRows(rows);
  const xgRows = dedupedRows.filter((row) => Number.isFinite(row.xg) || Number.isFinite(row.xga));
  const neutralXg = requireHomeSide ? competitionAverages.avgHomeGoals : competitionAverages.avgAwayGoals;
  const neutralXga = requireHomeSide ? competitionAverages.avgAwayGoals : competitionAverages.avgHomeGoals;

  const windowAverage = (key, size, fallback) => {
    const slice = xgRows.slice(0, size).map((row) => row[key]).filter(Number.isFinite);
    return slice.length ? round(average(slice, fallback), 2) : round(fallback, 2);
  };

  const avgXgLast5 = windowAverage("xg", 5, neutralXg);
  const avgXgaLast5 = windowAverage("xga", 5, neutralXga);
  const avgXgLast10 = windowAverage("xg", 10, neutralXg);
  const avgXgaLast10 = windowAverage("xga", 10, neutralXga);
  const xgDifferenceLast5 = round(avgXgLast5 - avgXgaLast5, 2);
  const xgDifferenceLast10 = round(avgXgLast10 - avgXgaLast10, 2);
  const xgTrendMomentum = round(xgDifferenceLast5 - xgDifferenceLast10, 2);
  const sampleSize = xgRows.length;
  const coverageScore = clamp(sampleSize / 5, 0, 1);

  return {
    avgXgLast5,
    avgXgaLast5,
    avgXgLast10,
    avgXgaLast10,
    xgDifferenceLast5,
    xgDifferenceLast10,
    xgTrendMomentum,
    xgSampleSize: sampleSize,
    xgCoverageScore: round(coverageScore, 2),
    xgAttackStrength: sampleSize
      ? normalizeStrengthRatio(safeDivide(avgXgLast5, neutralXg, 1), 1)
      : 1,
    xgDefenseStrength: sampleSize
      ? normalizeStrengthRatio(safeDivide(avgXgaLast5, neutralXga, 1), 1)
      : 1
  };
}

function extractPoints(match, teamId) {
  const isHome = match.home_team_id === teamId;
  const goalsFor = isHome ? match.home_score : match.away_score;
  const goalsAgainst = isHome ? match.away_score : match.home_score;

  if (goalsFor > goalsAgainst) {
    return 3;
  }

  if (goalsFor === goalsAgainst) {
    return 1;
  }

  return 0;
}

function normalizePpg(value, fallback = 1.35) {
  return clamp(value ?? fallback, 0, 3);
}

function normalizeGoalAverage(value, fallback = 1.2) {
  return clamp(value ?? fallback, 0.2, 3.4);
}

function normalizeGoalDiff(value, fallback = 0) {
  return clamp(value ?? fallback, -2.5, 2.5);
}

function normalizeStrengthRatio(value, fallback = 1) {
  return clamp(value ?? fallback, 0.55, 1.85);
}

function normalizeCoverage(value, fallback = 0.35) {
  return clamp(value ?? fallback, 0.15, 1);
}

function normalizeRestDays(value, fallback = 6) {
  return clamp(value ?? fallback, 3, 14);
}

function perspective(match, teamId, ratings) {
  const isHome = match.home_team_id === teamId;
  const goalsFor = isHome ? match.home_score : match.away_score;
  const goalsAgainst = isHome ? match.away_score : match.home_score;
  const opponentId = isHome ? match.away_team_id : match.home_team_id;

  return {
    isHome,
    goalsFor,
    goalsAgainst,
    goalDiff: goalsFor - goalsAgainst,
    points: extractPoints(match, teamId),
    opponentId,
    opponentElo: ratings.get(opponentId)?.elo ?? BASE_RATING
  };
}

function summarizeRecord(matches, teamId, ratings) {
  const record = {
    played: matches.length,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    strongOppWins: 0,
    strongOppPlayed: 0
  };

  for (const match of matches) {
    const view = perspective(match, teamId, ratings);
    record.goalsFor += view.goalsFor;
    record.goalsAgainst += view.goalsAgainst;

    if (view.points === 3) {
      record.wins += 1;
    } else if (view.points === 1) {
      record.draws += 1;
    } else {
      record.losses += 1;
    }

    if (view.opponentElo >= BASE_RATING + 50) {
      record.strongOppPlayed += 1;
      if (view.points === 3) {
        record.strongOppWins += 1;
      }
    }
  }

  return {
    ...record,
    pointsPerGame: normalizePpg(safeDivide((record.wins * 3) + record.draws, record.played, 1.35), 1.35),
    goalsForPerGame: normalizeGoalAverage(safeDivide(record.goalsFor, record.played, 1.2), 1.2),
    goalsAgainstPerGame: normalizeGoalAverage(safeDivide(record.goalsAgainst, record.played, 1.2), 1.2)
  };
}

function summarizeRecentMatches(matches, teamId) {
  return matches.slice(0, 5).map((match) => {
    const isHome = match.home_team_id === teamId;
    const goalsFor = isHome ? match.home_score : match.away_score;
    const goalsAgainst = isHome ? match.away_score : match.home_score;

    return {
      date: match.utc_date,
      opponent: isHome ? match.away_team_name : match.home_team_name,
      venue: isHome ? "Home" : "Away",
      competitionCode: match.competition_code,
      scoreline: `${goalsFor}-${goalsAgainst}`,
      result: goalsFor > goalsAgainst ? "W" : goalsFor === goalsAgainst ? "D" : "L"
    };
  });
}

function averageForWindow(history, teamId, ratings, size, key, fallback) {
  const slice = history.slice(0, size);

  return normalizeGoalAverage(
    average(slice.map((match) => perspective(match, teamId, ratings)[key]), fallback),
    fallback
  );
}

function averageGoalDiffWindow(history, teamId, ratings, size, fallback = 0) {
  const slice = history.slice(0, size);

  return normalizeGoalDiff(
    average(slice.map((match) => perspective(match, teamId, ratings).goalDiff), fallback),
    fallback
  );
}

function calculateOpponentAdjustedForm(history, teamId, ratings, fallback = 1.35) {
  if (!history.length) {
    return normalizePpg(fallback, fallback);
  }

  const entries = history.slice(0, 10).map((match, index) => {
    const matchView = perspective(match, teamId, ratings);
    const weight = Math.max(1, 8 - index);
    const opponentBoost = clamp((matchView.opponentElo - BASE_RATING) / 220, -0.7, 0.9);
    const goalDiffBoost = clamp(matchView.goalDiff * 0.16, -0.45, 0.45);
    const scoringBoost = clamp(matchView.goalsFor / 3, 0, 1) * Math.max(opponentBoost, 0) * 0.35;
    const adjustedPoints = clamp(
      matchView.points + (opponentBoost * 0.6) + goalDiffBoost + scoringBoost,
      0,
      3
    );

    return {
      value: adjustedPoints,
      weight
    };
  });

  return normalizePpg(weightedAverage(entries, fallback), fallback);
}

function summarizeHistory(matchId, history, teamId, ratings, targetDate, requireHomeSide, competitionAverages) {
  if (!history.length) {
    return {
      sampleSize: 0,
      sideSampleSize: 0,
      recentFormPpg: 1.35,
      opponentAdjustedForm: 1.35,
      weightedGoalsFor: 1.2,
      weightedGoalsAgainst: 1.2,
      splitGoalsFor: 1.2,
      splitGoalsAgainst: 1.2,
      avgGoalsLast5: 1.2,
      avgGoalsLast10: 1.2,
      avgConcededLast5: 1.2,
      avgConcededLast10: 1.2,
      goalDiffLast5: 0,
      goalDiffLast10: 0,
      sideAttackStrength: 1,
      sideDefenseStrength: 1,
      opponentStrength: BASE_RATING,
      restDays: 6,
      dataCoverageScore: 0.2,
      recentRecord: { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, strongOppWins: 0, strongOppPlayed: 0, pointsPerGame: 1.35, goalsForPerGame: 1.2, goalsAgainstPerGame: 1.2 },
      sideRecord: { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, strongOppWins: 0, strongOppPlayed: 0, pointsPerGame: 1.35, goalsForPerGame: 1.2, goalsAgainstPerGame: 1.2 },
      recentMatches: [],
      avgXgLast5: round(requireHomeSide ? competitionAverages.avgHomeGoals : competitionAverages.avgAwayGoals, 2),
      avgXgaLast5: round(requireHomeSide ? competitionAverages.avgAwayGoals : competitionAverages.avgHomeGoals, 2),
      avgXgLast10: round(requireHomeSide ? competitionAverages.avgHomeGoals : competitionAverages.avgAwayGoals, 2),
      avgXgaLast10: round(requireHomeSide ? competitionAverages.avgAwayGoals : competitionAverages.avgHomeGoals, 2),
      xgDifferenceLast5: 0,
      xgDifferenceLast10: 0,
      xgTrendMomentum: 0,
      xgSampleSize: 0,
      xgCoverageScore: 0,
      xgAttackStrength: 1,
      xgDefenseStrength: 1,
      goalDifferenceMomentum: 0,
      recentAttackingEfficiency: 1,
      recentAttackingEfficiencyDelta: 0,
      injuryImpactScore: 0,
      suspensionImpactScore: 0,
      lineupCertaintyScore: 0.5,
      lineupUncertainty: 0.5,
      expectedLineupStrength: 0,
      missingStartersCount: 0,
      missingStarters: 0,
      missingKeyPlayers: 0,
      missingKeyPositions: [],
      availabilityCoverageScore: 0,
      availabilitySources: [],
      injuries: [],
      suspensions: [],
      expectedLineup: [],
      injuryImpact: 0,
      lineupStrength: 0
    };
  }

  const lastMatchDate = new Date(history[0].utc_date);
  const formEntries = [];
  const goalsForEntries = [];
  const goalsAgainstEntries = [];
  const splitFor = [];
  const splitAgainst = [];
  const opponentRatings = [];
  const sideHistory = [];

  history.forEach((match, index) => {
    const weight = Math.max(1, 6 - index);
    const matchView = perspective(match, teamId, ratings);

    formEntries.push({ value: matchView.points, weight });
    goalsForEntries.push({ value: matchView.goalsFor, weight });
    goalsAgainstEntries.push({ value: matchView.goalsAgainst, weight });

    if (matchView.isHome === requireHomeSide) {
      splitFor.push(matchView.goalsFor);
      splitAgainst.push(matchView.goalsAgainst);
      sideHistory.push(match);
    }

    opponentRatings.push(matchView.opponentElo);
  });

  const baseGoalsFor = normalizeGoalAverage(weightedAverage(goalsForEntries, 1.2), 1.2);
  const baseGoalsAgainst = normalizeGoalAverage(weightedAverage(goalsAgainstEntries, 1.2), 1.2);
  const splitGoalsFor = normalizeGoalAverage(
    average(splitFor, average(goalsForEntries.map((entry) => entry.value), 1.2)),
    1.2
  );
  const splitGoalsAgainst = normalizeGoalAverage(
    average(splitAgainst, average(goalsAgainstEntries.map((entry) => entry.value), 1.2)),
    1.2
  );
  const sideBaselineFor = requireHomeSide ? competitionAverages.avgHomeGoals : competitionAverages.avgAwayGoals;
  const sideBaselineAgainst = requireHomeSide ? competitionAverages.avgAwayGoals : competitionAverages.avgHomeGoals;
  const sideAttackStrength = normalizeStrengthRatio(safeDivide(splitGoalsFor, sideBaselineFor, 1), 1);
  const sideDefenseStrength = normalizeStrengthRatio(safeDivide(splitGoalsAgainst, sideBaselineAgainst, 1), 1);
  const coverageScore = normalizeCoverage(
    ((Math.min(history.length, 10) / 10) * 0.7) +
      ((Math.min(sideHistory.length, 5) / 5) * 0.3),
    0.35
  );
  const recentRecord = summarizeRecord(history.slice(0, 5), teamId, ratings);
  const sideRecord = summarizeRecord(sideHistory.slice(0, 10), teamId, ratings);
  const advancedMetrics = summarizeAdvancedMetrics(
    readAdvancedStatsBefore(matchId, targetDate, teamId),
    requireHomeSide,
    competitionAverages
  );
  const baseXgForEfficiency = advancedMetrics.xgCoverageScore >= 0.35
    ? advancedMetrics.avgXgLast5
    : baseGoalsFor;
  const recentAttackingEfficiency = clamp(
    safeDivide(baseGoalsFor, Math.max(baseXgForEfficiency, 0.35), 1),
    0.72,
    1.35
  );

  return {
    sampleSize: history.length,
    sideSampleSize: sideHistory.length,
    recentFormPpg: normalizePpg(weightedAverage(formEntries, 1.35), 1.35),
    opponentAdjustedForm: calculateOpponentAdjustedForm(history, teamId, ratings, 1.35),
    weightedGoalsFor: baseGoalsFor,
    weightedGoalsAgainst: baseGoalsAgainst,
    splitGoalsFor,
    splitGoalsAgainst,
    avgGoalsLast5: averageForWindow(history, teamId, ratings, 5, "goalsFor", baseGoalsFor),
    avgGoalsLast10: averageForWindow(history, teamId, ratings, 10, "goalsFor", baseGoalsFor),
    avgConcededLast5: averageForWindow(history, teamId, ratings, 5, "goalsAgainst", baseGoalsAgainst),
    avgConcededLast10: averageForWindow(history, teamId, ratings, 10, "goalsAgainst", baseGoalsAgainst),
    goalDiffLast5: averageGoalDiffWindow(history, teamId, ratings, 5, 0),
    goalDiffLast10: averageGoalDiffWindow(history, teamId, ratings, 10, 0),
    goalDifferenceMomentum: round(
      averageGoalDiffWindow(history, teamId, ratings, 5, 0) - averageGoalDiffWindow(history, teamId, ratings, 10, 0),
      2
    ),
    sideAttackStrength,
    sideDefenseStrength,
    opponentStrength: clamp(average(opponentRatings, BASE_RATING), 1300, 1800),
    restDays: normalizeRestDays(daysBetween(lastMatchDate, new Date(targetDate)), 6),
    dataCoverageScore: coverageScore,
    recentRecord,
    sideRecord,
    recentMatches: summarizeRecentMatches(history, teamId),
    recentAttackingEfficiency,
    recentAttackingEfficiencyDelta: round(recentAttackingEfficiency - 1, 2),
    ...advancedMetrics,
    injuryImpactScore: 0,
    suspensionImpactScore: 0,
    lineupCertaintyScore: 0.5,
    lineupUncertainty: 0.5,
    expectedLineupStrength: 0,
    missingStartersCount: 0,
    missingStarters: 0,
    missingKeyPlayers: 0,
    missingKeyPositions: [],
    availabilityCoverageScore: 0,
    availabilitySources: [],
    injuries: [],
    suspensions: [],
    expectedLineup: [],
    injuryImpact: 0,
    lineupStrength: 0
  };
}

export function buildMatchFeatures(matchId, ratings, options = {}) {
  const db = getDb();
  const match = db.prepare(`
    SELECT
      matches.*,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE matches.id = ?
  `).get(matchId);

  if (!match) {
    throw new Error(`Match ${matchId} was not found.`);
  }

  const competitionAverages = getCompetitionAverages(match.utc_date);
  const homeHistory = getFinishedMatchesBefore(match.id, match.utc_date, match.home_team_id);
  const awayHistory = getFinishedMatchesBefore(match.id, match.utc_date, match.away_team_id);
  const homeCompetitionSideHistory = getCompetitionMatchesBefore(
    match.id,
    match.utc_date,
    match.home_team_id,
    match.competition_code,
    true
  );
  const awayCompetitionSideHistory = getCompetitionMatchesBefore(
    match.id,
    match.utc_date,
    match.away_team_id,
    match.competition_code,
    false
  );
  const homeSummary = summarizeHistory(
    match.id,
    homeHistory,
    match.home_team_id,
    ratings,
    match.utc_date,
    true,
    competitionAverages
  );
  const awaySummary = summarizeHistory(
    match.id,
    awayHistory,
    match.away_team_id,
    ratings,
    match.utc_date,
    false,
    competitionAverages
  );
  const homeRating = ratings.get(match.home_team_id)?.elo ?? BASE_RATING;
  const awayRating = ratings.get(match.away_team_id)?.elo ?? BASE_RATING;
  const dataCoverageScore = normalizeCoverage(
    Math.min(homeSummary.dataCoverageScore, awaySummary.dataCoverageScore),
    0.35
  );
  const homeAvailability = buildAvailabilityFeatures(match.id, match.home_team_id, match.utc_date, {
    asOfTime: options.asOfTime ?? null
  });
  const awayAvailability = buildAvailabilityFeatures(match.id, match.away_team_id, match.utc_date, {
    asOfTime: options.asOfTime ?? null
  });
  const homeCompetitionRecord = summarizeRecord(homeCompetitionSideHistory, match.home_team_id, ratings);
  const awayCompetitionRecord = summarizeRecord(awayCompetitionSideHistory, match.away_team_id, ratings);
  const marketBaseline = readMarketBaseline(match.id, options.asOfTime ?? null);
  const restDaysAdvantage = round(homeSummary.restDays - awaySummary.restDays, 1);
  const homeAwayStrengthDelta = round(
    ((homeSummary.sideAttackStrength - awaySummary.sideDefenseStrength) * 0.55) +
    ((homeSummary.sideDefenseStrength - awaySummary.sideAttackStrength) * 0.45),
    2
  );

  return {
    match,
    competitionAverages,
    home: {
      teamId: match.home_team_id,
      name: match.home_team_name,
      elo: homeRating,
      homeAttackStrength: homeSummary.sideAttackStrength,
      homeDefenseStrength: homeSummary.sideDefenseStrength,
      competitionSideRecord: homeCompetitionRecord,
      ...homeSummary,
      ...homeAvailability
    },
    away: {
      teamId: match.away_team_id,
      name: match.away_team_name,
      elo: awayRating,
      awayAttackStrength: awaySummary.sideAttackStrength,
      awayDefenseStrength: awaySummary.sideDefenseStrength,
      competitionSideRecord: awayCompetitionRecord,
      ...awaySummary,
      ...awayAvailability
    },
    context: {
      homeRestEdge: clamp(safeDivide(homeSummary.restDays - awaySummary.restDays, 7, 0), -1.2, 1.2),
      restDaysAdvantage,
      homeAwayStrengthDelta,
      recentAttackingEfficiencyDelta: round(
        (homeSummary.recentAttackingEfficiency ?? 1) - (awaySummary.recentAttackingEfficiency ?? 1),
        2
      ),
      xgCoverageScore: Math.min(homeSummary.xgCoverageScore ?? 0, awaySummary.xgCoverageScore ?? 0),
      hoursToKickoff: Math.max(0, daysBetween(new Date(), new Date(match.utc_date)) * 24),
      dataCoverage: Math.min(homeSummary.sampleSize, awaySummary.sampleSize),
      dataCoverageScore,
      marketBaseline,
      availabilityCoverageScore: Math.min(
        homeAvailability.availabilityCoverageScore ?? 0,
        awayAvailability.availabilityCoverageScore ?? 0
      ),
      uncertaintyLevel:
        dataCoverageScore >= 0.8 ? "low" :
        dataCoverageScore >= 0.55 ? "medium" :
        "high"
    }
  };
}
