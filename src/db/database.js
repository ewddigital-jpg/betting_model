import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "../config/env.js";
import { SUPPORTED_COMPETITIONS } from "../config/leagues.js";
import { logger } from "../lib/logger.js";
import { isoNow } from "../lib/time.js";
import { SCHEMA_SQL } from "./schema.js";

let database;

function shouldSkipDbMaintenance(rawValue = process.env.DB_SKIP_MAINTENANCE) {
  return String(rawValue ?? "").toLowerCase() === "true";
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    try {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    } catch (error) {
      if (!String(error.message ?? "").includes("duplicate column name")) {
        throw error;
      }
    }
  }
}

function runMigrations(db) {
  ensureColumn(db, "recommendation_snapshots", "settled_at", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "outcome_label", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "bet_result", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "is_correct", "INTEGER");
  ensureColumn(db, "recommendation_snapshots", "roi", "REAL");
  ensureColumn(db, "recommendation_snapshots", "grade_note", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "odds_at_prediction", "REAL");
  ensureColumn(db, "recommendation_snapshots", "odds_snapshot_at", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "odds_freshness_minutes", "REAL");
  ensureColumn(db, "recommendation_snapshots", "odds_freshness_score", "REAL");
  ensureColumn(db, "recommendation_snapshots", "odds_refreshed_recently", "INTEGER");
  ensureColumn(db, "recommendation_snapshots", "odds_coverage_status", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "bookmaker_count", "INTEGER");
  ensureColumn(db, "recommendation_snapshots", "stale_odds_flag", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recommendation_snapshots", "quota_degraded_flag", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recommendation_snapshots", "data_completeness_score", "REAL");
  ensureColumn(db, "recommendation_snapshots", "board_provider", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "board_source_label", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "board_source_mode", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "source_reliability_score", "REAL");
  ensureColumn(db, "recommendation_snapshots", "board_quality_tier", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "board_quality_score", "REAL");
  ensureColumn(db, "recommendation_snapshots", "fallback_used_flag", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recommendation_snapshots", "price_quality_status", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "price_trustworthy_flag", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recommendation_snapshots", "price_block_reasons_json", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "recommendation_downgrade_reason", "TEXT");
  ensureColumn(db, "recommendation_snapshots", "market_probability", "REAL");
  ensureColumn(db, "recommendation_snapshots", "opening_odds", "REAL");
  ensureColumn(db, "recommendation_snapshots", "closing_odds", "REAL");
  ensureColumn(db, "recommendation_snapshots", "closing_line_value", "REAL");
  ensureColumn(db, "odds_snapshots", "source_provider", "TEXT");
  ensureColumn(db, "odds_snapshots", "source_label", "TEXT");
  ensureColumn(db, "odds_quote_history", "source_provider", "TEXT");
  ensureColumn(db, "odds_quote_history", "source_label", "TEXT");
  ensureColumn(db, "odds_market_boards", "source_label", "TEXT");
  ensureColumn(db, "odds_market_boards", "source_reliability_score", "REAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS odds_quote_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER,
      match_id INTEGER NOT NULL,
      bookmaker_key TEXT NOT NULL,
      bookmaker_title TEXT NOT NULL,
      source_provider TEXT,
      source_label TEXT,
      market TEXT NOT NULL,
      outcome_key TEXT NOT NULL,
      odds REAL NOT NULL,
      is_live INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES odds_snapshots(id),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE INDEX IF NOT EXISTS idx_odds_quote_history_match_time ON odds_quote_history(match_id, market, recorded_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_odds_quote_history_snapshot_outcome ON odds_quote_history(snapshot_id, outcome_key);
    CREATE TABLE IF NOT EXISTS team_match_advanced_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      source_provider TEXT NOT NULL,
      xg REAL,
      xga REAL,
      shots INTEGER,
      shots_on_target INTEGER,
      big_chances INTEGER,
      possession REAL,
      extracted_at TEXT NOT NULL,
      UNIQUE(match_id, team_id, source_provider),
      FOREIGN KEY (match_id) REFERENCES matches(id),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );
    CREATE INDEX IF NOT EXISTS idx_team_match_advanced_stats_match_team ON team_match_advanced_stats(match_id, team_id, extracted_at DESC);
    CREATE TABLE IF NOT EXISTS historical_enrichment_repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_provider TEXT NOT NULL,
      competition_code TEXT,
      source_match_date TEXT,
      source_home_team TEXT,
      source_away_team TEXT,
      normalized_home TEXT,
      normalized_away TEXT,
      reason_code TEXT NOT NULL,
      reason_details TEXT,
      candidate_matches_json TEXT,
      raw_payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_historical_enrichment_repairs_lookup ON historical_enrichment_repairs(source_provider, competition_code, source_match_date);
    CREATE TABLE IF NOT EXISTS decision_policy_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trained_at TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      holdout_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'candidate',
      is_active INTEGER NOT NULL DEFAULT 0,
      train_roi REAL,
      holdout_roi REAL,
      train_hit_rate REAL,
      holdout_hit_rate REAL,
      improvement_vs_active REAL,
      policies_json TEXT NOT NULL,
      summary_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decision_policy_sets_active ON decision_policy_sets(is_active, trained_at DESC);
    CREATE TABLE IF NOT EXISTS reminder_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      kickoff_time TEXT NOT NULL,
      recipient TEXT NOT NULL,
      channel TEXT NOT NULL,
      market_name TEXT NOT NULL,
      selection_label TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      message_id TEXT,
      error_message TEXT,
      summary_json TEXT NOT NULL,
      UNIQUE(match_id, kickoff_time, recipient, channel, market_name, selection_label),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE INDEX IF NOT EXISTS idx_reminder_notifications_match_time ON reminder_notifications(match_id, sent_at DESC);
    CREATE TABLE IF NOT EXISTS system_metric_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      competition_code TEXT,
      generated_at TEXT NOT NULL,
      trust_percent REAL,
      blind_brier_avg REAL,
      blind_modeled_matches INTEGER NOT NULL DEFAULT 0,
      forward_tracked_matches INTEGER NOT NULL DEFAULT 0,
      forward_settled_bets INTEGER NOT NULL DEFAULT 0,
      upcoming_matches INTEGER NOT NULL DEFAULT 0,
      upcoming_with_odds INTEGER NOT NULL DEFAULT 0,
      likely_lineups INTEGER NOT NULL DEFAULT 0,
      confirmed_lineups INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_system_metric_snapshots_scope ON system_metric_snapshots(scope, competition_code, generated_at DESC);
    CREATE TABLE IF NOT EXISTS team_news_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER,
      team_id INTEGER,
      provider TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      url TEXT NOT NULL,
      published_at TEXT,
      relevance_score REAL NOT NULL DEFAULT 0.5,
      extracted_at TEXT NOT NULL,
      UNIQUE(provider, url),
      FOREIGN KEY (match_id) REFERENCES matches(id),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );
    CREATE INDEX IF NOT EXISTS idx_team_news_records_match_team ON team_news_records(match_id, team_id, published_at DESC);
    CREATE TABLE IF NOT EXISTS odds_market_boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      market TEXT NOT NULL,
      source_provider TEXT NOT NULL,
      source_label TEXT,
      source_mode TEXT NOT NULL,
      source_reliability_score REAL,
      board_quality_tier TEXT NOT NULL,
      board_quality_score REAL NOT NULL,
      bookmaker_count INTEGER NOT NULL DEFAULT 0,
      freshness_minutes REAL,
      completeness_score REAL,
      implied_consistency_score REAL,
      quota_degraded_flag INTEGER NOT NULL DEFAULT 0,
      board_recorded_at TEXT,
      board_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(match_id, market, source_mode),
      FOREIGN KEY (match_id) REFERENCES matches(id)
    );
    CREATE INDEX IF NOT EXISTS idx_odds_market_boards_lookup ON odds_market_boards(match_id, market, source_mode, updated_at DESC);
    CREATE TABLE IF NOT EXISTS odds_source_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      competition_code TEXT NOT NULL,
      sport_key TEXT,
      source_label TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      expires_at TEXT,
      request_status TEXT NOT NULL,
      error_message TEXT,
      UNIQUE(provider, competition_code)
    );
    CREATE INDEX IF NOT EXISTS idx_odds_source_cache_lookup ON odds_source_cache(competition_code, fetched_at DESC);
  `);
}

function backfillOddsQuoteHistory(db) {
  db.exec(`
    INSERT OR IGNORE INTO odds_quote_history (
      snapshot_id, match_id, bookmaker_key, bookmaker_title, source_provider, source_label, market, outcome_key, odds, is_live, recorded_at
    )
    SELECT id, match_id, bookmaker_key, bookmaker_title, source_provider, source_label, market, 'home', home_price, is_live, retrieved_at
    FROM odds_snapshots
    WHERE home_price IS NOT NULL;

    INSERT OR IGNORE INTO odds_quote_history (
      snapshot_id, match_id, bookmaker_key, bookmaker_title, source_provider, source_label, market, outcome_key, odds, is_live, recorded_at
    )
    SELECT id, match_id, bookmaker_key, bookmaker_title, source_provider, source_label, market, 'draw', draw_price, is_live, retrieved_at
    FROM odds_snapshots
    WHERE draw_price IS NOT NULL;

    INSERT OR IGNORE INTO odds_quote_history (
      snapshot_id, match_id, bookmaker_key, bookmaker_title, source_provider, source_label, market, outcome_key, odds, is_live, recorded_at
    )
    SELECT id, match_id, bookmaker_key, bookmaker_title, source_provider, source_label, market, 'away', away_price, is_live, retrieved_at
    FROM odds_snapshots
    WHERE away_price IS NOT NULL;
  `);
}

function normalizeTeamName(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\b(fc|cf|sc|afc|club|the|de|da|do|di)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isCloseNameMatch(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftTokens = left.split(" ").filter(Boolean);
  const rightTokens = right.split(" ").filter(Boolean);
  const sharedTokens = leftTokens.filter((token) => rightTokens.includes(token));

  return sharedTokens.length >= 2 && sharedTokens.length >= Math.min(leftTokens.length, rightTokens.length) - 1;
}

function findExistingTeamByIdentity(db, team) {
  const normalizedNames = [
    normalizeTeamName(team.name),
    normalizeTeamName(team.shortName)
  ].filter((value) => value && value.length >= 4);
  const normalizedTla = String(team.tla ?? "").trim().toUpperCase();
  const teams = db.prepare("SELECT id, name, short_name, tla FROM teams").all();

  return teams.find((candidate) => {
    const candidateNames = [
      normalizeTeamName(candidate.name),
      normalizeTeamName(candidate.short_name)
    ].filter(Boolean);

    if (normalizedTla && candidate.tla && candidate.tla.toUpperCase() === normalizedTla) {
      return true;
    }

    return normalizedNames.some((name) =>
      candidateNames.some((candidateName) => isCloseNameMatch(name, candidateName))
    );
  });
}

function ensureDirectory(filePath) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
}

export function getDb() {
  if (database) {
    return database;
  }

  ensureDirectory(env.dbPath);
  database = new DatabaseSync(env.dbPath);
  database.exec("PRAGMA busy_timeout = 5000;");
  const skipMaintenance = shouldSkipDbMaintenance();

  if (!skipMaintenance) {
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(SCHEMA_SQL);
    runMigrations(database);
    backfillOddsQuoteHistory(database);

    const competitionCount = database.prepare("SELECT COUNT(*) AS count FROM competitions").get().count;

    if (competitionCount === 0) {
      const insertCompetition = database.prepare(`
        INSERT OR IGNORE INTO competitions (code, name, sport_key, last_synced_at)
        VALUES (?, ?, ?, NULL)
      `);

      for (const competition of SUPPORTED_COMPETITIONS) {
        insertCompetition.run(competition.code, competition.name, competition.sportKey);
      }
    }
  }

  logger.info("Database initialized", {
    dbPath: env.dbPath,
    skipMaintenance
  });
  return database;
}

export const __databaseTestables = {
  shouldSkipDbMaintenance
};

export function withTransaction(callback) {
  const db = getDb();
  db.exec("BEGIN");

  try {
    const result = callback(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function upsertTeam(team) {
  const db = getDb();
  const now = isoNow();
  const readBySource = db.prepare("SELECT id FROM teams WHERE source_team_id = ?");
  const insertStatement = db.prepare(`
    INSERT INTO teams (source_team_id, name, short_name, tla, crest, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_team_id) DO UPDATE SET
      name = excluded.name,
      short_name = excluded.short_name,
      tla = excluded.tla,
      crest = excluded.crest,
      updated_at = excluded.updated_at
    RETURNING id
  `);
  const updateById = db.prepare(`
    UPDATE teams
    SET name = ?, short_name = ?, tla = ?, crest = ?, updated_at = ?
    WHERE id = ?
  `);
  const existingBySource = readBySource.get(team.id);

  if (existingBySource) {
    updateById.run(
      team.name,
      team.shortName ?? null,
      team.tla ?? null,
      team.crest ?? null,
      now,
      existingBySource.id
    );
    return existingBySource.id;
  }

  const existingByIdentity = findExistingTeamByIdentity(db, team);

  if (existingByIdentity) {
    updateById.run(
      team.name,
      team.shortName ?? null,
      team.tla ?? null,
      team.crest ?? null,
      now,
      existingByIdentity.id
    );
    return existingByIdentity.id;
  }

  return insertStatement.get(
    team.id,
    team.name,
    team.shortName ?? null,
    team.tla ?? null,
    team.crest ?? null,
    now,
    now
  ).id;
}

export function getCompetitionSyncState(code) {
  const db = getDb();
  return db.prepare("SELECT * FROM competitions WHERE code = ?").get(code);
}

export function setCompetitionSyncState(code, timestamp) {
  const db = getDb();
  db.prepare("UPDATE competitions SET last_synced_at = ? WHERE code = ?").run(timestamp, code);
}
