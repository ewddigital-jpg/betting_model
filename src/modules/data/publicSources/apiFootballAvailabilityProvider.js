import { env, hasApiFootballConfig } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import { isoNow } from "../../../lib/time.js";
import { normalizeName, teamNameSimilarity } from "./shared.js";

const API_FOOTBALL_COMPETITION_MAP = {
  CL: 2,
  EL: 3
};

async function callApiFootball(pathname, query = {}) {
  const url = new URL(`${env.apiFootballBaseUrl}/${pathname}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      "x-apisports-key": env.apiFootballApiKey
    }
  });

  if (!response.ok) {
    throw new Error(`API-Football ${pathname} failed with ${response.status}`);
  }

  const payload = await response.json();
  return payload.response ?? [];
}

function findFixtureMatch(fixtures, match) {
  return fixtures.find((fixture) => {
    const fixtureHome = fixture.teams?.home?.name ?? "";
    const fixtureAway = fixture.teams?.away?.name ?? "";
    const homeScore = teamNameSimilarity(fixtureHome, match.homeTeamName);
    const awayScore = teamNameSimilarity(fixtureAway, match.awayTeamName);
    return homeScore >= 0.6 && awayScore >= 0.6;
  });
}

function normalizeAvailabilityStatus(value, fallback = "out") {
  const normalized = normalizeName(value);

  if (normalized.includes("doubt")) {
    return "doubtful";
  }

  if (normalized.includes("question")) {
    return "questionable";
  }

  if (normalized.includes("suspen")) {
    return "suspended";
  }

  if (normalized.includes("fit") || normalized.includes("avail")) {
    return "available";
  }

  return fallback;
}

function importanceFromRole(role) {
  const normalized = normalizeName(role);

  if (normalized.includes("goalkeeper")) {
    return 0.95;
  }

  if (normalized.includes("defender") || normalized.includes("midfielder") || normalized.includes("forward")) {
    return 0.75;
  }

  return 0.6;
}

export const apiFootballAvailabilityProvider = {
  name: "api-football",

  async collect(match) {
    if (!hasApiFootballConfig()) {
      return null;
    }

    const league = API_FOOTBALL_COMPETITION_MAP[match.competitionCode];
    if (!league) {
      return null;
    }

    try {
      const season = new Date(match.utcDate).getUTCFullYear() - 1;
      const fixtureRows = await callApiFootball("fixtures", {
        league,
        season,
        date: match.utcDate.slice(0, 10)
      });
      const fixture = findFixtureMatch(fixtureRows, match);

      if (!fixture?.fixture?.id) {
        return null;
      }

      const [injuries, lineups] = await Promise.all([
        callApiFootball("injuries", { fixture: fixture.fixture.id }).catch(() => []),
        callApiFootball("fixtures/lineups", { fixture: fixture.fixture.id }).catch(() => [])
      ]);
      const extractedAt = isoNow();

      return {
        injuries: injuries.map((entry) => ({
          teamName: entry.team?.name ?? "",
          playerName: entry.player?.name ?? "",
          playerRole: entry.player?.type ?? null,
          status: normalizeAvailabilityStatus(entry.player?.reason, "injured"),
          reason: entry.player?.reason ?? null,
          expectedReturn: null,
          importanceScore: importanceFromRole(entry.player?.type),
          sourceProvider: "api-football",
          sourceUrl: null,
          extractedAt
        })),
        suspensions: injuries
          .filter((entry) => normalizeAvailabilityStatus(entry.player?.reason, "injured") === "suspended")
          .map((entry) => ({
            teamName: entry.team?.name ?? "",
            playerName: entry.player?.name ?? "",
            playerRole: entry.player?.type ?? null,
            status: "suspended",
            reason: entry.player?.reason ?? null,
            returnDate: null,
            importanceScore: importanceFromRole(entry.player?.type),
            sourceProvider: "api-football",
            sourceUrl: null,
            extractedAt
          })),
        expectedLineups: lineups.flatMap((entry) =>
          (entry.startXI ?? []).map((player, index) => ({
            teamName: entry.team?.name ?? "",
            playerName: player.player?.name ?? "",
            playerRole: normalizeName(player.player?.pos).includes("g") ? "goalkeeper" : player.player?.pos ?? null,
            lineupSlot: index + 1,
            expectedStart: true,
            certaintyScore: 0.95,
            sourceProvider: "api-football",
            sourceUrl: null,
            extractedAt
          }))
        )
      };
    } catch (error) {
      logger.warn("API-Football availability import failed", {
        matchId: match.id,
        message: error.message
      });
      return null;
    }
  }
};
