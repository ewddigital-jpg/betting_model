import fs from "node:fs";
import path from "node:path";
import { env } from "../../../config/env.js";
import { getDb } from "../../../db/database.js";
import { logger } from "../../../lib/logger.js";
import { isoNow } from "../../../lib/time.js";

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

function parseNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function readCsvFile(filePath) {
  const contents = fs.readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/u).filter((line) => line.trim());

  if (!lines.length) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function readJsonFile(filePath) {
  const contents = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(contents)) {
    return contents;
  }

  if (Array.isArray(contents.rows)) {
    return contents.rows;
  }

  return [];
}

function readAdvancedStatRows() {
  if (!fs.existsSync(env.advancedStatsImportPath)) {
    return [];
  }

  const files = fs.readdirSync(env.advancedStatsImportPath)
    .filter((fileName) => fileName.endsWith(".csv") || fileName.endsWith(".json"))
    .sort();

  const rows = [];

  for (const fileName of files) {
    const filePath = path.join(env.advancedStatsImportPath, fileName);
    try {
      const fileRows = fileName.endsWith(".csv")
        ? readCsvFile(filePath)
        : readJsonFile(filePath);
      rows.push(...fileRows.map((row) => ({ ...row, __file: fileName })));
    } catch (error) {
      logger.warn("Advanced stats file could not be parsed", {
        filePath,
        message: error.message
      });
    }
  }

  return rows;
}

function listAdvancedStatFiles() {
  if (!fs.existsSync(env.advancedStatsImportPath)) {
    return [];
  }

  return fs.readdirSync(env.advancedStatsImportPath)
    .filter((fileName) => fileName.endsWith(".csv") || fileName.endsWith(".json"))
    .sort();
}

function readMatchLookup() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      matches.id,
      matches.competition_code,
      matches.utc_date,
      matches.home_team_id,
      matches.away_team_id,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
  `).all();

  return rows.map((row) => ({
    ...row,
    normalizedHome: normalizeName(row.home_team_name),
    normalizedAway: normalizeName(row.away_team_name),
    matchDate: row.utc_date.slice(0, 10)
  }));
}

function resolveMatch(rows, entry) {
  const explicitMatchId = Number(entry.match_id ?? entry.matchId ?? 0);
  if (Number.isFinite(explicitMatchId) && explicitMatchId > 0) {
    return rows.find((row) => row.id === explicitMatchId) ?? null;
  }

  const matchDate = String(entry.match_date ?? entry.date ?? entry.utc_date ?? "").slice(0, 10);
  const homeTeam = normalizeName(entry.home_team ?? entry.homeTeam);
  const awayTeam = normalizeName(entry.away_team ?? entry.awayTeam);
  const competitionCode = String(entry.competition_code ?? entry.competitionCode ?? "").trim();

  return rows.find((row) =>
    (!competitionCode || row.competition_code === competitionCode) &&
    (!matchDate || row.matchDate === matchDate) &&
    row.normalizedHome === homeTeam &&
    row.normalizedAway === awayTeam
  ) ?? null;
}

function resolveTeamId(match, entry) {
  const explicitTeamId = Number(entry.team_id ?? entry.teamId ?? 0);
  if (Number.isFinite(explicitTeamId) && explicitTeamId > 0) {
    return explicitTeamId;
  }

  const normalizedTeam = normalizeName(entry.team ?? entry.team_name ?? entry.teamName);
  if (!normalizedTeam) {
    return null;
  }

  if (normalizedTeam === match.normalizedHome) {
    return match.home_team_id;
  }

  if (normalizedTeam === match.normalizedAway) {
    return match.away_team_id;
  }

  return null;
}

function normalizeAdvancedRow(match, teamId, entry) {
  return {
    matchId: match.id,
    teamId,
    sourceProvider: String(entry.source_provider ?? entry.sourceProvider ?? entry.provider ?? "manual-xg").trim() || "manual-xg",
    xg: parseNumber(entry.xg),
    xga: parseNumber(entry.xga),
    shots: parseNumber(entry.shots),
    shotsOnTarget: parseNumber(entry.shots_on_target ?? entry.shotsOnTarget),
    bigChances: parseNumber(entry.big_chances ?? entry.bigChances),
    possession: parseNumber(entry.possession),
    extractedAt: String(entry.extracted_at ?? entry.extractedAt ?? isoNow())
  };
}

export function importAdvancedStatsData() {
  const sourceRows = readAdvancedStatRows();
  if (!sourceRows.length) {
    return {
      importedRows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      files: 0,
      results: []
    };
  }

  const matches = readMatchLookup();
  const db = getDb();
  const insertStatement = db.prepare(`
    INSERT INTO team_match_advanced_stats (
      match_id, team_id, source_provider, xg, xga, shots, shots_on_target, big_chances, possession, extracted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, team_id, source_provider) DO UPDATE SET
      xg = excluded.xg,
      xga = excluded.xga,
      shots = excluded.shots,
      shots_on_target = excluded.shots_on_target,
      big_chances = excluded.big_chances,
      possession = excluded.possession,
      extracted_at = excluded.extracted_at
  `);

  const results = [];
  let matchedRows = 0;
  let unmatchedRows = 0;

  for (const row of sourceRows) {
    const match = resolveMatch(matches, row);
    const teamId = match ? resolveTeamId(match, row) : null;

    if (!match || !teamId) {
      unmatchedRows += 1;
      results.push({
        file: row.__file ?? null,
        status: "unmatched",
        matchDate: row.match_date ?? row.date ?? null,
        homeTeam: row.home_team ?? row.homeTeam ?? null,
        awayTeam: row.away_team ?? row.awayTeam ?? null,
        team: row.team ?? row.team_name ?? row.teamName ?? null
      });
      continue;
    }

    const normalized = normalizeAdvancedRow(match, teamId, row);
    insertStatement.run(
      normalized.matchId,
      normalized.teamId,
      normalized.sourceProvider,
      normalized.xg,
      normalized.xga,
      normalized.shots,
      normalized.shotsOnTarget,
      normalized.bigChances,
      normalized.possession,
      normalized.extractedAt
    );

    matchedRows += 1;
  }

  logger.info("Advanced stats import finished", {
    importedRows: matchedRows,
    unmatchedRows
  });

  return {
    importedRows: matchedRows,
    matchedRows,
    unmatchedRows,
    files: new Set(sourceRows.map((row) => row.__file)).size,
    results: results.slice(0, 25)
  };
}

export function getAdvancedStatsDiagnostics() {
  const files = listAdvancedStatFiles();
  const sourceRows = readAdvancedStatRows();
  const db = getDb();
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS rows_count,
      COUNT(DISTINCT match_id) AS match_count,
      MAX(extracted_at) AS latest_extracted_at
    FROM team_match_advanced_stats
  `).get();

  return {
    importPath: env.advancedStatsImportPath,
    pathExists: fs.existsSync(env.advancedStatsImportPath),
    files,
    fileCount: files.length,
    sourceRowCount: sourceRows.length,
    storedRowCount: totals?.rows_count ?? 0,
    matchedMatchCount: totals?.match_count ?? 0,
    latestExtractedAt: totals?.latest_extracted_at ?? null
  };
}
