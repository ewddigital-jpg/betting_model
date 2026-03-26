import fs from "node:fs";
import path from "node:path";
import { env } from "../../../config/env.js";
import { getDb } from "../../../db/database.js";

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

function parseIntegerFlag(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return 1;
  }

  if (["0", "false", "no"].includes(normalized)) {
    return 0;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? (parsed > 0 ? 1 : 0) : fallback;
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

function readHistoricalOddsRows() {
  if (!fs.existsSync(env.historicalOddsImportPath)) {
    return [];
  }

  const files = fs.readdirSync(env.historicalOddsImportPath)
    .filter((fileName) => fileName.endsWith(".csv") || fileName.endsWith(".json"))
    .sort();

  const rows = [];

  for (const fileName of files) {
    const filePath = path.join(env.historicalOddsImportPath, fileName);
    const fileRows = fileName.endsWith(".csv")
      ? readCsvFile(filePath)
      : readJsonFile(filePath);
    rows.push(...fileRows.map((row) => ({ ...row, __file: fileName })));
  }

  return rows;
}

function listHistoricalOddsFiles() {
  if (!fs.existsSync(env.historicalOddsImportPath)) {
    return [];
  }

  return fs.readdirSync(env.historicalOddsImportPath)
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
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
  `).all();

  return rows.map((row) => ({
    ...row,
    matchDate: String(row.utc_date ?? "").slice(0, 10),
    normalizedHome: normalizeName(row.home_team_name),
    normalizedAway: normalizeName(row.away_team_name)
  }));
}

function tokenSimilarity(a, b) {
  const tokA = a.split(" ").filter((t) => t.length >= 3);
  const tokB = b.split(" ").filter((t) => t.length >= 3);
  if (!tokA.length || !tokB.length) return 0;
  const shared = tokA.filter((t) => tokB.includes(t));
  return shared.length / Math.max(tokA.length, tokB.length);
}

function resolveMatch(matches, row) {
  const explicitMatchId = Number(row.match_id ?? row.matchId ?? 0);
  if (Number.isFinite(explicitMatchId) && explicitMatchId > 0) {
    return matches.find((match) => match.id === explicitMatchId) ?? null;
  }

  const matchDate = String(row.match_date ?? row.date ?? row.utc_date ?? "").slice(0, 10);
  const competitionCode = String(row.competition_code ?? row.competitionCode ?? "").trim();
  const normalizedHome = normalizeName(row.home_team ?? row.homeTeam);
  const normalizedAway = normalizeName(row.away_team ?? row.awayTeam);

  // Pass 1: exact normalized name match
  const exact = matches.find((match) =>
    (!competitionCode || match.competition_code === competitionCode) &&
    (!matchDate || match.matchDate === matchDate) &&
    match.normalizedHome === normalizedHome &&
    match.normalizedAway === normalizedAway
  );
  if (exact) return exact;

  // Pass 2: token similarity fallback (handles PSG/Paris Saint Germain, Bayern Munich/FC Bayern München etc.)
  const dateFiltered = matches.filter((match) =>
    (!competitionCode || match.competition_code === competitionCode) &&
    (!matchDate || match.matchDate === matchDate)
  );

  let best = null;
  let bestScore = 0;

  for (const match of dateFiltered) {
    const homeSim = tokenSimilarity(match.normalizedHome, normalizedHome);
    const awaySim = tokenSimilarity(match.normalizedAway, normalizedAway);
    const score   = homeSim + awaySim;
    if (score > bestScore && homeSim >= 0.5 && awaySim >= 0.5) {
      bestScore = score;
      best = match;
    }
  }

  return best ?? null;
}

function normalizeMarket(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["h2h", "1x2", "match_result", "moneyline"].includes(normalized)) {
    return "h2h";
  }

  if (["totals_2_5", "ou25", "over_under_2_5", "totals25"].includes(normalized)) {
    return "totals_2_5";
  }

  if (["btts", "both_teams_to_score"].includes(normalized)) {
    return "btts";
  }

  return null;
}

function normalizeOutcomeKey(row) {
  const outcome = String(row.outcome_key ?? row.outcome ?? row.selection ?? "").trim().toLowerCase();
  const market = normalizeMarket(row.market ?? row.market_key ?? row.marketKey);

  if (market === "h2h") {
    if (["home", "1", "home_win"].includes(outcome)) {
      return "home";
    }

    if (["draw", "x"].includes(outcome)) {
      return "draw";
    }

    if (["away", "2", "away_win"].includes(outcome)) {
      return "away";
    }
  }

  if (market === "totals_2_5") {
    if (["over", "over_2_5", "yes"].includes(outcome)) {
      return "home";
    }

    if (["under", "under_2_5", "no"].includes(outcome)) {
      return "away";
    }
  }

  if (market === "btts") {
    if (["yes", "btts_yes"].includes(outcome)) {
      return "home";
    }

    if (["no", "btts_no"].includes(outcome)) {
      return "away";
    }
  }

  return null;
}

export const __historicalOddsImporterTestables = {
  normalizeMarket,
  normalizeOutcomeKey
};

function normalizeHistoricalOddsRow(matches, row) {
  const match = resolveMatch(matches, row);
  const market = normalizeMarket(row.market ?? row.market_key ?? row.marketKey);
  const outcomeKey = normalizeOutcomeKey(row);
  const odds = parseNumber(row.odds ?? row.price);
  const recordedAt = String(row.recorded_at ?? row.timestamp ?? row.retrieved_at ?? "").trim();
  const bookmakerKey = String(row.bookmaker_key ?? row.bookmaker ?? "").trim().toLowerCase();
  const bookmakerTitle = String(row.bookmaker_title ?? row.bookmakerTitle ?? row.bookmaker ?? "").trim();

  if (!match || !market || !outcomeKey || !odds || !recordedAt || !bookmakerKey) {
    return null;
  }

  const sourceProvider = bookmakerKey === "oddsportal-avg" || bookmakerKey.startsWith("oddsportal")
    ? "oddsportal-avg"
    : String(row.source_provider ?? row.sourceProvider ?? "").trim() || null;

  return {
    matchId: match.id,
    market,
    outcomeKey,
    odds,
    recordedAt,
    bookmakerKey,
    bookmakerTitle: bookmakerTitle || bookmakerKey,
    isLive: parseIntegerFlag(row.is_live ?? row.isLive, 0),
    sourceProvider,
    file: row.__file ?? null
  };
}

function groupKeyForRow(row) {
  return [
    row.matchId,
    row.market,
    row.bookmakerKey,
    row.bookmakerTitle,
    row.recordedAt,
    row.isLive
  ].join("::");
}

function createSnapshotPayload(group) {
  const prices = {
    home_price: null,
    draw_price: null,
    away_price: null
  };

  for (const row of group.rows) {
    if (row.outcomeKey === "home") {
      prices.home_price = row.odds;
    } else if (row.outcomeKey === "draw") {
      prices.draw_price = row.odds;
    } else if (row.outcomeKey === "away") {
      prices.away_price = row.odds;
    }
  }

  return prices;
}

function upsertSnapshot(db, group) {
  const snapshotPayload = createSnapshotPayload(group);
  const existing = db.prepare(`
    SELECT id
    FROM odds_snapshots
    WHERE match_id = ?
      AND bookmaker_key = ?
      AND bookmaker_title = ?
      AND market = ?
      AND datetime(retrieved_at) = datetime(?)
      AND is_live = ?
      AND IFNULL(home_price, -1) = IFNULL(?, -1)
      AND IFNULL(draw_price, -1) = IFNULL(?, -1)
      AND IFNULL(away_price, -1) = IFNULL(?, -1)
    LIMIT 1
  `).get(
    group.matchId,
    group.bookmakerKey,
    group.bookmakerTitle,
    group.market,
    group.recordedAt,
    group.isLive,
    snapshotPayload.home_price,
    snapshotPayload.draw_price,
    snapshotPayload.away_price
  );

  if (existing?.id) {
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO odds_snapshots (
      match_id, bookmaker_key, bookmaker_title, source_provider, market, home_price, draw_price, away_price, is_live, retrieved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    group.matchId,
    group.bookmakerKey,
    group.bookmakerTitle,
    group.sourceProvider ?? null,
    group.market,
    snapshotPayload.home_price,
    snapshotPayload.draw_price,
    snapshotPayload.away_price,
    group.isLive,
    group.recordedAt
  );

  return result.id;
}

export function getHistoricalOddsImportStatus() {
  const db = getDb();
  const files = listHistoricalOddsFiles();
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS quote_rows,
      COUNT(DISTINCT match_id) AS matches_with_quotes,
      COUNT(DISTINCT CASE WHEN datetime(recorded_at) <= datetime(matches.utc_date) THEN match_id END) AS matches_with_pre_kickoff_quotes
    FROM odds_quote_history
    JOIN matches ON matches.id = odds_quote_history.match_id
  `).get();

  return {
    importPath: env.historicalOddsImportPath,
    folderExists: fs.existsSync(env.historicalOddsImportPath),
    filesFound: files.length,
    quoteRowsStored: stats?.quote_rows ?? 0,
    matchesWithQuotes: stats?.matches_with_quotes ?? 0,
    matchesWithPreKickoffQuotes: stats?.matches_with_pre_kickoff_quotes ?? 0
  };
}

export function importHistoricalOddsData() {
  const sourceRows = readHistoricalOddsRows();
  const files = listHistoricalOddsFiles();

  if (!sourceRows.length) {
    return {
      files: files.length,
      sourceRows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      importedSnapshots: 0,
      importedQuotes: 0,
      unmatched: []
    };
  }

  const matches = readMatchLookup();
  const db = getDb();
  const normalizedRows = [];
  const unmatched = [];

  for (const row of sourceRows) {
    const normalized = normalizeHistoricalOddsRow(matches, row);
    if (!normalized) {
      unmatched.push({
        file: row.__file ?? null,
        matchDate: row.match_date ?? row.date ?? row.utc_date ?? null,
        homeTeam: row.home_team ?? row.homeTeam ?? null,
        awayTeam: row.away_team ?? row.awayTeam ?? null,
        bookmaker: row.bookmaker ?? row.bookmaker_key ?? null,
        market: row.market ?? row.market_key ?? null,
        outcome: row.outcome ?? row.outcome_key ?? row.selection ?? null
      });
      continue;
    }

    normalizedRows.push(normalized);
  }

  const groups = new Map();
  for (const row of normalizedRows) {
    const key = groupKeyForRow(row);
    if (!groups.has(key)) {
      groups.set(key, {
        matchId: row.matchId,
        market: row.market,
        bookmakerKey: row.bookmakerKey,
        bookmakerTitle: row.bookmakerTitle,
        sourceProvider: row.sourceProvider ?? null,
        recordedAt: row.recordedAt,
        isLive: row.isLive,
        rows: []
      });
    }

    groups.get(key).rows.push(row);
  }

  const insertQuote = db.prepare(`
    INSERT OR IGNORE INTO odds_quote_history (
      snapshot_id, match_id, bookmaker_key, bookmaker_title, market, outcome_key, odds, is_live, recorded_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let importedSnapshots = 0;
  let importedQuotes = 0;

  for (const group of groups.values()) {
    const beforeSnapshotCount = db.prepare("SELECT COUNT(*) AS count FROM odds_snapshots").get().count;
    const snapshotId = upsertSnapshot(db, group);
    const afterSnapshotCount = db.prepare("SELECT COUNT(*) AS count FROM odds_snapshots").get().count;
    importedSnapshots += Math.max(0, afterSnapshotCount - beforeSnapshotCount);

    for (const row of group.rows) {
      const beforeQuoteCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM odds_quote_history
        WHERE snapshot_id = ? AND outcome_key = ?
      `).get(snapshotId, row.outcomeKey).count;
      insertQuote.run(
        snapshotId,
        row.matchId,
        row.bookmakerKey,
        row.bookmakerTitle,
        row.market,
        row.outcomeKey,
        row.odds,
        row.isLive,
        row.recordedAt
      );
      const afterQuoteCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM odds_quote_history
        WHERE snapshot_id = ? AND outcome_key = ?
      `).get(snapshotId, row.outcomeKey).count;
      importedQuotes += Math.max(0, afterQuoteCount - beforeQuoteCount);
    }
  }

  return {
    files: files.length,
    sourceRows: sourceRows.length,
    matchedRows: normalizedRows.length,
    unmatchedRows: unmatched.length,
    importedSnapshots,
    importedQuotes,
    unmatched: unmatched.slice(0, 25)
  };
}
