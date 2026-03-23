import { env, hasFootballDataConfig } from "../../config/env.js";
import { getJson } from "../../lib/http.js";

function buildUrl(pathname, params = {}) {
  const url = new URL(`${env.footballDataBaseUrl}${pathname}`);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function headers() {
  if (!hasFootballDataConfig()) {
    throw new Error("FOOTBALL_DATA_API_KEY is missing.");
  }

  return {
    "X-Auth-Token": env.footballDataApiKey
  };
}

export async function fetchCompetitionMatches(code) {
  return getJson(
    buildUrl(`/competitions/${code}/matches`, {
      limit: 200
    }),
    { headers: headers() }
  );
}

export async function fetchCompetitionStandings(code) {
  return getJson(buildUrl(`/competitions/${code}/standings`), {
    headers: headers()
  });
}
