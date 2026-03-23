import { env, hasSportmonksConfig } from "../../config/env.js";
import { getJson } from "../../lib/http.js";

function buildUrl(pathname, params = {}) {
  if (!hasSportmonksConfig()) {
    throw new Error("SPORTMONKS_API_KEY is missing.");
  }

  const url = new URL(`${env.sportmonksBaseUrl}${pathname}`);
  url.searchParams.set("api_token", env.sportmonksApiKey);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

export async function fetchLeagueLatestSeason(leagueId) {
  const payload = await getJson(buildUrl(`/leagues/${leagueId}`, { include: "latest" }));
  const latest = payload?.data?.latest;
  const derivedSeasonId = Array.isArray(latest)
    ? latest.find((fixture) => fixture?.season_id)?.season_id
    : latest?.season_id ?? latest?.id;

  if (!derivedSeasonId) {
    throw new Error(`Sportmonks did not return a latest season for league ${leagueId}.`);
  }

  return {
    id: derivedSeasonId
  };
}

export async function fetchSeasonFixtures(seasonId) {
  return getJson(buildUrl(`/seasons/${seasonId}`, {
    include: "fixtures.participants;fixtures.scores;fixtures.state;fixtures.stage;fixtures.group;fixtures.venue;fixtures.weatherreport;fixtures.formations"
  }));
}

export async function fetchSeasonStandings(seasonId) {
  return getJson(buildUrl(`/standings/seasons/${seasonId}`, {
    include: "participant"
  }));
}

export async function fetchFixtureAvailability(fixtureId) {
  return getJson(buildUrl(`/fixtures/${fixtureId}`, {
    include: "participants;sidelined.player;sidelined.type;sidelined.sideline;lineups;formations"
  }));
}
