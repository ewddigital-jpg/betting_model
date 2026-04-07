/**
 * sportmonksStatsImporter — backfills team_match_advanced_stats for historical
 * CL/EL matches sourced via Sportmonks.
 *
 * Sportmonks does not provide xG directly, so we estimate it from:
 *   xG ≈ shots_insidebox × 0.12 + shots_outsidebox × 0.03 + big_chances × 0.35
 *
 * Real shots, shots_on_target, big_chances and possession are stored verbatim.
 */

import { getDb } from "../../../db/database.js";
import { logger } from "../../../lib/logger.js";
import { hasSportmonksConfig } from "../../../config/env.js";
import { env } from "../../../config/env.js";

const SOURCE_PROVIDER = "sportmonks";
const SPORTMONKS_ID_OFFSET = 2_000_000_000;

// Sportmonks statistic type_ids
const TYPE = {
  SHOTS_TOTAL: 42,
  SHOTS_ON_TARGET: 86,
  SHOTS_INSIDEBOX: 49,
  SHOTS_OUTSIDEBOX: 50,
  SHOTS_BLOCKED: 58,
  BIG_CHANCES_CREATED: 580,
  BIG_CHANCES_MISSED: 581,
  POSSESSION: 45,
  DANGEROUS_ATTACKS: 44,
  KEY_PASSES: 117
};

function buildUrl(fixtureId) {
  const url = new URL(`${env.sportmonksBaseUrl}/fixtures/${fixtureId}`);
  url.searchParams.set("api_token", env.sportmonksApiKey);
  url.searchParams.set("include", "statistics;participants");
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statValue(statistics, typeId, location) {
  const stat = statistics.find((s) => s.type_id === typeId && s.location === location);
  return stat?.data?.value ?? null;
}

const XG_CAP = 4.0;

function estimateXg(shotsInside, shotsOutside, bigChances) {
  const inside = shotsInside ?? 0;
  const outside = shotsOutside ?? 0;
  const big = bigChances ?? 0;
  const estimate = inside * 0.12 + outside * 0.03 + big * 0.35;
  if (estimate <= 0) {
    return null;
  }
  // Cap at XG_CAP to avoid extreme outliers (e.g. 6-0 wins with many big chances)
  return Math.round(Math.min(estimate, XG_CAP) * 100) / 100;
}

function extractStats(statistics, participants, homeParticipantId) {
  const isHome = (stat) =>
    homeParticipantId
      ? stat.participant_id === homeParticipantId
      : stat.location === "home";

  const homeStat = (typeId) => {
    const s = statistics.find((s) => s.type_id === typeId && isHome(s));
    return s?.data?.value ?? null;
  };
  const awayStat = (typeId) => {
    const s = statistics.find((s) => s.type_id === typeId && !isHome(s));
    return s?.data?.value ?? null;
  };

  const homeInside = homeStat(TYPE.SHOTS_INSIDEBOX);
  const homeOutside = homeStat(TYPE.SHOTS_OUTSIDEBOX);
  const homeBig = homeStat(TYPE.BIG_CHANCES_CREATED);
  const awayInside = awayStat(TYPE.SHOTS_INSIDEBOX);
  const awayOutside = awayStat(TYPE.SHOTS_OUTSIDEBOX);
  const awayBig = awayStat(TYPE.BIG_CHANCES_CREATED);

  return {
    home: {
      shots: homeStat(TYPE.SHOTS_TOTAL),
      shotsOnTarget: homeStat(TYPE.SHOTS_ON_TARGET),
      bigChances: homeBig,
      possession: homeStat(TYPE.POSSESSION),
      xg: estimateXg(homeInside, homeOutside, homeBig),
      xga: estimateXg(awayInside, awayOutside, awayBig)
    },
    away: {
      shots: awayStat(TYPE.SHOTS_TOTAL),
      shotsOnTarget: awayStat(TYPE.SHOTS_ON_TARGET),
      bigChances: awayBig,
      possession: awayStat(TYPE.POSSESSION),
      xg: estimateXg(awayInside, awayOutside, awayBig),
      xga: estimateXg(homeInside, homeOutside, homeBig)
    }
  };
}

function upsertStats(db, matchId, teamId, stats) {
  db.prepare(`
    INSERT INTO team_match_advanced_stats (
      match_id, team_id, source_provider, xg, xga, shots, shots_on_target, big_chances, possession, extracted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(match_id, team_id, source_provider) DO UPDATE SET
      xg = COALESCE(excluded.xg, team_match_advanced_stats.xg),
      xga = COALESCE(excluded.xga, team_match_advanced_stats.xga),
      shots = COALESCE(excluded.shots, team_match_advanced_stats.shots),
      shots_on_target = COALESCE(excluded.shots_on_target, team_match_advanced_stats.shots_on_target),
      big_chances = COALESCE(excluded.big_chances, team_match_advanced_stats.big_chances),
      possession = COALESCE(excluded.possession, team_match_advanced_stats.possession),
      extracted_at = datetime('now')
  `).run(
    matchId, teamId, SOURCE_PROVIDER,
    stats.xg, stats.xga, stats.shots, stats.shotsOnTarget,
    stats.bigChances, stats.possession
  );
}

function readPendingMatches(db, limit) {
  return db.prepare(`
    SELECT
      m.id AS matchId,
      m.source_match_id,
      m.home_team_id,
      m.away_team_id,
      m.competition_code,
      m.utc_date
    FROM matches m
    WHERE m.source_match_id > ${SPORTMONKS_ID_OFFSET}
      AND m.status = 'FINISHED'
      AND m.competition_code IN ('CL', 'EL')
      AND NOT EXISTS (
        SELECT 1 FROM team_match_advanced_stats s
        WHERE s.match_id = m.id AND s.source_provider = '${SOURCE_PROVIDER}'
      )
    ORDER BY m.utc_date DESC
    LIMIT ?
  `).all(limit);
}

export async function importSportmonksStats({ limit = 200, delayMs = 600 } = {}) {
  if (!hasSportmonksConfig()) {
    return { ok: false, error: "Sportmonks API not configured." };
  }

  const db = getDb();
  const matches = readPendingMatches(db, limit);

  if (!matches.length) {
    return { ok: true, processed: 0, inserted: 0, failed: 0, message: "Nothing to backfill." };
  }

  logger.info("sportmonksStats: starting backfill", { pending: matches.length, limit });

  let processed = 0;
  let inserted = 0;
  let failed = 0;
  let noStats = 0;

  for (const match of matches) {
    const fixtureId = Number(match.source_match_id) - SPORTMONKS_ID_OFFSET;

    try {
      const url = buildUrl(fixtureId);
      const res = await fetch(url);

      if (!res.ok) {
        if (res.status === 429) {
          logger.warn("sportmonksStats: rate limited, pausing 10s");
          await sleep(10000);
        }
        failed += 1;
        continue;
      }

      const payload = await res.json();
      const statistics = payload?.data?.statistics ?? [];
      const participants = payload?.data?.participants ?? [];

      if (!statistics.length) {
        noStats += 1;
        processed += 1;
        continue;
      }

      // Identify home participant from participants meta
      const homeParticipant = participants.find((p) => p.meta?.location === "home");
      const homeParticipantId = homeParticipant?.id ?? null;

      const stats = extractStats(statistics, participants, homeParticipantId);

      const beforeCount = db.prepare("SELECT COUNT(*) AS n FROM team_match_advanced_stats").get().n;
      upsertStats(db, match.matchId, match.home_team_id, stats.home);
      upsertStats(db, match.matchId, match.away_team_id, stats.away);
      const afterCount = db.prepare("SELECT COUNT(*) AS n FROM team_match_advanced_stats").get().n;

      inserted += afterCount - beforeCount;
      processed += 1;

      if (processed % 25 === 0) {
        logger.info("sportmonksStats: progress", { processed, inserted, failed, total: matches.length });
      }
    } catch (error) {
      logger.error("sportmonksStats: fixture fetch failed", { fixtureId, error: error.message });
      failed += 1;
    }

    await sleep(delayMs);
  }

  const totalRows = db.prepare("SELECT COUNT(*) AS n FROM team_match_advanced_stats").get().n;

  logger.info("sportmonksStats: backfill complete", { processed, inserted, failed, noStats, totalRows });

  return {
    ok: true,
    processed,
    inserted,
    failed,
    noStats,
    totalAdvancedStatsRows: totalRows
  };
}
