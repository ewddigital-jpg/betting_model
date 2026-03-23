import { extractTableRows, fetchSourceDocument, normalizeName, parseCsvText, parseNumber, stripTags } from "./historicalCrawlShared.js";

const FBREF_COMPETITIONS = [
  {
    code: "CL",
    scheduleUrl: "https://fbref.com/en/comps/8/schedule/Champions-League-Scores-and-Fixtures",
    statsUrl: "https://fbref.com/en/comps/8/stats/Champions-League-Stats",
    scheduleDumpKey: "fbref-cl-schedule",
    statsDumpKey: "fbref-cl-stats"
  },
  {
    code: "EL",
    scheduleUrl: "https://fbref.com/en/comps/19/schedule/Europa-League-Scores-and-Fixtures",
    statsUrl: "https://fbref.com/en/comps/19/stats/Europa-League-Stats",
    scheduleDumpKey: "fbref-el-schedule",
    statsDumpKey: "fbref-el-stats"
  },
  {
    code: "UECL",
    scheduleUrl: "https://fbref.com/en/comps/882/schedule/Europa-Conference-League-Scores-and-Fixtures",
    statsUrl: "https://fbref.com/en/comps/882/stats/Europa-Conference-League-Stats",
    scheduleDumpKey: "fbref-uecl-schedule",
    statsDumpKey: "fbref-uecl-stats"
  }
];

function parseScheduleRows(rows, competitionCode) {
  return rows
    .filter((row) => row.date && row.home_team && row.away_team)
    .map((row) => {
      const [homeScore, awayScore] = String(row.score ?? "").split(/[–-]/u).map((value) => parseNumber(value));
      return {
        competitionCode,
        matchDate: row.date,
        homeTeam: stripTags(row.home_team),
        awayTeam: stripTags(row.away_team),
        normalizedHome: normalizeName(row.home_team),
        normalizedAway: normalizeName(row.away_team),
        homeScore,
        awayScore,
        homeXg: parseNumber(row.home_xg ?? row.xg_home),
        awayXg: parseNumber(row.away_xg ?? row.xg_away),
        homeShots: parseNumber(row.home_sh ?? row.sh_home ?? row.home_shots),
        awayShots: parseNumber(row.away_sh ?? row.sh_away ?? row.away_shots),
        venue: row.venue ? stripTags(row.venue) : null,
        sourceProvider: "fbref",
        sourceType: "schedule"
      };
    });
}

function parseScheduleCsvRows(rows, competitionCode) {
  return rows
    .map((row) => ({
      competitionCode,
      matchDate: row.date ?? row.match_date ?? null,
      homeTeam: row.home_team ?? row.homeTeam ?? null,
      awayTeam: row.away_team ?? row.awayTeam ?? null,
      normalizedHome: normalizeName(row.home_team ?? row.homeTeam),
      normalizedAway: normalizeName(row.away_team ?? row.awayTeam),
      homeScore: parseNumber(row.home_score ?? row.homeGoals),
      awayScore: parseNumber(row.away_score ?? row.awayGoals),
      homeXg: parseNumber(row.home_xg ?? row.xg_home),
      awayXg: parseNumber(row.away_xg ?? row.xg_away),
      homeShots: parseNumber(row.home_shots ?? row.sh_home),
      awayShots: parseNumber(row.away_shots ?? row.sh_away),
      venue: row.venue ?? null,
      sourceProvider: "fbref",
      sourceType: "schedule"
    }))
    .filter((row) => row.matchDate && row.homeTeam && row.awayTeam && row.homeXg !== null && row.awayXg !== null);
}

function parseStatsRows(rows, competitionCode) {
  return rows
    .filter((row) => row.squad)
    .map((row) => ({
      competitionCode,
      teamName: stripTags(row.squad),
      normalizedTeam: normalizeName(row.squad),
      shots: parseNumber(row.sh ?? row.shots),
      shotsOnTarget: parseNumber(row.sot ?? row.shots_on_target),
      xg: parseNumber(row.xg),
      xga: parseNumber(row.xga),
      possession: parseNumber(row.poss ?? row.possession),
      sourceProvider: "fbref",
      sourceType: "team-stats"
    }));
}

function parseStatsCsvRows(rows, competitionCode) {
  return rows
    .map((row) => ({
      competitionCode,
      teamName: row.squad ?? row.team ?? row.team_name ?? null,
      normalizedTeam: normalizeName(row.squad ?? row.team ?? row.team_name),
      shots: parseNumber(row.sh ?? row.shots),
      shotsOnTarget: parseNumber(row.sot ?? row.shots_on_target),
      xg: parseNumber(row.xg),
      xga: parseNumber(row.xga),
      possession: parseNumber(row.poss ?? row.possession),
      sourceProvider: "fbref",
      sourceType: "team-stats"
    }))
    .filter((row) => row.teamName);
}

function extractScheduleRows(document, competitionCode) {
  if (!document.ok) {
    return [];
  }

  if (document.source === "dump-csv") {
    return parseScheduleCsvRows(parseCsvText(document.text), competitionCode);
  }

  for (const tableId of ["sched_all", "sched_2025-2026_1"]) {
    const rows = parseScheduleRows(extractTableRows(document.text, tableId), competitionCode);
    if (rows.length) {
      return rows;
    }
  }

  return [];
}

function extractStatsRows(document, competitionCode) {
  if (!document.ok) {
    return [];
  }

  if (document.source === "dump-csv") {
    return parseStatsCsvRows(parseCsvText(document.text), competitionCode);
  }

  for (const tableId of ["stats_squads_standard_for", "stats_squads_standard"]) {
    const rows = parseStatsRows(extractTableRows(document.text, tableId), competitionCode);
    if (rows.length) {
      return rows;
    }
  }

  return [];
}

export async function crawlFbrefHistoricalData() {
  const results = [];

  for (const competition of FBREF_COMPETITIONS) {
    const scheduleDocument = await fetchSourceDocument(competition.scheduleUrl, competition.scheduleDumpKey, {
      headers: { referer: "https://fbref.com/" }
    });
    const statsDocument = await fetchSourceDocument(competition.statsUrl, competition.statsDumpKey, {
      headers: { referer: "https://fbref.com/" }
    });

    const scheduleRows = extractScheduleRows(scheduleDocument, competition.code);
    const teamStats = extractStatsRows(statsDocument, competition.code);

    results.push({
      competitionCode: competition.code,
      scheduleSource: scheduleDocument.source,
      statsSource: statsDocument.source,
      matches: scheduleRows,
      teamStats
    });
  }

  return results;
}
