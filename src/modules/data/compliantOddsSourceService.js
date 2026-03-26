import fs from "node:fs";
import path from "node:path";
import { env, hasOddsConfig } from "../../config/env.js";
import { hasCompetitionLiveOddsPath } from "../../config/leagues.js";
import { getDb } from "../../db/database.js";
import { logger } from "../../lib/logger.js";
import { isoNow } from "../../lib/time.js";
import { fetchLeagueOdds, fetchTrackedOdds } from "./oddsApiClient.js";

const SUPPORTED_MARKETS = new Set(["h2h", "totals_2_5", "btts"]);

function sourceReliabilityScore(provider, sourceMode = "live") {
  if (provider === "odds-api" && sourceMode === "live") {
    return 0.94;
  }

  if (provider === "odds-api" && sourceMode === "cache") {
    return 0.84;
  }

  if (provider === "sportmonks-odds" && sourceMode === "live") {
    return 0.92;
  }

  if (provider === "local-export" || sourceMode === "licensed-import") {
    return 0.87;
  }

  if (provider === "trusted-cache") {
    return 0.72;
  }

  return 0;
}

function annotateEvents(events, provider, sourceLabel, sourceMode = "live") {
  const reliability = sourceReliabilityScore(provider, sourceMode);

  return (events ?? []).map((event) => ({
    ...event,
    bookmakers: (event.bookmakers ?? []).map((bookmaker) => ({
      ...bookmaker,
      source_provider: provider,
      source_label: sourceLabel,
      source_mode: sourceMode,
      source_reliability_score: reliability
    }))
  }));
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

function eventMergeKey(event) {
  return [
    new Date(event.commence_time).toISOString(),
    normalizeName(event.home_team),
    normalizeName(event.away_team)
  ].join("|");
}

function mergeOddsEvents(sourceEvents) {
  const merged = new Map();

  for (const event of sourceEvents.flatMap((entry) => entry ?? [])) {
    const key = eventMergeKey(event);
    const current = merged.get(key) ?? {
      ...event,
      bookmakers: []
    };
    const bookmakerMap = new Map(
      (current.bookmakers ?? []).map((bookmaker) => [
        [
          bookmaker.source_provider ?? "unknown",
          bookmaker.source_label ?? "",
          bookmaker.key,
          bookmaker.title
        ].join("|"),
        bookmaker
      ])
    );

    for (const bookmaker of event.bookmakers ?? []) {
      bookmakerMap.set(
        [
          bookmaker.source_provider ?? "unknown",
          bookmaker.source_label ?? "",
          bookmaker.key,
          bookmaker.title
        ].join("|"),
        bookmaker
      );
    }

    current.bookmakers = Array.from(bookmakerMap.values());
    merged.set(key, current);
  }

  return Array.from(merged.values());
}

function readNextKickoffHours(competitionCode) {
  const db = getDb();
  const row = db.prepare(`
    SELECT utc_date
    FROM matches
    WHERE competition_code = ?
      AND datetime(utc_date) >= datetime('now')
      AND datetime(utc_date) <= datetime('now', '+48 hours')
    ORDER BY datetime(utc_date) ASC
    LIMIT 1
  `).get(competitionCode);

  if (!row?.utc_date) {
    return null;
  }

  return Math.max(0, (new Date(row.utc_date).getTime() - Date.now()) / 3_600_000);
}

function readRelevantMatchDemand(competitionCode) {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN datetime(utc_date) >= datetime('now') AND datetime(utc_date) <= datetime('now', '+6 hours') THEN 1 ELSE 0 END) AS within_6h,
      SUM(CASE WHEN datetime(utc_date) >= datetime('now') AND datetime(utc_date) <= datetime('now', '+24 hours') THEN 1 ELSE 0 END) AS within_24h,
      SUM(CASE WHEN datetime(utc_date) >= datetime('now') AND datetime(utc_date) <= datetime('now', '+48 hours') THEN 1 ELSE 0 END) AS within_48h
    FROM matches
    WHERE competition_code = ?
      AND status != 'FINISHED'
      AND datetime(utc_date) >= datetime('now', '-30 minutes')
  `).get(competitionCode);

  return {
    within6Hours: Number(row?.within_6h ?? 0),
    within24Hours: Number(row?.within_24h ?? 0),
    within48Hours: Number(row?.within_48h ?? 0)
  };
}

function readTrackedMatches(competitionCode) {
  const db = getDb();
  return db.prepare(`
    SELECT
      matches.id,
      matches.utc_date,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE matches.competition_code = ?
      AND matches.status != 'FINISHED'
      AND datetime(matches.utc_date) >= datetime('now', '-30 minutes')
      AND datetime(matches.utc_date) <= datetime('now', '+48 hours')
    ORDER BY datetime(matches.utc_date) ASC
  `).all(competitionCode).map((row) => ({
    matchId: row.id,
    kickoffTime: row.utc_date,
    homeTeam: row.home_team_name,
    awayTeam: row.away_team_name
  }));
}

function refreshWindowMinutes(nextKickoffHours) {
  if (nextKickoffHours === null) {
    return 60;
  }

  if (nextKickoffHours <= 1) {
    return 2;
  }

  if (nextKickoffHours <= 2) {
    return 4;
  }

  if (nextKickoffHours <= 3) {
    return 8;
  }

  if (nextKickoffHours <= 6) {
    return 15;
  }

  if (nextKickoffHours <= 24) {
    return 30;
  }

  return 60;
}

function addMinutes(timestamp, minutes) {
  return new Date(new Date(timestamp).getTime() + (minutes * 60_000)).toISOString();
}

function readProviderCache(provider, competitionCode, now = isoNow()) {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM odds_source_cache
    WHERE provider = ?
      AND competition_code = ?
    ORDER BY datetime(fetched_at) DESC, id DESC
    LIMIT 1
  `).get(provider, competitionCode);

  if (!row) {
    return null;
  }

  return {
    ...row,
    payload: JSON.parse(row.payload_json),
    isFresh: row.expires_at ? new Date(row.expires_at).getTime() >= new Date(now).getTime() : false
  };
}

function isUsableFreshCache(entry) {
  return Boolean(entry) &&
    entry.isFresh &&
    entry.request_status === "success" &&
    Array.isArray(entry.payload) &&
    entry.payload.length > 0;
}

function readAnyFreshCache(competitionCode, now = isoNow()) {
  const candidates = [
    readProviderCache("odds-api", competitionCode, now),
    readProviderCache("sportmonks-odds", competitionCode, now),
    readProviderCache("local-export", competitionCode, now)
  ].filter(Boolean);

  const fresh = candidates
    .filter((entry) => isUsableFreshCache(entry))
    .sort((left, right) => new Date(right.fetched_at).getTime() - new Date(left.fetched_at).getTime());

  return fresh[0] ?? null;
}

function readLatestCache(competitionCode) {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM odds_source_cache
    WHERE competition_code = ?
    ORDER BY datetime(fetched_at) DESC, id DESC
    LIMIT 1
  `).get(competitionCode);

  if (!row) {
    return null;
  }

  return {
    ...row,
    payload: JSON.parse(row.payload_json)
  };
}

function writeProviderCache({
  provider,
  competitionCode,
  sportKey,
  sourceLabel,
  payload,
  fetchedAt = isoNow(),
  refreshMinutes,
  requestStatus,
  errorMessage = null
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO odds_source_cache (
      provider, competition_code, sport_key, source_label, payload_json,
      fetched_at, expires_at, request_status, error_message
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, competition_code) DO UPDATE SET
      sport_key = excluded.sport_key,
      source_label = excluded.source_label,
      payload_json = excluded.payload_json,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at,
      request_status = excluded.request_status,
      error_message = excluded.error_message
  `).run(
    provider,
    competitionCode,
    sportKey ?? null,
    sourceLabel,
    JSON.stringify(payload),
    fetchedAt,
    addMinutes(fetchedAt, refreshMinutes),
    requestStatus,
    errorMessage
  );
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function parseCsv(contents) {
  const lines = contents.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);

  if (lines.length <= 1) {
    return [];
  }

  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return header.reduce((row, key, index) => {
      row[key] = cells[index] ?? "";
      return row;
    }, {});
  });
}

function normalizeCsvMarket(value) {
  const key = String(value ?? "").toLowerCase().trim();

  if (["h2h", "1x2", "match_winner"].includes(key)) {
    return "h2h";
  }

  if (["totals_2_5", "ou25", "over_under_2_5", "totals"].includes(key)) {
    return "totals_2_5";
  }

  if (["btts", "both_teams_to_score"].includes(key)) {
    return "btts";
  }

  return null;
}

function normalizeCsvSelection(selection, market, homeTeam, awayTeam) {
  const normalized = String(selection ?? "").toLowerCase().trim();

  if (market === "h2h") {
    if (normalized === "home") {
      return homeTeam;
    }

    if (normalized === "away") {
      return awayTeam;
    }

    if (normalized === "draw") {
      return "Draw";
    }

    return selection;
  }

  if (market === "totals_2_5") {
    if (normalized === "over" || normalized.startsWith("over ")) {
      return "Over";
    }

    if (normalized === "under" || normalized.startsWith("under ")) {
      return "Under";
    }
  }

  if (market === "btts") {
    if (normalized === "yes") {
      return "Yes";
    }

    if (normalized === "no") {
      return "No";
    }
  }

  return selection;
}

export const __compliantOddsTestables = {
  normalizeCsvMarket,
  normalizeCsvSelection,
  isUsableFreshCache,
  buildLiveOddsDemandContext
};

function buildLiveOddsDemandContext(competition) {
  if (!hasCompetitionLiveOddsPath(competition)) {
    return {
      liveOddsEnabled: false,
      demand: {
        within6Hours: 0,
        within24Hours: 0,
        within48Hours: 0
      },
      trackedMatches: []
    };
  }

  return {
    liveOddsEnabled: true,
    demand: readRelevantMatchDemand(competition.code),
    trackedMatches: readTrackedMatches(competition.code)
  };
}

function toOddsApiEventsFromRows(rows, sourceLabel, defaultSportKey = "") {
  const groupedEvents = new Map();

  for (const row of rows) {
    const market = normalizeCsvMarket(row.market ?? row.market_key);
    if (!SUPPORTED_MARKETS.has(market)) {
      continue;
    }

    const homeTeam = row.home_team ?? row.homeTeam;
    const awayTeam = row.away_team ?? row.awayTeam;
    const commenceTime = row.commence_time ?? row.kickoff_time ?? row.timestamp;
    const bookmakerKey = row.bookmaker_key ?? row.bookmaker ?? "local-export";
    const bookmakerTitle = row.bookmaker_title ?? row.bookmaker ?? bookmakerKey;
    const price = Number(row.odds ?? row.price);

    if (!homeTeam || !awayTeam || !commenceTime || !Number.isFinite(price)) {
      continue;
    }

    const eventKey = `${commenceTime}|${homeTeam}|${awayTeam}`;
    const bookmakerMap = groupedEvents.get(eventKey) ?? new Map();
    const bookmakerEntry = bookmakerMap.get(bookmakerKey) ?? {
      key: bookmakerKey,
      title: bookmakerTitle,
      last_update: row.last_update ?? row.timestamp ?? isoNow(),
      markets: new Map()
    };
    const marketEntry = bookmakerEntry.markets.get(market) ?? {
      key: market === "totals_2_5" ? "totals" : market,
      outcomes: []
    };
    const selectionName = normalizeCsvSelection(
      row.selection ?? row.outcome_key ?? row.outcome,
      market,
      homeTeam,
      awayTeam
    );

    if (!selectionName) {
      continue;
    }

    marketEntry.outcomes.push({
      name: selectionName,
      price,
      point: market === "totals_2_5" ? 2.5 : undefined
    });
    bookmakerEntry.markets.set(market, marketEntry);
    bookmakerMap.set(bookmakerKey, bookmakerEntry);
    groupedEvents.set(eventKey, bookmakerMap);
  }

  return Array.from(groupedEvents.entries()).map(([eventKey, bookmakerMap]) => {
    const [commenceTime, homeTeam, awayTeam] = eventKey.split("|");
    return {
      id: `${sourceLabel}:${eventKey}`,
      sport_key: defaultSportKey,
      commence_time: commenceTime,
      home_team: homeTeam,
      away_team: awayTeam,
      bookmakers: Array.from(bookmakerMap.values()).map((bookmaker) => ({
        key: bookmaker.key,
        title: bookmaker.title,
        last_update: bookmaker.last_update,
        markets: Array.from(bookmaker.markets.values())
      }))
    };
  });
}

function parseLocalFeedFile(filePath, competition) {
  const extension = path.extname(filePath).toLowerCase();
  const contents = fs.readFileSync(filePath, "utf8");

  if (extension === ".json") {
    const parsed = JSON.parse(contents);

    if (Array.isArray(parsed) && parsed.every((item) => item?.home_team && item?.away_team && item?.bookmakers)) {
      return annotateEvents(parsed, "local-export", path.basename(filePath), "licensed-import");
    }

    if (Array.isArray(parsed)) {
      return annotateEvents(
        toOddsApiEventsFromRows(parsed, path.basename(filePath), competition.sportKey),
        "local-export",
        path.basename(filePath),
        "licensed-import"
      );
    }

    if (Array.isArray(parsed?.rows)) {
      return annotateEvents(
        toOddsApiEventsFromRows(parsed.rows, path.basename(filePath), competition.sportKey),
        "local-export",
        path.basename(filePath),
        "licensed-import"
      );
    }

    return [];
  }

  if (extension === ".csv") {
    return annotateEvents(
      toOddsApiEventsFromRows(parseCsv(contents), path.basename(filePath), competition.sportKey),
      "local-export",
      path.basename(filePath),
      "licensed-import"
    );
  }

  return [];
}

function readLocalFeedEvents(competition) {
  if (!fs.existsSync(env.oddsLocalFeedPath)) {
    return {
      sourceLabel: null,
      events: []
    };
  }

  const files = fs.readdirSync(env.oddsLocalFeedPath)
    .filter((entry) => /\.(csv|json)$/iu.test(entry))
    .map((entry) => path.join(env.oddsLocalFeedPath, entry));
  const matchingFiles = files.filter((filePath) => {
    const filename = path.basename(filePath).toLowerCase();
    return filename.includes(competition.code.toLowerCase()) || filename.includes(String(competition.sportKey ?? "").toLowerCase());
  });

  const matchedFiles = [];
  const eventSets = [];

  for (const filePath of matchingFiles) {
    const events = parseLocalFeedFile(filePath, competition);
    if (events.length) {
      matchedFiles.push(path.basename(filePath));
      eventSets.push(events);
    }
  }

  return {
    sourceLabel: matchedFiles.length ? matchedFiles.join(", ") : null,
    files: matchedFiles,
    events: mergeOddsEvents(eventSets)
  };
}

function buildDiagnostics({
  provider,
  sourceLabel,
  sourceMode,
  fallbackUsed = false,
  fallbackSource = null,
  quotaDegraded = false,
  fromCache = false,
  staleCache = false,
  requestIntervalMinutes,
  demand,
  trackedMatchCount = 0,
  requestStrategy = "competition-poll",
  providerChain,
  payload,
  error = null
}) {
  return {
    provider,
    sourceLabel,
    sourceMode,
    fallbackUsed,
    fallbackSource,
    quotaDegraded,
    fromCache,
    staleCache,
    requestIntervalMinutes,
    demand,
    trackedMatchCount,
    requestStrategy,
    providerChain,
    sourceReliabilityScore: sourceReliabilityScore(provider, sourceMode),
    error: error ? error.message : null,
    oddsEvents: Array.isArray(payload) ? payload.length : 0
  };
}

function isQuotaError(error) {
  const message = String(error?.message ?? "");
  return message.includes("OUT_OF_USAGE_CREDITS") || message.includes("Usage quota has been reached");
}

export async function fetchCompliantOddsBundle(competition, { force = false } = {}) {
  const now = isoNow();
  const demandContext = buildLiveOddsDemandContext(competition);
  const demand = demandContext.demand;
  const trackedMatches = demandContext.trackedMatches;
  const nextKickoffHours = readNextKickoffHours(competition.code);
  const requestIntervalMinutes = refreshWindowMinutes(nextKickoffHours);
  const providerChain = [
    { provider: "odds-api", mode: "live", ready: demandContext.liveOddsEnabled && hasOddsConfig() && Boolean(competition.sportKey) },
    { provider: "sportmonks-odds", mode: "integration-ready", ready: false },
    { provider: "local-export", mode: "licensed-import", ready: true },
    { provider: "trusted-cache", mode: "trusted-cache", ready: true }
  ];
  const freshCache = readAnyFreshCache(competition.code, now);

  if (freshCache) {
    return {
      oddsPayload: freshCache.payload,
      sourceBundles: [
        {
          provider: freshCache.provider,
          sourceLabel: freshCache.source_label,
          sourceMode: "cache",
          events: freshCache.payload
        }
      ],
      oddsDiagnostics: buildDiagnostics({
        provider: freshCache.provider,
        sourceLabel: freshCache.source_label,
        sourceMode: "cache",
        fromCache: true,
        requestIntervalMinutes,
        demand,
        trackedMatchCount: trackedMatches.length,
        requestStrategy: "cache-hit",
        providerChain,
        payload: freshCache.payload
      })
    };
  }

  if (!demandContext.liveOddsEnabled) {
    return {
      oddsPayload: [],
      oddsDiagnostics: buildDiagnostics({
        provider: "none",
        sourceLabel: null,
        sourceMode: "skipped",
        requestIntervalMinutes,
        demand,
        trackedMatchCount: 0,
        requestStrategy: "skipped-no-live-odds-path",
        providerChain,
        payload: [],
        error: null
      })
    };
  }

  if (demand.within48Hours === 0 && !force) {
    return {
      oddsPayload: [],
      oddsDiagnostics: buildDiagnostics({
        provider: "none",
        sourceLabel: null,
        sourceMode: "skipped",
        requestIntervalMinutes,
        demand,
        trackedMatchCount: trackedMatches.length,
        requestStrategy: "skipped-no-demand",
        providerChain,
        payload: [],
        error: null
      })
    };
  }

  let primaryError = null;
  const sourceBundles = [];

  if (hasOddsConfig() && competition.sportKey) {
    try {
      const officialPayload = trackedMatches.length && trackedMatches.length <= 4
        ? await fetchTrackedOdds(competition.sportKey, trackedMatches)
        : await fetchLeagueOdds(competition.sportKey);
      const requestStrategy = trackedMatches.length && trackedMatches.length <= 4
        ? "targeted-events"
        : "competition-poll";
      const oddsPayload = annotateEvents(officialPayload, "odds-api", "the-odds-api", "live");
      writeProviderCache({
        provider: "odds-api",
        competitionCode: competition.code,
        sportKey: competition.sportKey,
        sourceLabel: "the-odds-api",
        payload: oddsPayload,
        refreshMinutes: requestIntervalMinutes,
        requestStatus: "success"
      });
      sourceBundles.push({
        provider: "odds-api",
        sourceLabel: "the-odds-api",
        sourceMode: "live",
        events: oddsPayload
      });

      const localFeed = readLocalFeedEvents(competition);
      if (localFeed.events.length) {
        writeProviderCache({
          provider: "local-export",
          competitionCode: competition.code,
          sportKey: competition.sportKey,
          sourceLabel: localFeed.sourceLabel ?? "local-export",
          payload: localFeed.events,
          refreshMinutes: requestIntervalMinutes,
          requestStatus: "success"
        });
        sourceBundles.push({
          provider: "local-export",
          sourceLabel: localFeed.sourceLabel ?? "local-export",
          sourceMode: "licensed-import",
          events: localFeed.events
        });
      }

      return {
        oddsPayload: mergeOddsEvents(sourceBundles.map((bundle) => bundle.events)),
        sourceBundles,
        oddsDiagnostics: buildDiagnostics({
          provider: "odds-api",
          sourceLabel: "the-odds-api",
          sourceMode: "live",
          requestIntervalMinutes,
          demand,
          trackedMatchCount: trackedMatches.length,
          requestStrategy,
          providerChain,
          payload: mergeOddsEvents(sourceBundles.map((bundle) => bundle.events))
        })
      };
    } catch (error) {
      primaryError = error;
      writeProviderCache({
        provider: "odds-api",
        competitionCode: competition.code,
        sportKey: competition.sportKey,
        sourceLabel: "the-odds-api",
        payload: [],
        refreshMinutes: requestIntervalMinutes,
        requestStatus: "failed",
        errorMessage: error.message
      });
      logger.warn("Official odds API request failed", {
        competition: competition.code,
        message: error.message
      });
    }
  }

  const localFeed = readLocalFeedEvents(competition);
  if (localFeed.events.length) {
    writeProviderCache({
      provider: "local-export",
      competitionCode: competition.code,
      sportKey: competition.sportKey,
      sourceLabel: localFeed.sourceLabel ?? "local-export",
      payload: localFeed.events,
      refreshMinutes: requestIntervalMinutes,
      requestStatus: "success"
    });

    return {
      oddsPayload: localFeed.events,
      sourceBundles: [
        {
          provider: "local-export",
          sourceLabel: localFeed.sourceLabel ?? "local-export",
          sourceMode: "licensed-import",
          events: localFeed.events
        }
      ],
      oddsDiagnostics: buildDiagnostics({
        provider: "local-export",
        sourceLabel: localFeed.sourceLabel ?? "local-export",
        sourceMode: "licensed-import",
        fallbackUsed: Boolean(primaryError),
        fallbackSource: primaryError ? "local-export" : null,
        quotaDegraded: isQuotaError(primaryError),
        requestIntervalMinutes,
        demand,
        trackedMatchCount: trackedMatches.length,
        requestStrategy: "licensed-feed",
        providerChain,
        payload: localFeed.events,
        error: primaryError
      })
    };
  }

  const staleCache = readLatestCache(competition.code);
  if (staleCache?.payload?.length) {
    return {
      oddsPayload: staleCache.payload,
      sourceBundles: [
        {
          provider: staleCache.provider,
          sourceLabel: staleCache.source_label,
          sourceMode: "trusted-cache",
          events: staleCache.payload
        }
      ],
      oddsDiagnostics: buildDiagnostics({
        provider: "trusted-cache",
        sourceLabel: staleCache.source_label,
        sourceMode: "trusted-cache",
        fallbackUsed: true,
        fallbackSource: "trusted-cache",
        quotaDegraded: isQuotaError(primaryError),
        fromCache: true,
        staleCache: true,
        requestIntervalMinutes,
        demand,
        trackedMatchCount: trackedMatches.length,
        requestStrategy: "trusted-cache",
        providerChain,
        payload: staleCache.payload,
        error: primaryError
      })
    };
  }

  return {
    oddsPayload: [],
    sourceBundles: [],
    oddsDiagnostics: buildDiagnostics({
      provider: primaryError ? "none" : "none",
      sourceLabel: null,
      sourceMode: "none",
      fallbackUsed: false,
      fallbackSource: null,
      quotaDegraded: isQuotaError(primaryError),
      requestIntervalMinutes,
      demand,
      trackedMatchCount: trackedMatches.length,
      requestStrategy: "no-usable-source",
      providerChain,
      payload: [],
      error: primaryError
    })
  };
}
