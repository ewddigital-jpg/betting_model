import { env, hasFootballDataConfig, hasSportmonksConfig } from "../../config/env.js";
import { importFbrefMatches } from "./importers/fbrefMatchImporter.js";
import { APP_COMPETITION_CODES, COMPETITION_BY_CODE, SUPPORTED_COMPETITIONS } from "../../config/leagues.js";
import { getDb, setCompetitionSyncState, upsertTeam, withTransaction } from "../../db/database.js";
import { logger } from "../../lib/logger.js";
import { isoNow } from "../../lib/time.js";
import { fetchCompetitionMatches, fetchCompetitionStandings } from "./footballDataClient.js";
import { fetchCompliantOddsBundle } from "./compliantOddsSourceService.js";
import { readOddsMarketBoard, scoreOddsBoard, shouldPromoteBoard, upsertOddsMarketBoard } from "./oddsBoardService.js";
import { fetchLeagueLatestSeason, fetchSeasonFixtures, fetchSeasonStandings } from "./sportmonksClient.js";

const SPORTMONKS_ID_OFFSET = 2_000_000_000;
const TEAM_ALIASES = {
  "arsenal": ["arsenal fc"],
  "arsenal fc": ["arsenal"],
  "atletico madrid": ["atletico", "atletico de madrid", "atletico madrid fc"],
  "atletico de madrid": ["atletico madrid", "atletico"],
  "fc barcelona": ["barcelona", "barca"],
  "barcelona": ["fc barcelona", "barca"],
  "barca": ["fc barcelona", "barcelona"],
  "bayer 04 leverkusen": ["bayer leverkusen", "leverkusen"],
  "bayer leverkusen": ["bayer 04 leverkusen", "leverkusen"],
  "leverkusen": ["bayer 04 leverkusen", "bayer leverkusen"],
  "bod glimt": ["bodo glimt", "bodo / glimt"],
  "bodo glimt": ["bod glimt", "bodo / glimt"],
  "inter": ["inter milan", "internazionale"],
  "inter milan": ["inter", "internazionale"],
  "internazionale": ["inter", "inter milan"],
  "manchester city": ["man city", "manchester city fc"],
  "man city": ["manchester city", "manchester city fc"],
  "manchester city fc": ["manchester city", "man city"],
  "newcastle": ["newcastle united", "newcastle united fc"],
  "newcastle united": ["newcastle", "newcastle united fc"],
  "newcastle united fc": ["newcastle", "newcastle united"],
  "paris saint germain": ["psg", "paris sg"],
  "psg": ["paris saint germain", "paris sg"],
  "paris sg": ["paris saint germain", "psg"],
  "porto": ["fc porto"],
  "fc porto": ["porto"],
  "real madrid": ["real madrid cf"],
  "real madrid cf": ["real madrid"],
  "sporting": ["sporting cp", "sporting lisbon"],
  "sporting cp": ["sporting", "sporting lisbon"],
  "sporting lisbon": ["sporting", "sporting cp"],
  "tottenham": ["tottenham hotspur", "tottenham hotspur fc", "spurs"],
  "tottenham hotspur": ["tottenham", "tottenham hotspur fc", "spurs"],
  "tottenham hotspur fc": ["tottenham", "tottenham hotspur", "spurs"],
  "spurs": ["tottenham", "tottenham hotspur"]
};

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\b(fc|cf|sc|afc|club|the|de|da|do|di)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeNameLoose(value) {
  return normalizeName(value)
    .replace(/\b[0-9]+\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildCandidateNames(value) {
  const normalized = normalizeNameLoose(value);
  const aliases = TEAM_ALIASES[normalized] ?? [];
  return [...new Set([normalized, ...aliases.map((alias) => normalizeNameLoose(alias)).filter(Boolean)])];
}

function buildNameTokens(value) {
  return buildCandidateNames(value)
    .flatMap((candidate) => candidate.split(" "))
    .map((token) => token.trim())
    .filter((token, index, tokens) => token && token.length >= 3 && tokens.indexOf(token) === index);
}

function overlapRatio(leftTokens, rightTokens) {
  if (!leftTokens.length || !rightTokens.length) {
    return 0;
  }

  const shared = leftTokens.filter((token) => rightTokens.includes(token));
  return shared.length / Math.max(leftTokens.length, rightTokens.length);
}

function teamNameSimilarity(left, right) {
  const strictCandidatesLeft = [normalizeName(left), ...buildCandidateNames(left)];
  const strictCandidatesRight = [normalizeName(right), ...buildCandidateNames(right)];
  let best = 0;

  for (const leftCandidate of strictCandidatesLeft) {
    for (const rightCandidate of strictCandidatesRight) {
      if (!leftCandidate || !rightCandidate) {
        continue;
      }

      if (leftCandidate === rightCandidate) {
        best = Math.max(best, leftCandidate === normalizeName(left) && rightCandidate === normalizeName(right) ? 1 : 0.98);
        continue;
      }

      const ratio = overlapRatio(
        leftCandidate.split(" ").filter((token) => token.length >= 3),
        rightCandidate.split(" ").filter((token) => token.length >= 3)
      );

      if (ratio >= 0.8) {
        best = Math.max(best, 0.9);
      } else if (ratio >= 0.6) {
        best = Math.max(best, 0.75);
      } else if (ratio >= 0.5) {
        best = Math.max(best, 0.6);
      }
    }
  }

  return best;
}

export const __oddsMatchingTestables = {
  teamNameSimilarity
};

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3_600_000;
}

function extractScore(match) {
  return {
    home: match.score?.fullTime?.home ?? null,
    away: match.score?.fullTime?.away ?? null,
    winner: match.score?.winner ?? null
  };
}

function namespacedSourceId(provider, id) {
  if (!Number.isFinite(Number(id))) {
    return null;
  }

  return provider === "sportmonks" ? SPORTMONKS_ID_OFFSET + Number(id) : Number(id);
}

function toIsoTimestamp(value) {
  if (!value) {
    return null;
  }

  if (String(value).includes("T")) {
    return new Date(value).toISOString();
  }

  return new Date(String(value).replace(" ", "T") + "Z").toISOString();
}

function mapSportmonksStatus(state) {
  const raw = String(
    state?.developer_name ??
    state?.short_name ??
    state?.state ??
    ""
  ).toUpperCase();

  if (["FT", "AET", "FT_PEN", "PEN", "AP"].includes(raw)) {
    return "FINISHED";
  }

  if (["HT", "BREAK", "INT"].includes(raw)) {
    return "PAUSED";
  }

  if (["1H", "2H", "ET", "LIVE", "INPLAY"].includes(raw)) {
    return "LIVE";
  }

  if (["POSTP", "DELAYED"].includes(raw)) {
    return "POSTPONED";
  }

  if (["CANCL", "CANC", "CANCELLED"].includes(raw)) {
    return "CANCELLED";
  }

  return "SCHEDULED";
}

function extractSportmonksScore(fixture) {
  const currentScores = new Map(
    (fixture.scores ?? [])
      .filter((score) => score.description === "CURRENT")
      .map((score) => [score.score?.participant, score.score?.goals ?? null])
  );
  const homeGoals = currentScores.get("home") ?? null;
  const awayGoals = currentScores.get("away") ?? null;
  const homeParticipant = (fixture.participants ?? []).find((participant) => participant.meta?.location === "home");
  const awayParticipant = (fixture.participants ?? []).find((participant) => participant.meta?.location === "away");

  let winner = null;

  if (homeParticipant?.meta?.winner) {
    winner = "HOME_TEAM";
  } else if (awayParticipant?.meta?.winner) {
    winner = "AWAY_TEAM";
  } else if (
    mapSportmonksStatus(fixture.state) === "FINISHED" &&
    homeGoals !== null &&
    awayGoals !== null &&
    homeGoals === awayGoals
  ) {
    winner = "DRAW";
  }

  return {
    home: homeGoals,
    away: awayGoals,
    winner
  };
}

function normalizeSportmonksTeam(team) {
  return {
    id: namespacedSourceId("sportmonks", team.id),
    name: team.name,
    shortName: team.short_code ?? team.name,
    tla: team.short_code ?? null,
    crest: team.image_path ?? null
  };
}

function normalizeSportmonksMatchesPayload(seasonPayload) {
  const season = seasonPayload?.data;

  return {
    season: {
      startDate: season?.starting_at ?? null
    },
    matches: (season?.fixtures ?? []).map((fixture) => {
      const homeTeam = (fixture.participants ?? []).find((participant) => participant.meta?.location === "home");
      const awayTeam = (fixture.participants ?? []).find((participant) => participant.meta?.location === "away");
      const score = extractSportmonksScore(fixture);

      return {
        id: namespacedSourceId("sportmonks", fixture.id),
        utcDate: toIsoTimestamp(fixture.starting_at),
        status: mapSportmonksStatus(fixture.state),
        matchday: fixture.round_id ?? null,
        stage: fixture.stage?.name ?? null,
        group: fixture.group?.name ?? null,
        leg: fixture.leg ?? null,
        hasPremiumOdds: Boolean(fixture.has_premium_odds),
        venue: fixture.venue
          ? {
              name: fixture.venue.name ?? null,
              city: fixture.venue.city_name ?? null,
              capacity: fixture.venue.capacity ?? null,
              surface: fixture.venue.surface ?? null
            }
          : null,
        weatherSummary: fixture.weatherreport?.description ?? null,
        homeTeam: homeTeam ? normalizeSportmonksTeam(homeTeam) : null,
        awayTeam: awayTeam ? normalizeSportmonksTeam(awayTeam) : null,
        score: {
          fullTime: {
            home: score.home,
            away: score.away
          },
          winner: score.winner
        }
      };
    })
  };
}

function normalizeSportmonksStandingsPayload(standingsPayload, season) {
  const rows = standingsPayload?.data ?? [];

  return {
    season: {
      startDate: season?.starting_at ?? null
    },
    standings: rows.length
      ? [
          {
            stage: "League Stage",
            group: null,
            table: rows.map((row) => ({
              team: normalizeSportmonksTeam(row.participant),
              position: row.position ?? null,
              points: row.points ?? null,
              playedGames: row.played ?? null,
              won: row.won ?? null,
              draw: row.draw ?? null,
              lost: row.lost ?? null,
              goalsFor: row.goals_for ?? null,
              goalsAgainst: row.goals_against ?? null,
              goalDifference: row.goal_difference ?? null
            }))
          }
        ]
      : []
  };
}

function selectSyncProvider(competition) {
  if (competition.sportmonksLeagueId && hasSportmonksConfig()) {
    return "sportmonks";
  }

  if (hasFootballDataConfig()) {
    return "football-data";
  }

  return null;
}

function matchOddsEvent(matchRow, homeTeamName, awayTeamName, oddsEvents) {
  let bestEvent = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const event of oddsEvents) {
    const alignedSimilarity =
      teamNameSimilarity(homeTeamName, event.home_team) +
      teamNameSimilarity(awayTeamName, event.away_team);
    const swappedSimilarity =
      teamNameSimilarity(homeTeamName, event.away_team) +
      teamNameSimilarity(awayTeamName, event.home_team);
    const bestNameSimilarity = Math.max(alignedSimilarity, swappedSimilarity);

    if (bestNameSimilarity < 1.2) {
      continue;
    }

    const kickoffGap = hoursBetween(event.commence_time, matchRow.utc_date);

    if (kickoffGap <= 18) {
      const score = kickoffGap + ((2 - bestNameSimilarity) * 3);

      if (score < bestScore) {
        bestScore = score;
        bestEvent = event;
      }
    }
  }

  return bestEvent;
}

function eventBookmakerCount(event) {
  return event.bookmakers?.length ?? 0;
}

function eventMarketCount(event) {
  return (event.bookmakers ?? []).reduce((sum, bookmaker) => sum + (bookmaker.markets?.length ?? 0), 0);
}

function dedupeOddsEvents(oddsEvents) {
  const byFixture = new Map();

  for (const event of oddsEvents) {
    const key = [
      new Date(event.commence_time).toISOString(),
      normalizeNameLoose(event.home_team),
      normalizeNameLoose(event.away_team)
    ].join("|");
    const existing = byFixture.get(key);

    if (
      !existing ||
      eventBookmakerCount(event) > eventBookmakerCount(existing) ||
      (
        eventBookmakerCount(event) === eventBookmakerCount(existing) &&
        eventMarketCount(event) > eventMarketCount(existing)
      )
    ) {
      byFixture.set(key, event);
    }
  }

  return Array.from(byFixture.values());
}

function bestBookmakers(bookmakers) {
  return [...(bookmakers ?? [])]
    .sort((left, right) => {
      const leftMarkets = left.markets?.length ?? 0;
      const rightMarkets = right.markets?.length ?? 0;

      if (rightMarkets !== leftMarkets) {
        return rightMarkets - leftMarkets;
      }

      return new Date(right.last_update ?? 0).getTime() - new Date(left.last_update ?? 0).getTime();
    })
    .slice(0, 14);
}

function buildMarketLookup(bookmaker) {
  return Object.fromEntries((bookmaker.markets ?? []).map((market) => [market.key, market]));
}

function extractTotalsMarket(marketLookup) {
  if (marketLookup.totals) {
    return marketLookup.totals;
  }

  return Object.values(marketLookup).find((market) => String(market.key).startsWith("totals"));
}

function extractBttsMarket(marketLookup) {
  if (marketLookup.btts) {
    return marketLookup.btts;
  }

  return Object.values(marketLookup).find((market) => String(market.key).includes("btts"));
}

function pickOutcomePrice(outcomes, teamName) {
  let bestOutcome = null;
  let bestScore = 0;

  for (const outcome of outcomes) {
    const score = teamNameSimilarity(outcome.name, teamName);

    if (score > bestScore) {
      bestScore = score;
      bestOutcome = outcome;
    }
  }

  return bestScore >= 0.6 ? bestOutcome?.price ?? null : null;
}

function parseGoalLineValue(value) {
  if (Number.isFinite(value)) {
    return Number(value);
  }

  const normalized = String(value ?? "")
    .trim()
    .replace(",", ".");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractGoalLineFromOutcome(outcome) {
  const directPoint = parseGoalLineValue(outcome?.point);
  if (Number.isFinite(directPoint)) {
    return directPoint;
  }

  const match = String(outcome?.name ?? "")
    .replace(",", ".")
    .match(/([0-9]+(?:\.[0-9]+)?)/u);
  return match ? Number(match[1]) : null;
}

function isTotalsOutcome(outcome, side, targetLine = 2.5) {
  const normalizedName = normalizeName(outcome?.name ?? "");
  const line = extractGoalLineFromOutcome(outcome);
  const sideMatches =
    side === "over"
      ? normalizedName === "over" || normalizedName.startsWith("over ")
      : normalizedName === "under" || normalizedName.startsWith("under ");

  if (!sideMatches) {
    return false;
  }

  if (!Number.isFinite(line)) {
    return true;
  }

  return Math.abs(line - targetLine) < 0.001;
}

function mapBookmakerMarketRows(match, marketLookup) {
  const rows = [];
  const h2hMarket = marketLookup.h2h;

  if (h2hMarket) {
    const outcomes = h2hMarket.outcomes ?? [];
    rows.push({
      marketKey: "h2h",
      homePrice: pickOutcomePrice(outcomes, match.home_team_name),
      drawPrice: outcomes.find((outcome) => normalizeName(outcome.name) === "draw")?.price ?? null,
      awayPrice: pickOutcomePrice(outcomes, match.away_team_name)
    });
  }

  const totalsMarket = extractTotalsMarket(marketLookup);

  if (totalsMarket) {
    const outcomes = totalsMarket.outcomes ?? [];
    const over = outcomes.find((outcome) => isTotalsOutcome(outcome, "over", 2.5));
    const under = outcomes.find((outcome) => isTotalsOutcome(outcome, "under", 2.5));

    if (over || under) {
      rows.push({
        marketKey: "totals_2_5",
        homePrice: over?.price ?? null,
        drawPrice: null,
        awayPrice: under?.price ?? null
      });
    }
  }

  const bttsMarket = extractBttsMarket(marketLookup);

  if (bttsMarket) {
    const outcomes = bttsMarket.outcomes ?? [];
    const yes = outcomes.find((outcome) => normalizeName(outcome.name) === "yes");
    const no = outcomes.find((outcome) => normalizeName(outcome.name) === "no");

    if (yes || no) {
      rows.push({
        marketKey: "btts",
        homePrice: yes?.price ?? null,
        drawPrice: null,
        awayPrice: no?.price ?? null
      });
    }
  }

  return rows;
}

Object.assign(__oddsMatchingTestables, {
  pickOutcomePrice,
  mapBookmakerMarketRows,
  parseGoalLineValue,
  isTotalsOutcome
});

function recordQuoteHistory(insertQuoteHistory, snapshotId, match, bookmaker, marketKey, outcomeKey, odds, sourceProvider, sourceLabel) {
  if (!Number.isFinite(odds)) {
    return;
  }

  insertQuoteHistory.run(
    snapshotId ?? null,
    match.id,
    bookmaker.key,
    bookmaker.title,
    sourceProvider ?? null,
    sourceLabel ?? null,
    marketKey,
    outcomeKey,
    odds,
    ["IN_PLAY", "LIVE", "PAUSED"].includes(match.status) ? 1 : 0,
    bookmaker.last_update ?? isoNow()
  );
}

function upsertOddsSnapshot(insertSnapshot, insertQuoteHistory, match, bookmaker, marketKey, homePrice, drawPrice, awayPrice, sourceProvider, sourceLabel) {
  const retrievedAt = bookmaker.last_update ?? isoNow();
  const snapshot = insertSnapshot.run(
    match.id,
    bookmaker.key,
    bookmaker.title,
    sourceProvider ?? null,
    sourceLabel ?? null,
    marketKey,
    homePrice,
    drawPrice,
    awayPrice,
    ["IN_PLAY", "LIVE", "PAUSED"].includes(match.status) ? 1 : 0,
    retrievedAt
  );

  const snapshotId = snapshot?.lastInsertRowid ? Number(snapshot.lastInsertRowid) : null;
  recordQuoteHistory(insertQuoteHistory, snapshotId, match, bookmaker, marketKey, "home", homePrice, sourceProvider, sourceLabel);
  recordQuoteHistory(insertQuoteHistory, snapshotId, match, bookmaker, marketKey, "draw", drawPrice, sourceProvider, sourceLabel);
  recordQuoteHistory(insertQuoteHistory, snapshotId, match, bookmaker, marketKey, "away", awayPrice, sourceProvider, sourceLabel);

  return {
    bookmaker_key: bookmaker.key,
    bookmaker_title: bookmaker.title,
    source_provider: sourceProvider ?? null,
    source_label: sourceLabel ?? null,
    market: marketKey,
    home_price: homePrice,
    draw_price: drawPrice,
    away_price: awayPrice,
    is_live: ["IN_PLAY", "LIVE", "PAUSED"].includes(match.status) ? 1 : 0,
    retrieved_at: retrievedAt
  };
}

function storeBookmakerMarkets(insertSnapshot, insertQuoteHistory, match, bookmaker, marketLookup, sourceProvider, sourceLabel) {
  const storedRows = [];
  const bookmakerSourceProvider = bookmaker.source_provider ?? sourceProvider;
  const bookmakerSourceLabel = bookmaker.source_label ?? sourceLabel;
  const mappedRows = mapBookmakerMarketRows(match, marketLookup);

  for (const row of mappedRows) {
    storedRows.push(upsertOddsSnapshot(
      insertSnapshot,
      insertQuoteHistory,
      match,
      bookmaker,
      row.marketKey,
      row.homePrice,
      row.drawPrice,
      row.awayPrice,
      bookmakerSourceProvider,
      bookmakerSourceLabel
    ));
  }

  return storedRows;
}

function upsertMatchContext(matchId, context) {
  if (!context) {
    return;
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO match_context (
      match_id, source, venue_name, venue_city, venue_capacity, venue_surface,
      leg, has_premium_odds, weather_summary, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id) DO UPDATE SET
      source = excluded.source,
      venue_name = excluded.venue_name,
      venue_city = excluded.venue_city,
      venue_capacity = excluded.venue_capacity,
      venue_surface = excluded.venue_surface,
      leg = excluded.leg,
      has_premium_odds = excluded.has_premium_odds,
      weather_summary = excluded.weather_summary,
      updated_at = excluded.updated_at
  `).run(
    matchId,
    context.source,
    context.venueName ?? null,
    context.venueCity ?? null,
    context.venueCapacity ?? null,
    context.venueSurface ?? null,
    context.leg ?? null,
    context.hasPremiumOdds ? 1 : 0,
    context.weatherSummary ?? null,
    isoNow()
  );
}

function upsertMatchesForCompetition(competitionCode, payload) {
  const db = getDb();
  const syncTime = isoNow();
  const insertMatchStatement = db.prepare(`
    INSERT INTO matches (
      source_match_id, competition_code, season, utc_date, status, matchday, stage, group_name,
      home_team_id, away_team_id, home_score, away_score, winner, odds_event_id, last_synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(source_match_id) DO UPDATE SET
      competition_code = excluded.competition_code,
      season = excluded.season,
      utc_date = excluded.utc_date,
      status = excluded.status,
      matchday = excluded.matchday,
      stage = excluded.stage,
      group_name = excluded.group_name,
      home_team_id = excluded.home_team_id,
      away_team_id = excluded.away_team_id,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      winner = excluded.winner,
      last_synced_at = excluded.last_synced_at
  `);
  const readMatchBySource = db.prepare(`
    SELECT id
    FROM matches
    WHERE source_match_id = ?
    LIMIT 1
  `);
  const readPotentialMatchesByKickoff = db.prepare(`
    SELECT
      matches.id,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE competition_code = ?
      AND datetime(utc_date) = datetime(?)
    ORDER BY datetime(matches.last_synced_at) DESC, matches.id DESC
  `);
  const updateMatchById = db.prepare(`
    UPDATE matches
    SET
      competition_code = ?,
      season = ?,
      utc_date = ?,
      status = ?,
      matchday = ?,
      stage = ?,
      group_name = ?,
      home_team_id = ?,
      away_team_id = ?,
      home_score = ?,
      away_score = ?,
      winner = ?,
      last_synced_at = ?
    WHERE id = ?
  `);

  for (const match of payload.matches ?? []) {
    if (!match.homeTeam?.id || !match.awayTeam?.id || !match.utcDate) {
      continue;
    }

    const homeTeamId = upsertTeam(match.homeTeam);
    const awayTeamId = upsertTeam(match.awayTeam);
    const score = extractScore(match);
    const season = payload.season?.startDate ? Number(payload.season.startDate.slice(0, 4)) : null;
    const existingBySource = readMatchBySource.get(match.id);
    const normalizedHomeName = normalizeName(match.homeTeam.name);
    const normalizedAwayName = normalizeName(match.awayTeam.name);
    const existingByIdentity = existingBySource
      ? null
      : readPotentialMatchesByKickoff
          .all(competitionCode, match.utcDate)
          .find((candidate) =>
            normalizeName(candidate.home_team_name) === normalizedHomeName &&
            normalizeName(candidate.away_team_name) === normalizedAwayName
          );

    if (existingBySource) {
      updateMatchById.run(
        competitionCode,
        season,
        match.utcDate,
        match.status,
        match.matchday ?? null,
        match.stage ?? null,
        match.group ?? null,
        homeTeamId,
        awayTeamId,
        score.home,
        score.away,
        score.winner,
        syncTime,
        existingBySource.id
      );
      upsertMatchContext(existingBySource.id, {
        source: "sportmonks",
        venueName: match.venue?.name ?? null,
        venueCity: match.venue?.city ?? null,
        venueCapacity: match.venue?.capacity ?? null,
        venueSurface: match.venue?.surface ?? null,
        leg: match.leg ?? null,
        hasPremiumOdds: match.hasPremiumOdds ?? false,
        weatherSummary: match.weatherSummary ?? null
      });
      continue;
    }

    if (existingByIdentity) {
      updateMatchById.run(
        competitionCode,
        season,
        match.utcDate,
        match.status,
        match.matchday ?? null,
        match.stage ?? null,
        match.group ?? null,
        homeTeamId,
        awayTeamId,
        score.home,
        score.away,
        score.winner,
        syncTime,
        existingByIdentity.id
      );
      upsertMatchContext(existingByIdentity.id, {
        source: "sportmonks",
        venueName: match.venue?.name ?? null,
        venueCity: match.venue?.city ?? null,
        venueCapacity: match.venue?.capacity ?? null,
        venueSurface: match.venue?.surface ?? null,
        leg: match.leg ?? null,
        hasPremiumOdds: match.hasPremiumOdds ?? false,
        weatherSummary: match.weatherSummary ?? null
      });
      continue;
    }

    insertMatchStatement.run(
      match.id,
      competitionCode,
      season,
      match.utcDate,
      match.status,
      match.matchday ?? null,
      match.stage ?? null,
      match.group ?? null,
      homeTeamId,
      awayTeamId,
      score.home,
      score.away,
      score.winner,
      syncTime
    );
    const insertedMatch = readMatchBySource.get(match.id);
    if (insertedMatch?.id) {
      upsertMatchContext(insertedMatch.id, {
        source: "sportmonks",
        venueName: match.venue?.name ?? null,
        venueCity: match.venue?.city ?? null,
        venueCapacity: match.venue?.capacity ?? null,
        venueSurface: match.venue?.surface ?? null,
        leg: match.leg ?? null,
        hasPremiumOdds: match.hasPremiumOdds ?? false,
        weatherSummary: match.weatherSummary ?? null
      });
    }
  }
}

function mergeDuplicateMatches(competitionCode) {
  const db = getDb();
  const matches = db.prepare(`
    SELECT
      matches.id,
      matches.competition_code,
      matches.utc_date,
      matches.odds_event_id,
      matches.last_synced_at,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE matches.competition_code = ?
    ORDER BY datetime(matches.last_synced_at) DESC, matches.id DESC
  `).all(competitionCode);
  const groupedMatches = new Map();

  for (const match of matches) {
    const key = [
      match.competition_code,
      new Date(match.utc_date).toISOString(),
      normalizeName(match.home_team_name),
      normalizeName(match.away_team_name)
    ].join("|");
    const group = groupedMatches.get(key) ?? [];
    group.push(match);
    groupedMatches.set(key, group);
  }

  const duplicateGroups = Array.from(groupedMatches.values())
    .filter((group) => group.length > 1)
    .map((group) => ({
      canonical: group[0],
      duplicates: group.slice(1)
    }));

  if (!duplicateGroups.length) {
    return;
  }

  const moveOddsSnapshots = db.prepare("UPDATE odds_snapshots SET match_id = ? WHERE match_id = ?");
  const deleteAnalysisReport = db.prepare("DELETE FROM analysis_reports WHERE match_id = ?");
  const readCanonicalOdds = db.prepare("SELECT odds_event_id FROM matches WHERE id = ?");
  const updateCanonicalOdds = db.prepare("UPDATE matches SET odds_event_id = ? WHERE id = ?");
  const deleteMatch = db.prepare("DELETE FROM matches WHERE id = ?");

  for (const group of duplicateGroups) {
    for (const duplicate of group.duplicates) {
      moveOddsSnapshots.run(group.canonical.id, duplicate.id);
      deleteAnalysisReport.run(duplicate.id);

      const canonical = readCanonicalOdds.get(group.canonical.id);
      if (!canonical?.odds_event_id && duplicate.odds_event_id) {
        updateCanonicalOdds.run(duplicate.odds_event_id, group.canonical.id);
      }

      deleteMatch.run(duplicate.id);
    }
  }
}

function replaceStandingsForCompetition(competitionCode, payload) {
  const db = getDb();
  const fetchedAt = isoNow();
  const deleteStatement = db.prepare("DELETE FROM standings_rows WHERE competition_code = ?");
  const insertStatement = db.prepare(`
    INSERT INTO standings_rows (
      competition_code, season, stage, group_name, team_id, position, points, played_games, wins,
      draws, losses, goals_for, goals_against, goal_difference, fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  deleteStatement.run(competitionCode);

  for (const standing of payload.standings ?? []) {
    for (const row of standing.table ?? []) {
      if (!row.team?.id) {
        continue;
      }

      const teamId = upsertTeam(row.team);

      insertStatement.run(
        competitionCode,
        payload.season?.startDate ? Number(payload.season.startDate.slice(0, 4)) : null,
        standing.stage ?? null,
        standing.group ?? null,
        teamId,
        row.position ?? null,
        row.points ?? null,
        row.playedGames ?? null,
        row.won ?? null,
        row.draw ?? null,
        row.lost ?? null,
        row.goalsFor ?? null,
        row.goalsAgainst ?? null,
        row.goalDifference ?? null,
        fetchedAt
      );
    }
  }
}

function clearOddsCoverageGaps(competitionCode) {
  const db = getDb();
  const matches = db.prepare(`
    SELECT id
    FROM matches
    WHERE competition_code = ?
      AND datetime(utc_date) >= datetime('now', '-7 days')
      AND datetime(utc_date) <= datetime('now', '+14 days')
  `).all(competitionCode);
  const hasSnapshot = db.prepare(`
    SELECT 1
    FROM odds_snapshots
    WHERE match_id = ?
    LIMIT 1
  `);
  const clearOddsEvent = db.prepare("UPDATE matches SET odds_event_id = NULL WHERE id = ?");

  for (const match of matches) {
    if (!hasSnapshot.get(match.id)) {
      clearOddsEvent.run(match.id);
    }
  }
}

function shouldPromoteTrustedBoard(boardQuality) {
  return ["strong", "usable"].includes(boardQuality.tier);
}

function persistMatchBoards(match, provider, sourceMode, rowsByMarket, options = {}) {
  for (const [market, rows] of Object.entries(rowsByMarket)) {
    if (!rows.length) {
      continue;
    }

    const providerCounts = new Map();
    const sourceLabelCounts = new Map();

    for (const row of rows) {
      const rowProvider = row.source_provider ?? provider;
      const rowLabel = row.source_label ?? options.sourceLabel ?? null;
      providerCounts.set(rowProvider, (providerCounts.get(rowProvider) ?? 0) + 1);
      if (rowLabel) {
        sourceLabelCounts.set(rowLabel, (sourceLabelCounts.get(rowLabel) ?? 0) + 1);
      }
    }

    const dominantProvider = Array.from(providerCounts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? provider;
    const dominantSourceLabel = Array.from(sourceLabelCounts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? options.sourceLabel ?? null;

    const boardQuality = scoreOddsBoard(rows, market, {
      kickoffTime: match.utc_date,
      quotaDegraded: Boolean(options.quotaDegraded),
      sourceProvider: dominantProvider,
      sourceMode
    });

    upsertOddsMarketBoard({
      matchId: match.id,
      market,
      sourceProvider: dominantProvider,
      sourceLabel: dominantSourceLabel,
      sourceMode,
      sourceReliabilityScore: boardQuality.sourceReliabilityScore,
      boardQualityTier: boardQuality.tier,
      boardQualityScore: boardQuality.score,
      bookmakerCount: boardQuality.bookmakerCount,
      freshnessMinutes: boardQuality.freshnessMinutes,
      completenessScore: boardQuality.completenessScore,
      impliedConsistencyScore: boardQuality.impliedConsistencyScore,
      quotaDegraded: Boolean(options.quotaDegraded),
      boardRecordedAt: rows.map((row) => row.retrieved_at).filter(Boolean).sort().at(-1) ?? null,
      rows
    });

    if (["live", "licensed-import"].includes(sourceMode) && shouldPromoteTrustedBoard(boardQuality) && !options.quotaDegraded) {
      const promotedBoard = {
        matchId: match.id,
        market,
        sourceProvider: dominantProvider,
        sourceLabel: dominantSourceLabel,
        sourceMode: "trusted_cache",
        sourceReliabilityScore: boardQuality.sourceReliabilityScore,
        boardQualityTier: boardQuality.tier,
        boardQualityScore: boardQuality.score,
        bookmakerCount: boardQuality.bookmakerCount,
        freshnessMinutes: boardQuality.freshnessMinutes,
        completenessScore: boardQuality.completenessScore,
        impliedConsistencyScore: boardQuality.impliedConsistencyScore,
        quotaDegraded: false,
        boardRecordedAt: rows.map((row) => row.retrieved_at).filter(Boolean).sort().at(-1) ?? null,
        rows
      };
      const existingTrustedBoard = readOddsMarketBoard(match.id, market, "trusted_cache");

      if (shouldPromoteBoard(promotedBoard, existingTrustedBoard)) {
        upsertOddsMarketBoard(promotedBoard);
      }
    }
  }
}

function storeOddsSnapshots(competitionCode, oddsEvents, options = {}) {
  const db = getDb();
  const dedupedEvents = dedupeOddsEvents(oddsEvents);
  const matches = db.prepare(`
    SELECT
      matches.id,
      matches.utc_date,
      matches.status,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE matches.competition_code = ?
      AND datetime(matches.utc_date) >= datetime('now', '-7 days')
      AND datetime(matches.utc_date) <= datetime('now', '+14 days')
  `).all(competitionCode);

  const updateMatchOddsId = db.prepare("UPDATE matches SET odds_event_id = ? WHERE id = ?");
  const insertSnapshot = db.prepare(`
    INSERT INTO odds_snapshots (
      match_id, bookmaker_key, bookmaker_title, source_provider, source_label, market, home_price, draw_price, away_price, is_live, retrieved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertQuoteHistory = db.prepare(`
    INSERT INTO odds_quote_history (
      snapshot_id, match_id, bookmaker_key, bookmaker_title, source_provider, source_label, market, outcome_key, odds, is_live, recorded_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const match of matches) {
    const oddsEvent = matchOddsEvent(match, match.home_team_name, match.away_team_name, dedupedEvents);

    if (!oddsEvent) {
      continue;
    }

    updateMatchOddsId.run(oddsEvent.id, match.id);
    const rowsByMarket = {
      h2h: [],
      totals_2_5: [],
      btts: []
    };

    for (const bookmaker of bestBookmakers(oddsEvent.bookmakers)) {
      for (const row of storeBookmakerMarkets(
        insertSnapshot,
        insertQuoteHistory,
        match,
        bookmaker,
        buildMarketLookup(bookmaker),
        options.provider ?? "odds-api",
        options.sourceLabel ?? null
      )) {
        rowsByMarket[row.market].push(row);
      }
    }

    persistMatchBoards(match, options.provider ?? "odds-api", options.sourceMode ?? "live", rowsByMarket, {
      sourceLabel: options.sourceLabel ?? null,
      quotaDegraded: Boolean(options.quotaDegraded)
    });
  }

  clearOddsCoverageGaps(competitionCode);
}

async function fetchFootballDataBundle(code, competition) {
  if (!hasFootballDataConfig()) {
    throw new Error(`Cannot sync ${code} without FOOTBALL_DATA_API_KEY.`);
  }

  const [matchesPayload, standingsPayload, oddsBundle] = await Promise.all([
    fetchCompetitionMatches(code),
    fetchCompetitionStandings(code),
    fetchCompliantOddsBundle({ ...competition, code })
  ]);

  return {
    provider: "football-data",
    matchesPayload,
    standingsPayload,
    oddsPayload: oddsBundle.oddsPayload,
    oddsDiagnostics: oddsBundle.oddsDiagnostics
  };
}

async function fetchSportmonksBundle(code, competition) {
  if (!competition.sportmonksLeagueId) {
    throw new Error(`Competition ${code} does not have a Sportmonks mapping.`);
  }

  const season = await fetchLeagueLatestSeason(competition.sportmonksLeagueId);
  const [seasonPayload, standingsPayload, oddsBundle] = await Promise.all([
    fetchSeasonFixtures(season.id),
    fetchSeasonStandings(season.id).catch((error) => {
      logger.warn("Sportmonks standings fetch failed", {
        competition: code,
        message: error.message
      });
      return { data: [] };
    }),
    fetchCompliantOddsBundle({ ...competition, code })
  ]);

  return {
    provider: "sportmonks",
    matchesPayload: normalizeSportmonksMatchesPayload(seasonPayload),
    standingsPayload: normalizeSportmonksStandingsPayload(standingsPayload, seasonPayload?.data),
    oddsPayload: oddsBundle.oddsPayload,
    oddsDiagnostics: oddsBundle.oddsDiagnostics
  };
}

export async function syncCompetition(code) {
  if (!COMPETITION_BY_CODE[code]) {
    throw new Error(`Unsupported competition code: ${code}`);
  }

  const competition = COMPETITION_BY_CODE[code];
  const provider = selectSyncProvider(competition);

  if (!provider) {
    logger.debug("Skipping API sync — no provider configured", { competition: code });
    return { competition: code, provider: "none", matches: 0, standingsRows: 0, oddsEvents: 0 };
  }

  logger.info("Sync started", { competition: code, provider });

  const bundle = provider === "sportmonks"
    ? await fetchSportmonksBundle(code, competition)
    : await fetchFootballDataBundle(code, competition);
  const { matchesPayload, standingsPayload, oddsPayload, oddsDiagnostics } = bundle;

  withTransaction(() => {
    upsertMatchesForCompetition(code, matchesPayload);
    mergeDuplicateMatches(code);
    replaceStandingsForCompetition(code, standingsPayload);

    if (Array.isArray(oddsPayload) && oddsPayload.length) {
      storeOddsSnapshots(code, oddsPayload, {
        provider: oddsDiagnostics?.provider ?? "odds-api",
        sourceLabel: oddsDiagnostics?.sourceLabel ?? null,
        sourceMode: oddsDiagnostics?.sourceMode ?? "live",
        quotaDegraded: Boolean(oddsDiagnostics?.quotaDegraded)
      });
    }

    setCompetitionSyncState(code, isoNow());
  });

  logger.info("Sync finished", {
    competition: code,
    provider: bundle.provider,
    matches: matchesPayload.matches?.length ?? 0,
    oddsEvents: Array.isArray(oddsPayload) ? oddsPayload.length : 0,
    oddsDiagnostics
  });

  return {
    competition: code,
    provider: bundle.provider,
    matches: matchesPayload.matches?.length ?? 0,
    standingsRows: standingsPayload.standings?.reduce((sum, item) => sum + (item.table?.length ?? 0), 0) ?? 0,
    oddsEvents: Array.isArray(oddsPayload) ? oddsPayload.length : 0,
    oddsDiagnostics
  };
}

export async function syncAllCompetitions() {
  const results = [];

  for (const competition of SUPPORTED_COMPETITIONS) {
    try {
      const result = await syncCompetition(competition.code);
      results.push(result);
    } catch (error) {
      logger.error("Competition sync failed", {
        competition: competition.code,
        message: error.message
      });
      results.push({
        competition: competition.code,
        error: error.message
      });
    }
  }

  return results;
}

export async function syncFreeModeData() {
  // When no paid API keys are configured, seed match roster from fbref first
  // so the enrichment scrapers (xG, lineups, odds) have real rows to attach to.
  if (!hasFootballDataConfig() && !hasSportmonksConfig()) {
    logger.info("No API keys configured — running fbref public match importer");
    try {
      const fbrefResult = await importFbrefMatches({ competitionCodes: ["CL", "EL"] });
      logger.info("fbref public import complete", fbrefResult);
    } catch (err) {
      logger.warn("fbref public import failed", { message: err.message });
    }
  }

  const results = await syncAllCompetitions();
  const summary = {
    appCompetitions: results.filter((result) => APP_COMPETITION_CODES.includes(result.competition)),
    historyCompetitions: results.filter((result) => !APP_COMPETITION_CODES.includes(result.competition))
  };

  logger.info("Free-mode sync summary", {
    appCompetitions: summary.appCompetitions.length,
    historyCompetitions: summary.historyCompetitions.length
  });

  return results;
}

export async function syncIfStale() {
  if (!env.syncOnStart) {
    return [];
  }

  return syncFreeModeData();
}
