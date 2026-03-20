import { APP_COMPETITION_CODES, COMPETITION_BY_CODE } from "../../config/leagues.js";
import { getDb } from "../../db/database.js";
import { isResolvedFixtureTeams } from "../../lib/fixtures.js";
import { logger } from "../../lib/logger.js";
import { formatKickoff, isoNow } from "../../lib/time.js";
import { analyzeMatch } from "../analysis/analysisService.js";
import { getTeamRatingsMap, refreshTeamRatings } from "../analysis/eloEngine.js";
import { getRecommendationHistoryForMatch } from "../data/collectorService.js";

function readUpcomingMatches(competitionCode = null) {
  const db = getDb();
  const sql = `
    WITH ranked_matches AS (
      SELECT
        matches.id,
        matches.competition_code,
        matches.utc_date,
        matches.status,
        matches.stage,
        matches.matchday,
        matches.home_team_id,
        matches.away_team_id,
        matches.last_synced_at,
        home_team.name AS home_team_name,
        away_team.name AS away_team_name,
        ROW_NUMBER() OVER (
          PARTITION BY
            matches.competition_code,
            datetime(matches.utc_date),
            lower(trim(home_team.name)),
            lower(trim(away_team.name))
          ORDER BY datetime(matches.last_synced_at) DESC, matches.id DESC
        ) AS rank_in_fixture
      FROM matches
      JOIN teams home_team ON home_team.id = matches.home_team_id
      JOIN teams away_team ON away_team.id = matches.away_team_id
      WHERE matches.status != 'FINISHED'
        AND datetime(matches.utc_date) >= datetime('now', '-6 hours')
        AND NOT (home_team.name = 'TBC' AND away_team.name = 'TBC')
        ${
          competitionCode
            ? "AND matches.competition_code = ?"
            : `AND matches.competition_code IN (${APP_COMPETITION_CODES.map(() => "?").join(", ")})`
        }
    )
    SELECT
      id,
      competition_code,
      utc_date,
      status,
      stage,
      matchday,
      home_team_id,
      away_team_id,
      home_team_name,
      away_team_name,
      last_synced_at
    FROM ranked_matches
    WHERE rank_in_fixture = 1
    ORDER BY datetime(utc_date) ASC, home_team_name ASC
    LIMIT 60
  `;

  return db.prepare(sql).all(...(competitionCode ? [competitionCode] : APP_COMPETITION_CODES));
}

function readStanding(teamId, competitionCode) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM standings_rows
    WHERE team_id = ?
      AND competition_code = ?
    ORDER BY datetime(fetched_at) DESC
    LIMIT 1
  `).get(teamId, competitionCode);
}

function readTeamNews(matchId, teamId, limit = 5) {
  const db = getDb();
  return db.prepare(`
    SELECT
      id,
      provider,
      source_type,
      title,
      summary,
      url,
      published_at,
      relevance_score,
      extracted_at
    FROM team_news_records
    WHERE match_id = ?
      AND (team_id = ? OR team_id IS NULL)
    ORDER BY COALESCE(datetime(published_at), datetime(extracted_at)) DESC, relevance_score DESC, id DESC
    LIMIT ?
  `).all(matchId, teamId, limit);
}

function lineupStatusFromAnalysis(analysis) {
  const homeHasProjectedXi = (analysis.features.home.expectedLineup?.length ?? 0) >= 9;
  const awayHasProjectedXi = (analysis.features.away.expectedLineup?.length ?? 0) >= 9;
  const homeOfficial = analysis.features.home.strongestLineupSource === "uefa-lineups";
  const awayOfficial = analysis.features.away.strongestLineupSource === "uefa-lineups";

  if (homeHasProjectedXi && awayHasProjectedXi && homeOfficial && awayOfficial) {
    return "Official";
  }

  if (homeHasProjectedXi && awayHasProjectedXi) {
    return "Predicted";
  }

  return (analysis.features.context.hoursToKickoff ?? 99) <= 2
    ? "Pending"
    : "No lineup read";
}

function pickLeadMarket(analysis) {
  const key = analysis.betting.primaryMarket?.marketKey
    ?? analysis.betting.bestBet?.marketKey
    ?? "totals25";

  return analysis.betting.markets[key] ?? analysis.betting.markets.totals25 ?? analysis.betting.markets.oneXTwo;
}

function sourceQualityFromAnalysis(analysis) {
  const homeOfficial = analysis.features.home.strongestLineupSource === "uefa-lineups";
  const awayOfficial = analysis.features.away.strongestLineupSource === "uefa-lineups";
  const homeStructured = Boolean(analysis.features.home.structuredLineupSource);
  const awayStructured = Boolean(analysis.features.away.structuredLineupSource);

  if (homeOfficial && awayOfficial) {
    return "Official";
  }

  if (homeStructured && awayStructured) {
    return "Structured";
  }

  return "Soft";
}

function buildComboProfile(analysis) {
  const leadMarket = pickLeadMarket(analysis);
  const lineupStatus = lineupStatusFromAnalysis(analysis);
  const hasBet = Boolean(analysis.betting.bestBet?.hasBet);
  const credibilityScore = leadMarket?.recommendation?.credibilityScore ?? 0;
  const trustScore = leadMarket?.trust?.score ?? 0;
  const disagreement = leadMarket?.bestOption?.disagreement ?? 0;
  const currentOdds = leadMarket?.bestOption?.bookmakerOdds ?? null;
  const hoursToKickoff = analysis.features.context.hoursToKickoff ?? null;
  const marketName = leadMarket?.name ?? analysis.betting.bestBet?.marketName ?? "1X2";
  const selectionLabel = leadMarket?.bestOption?.shortLabel ?? analysis.betting.bestBet?.selectionLabel ?? "No Bet";
  const sourceQuality = sourceQualityFromAnalysis(analysis);
  const isSpeculativeOneXTwo = marketName === "1X2" && ((disagreement > 0.12) || ((currentOdds ?? 0) >= 4.2));
  const lateWithoutClearLineups = hoursToKickoff !== null && hoursToKickoff <= 6 && !["Official", "Predicted"].includes(lineupStatus);

  if (!hasBet) {
    return {
      label: "Avoid",
      note: "No market is clean enough for a combo leg right now.",
      rank: 0,
      sourceQuality,
      marketName,
      selectionLabel,
      currentOdds,
      fairOdds: leadMarket?.bestOption?.fairOdds ?? null,
      targetOdds: leadMarket?.bestOption?.targetOdds ?? null,
      edge: leadMarket?.bestOption?.edge ?? null,
      disagreement,
      credibilityScore
    };
  }

  if (lateWithoutClearLineups) {
    return {
      label: "Late Check",
      note: "The angle is live, but it still needs firmer lineups before you lock it into a combo.",
      rank: 1,
      sourceQuality,
      marketName,
      selectionLabel,
      currentOdds,
      fairOdds: leadMarket?.bestOption?.fairOdds ?? null,
      targetOdds: leadMarket?.bestOption?.targetOdds ?? null,
      edge: leadMarket?.bestOption?.edge ?? null,
      disagreement,
      credibilityScore
    };
  }

  if (isSpeculativeOneXTwo && credibilityScore < 78) {
    return {
      label: "Price Leg",
      note: "The number is attractive, but the market still disagrees too much to treat this as a core combo leg.",
      rank: 2,
      sourceQuality,
      marketName,
      selectionLabel,
      currentOdds,
      fairOdds: leadMarket?.bestOption?.fairOdds ?? null,
      targetOdds: leadMarket?.bestOption?.targetOdds ?? null,
      edge: leadMarket?.bestOption?.edge ?? null,
      disagreement,
      credibilityScore
    };
  }

  if (
    credibilityScore >= 76 &&
    trustScore >= 74 &&
    ["Official", "Predicted"].includes(lineupStatus) &&
    (marketName !== "1X2" || disagreement <= 0.1)
  ) {
    return {
      label: "Core Leg",
      note: "This is the cleanest combo leg on the slate right now.",
      rank: 4,
      sourceQuality,
      marketName,
      selectionLabel,
      currentOdds,
      fairOdds: leadMarket?.bestOption?.fairOdds ?? null,
      targetOdds: leadMarket?.bestOption?.targetOdds ?? null,
      edge: leadMarket?.bestOption?.edge ?? null,
      disagreement,
      credibilityScore
    };
  }

  if (credibilityScore >= 64 && trustScore >= 66) {
    return {
      label: "Support Leg",
      note: "Good enough to support a combo, but not the one you should trust most.",
      rank: 3,
      sourceQuality,
      marketName,
      selectionLabel,
      currentOdds,
      fairOdds: leadMarket?.bestOption?.fairOdds ?? null,
      targetOdds: leadMarket?.bestOption?.targetOdds ?? null,
      edge: leadMarket?.bestOption?.edge ?? null,
      disagreement,
      credibilityScore
    };
  }

  return {
    label: "Avoid",
    note: "There is still too much fragility here for a disciplined combo.",
    rank: 0,
    sourceQuality,
    marketName,
    selectionLabel,
    currentOdds,
    fairOdds: leadMarket?.bestOption?.fairOdds ?? null,
    targetOdds: leadMarket?.bestOption?.targetOdds ?? null,
    edge: leadMarket?.bestOption?.edge ?? null,
    disagreement,
    credibilityScore
  };
}

function buildAttentionLabel(analysis) {
  const leadMarket = pickLeadMarket(analysis);
  const credibilityScore = leadMarket?.recommendation?.credibilityScore ?? 0;
  const lineupStatus = lineupStatusFromAnalysis(analysis);
  const hasOdds = Object.values(analysis.betting.markets).some((market) => market.hasOdds);
  const hasBet = Boolean(analysis.betting.bestBet?.hasBet);
  const hoursToKickoff = analysis.features.context.hoursToKickoff ?? null;
  const comboProfile = buildComboProfile(analysis);

  if (!hasOdds) {
    return {
      label: "Ignore",
      note: "No usable odds stored yet."
    };
  }

  if (comboProfile.label === "Price Leg") {
    return {
      label: "Watch",
      note: comboProfile.note
    };
  }

  if (hasBet && credibilityScore >= 65 && (lineupStatus === "Official" || lineupStatus === "Predicted" || (hoursToKickoff !== null && hoursToKickoff > 6))) {
    return {
      label: "Playable",
      note: "Credibility and price are both strong enough."
    };
  }

  if (hasBet && credibilityScore >= 50) {
    return {
      label: "Watch",
      note: lineupStatus === "No lineup read" || lineupStatus === "Pending"
        ? "The angle is live, but lineup clarity still matters."
        : "The angle is live, but not clean enough to force."
    };
  }

  if (credibilityScore >= 50) {
    return {
      label: "Watch",
      note: "There is a lean here, but not a clean bet yet."
    };
  }

  return {
    label: "Ignore",
    note: "The setup is still too fragile."
  };
}

function buildShortlistStatus(analysis) {
  const leadMarket = pickLeadMarket(analysis);
  const credibilityScore = leadMarket?.recommendation?.credibilityScore ?? 0;
  const lineupStatus = lineupStatusFromAnalysis(analysis);
  const hoursToKickoff = analysis.features.context.hoursToKickoff ?? null;
  const hasOdds = Object.values(analysis.betting.markets).some((market) => market.hasOdds);
  const hasBet = Boolean(analysis.betting.bestBet?.hasBet);
  const comboProfile = buildComboProfile(analysis);

  if (!hasOdds) {
    return {
      label: "Ignore Completely",
      note: "No usable bookmaker price is stored yet."
    };
  }

  if (comboProfile.label === "Price Leg") {
    return {
      label: "Check Again",
      note: comboProfile.note
    };
  }

  if (hasBet && credibilityScore >= 65 && ["Predicted", "Official"].includes(lineupStatus)) {
    return {
      label: "Playable Late",
      note: "This is the kind of match to revisit near kickoff."
    };
  }

  if (hasBet && credibilityScore >= 55) {
    return {
      label: "Check Again",
      note: ["Predicted", "Official"].includes(lineupStatus)
        ? "The angle is live, but still needs one last price check."
        : "The angle is live, but lineup clarity still matters."
    };
  }

  if (credibilityScore >= 50 && hoursToKickoff !== null && hoursToKickoff <= 12) {
    return {
      label: "Check Again",
      note: "Not enough to bet now, but still worth a late look."
    };
  }

  return {
    label: "Ignore Completely",
    note: "There is no clean reason to keep this on the shortlist."
  };
}

export function getUpcomingMatchesView(competitionCode = null) {
  const matches = readUpcomingMatches(competitionCode)
    .filter((match) => isResolvedFixtureTeams(match.home_team_name, match.away_team_name))
    .slice(0, 30);
  let ratings = getTeamRatingsMap();

  if (!ratings.size) {
    refreshTeamRatings();
    ratings = getTeamRatingsMap();
  }

  return matches.map((match) => {
    try {
      const analysis = analyzeMatch(match.id, ratings, { storeReport: false });
      const leadMarket = analysis.betting.bestBet?.hasBet
        ? `${analysis.betting.bestBet.marketName}: ${analysis.betting.bestBet.selectionLabel}`
        : "No Bet";
      const leadAnalysisMarket = pickLeadMarket(analysis);
      const lineupStatus = lineupStatusFromAnalysis(analysis);
      const attention = buildAttentionLabel(analysis);
      const shortlist = buildShortlistStatus(analysis);
      const combo = buildComboProfile(analysis);

      return {
        id: match.id,
        competitionCode: match.competition_code,
        competitionName: COMPETITION_BY_CODE[match.competition_code]?.name ?? match.competition_code,
        kickoffTime: match.utc_date,
        kickoffLabel: formatKickoff(match.utc_date),
        status: match.status,
        stage: match.stage,
        matchday: match.matchday,
        homeTeam: match.home_team_name,
        awayTeam: match.away_team_name,
        probabilities: analysis.model.probabilities,
        recommendation: {
          assessment: leadMarket,
          confidence: analysis.betting.bestBet?.confidence ?? analysis.betting.markets.oneXTwo.recommendation.confidence
        },
        credibility: analysis.betting.bestBet?.hasBet
          ? {
              score: leadAnalysisMarket?.recommendation.credibilityScore ?? null,
              label: leadAnalysisMarket?.recommendation.credibilityLabel ?? null
            }
          : {
              score: analysis.betting.markets.oneXTwo.recommendation.credibilityScore ?? null,
              label: analysis.betting.markets.oneXTwo.recommendation.credibilityLabel ?? null
            },
        attention,
        trust: {
          score: analysis.betting.bestBet?.hasBet
            ? Object.values(analysis.betting.markets).find((market) => market.name === analysis.betting.bestBet.marketName)?.trust?.score ?? null
            : analysis.betting.markets.oneXTwo.trust.score,
          label: analysis.betting.bestBet?.hasBet
            ? analysis.betting.bestBet.trust ?? null
            : analysis.betting.markets.oneXTwo.trust.label
        },
        selectedBookmaker: analysis.betting.bestBet?.hasBet
          ? analysis.betting.markets[
              analysis.betting.bestBet.marketName === "1X2"
                ? "oneXTwo"
                : analysis.betting.bestBet.marketName === "Over / Under 2.5"
                  ? "totals25"
                  : "btts"
            ]?.selectedBookmaker?.bookmakerTitle ?? null
          : analysis.betting.market.selectedBookmaker?.bookmakerTitle ?? null,
        hasOdds: Object.values(analysis.betting.markets).some((market) => market.hasOdds),
        dataCoverageScore: analysis.features.context.dataCoverageScore,
        lineupStatus,
        sourceQuality: combo.sourceQuality,
        combo,
        newsCount: readTeamNews(match.id, match.home_team_id, 2).length + readTeamNews(match.id, match.away_team_id, 2).length,
        shortlist
      };
    } catch (error) {
      logger.warn("List analysis failed", { matchId: match.id, message: error.message });

      return {
        id: match.id,
        competitionCode: match.competition_code,
        competitionName: COMPETITION_BY_CODE[match.competition_code]?.name ?? match.competition_code,
        kickoffTime: match.utc_date,
        kickoffLabel: formatKickoff(match.utc_date),
        status: match.status,
        stage: match.stage,
        matchday: match.matchday,
        homeTeam: match.home_team_name,
        awayTeam: match.away_team_name,
        probabilities: null,
        recommendation: null,
        selectedBookmaker: null,
        hasOdds: false,
        dataCoverageScore: null,
        warning: error.message
      };
    }
  });
}

export function getMatchDetailView(matchId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      matches.*,
      match_context.venue_name,
      match_context.venue_city,
      match_context.venue_capacity,
      match_context.venue_surface,
      match_context.leg AS context_leg,
      match_context.has_premium_odds,
      match_context.weather_summary,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    LEFT JOIN match_context ON match_context.match_id = matches.id
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE matches.id = ?
  `).get(matchId);

  if (!row) {
    throw new Error(`Match ${matchId} was not found.`);
  }

  let ratings = getTeamRatingsMap();

  if (!ratings.size) {
    refreshTeamRatings();
    ratings = getTeamRatingsMap();
  }

  const analysis = analyzeMatch(matchId, ratings, { storeReport: false });
  const homeStanding = readStanding(row.home_team_id, row.competition_code);
  const awayStanding = readStanding(row.away_team_id, row.competition_code);
  const leadMarket = pickLeadMarket(analysis);
  const lineupStatus = lineupStatusFromAnalysis(analysis);
  const attention = buildAttentionLabel(analysis);
  const shortlist = buildShortlistStatus(analysis);
  const combo = buildComboProfile(analysis);

  return {
    generatedAt: isoNow(),
    match: {
      id: row.id,
      competitionCode: row.competition_code,
      competitionName: COMPETITION_BY_CODE[row.competition_code]?.name ?? row.competition_code,
      name: `${row.home_team_name} vs ${row.away_team_name}`,
      homeTeam: row.home_team_name,
      awayTeam: row.away_team_name,
      kickoffTime: row.utc_date,
      kickoffLabel: formatKickoff(row.utc_date),
      stage: row.stage,
      leg: row.context_leg ?? null,
      status: row.status,
      matchday: row.matchday
    },
    overview: {
      dataCoverageScore: analysis.features.context.dataCoverageScore,
      coverageBlend: analysis.model.diagnostics.coverageBlend,
      trustScore: analysis.betting.bestBet?.hasBet
        ? Object.values(analysis.betting.markets).find((market) => market.name === analysis.betting.bestBet.marketName)?.trust?.score ?? null
        : analysis.betting.markets.oneXTwo.trust.score,
      trustLabel: analysis.betting.bestBet?.hasBet
        ? analysis.betting.bestBet.trust ?? null
        : analysis.betting.markets.oneXTwo.trust.label,
      credibilityScore: analysis.betting.bestBet?.hasBet
        ? leadMarket?.recommendation?.credibilityScore ?? null
        : analysis.betting.markets.oneXTwo.recommendation.credibilityScore,
      credibilityLabel: analysis.betting.bestBet?.hasBet
        ? leadMarket?.recommendation?.credibilityLabel ?? null
        : analysis.betting.markets.oneXTwo.recommendation.credibilityLabel,
      expectedGoals: analysis.model.expectedGoals,
      probabilities: analysis.model.probabilities
    },
    bestBet: analysis.betting.bestBet,
    markets: analysis.betting.markets,
    analysis: analysis.explanation,
    form: {
      homeRecentMatches: analysis.features.home.recentMatches,
      awayRecentMatches: analysis.features.away.recentMatches
    },
    availability: {
      home: {
        injuryImpactScore: analysis.features.home.injuryImpactScore,
        suspensionImpactScore: analysis.features.home.suspensionImpactScore,
        lineupCertaintyScore: analysis.features.home.lineupCertaintyScore,
        lineupUncertainty: analysis.features.home.lineupUncertainty,
        expectedLineupStrength: analysis.features.home.expectedLineupStrength,
        sourceConflictScore: analysis.features.home.sourceConflictScore,
        strongestLineupSource: analysis.features.home.strongestLineupSource,
        strongestAbsenceSource: analysis.features.home.strongestAbsenceSource,
        structuredLineupSource: analysis.features.home.structuredLineupSource,
        structuredAbsenceSource: analysis.features.home.structuredAbsenceSource,
        latestLineupExtractedAt: analysis.features.home.latestLineupExtractedAt,
        latestAvailabilityExtractedAt: analysis.features.home.latestAvailabilityExtractedAt,
        lineupUpdateAgeHours: analysis.features.home.lineupUpdateAgeHours,
        hoursToKickoff: analysis.features.home.hoursToKickoff,
        missingStartersCount: analysis.features.home.missingStartersCount,
        missingStarters: analysis.features.home.missingStarters,
        missingKeyPlayers: analysis.features.home.missingKeyPlayers,
        missingKeyPositions: analysis.features.home.missingKeyPositions,
        injuries: analysis.features.home.injuries,
        suspensions: analysis.features.home.suspensions,
        expectedLineup: analysis.features.home.expectedLineup,
        sources: analysis.features.home.availabilitySources
      },
      away: {
        injuryImpactScore: analysis.features.away.injuryImpactScore,
        suspensionImpactScore: analysis.features.away.suspensionImpactScore,
        lineupCertaintyScore: analysis.features.away.lineupCertaintyScore,
        lineupUncertainty: analysis.features.away.lineupUncertainty,
        expectedLineupStrength: analysis.features.away.expectedLineupStrength,
        sourceConflictScore: analysis.features.away.sourceConflictScore,
        strongestLineupSource: analysis.features.away.strongestLineupSource,
        strongestAbsenceSource: analysis.features.away.strongestAbsenceSource,
        structuredLineupSource: analysis.features.away.structuredLineupSource,
        structuredAbsenceSource: analysis.features.away.structuredAbsenceSource,
        latestLineupExtractedAt: analysis.features.away.latestLineupExtractedAt,
        latestAvailabilityExtractedAt: analysis.features.away.latestAvailabilityExtractedAt,
        lineupUpdateAgeHours: analysis.features.away.lineupUpdateAgeHours,
        hoursToKickoff: analysis.features.away.hoursToKickoff,
        missingStartersCount: analysis.features.away.missingStartersCount,
        missingStarters: analysis.features.away.missingStarters,
        missingKeyPlayers: analysis.features.away.missingKeyPlayers,
        missingKeyPositions: analysis.features.away.missingKeyPositions,
        injuries: analysis.features.away.injuries,
        suspensions: analysis.features.away.suspensions,
        expectedLineup: analysis.features.away.expectedLineup,
        sources: analysis.features.away.availabilitySources
      }
    },
    news: {
      home: readTeamNews(matchId, row.home_team_id),
      away: readTeamNews(matchId, row.away_team_id)
    },
    context: {
      venueName: row.venue_name ?? null,
      venueCity: row.venue_city ?? null,
      venueCapacity: row.venue_capacity ?? null,
      venueSurface: row.venue_surface ?? null,
      hoursToKickoff: analysis.features.context.hoursToKickoff,
      lineupStatus,
      attention,
      shortlist,
      leg: row.context_leg ?? null,
      hasPremiumOdds: Boolean(row.has_premium_odds),
      weatherSummary: row.weather_summary ?? null
    },
    combo,
    modelInputs: {
      home: analysis.features.home,
      away: analysis.features.away,
      competitionAverages: analysis.features.competitionAverages,
      factors: analysis.model.factors,
      diagnostics: analysis.model.diagnostics
    },
    market: analysis.betting.market,
    standings: {
      home: homeStanding,
      away: awayStanding
    },
    technical: {
      impliedGap: analysis.impliedGap,
      factors: analysis.model.factors,
      diagnostics: analysis.model.diagnostics
    },
    recommendationHistory: getRecommendationHistoryForMatch(matchId)
  };
}
