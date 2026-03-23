import { decodeUnderstatJson, fetchSourceDocument, normalizeName, parseCsvText, parseNumber } from "./historicalCrawlShared.js";

const UNDERSTAT_LEAGUES = [
  { key: "UCL", code: "CL", url: "https://understat.com/league/UCL", apiUrl: "https://understat.com/getLeagueData/UCL/2025", dumpKey: "understat-ucl" },
  { key: "EPL", code: "PL", url: "https://understat.com/league/EPL", apiUrl: "https://understat.com/getLeagueData/EPL/2025", dumpKey: "understat-epl" },
  { key: "La_liga", code: "PD", url: "https://understat.com/league/La_liga", apiUrl: "https://understat.com/getLeagueData/La_liga/2025", dumpKey: "understat-la-liga" },
  { key: "Bundesliga", code: "BL1", url: "https://understat.com/league/Bundesliga", apiUrl: "https://understat.com/getLeagueData/Bundesliga/2025", dumpKey: "understat-bundesliga" },
  { key: "Serie_A", code: "SA", url: "https://understat.com/league/Serie_A", apiUrl: "https://understat.com/getLeagueData/Serie_A/2025", dumpKey: "understat-serie-a" }
];

function extractDatesData(htmlOrJson) {
  if (!htmlOrJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(htmlOrJson);
    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (Array.isArray(parsed?.dates)) {
      return parsed.dates;
    }
  } catch {
    // continue to HTML parsing
  }

  for (const pattern of [
    /datesData\s*=\s*JSON\.parse\('([\s\S]*?)'\)/iu,
    /matchesData\s*=\s*JSON\.parse\('([\s\S]*?)'\)/iu
  ]) {
    const match = htmlOrJson.match(pattern);
    if (match) {
      return decodeUnderstatJson(match[1]);
    }
  }

  return [];
}

async function fetchUnderstatLeagueData(league) {
  try {
    const response = await fetch(league.apiUrl, {
      headers: {
        "user-agent": "Mozilla/5.0",
        "accept-language": "en-US,en;q=0.9",
        referer: league.url,
        "x-requested-with": "XMLHttpRequest"
      }
    });

    if (response.ok) {
      const json = await response.json();
      return {
        ok: true,
        source: "remote-api",
        rows: Array.isArray(json?.dates) ? json.dates : []
      };
    }
  } catch {
    // fall through to dump or HTML fallback
  }

  return null;
}

function parseDumpJson(text, competitionCode) {
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.rows)
      ? parsed.rows
      : Array.isArray(parsed.dates)
        ? parsed.dates
        : Array.isArray(parsed.matches)
          ? parsed.matches
          : [];

  return rows.map((row) => row.sourceProvider ? row : normalizeMatch(row, competitionCode));
}

function normalizeCsvRow(row, competitionCode) {
  return {
    competitionCode,
    matchDate: String(row.match_date ?? row.date ?? "").slice(0, 10),
    homeTeam: row.home_team ?? row.homeTeam ?? null,
    awayTeam: row.away_team ?? row.awayTeam ?? null,
    normalizedHome: normalizeName(row.home_team ?? row.homeTeam),
    normalizedAway: normalizeName(row.away_team ?? row.awayTeam),
    homeScore: parseNumber(row.home_score ?? row.homeGoals),
    awayScore: parseNumber(row.away_score ?? row.awayGoals),
    homeXg: parseNumber(row.home_xg ?? row.xg_home),
    awayXg: parseNumber(row.away_xg ?? row.xg_away),
    homeShots: parseNumber(row.home_shots ?? row.shots_home),
    awayShots: parseNumber(row.away_shots ?? row.shots_away),
    sourceProvider: "understat"
  };
}

function normalizeMatch(row, competitionCode) {
  const home = row.h ?? row.home ?? {};
  const away = row.a ?? row.away ?? {};

  return {
    competitionCode,
    matchDate: String(row.datetime ?? row.date ?? "").slice(0, 10),
    homeTeam: home.title ?? row.home_team ?? null,
    awayTeam: away.title ?? row.away_team ?? null,
    normalizedHome: normalizeName(home.title ?? row.home_team),
    normalizedAway: normalizeName(away.title ?? row.away_team),
    homeScore: parseNumber(row.goals?.h ?? row.home_goals),
    awayScore: parseNumber(row.goals?.a ?? row.away_goals),
    homeXg: parseNumber(row.xG?.h ?? row.home_xg),
    awayXg: parseNumber(row.xG?.a ?? row.away_xg),
    homeShots: parseNumber(row.shots?.h ?? row.home_shots),
    awayShots: parseNumber(row.shots?.a ?? row.away_shots),
    sourceProvider: "understat"
  };
}

export async function crawlUnderstatHistoricalData() {
  const results = [];

  for (const league of UNDERSTAT_LEAGUES) {
    const apiDocument = await fetchUnderstatLeagueData(league);
    const document = await fetchSourceDocument(league.url, league.dumpKey, {
      headers: { referer: "https://understat.com/" }
    });
    let rawRows = [];
    let source = document.source;

    if (apiDocument?.ok) {
      rawRows = apiDocument.rows;
      source = apiDocument.source;
    } else if (document.ok) {
      if (document.source === "dump-json") {
        rawRows = parseDumpJson(document.text, league.code);
      } else if (document.source === "dump-csv") {
        rawRows = parseCsvText(document.text).map((row) => normalizeCsvRow(row, league.code));
      } else {
        rawRows = extractDatesData(document.text);
      }
    }

    const rows = rawRows
      .map((row) => row.sourceProvider ? row : normalizeMatch(row, league.code))
      .filter((row) => row.matchDate && row.homeTeam && row.awayTeam && row.homeXg !== null && row.awayXg !== null);

    results.push({
      competitionCode: league.code,
      leagueKey: league.key,
      source,
      matches: rows
    });
  }

  return results;
}
