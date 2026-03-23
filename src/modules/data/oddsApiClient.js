import { env, hasOddsConfig } from "../../config/env.js";
import { getJson } from "../../lib/http.js";

function buildUrl(pathname, params = {}) {
  const url = new URL(`${env.oddsBaseUrl}${pathname}`);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function defaultParams() {
  if (!hasOddsConfig()) {
    throw new Error("ODDS_API_KEY is missing.");
  }

  return {
    apiKey: env.oddsApiKey,
    regions: env.oddsRegions.join(","),
    markets: "h2h,totals,btts",
    oddsFormat: "decimal",
    dateFormat: "iso"
  };
}

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

function teamSimilarity(left, right) {
  const leftName = normalizeName(left);
  const rightName = normalizeName(right);

  if (!leftName || !rightName) {
    return 0;
  }

  if (leftName === rightName) {
    return 1;
  }

  const leftTokens = leftName.split(" ").filter((token) => token.length >= 3);
  const rightTokens = rightName.split(" ").filter((token) => token.length >= 3);
  const shared = leftTokens.filter((token) => rightTokens.includes(token));

  if (!shared.length) {
    return 0;
  }

  return shared.length / Math.max(leftTokens.length, rightTokens.length);
}

function kickoffGapHours(left, right) {
  return Math.abs(new Date(left).getTime() - new Date(right).getTime()) / 3_600_000;
}

async function fetchOddsWithMarkets(sportKey, markets) {
  return getJson(buildUrl(`/sports/${sportKey}/odds`, {
    ...defaultParams(),
    markets
  }));
}

async function fetchSportEvents(sportKey) {
  return getJson(buildUrl(`/sports/${sportKey}/events`, {
    ...defaultParams()
  }));
}

async function fetchEventOdds(sportKey, eventId, markets) {
  return getJson(buildUrl(`/sports/${sportKey}/events/${eventId}/odds`, {
    ...defaultParams(),
    markets
  }));
}

export async function fetchLeagueOdds(sportKey) {
  try {
    return await fetchOddsWithMarkets(sportKey, "h2h,totals,btts");
  } catch (error) {
    if (error.message.includes("INVALID_MARKET") || error.message.includes("Markets not supported")) {
      return fetchOddsWithMarkets(sportKey, "h2h,totals");
    }

    throw error;
  }
}

function matchTrackedEvent(trackedMatch, events) {
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const event of events) {
    const aligned =
      teamSimilarity(trackedMatch.homeTeam, event.home_team) +
      teamSimilarity(trackedMatch.awayTeam, event.away_team);
    const swapped =
      teamSimilarity(trackedMatch.homeTeam, event.away_team) +
      teamSimilarity(trackedMatch.awayTeam, event.home_team);
    const similarity = Math.max(aligned, swapped);

    if (similarity < 1.25) {
      continue;
    }

    const score = kickoffGapHours(trackedMatch.kickoffTime, event.commence_time) + ((2 - similarity) * 2);

    if (score < bestScore) {
      bestScore = score;
      best = event;
    }
  }

  return best;
}

export async function fetchTrackedOdds(sportKey, trackedMatches) {
  const relevantMatches = Array.isArray(trackedMatches) ? trackedMatches.filter(Boolean) : [];

  if (!relevantMatches.length) {
    return [];
  }

  if (relevantMatches.length > 4) {
    return fetchLeagueOdds(sportKey);
  }

  const events = await fetchSportEvents(sportKey);
  const matchedEvents = relevantMatches
    .map((match) => matchTrackedEvent(match, events))
    .filter(Boolean);
  const uniqueEvents = [...new Map(matchedEvents.map((event) => [event.id, event])).values()];

  if (!uniqueEvents.length) {
    return [];
  }

  const payloads = [];

  for (const event of uniqueEvents) {
    try {
      payloads.push(await fetchEventOdds(sportKey, event.id, "h2h,totals,btts"));
    } catch (error) {
      if (String(error.message ?? "").includes("INVALID_MARKET") || String(error.message ?? "").includes("Markets not supported")) {
        payloads.push(await fetchEventOdds(sportKey, event.id, "h2h,totals"));
      } else {
        throw error;
      }
    }
  }

  return payloads.flatMap((entry) => Array.isArray(entry) ? entry : [entry]).filter(Boolean);
}
