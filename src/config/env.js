import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  PORT: "3000",
  DB_PATH: "./data/ucl-uel-betting.sqlite",
  FOOTBALL_DATA_BASE_URL: "https://api.football-data.org/v4",
  API_FOOTBALL_BASE_URL: "https://v3.football.api-sports.io",
  SPORTMONKS_BASE_URL: "https://api.sportmonks.com/v3/football",
  ODDS_BASE_URL: "https://api.the-odds-api.com/v4",
  ODDS_REGIONS: "eu,uk",
  PRIMARY_BOOKMAKER: "bet365",
  HISTORY_COMPETITION_CODES: "PL,PD,BL1,SA,FL1",
  PUBLIC_SOURCE_SEEDS_PATH: "./data/public-source-seeds.json",
  ADVANCED_STATS_IMPORT_PATH: "./data/advanced-stats",
  HISTORICAL_ODDS_IMPORT_PATH: "./data/historical-odds",
  ODDS_LOCAL_FEED_PATH: "./data/odds-feeds",
  HISTORICAL_SOURCE_DUMPS_PATH: "./data/source-dumps",
  EMAIL_PROVIDER: "",
  EMAIL_FROM: "",
  EMAIL_TO: "",
  SMTP_HOST: "",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  ENABLE_BACKGROUND_JOBS: "true",
  COLLECTOR_INTERVAL_MINUTES: "30",
  REMINDER_INTERVAL_MINUTES: "10",
  TRAINING_INTERVAL_HOURS: "24",
  SYNC_ON_START: "false",
  AUTO_SYNC_STALE_MINUTES: "120",
  AUTO_SYNC_LOOKAHEAD_HOURS: "168"
};

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const contents = fs.readFileSync(envPath, "utf8");

  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^"(.*)"$/u, "$1");

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function toBoolean(value) {
  return String(value).toLowerCase() === "true";
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

loadDotEnv();

const raw = { ...DEFAULTS, ...process.env };

export const env = {
  port: toNumber(raw.PORT, 3000),
  dbPath: path.resolve(process.cwd(), raw.DB_PATH),
  footballDataApiKey: raw.FOOTBALL_DATA_API_KEY ?? "",
  footballDataBaseUrl: raw.FOOTBALL_DATA_BASE_URL,
  apiFootballApiKey: raw.API_FOOTBALL_API_KEY ?? "",
  apiFootballBaseUrl: raw.API_FOOTBALL_BASE_URL,
  sportmonksApiKey: raw.SPORTMONKS_API_KEY ?? "",
  sportmonksBaseUrl: raw.SPORTMONKS_BASE_URL,
  oddsApiKey: raw.ODDS_API_KEY ?? "",
  oddsBaseUrl: raw.ODDS_BASE_URL,
  oddsRegions: raw.ODDS_REGIONS.split(",").map((item) => item.trim()).filter(Boolean),
  primaryBookmaker: raw.PRIMARY_BOOKMAKER,
  historyCompetitionCodes: raw.HISTORY_COMPETITION_CODES.split(",").map((item) => item.trim()).filter(Boolean),
  publicSourceSeedsPath: path.resolve(process.cwd(), raw.PUBLIC_SOURCE_SEEDS_PATH),
  advancedStatsImportPath: path.resolve(process.cwd(), raw.ADVANCED_STATS_IMPORT_PATH),
  historicalOddsImportPath: path.resolve(process.cwd(), raw.HISTORICAL_ODDS_IMPORT_PATH),
  oddsLocalFeedPath: path.resolve(process.cwd(), raw.ODDS_LOCAL_FEED_PATH),
  historicalSourceDumpsPath: path.resolve(process.cwd(), raw.HISTORICAL_SOURCE_DUMPS_PATH),
  emailProvider: raw.EMAIL_PROVIDER?.trim() ?? "",
  emailFrom: raw.EMAIL_FROM?.trim() ?? "",
  emailTo: raw.EMAIL_TO?.trim() ?? "",
  smtpHost: raw.SMTP_HOST?.trim() ?? "",
  smtpPort: toNumber(raw.SMTP_PORT, 587),
  smtpSecure: toBoolean(raw.SMTP_SECURE),
  smtpUser: raw.SMTP_USER?.trim() ?? "",
  smtpPassword: raw.SMTP_PASSWORD ?? "",
  enableBackgroundJobs: toBoolean(raw.ENABLE_BACKGROUND_JOBS),
  collectorIntervalMinutes: toNumber(raw.COLLECTOR_INTERVAL_MINUTES, 720),
  reminderIntervalMinutes: toNumber(raw.REMINDER_INTERVAL_MINUTES, 30),
  trainingIntervalHours: toNumber(raw.TRAINING_INTERVAL_HOURS, 24),
  syncOnStart: toBoolean(raw.SYNC_ON_START),
  autoSyncStaleMinutes: toNumber(raw.AUTO_SYNC_STALE_MINUTES, 120),
  autoSyncLookaheadHours: toNumber(raw.AUTO_SYNC_LOOKAHEAD_HOURS, 168)
};

export function hasFootballDataConfig() {
  return Boolean(env.footballDataApiKey);
}

export function hasApiFootballConfig() {
  return Boolean(env.apiFootballApiKey);
}

export function hasSportmonksConfig() {
  return Boolean(env.sportmonksApiKey);
}

export function hasOddsConfig() {
  return Boolean(env.oddsApiKey);
}

export function hasEmailConfig() {
  return env.emailProvider === "smtp" &&
    Boolean(env.emailFrom) &&
    Boolean(env.emailTo) &&
    Boolean(env.smtpHost) &&
    Boolean(env.smtpUser) &&
    Boolean(env.smtpPassword);
}
