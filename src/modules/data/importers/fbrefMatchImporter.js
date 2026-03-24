/**
 * fbrefMatchImporter — zero-API-key founding importer.
 *
 * Scrapes fbref.com schedule pages for UCL and EL across multiple seasons,
 * creates team records and match records that don't yet exist, and marks
 * finished matches with real scores.
 *
 * This is the FOUNDING importer: it runs before all enrichment scrapers
 * (xG, lineups, odds) and gives them real rows to attach data to.
 */

import { getDb } from "../../../db/database.js";
import { logger } from "../../../lib/logger.js";
import { isoNow } from "../../../lib/time.js";
import {
  extractTableRows,
  fetchSourceDocument,
  normalizeName,
  parseNumber,
  stripTags
} from "../publicSources/historicalCrawlShared.js";

// ─── Season/competition catalogue ───────────────────────────────────────────

const SEASONS = [2022, 2023, 2024];

function buildUrls(compId, compSlug, compCode) {
  return [
    // Current season (always present)
    {
      season: null,
      compCode,
      scheduleUrl: `https://fbref.com/en/comps/${compId}/schedule/${compSlug}-Scores-and-Fixtures`,
      dumpKey: `fbref-${compCode.toLowerCase()}-schedule-current`
    },
    // Historical seasons
    ...SEASONS.map((year) => ({
      season: year,
      compCode,
      scheduleUrl: `https://fbref.com/en/comps/${compId}/${year}-${year + 1}/schedule/${year}-${year + 1}-${compSlug}-Scores-and-Fixtures`,
      dumpKey: `fbref-${compCode.toLowerCase()}-schedule-${year}-${year + 1}`
    }))
  ];
}

const COMPETITION_URLS = [
  ...buildUrls(8,  "Champions-League", "CL"),
  ...buildUrls(19, "Europa-League",    "EL")
];

// ─── Stage mapping ───────────────────────────────────────────────────────────

function mapStage(roundText) {
  const r = String(roundText ?? "").toLowerCase().trim();

  if (r.includes("final") && !r.includes("semi") && !r.includes("quarter")) return "FINAL";
  if (r.includes("semi")) return "SEMI_FINALS";
  if (r.includes("quarter")) return "QUARTER_FINALS";
  if (r.includes("round of 16") || r.includes("last 16") || r.includes("round of sixteen")) return "LAST_16";
  if (r.includes("playoff") || r.includes("play-off") || r.includes("qualifying")) return "PLAYOFFS";
  if (r.includes("knockout round play-off")) return "PLAYOFFS";
  if (r.includes("league phase")) return "LEAGUE_PHASE";
  if (r.includes("group")) return "GROUP_STAGE";
  if (r.includes("matchday") || r.includes("match day")) return "LEAGUE_PHASE";
  return "GROUP_STAGE";
}

function parseMatchday(roundText) {
  const match = String(roundText ?? "").match(/matchday\s+(\d+)/iu);
  return match ? Number(match[1]) : null;
}

function deriveSeason(dateString) {
  if (!dateString) return null;
  const year = Number(String(dateString).slice(0, 4));
  const month = Number(String(dateString).slice(5, 7));
  if (!year) return null;
  return month >= 7 ? year : year - 1;
}

// ─── Table ID candidates ─────────────────────────────────────────────────────

function buildTableIds(season) {
  const base = ["sched_all", "sched_eur", "schedule"];
  if (!season) {
    return [...base, "sched_2025-2026_1", "sched_2024-2025_1"];
  }
  return [`sched_${season}-${season + 1}_1`, ...base];
}

// ─── Row parsing ─────────────────────────────────────────────────────────────

function parseScheduleRow(row, compCode) {
  const date = row.date ?? row.match_date ?? null;
  const homeRaw = row.home_team ?? row.home ?? null;
  const awayRaw = row.away_team ?? row.away ?? null;

  if (!date || !homeRaw || !awayRaw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(date).trim())) return null;

  const scoreText = row.score ?? row.result ?? "";
  const scoreParts = String(scoreText).split(/[–\-]/u).map((v) => parseNumber(v));
  const homeScore = scoreParts[0] ?? null;
  const awayScore = scoreParts[1] ?? null;
  const hasScore = homeScore !== null && awayScore !== null;

  const timeText = row.time ?? "";
  const timeParts = String(timeText).match(/(\d{1,2}):(\d{2})/u);
  const hour = timeParts ? Number(timeParts[1]) : 20;
  const minute = timeParts ? Number(timeParts[2]) : 0;
  const utcDate = `${date.trim()}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;

  const roundText = row.round ?? row.comp_round ?? "";

  return {
    compCode,
    utcDate,
    matchDate: date.trim(),
    homeTeam: stripTags(homeRaw),
    awayTeam: stripTags(awayRaw),
    normalizedHome: normalizeName(homeRaw),
    normalizedAway: normalizeName(awayRaw),
    homeScore: hasScore ? homeScore : null,
    awayScore: hasScore ? awayScore : null,
    status: hasScore ? "FINISHED" : "SCHEDULED",
    stage: mapStage(roundText),
    matchday: parseMatchday(roundText),
    season: deriveSeason(date.trim()),
    venue: row.venue ? stripTags(row.venue) : null,
    homeXg: parseNumber(row.home_xg ?? row.xg_home ?? null),
    awayXg: parseNumber(row.away_xg ?? row.xg_away ?? null)
  };
}

async function fetchScheduleRows(entry) {
  const doc = await fetchSourceDocument(entry.scheduleUrl, entry.dumpKey, {
    headers: { referer: "https://fbref.com/" }
  });

  if (!doc.ok) return [];

  for (const tableId of buildTableIds(entry.season)) {
    const rows = extractTableRows(doc.text, tableId);
    const parsed = rows
      .map((row) => parseScheduleRow(row, entry.compCode))
      .filter(Boolean);

    if (parsed.length > 0) {
      logger.info("fbref schedule fetched", {
        compCode: entry.compCode,
        season: entry.season,
        tableId,
        source: doc.source,
        rows: parsed.length
      });
      return parsed;
    }
  }

  return [];
}

// ─── DB operations ───────────────────────────────────────────────────────────

function ensureCompetition(db, code) {
  const name = code === "CL" ? "UEFA Champions League" : "UEFA Europa League";
  db.prepare(`
    INSERT OR IGNORE INTO competitions (code, name, sport_key, last_synced_at)
    VALUES (?, ?, '', datetime('now'))
  `).run(code, name);
}

const teamIdCache = new Map();

function upsertTeam(db, normalizedName, displayName) {
  if (teamIdCache.has(normalizedName)) return teamIdCache.get(normalizedName);

  const existing = db.prepare(
    "SELECT id FROM teams WHERE lower(name) = lower(?)"
  ).get(displayName);

  if (existing) {
    teamIdCache.set(normalizedName, existing.id);
    return existing.id;
  }

  // Try normalized name match
  const all = db.prepare("SELECT id, name FROM teams").all();
  const fuzzy = all.find((t) => normalizeName(t.name) === normalizedName);
  if (fuzzy) {
    teamIdCache.set(normalizedName, fuzzy.id);
    return fuzzy.id;
  }

  const row = db.prepare(`
    INSERT INTO teams (source_team_id, name, short_name, tla, crest, created_at, updated_at)
    VALUES (NULL, ?, ?, ?, NULL, datetime('now'), datetime('now'))
    RETURNING id
  `).get(displayName, displayName, displayName.slice(0, 3).toUpperCase());

  teamIdCache.set(normalizedName, row.id);
  return row.id;
}

function matchExists(db, homeId, awayId, dateStr) {
  return db.prepare(`
    SELECT id FROM matches
    WHERE home_team_id = ? AND away_team_id = ?
      AND date(utc_date) = date(?)
  `).get(homeId, awayId, dateStr);
}

function upsertMatch(db, fixture, homeId, awayId) {
  const existing = matchExists(db, homeId, awayId, fixture.matchDate);

  if (existing) {
    // Update score/status if now finished and wasn't before
    if (fixture.status === "FINISHED" && fixture.homeScore !== null) {
      db.prepare(`
        UPDATE matches
        SET status = 'FINISHED',
            home_score = ?,
            away_score = ?,
            winner = ?,
            last_synced_at = datetime('now')
        WHERE id = ? AND (status != 'FINISHED' OR home_score IS NULL)
      `).run(
        fixture.homeScore,
        fixture.awayScore,
        fixture.homeScore > fixture.awayScore ? "HOME_TEAM" :
        fixture.homeScore < fixture.awayScore ? "AWAY_TEAM" : "DRAW",
        existing.id
      );
    }
    return { id: existing.id, created: false };
  }

  const winner = fixture.homeScore !== null
    ? (fixture.homeScore > fixture.awayScore ? "HOME_TEAM" :
       fixture.homeScore < fixture.awayScore ? "AWAY_TEAM" : "DRAW")
    : null;

  const row = db.prepare(`
    INSERT INTO matches
      (source_match_id, competition_code, season, utc_date, status,
       matchday, stage, home_team_id, away_team_id,
       home_score, away_score, winner, last_synced_at)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    RETURNING id
  `).get(
    fixture.compCode,
    fixture.season,
    fixture.utcDate,
    fixture.status,
    fixture.matchday,
    fixture.stage,
    homeId,
    awayId,
    fixture.homeScore,
    fixture.awayScore,
    winner
  );

  return { id: row.id, created: true };
}

// ─── Export ──────────────────────────────────────────────────────────────────

export async function importFbrefMatches({ competitionCodes = ["CL", "EL"], seasons = null } = {}) {
  const db = getDb();
  teamIdCache.clear();

  for (const code of competitionCodes) {
    ensureCompetition(db, code);
  }

  const entries = COMPETITION_URLS.filter((entry) => {
    if (!competitionCodes.includes(entry.compCode)) return false;
    if (seasons && entry.season && !seasons.includes(entry.season)) return false;
    return true;
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let fetchErrors = 0;
  const byCompetition = {};

  for (const entry of entries) {
    let rows;
    try {
      rows = await fetchScheduleRows(entry);
    } catch (err) {
      logger.warn("fbref fetch failed", { url: entry.scheduleUrl, message: err.message });
      fetchErrors++;
      continue;
    }

    if (!rows.length) {
      logger.info("fbref: no rows", { url: entry.scheduleUrl });
      continue;
    }

    const insertTx = db.transaction(() => {
      for (const fixture of rows) {
        if (!fixture.homeTeam || !fixture.awayTeam) { skipped++; continue; }

        const homeId = upsertTeam(db, fixture.normalizedHome, fixture.homeTeam);
        const awayId = upsertTeam(db, fixture.normalizedAway, fixture.awayTeam);

        const result = upsertMatch(db, fixture, homeId, awayId);

        if (result.created) {
          created++;
          byCompetition[fixture.compCode] = (byCompetition[fixture.compCode] ?? 0) + 1;
        } else if (!result.created) {
          updated++;
        }
      }
    });

    insertTx();

    logger.info("fbref schedule imported", {
      compCode: entry.compCode,
      season: entry.season ?? "current",
      rows: rows.length
    });

    // Polite delay between requests
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  const counts = db.prepare(`
    SELECT competition_code, status, COUNT(*) AS c
    FROM matches WHERE competition_code IN ('CL','EL')
    GROUP BY competition_code, status
  `).all();

  const summary = {
    created,
    updated,
    skipped,
    fetchErrors,
    byCompetition,
    totals: Object.fromEntries(
      counts.map((r) => [`${r.competition_code}:${r.status}`, r.c])
    )
  };

  logger.info("fbref match import complete", summary);
  return summary;
}
