import fs from "node:fs";
import { env } from "../../../config/env.js";
import { APP_COMPETITION_CODES } from "../../../config/leagues.js";
import { getDb } from "../../../db/database.js";
import { logger } from "../../../lib/logger.js";
import { isoNow } from "../../../lib/time.js";
import { resolveMatchTeamId } from "../teamIdentity.js";
import { getAvailabilityProvider } from "../publicSources/index.js";

function readSeedFile() {
  if (!fs.existsSync(env.publicSourceSeedsPath)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(env.publicSourceSeedsPath, "utf8"));
  } catch (error) {
    logger.warn("Availability seed file could not be parsed", {
      path: env.publicSourceSeedsPath,
      message: error.message
    });
    return [];
  }
}

function readStoredSeeds(limitDays = 7) {
  const db = getDb();
  return db.prepare(`
    SELECT
      asl.match_id AS matchId,
      asl.provider,
      asl.source_type AS sourceType,
      asl.url,
      asl.notes,
      teams.name AS teamName
    FROM availability_source_links asl
    LEFT JOIN teams ON teams.id = asl.team_id
    LEFT JOIN matches ON matches.id = asl.match_id
    WHERE asl.match_id IS NOT NULL
      AND matches.status != 'FINISHED'
      AND datetime(matches.utc_date) >= datetime('now', '-6 hours')
      AND datetime(matches.utc_date) <= datetime('now', ?)
    ORDER BY datetime(asl.updated_at) DESC, asl.id DESC
  `).all(`+${Number(limitDays) || 7} days`);
}

function dedupeSeeds(seeds) {
  const seen = new Set();
  return seeds.filter((seed) => {
    const key = [
      Number(seed.matchId) || 0,
      seed.provider ?? "",
      seed.sourceType ?? "",
      seed.url ?? "",
      seed.teamName ?? ""
    ].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function readUpcomingMatches(limitDays = 7) {
  const db = getDb();
  return db.prepare(`
    SELECT
      matches.id,
      matches.source_match_id,
      matches.competition_code,
      matches.utc_date,
      matches.home_team_id,
      matches.away_team_id,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE matches.competition_code IN (${APP_COMPETITION_CODES.map(() => "?").join(", ")})
      AND matches.status != 'FINISHED'
      AND datetime(matches.utc_date) >= datetime('now', '-6 hours')
      AND datetime(matches.utc_date) <= datetime('now', ?)
    ORDER BY datetime(matches.utc_date) ASC
  `).all(...APP_COMPETITION_CODES, `+${Number(limitDays) || 7} days`);
}

function readFinishedMatchesForLineupBackfill(limit = 120, competitionCode = null) {
  const db = getDb();
  const competitionClause = competitionCode ? "AND matches.competition_code = ?" : `AND matches.competition_code IN (${APP_COMPETITION_CODES.map(() => "?").join(", ")})`;
  const competitionValues = competitionCode ? [competitionCode] : APP_COMPETITION_CODES;

  return db.prepare(`
    SELECT
      matches.id,
      matches.source_match_id,
      matches.competition_code,
      matches.utc_date,
      matches.home_team_id,
      matches.away_team_id,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE matches.status = 'FINISHED'
      AND matches.source_match_id IS NOT NULL
      ${competitionClause}
      AND NOT EXISTS (
        SELECT 1
        FROM expected_lineup_records elr
        WHERE elr.match_id = matches.id
          AND elr.source_provider = 'sportmonks-availability'
      )
    ORDER BY datetime(matches.utc_date) DESC
    LIMIT ?
  `).all(...competitionValues, Number(limit) || 120);
}

function seedsForMatch(seeds, matchId) {
  return seeds.filter((seed) => Number(seed.matchId) === Number(matchId));
}

function teamIdForName(match, teamName) {
  return resolveMatchTeamId(match, teamName);
}

function deleteExistingRowsForProvider(matchId, providerName) {
  const db = getDb();
  db.prepare("DELETE FROM injury_records WHERE match_id = ? AND source_provider = ?").run(matchId, providerName);
  db.prepare("DELETE FROM suspension_records WHERE match_id = ? AND source_provider = ?").run(matchId, providerName);
  db.prepare("DELETE FROM expected_lineup_records WHERE match_id = ? AND source_provider = ?").run(matchId, providerName);
}

function storeSourceSeed(match, seed) {
  const db = getDb();
  db.prepare(`
    INSERT INTO availability_source_links (
      match_id, team_id, provider, source_type, url, notes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, source_type, url) DO UPDATE SET
      match_id = excluded.match_id,
      team_id = excluded.team_id,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(
    match.id,
    seed.teamName ? teamIdForName(match, seed.teamName) : null,
    seed.provider,
    seed.sourceType ?? "text",
    seed.url,
    seed.notes ?? null,
    isoNow(),
    isoNow()
  );
}

function storeDiscoveredSources(match, sources = []) {
  for (const source of sources) {
    if (!source?.provider || !source?.url) {
      continue;
    }

    storeSourceSeed(match, source);
  }
}

function insertAvailabilityRows(match, providerName, payload, options = {}) {
  const db = getDb();
  const onlyExpectedLineups = options.onlyExpectedLineups ?? false;
  const insertInjury = db.prepare(`
    INSERT INTO injury_records (
      match_id, team_id, player_name, player_role, status, reason, expected_return,
      importance_score, source_provider, source_url, extracted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSuspension = db.prepare(`
    INSERT INTO suspension_records (
      match_id, team_id, player_name, player_role, status, reason, return_date,
      importance_score, source_provider, source_url, extracted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLineup = db.prepare(`
    INSERT INTO expected_lineup_records (
      match_id, team_id, player_name, player_role, lineup_slot, expected_start, certainty_score,
      source_provider, source_url, extracted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  deleteExistingRowsForProvider(match.id, providerName);

  for (const row of onlyExpectedLineups ? [] : (payload.injuries ?? [])) {
    const teamId = teamIdForName(match, row.teamName);
    if (!teamId || !row.playerName) {
      continue;
    }

    insertInjury.run(
      match.id,
      teamId,
      row.playerName,
      row.playerRole ?? null,
      row.status ?? "out",
      row.reason ?? null,
      row.expectedReturn ?? null,
      row.importanceScore ?? 0.5,
      row.sourceProvider ?? providerName,
      row.sourceUrl ?? null,
      row.extractedAt ?? isoNow()
    );
  }

  for (const row of onlyExpectedLineups ? [] : (payload.suspensions ?? [])) {
    const teamId = teamIdForName(match, row.teamName);
    if (!teamId || !row.playerName) {
      continue;
    }

    insertSuspension.run(
      match.id,
      teamId,
      row.playerName,
      row.playerRole ?? null,
      row.status ?? "suspended",
      row.reason ?? null,
      row.returnDate ?? null,
      row.importanceScore ?? 0.5,
      row.sourceProvider ?? providerName,
      row.sourceUrl ?? null,
      row.extractedAt ?? isoNow()
    );
  }

  for (const row of payload.expectedLineups ?? []) {
    const teamId = teamIdForName(match, row.teamName);
    if (!teamId || !row.playerName) {
      continue;
    }

    insertLineup.run(
      match.id,
      teamId,
      row.playerName,
      row.playerRole ?? null,
      row.lineupSlot ?? null,
      row.expectedStart ? 1 : 0,
      row.certaintyScore ?? 0.5,
      row.sourceProvider ?? providerName,
      row.sourceUrl ?? null,
      row.extractedAt ?? isoNow()
    );
  }
}

async function importMatchAvailability(match, seeds) {
  const providers = [
    { name: "sportmonks-availability", seed: null },
    { name: "api-football", seed: null },
    ...seeds
      .filter((seed) => seed.provider !== "transfermarkt-rss")
      .map((seed) => ({ name: seed.provider, seed }))
  ];
  const summary = {
    matchId: match.id,
    providers: [],
    injuries: 0,
    suspensions: 0,
    expectedLineups: 0
  };

  for (const entry of providers) {
    const provider = getAvailabilityProvider(entry.name);

    if (!provider) {
      continue;
    }

    if (entry.seed) {
      storeSourceSeed(match, entry.seed);
    }

    const payload = await provider.collect(
      {
        id: match.id,
        competitionCode: match.competition_code,
        sourceMatchId: match.source_match_id,
        utcDate: match.utc_date,
        homeTeamId: match.home_team_id,
        awayTeamId: match.away_team_id,
        homeTeamName: match.home_team_name,
        awayTeamName: match.away_team_name
      },
      entry.seed
    );

    if (!payload) {
      continue;
    }

    storeDiscoveredSources(
      {
        id: match.id,
        homeTeamId: match.home_team_id,
        awayTeamId: match.away_team_id,
        homeTeamName: match.home_team_name,
        awayTeamName: match.away_team_name
      },
      payload.discoveredSources ?? []
    );

    insertAvailabilityRows(
      {
        id: match.id,
        homeTeamId: match.home_team_id,
        awayTeamId: match.away_team_id,
        homeTeamName: match.home_team_name,
        awayTeamName: match.away_team_name
      },
      provider.name,
      payload
    );

    summary.providers.push(provider.name);
    summary.injuries += payload.injuries?.length ?? 0;
    summary.suspensions += payload.suspensions?.length ?? 0;
    summary.expectedLineups += payload.expectedLineups?.length ?? 0;
  }

  return summary;
}

export async function importAvailabilityData({ matchIds = null, limitDays = 7 } = {}) {
  const seeds = dedupeSeeds([
    ...readSeedFile(),
    ...readStoredSeeds(limitDays)
  ]);
  const matches = readUpcomingMatches(limitDays)
    .filter((match) => !matchIds || matchIds.includes(match.id));
  const results = [];

  for (const match of matches) {
    const result = await importMatchAvailability(match, seedsForMatch(seeds, match.id));
    results.push(result);
  }

  logger.info("Availability import finished", {
    matches: results.length,
    withProviders: results.filter((item) => item.providers.length).length
  });

  return {
    importedMatches: results.length,
    results
  };
}

export async function importHistoricalLineupBackfill({ matchIds = null, limit = 120, competitionCode = null } = {}) {
  const provider = getAvailabilityProvider("sportmonks-availability");
  const matches = readFinishedMatchesForLineupBackfill(limit, competitionCode)
    .filter((match) => !matchIds || matchIds.includes(match.id));
  const results = [];

  if (!provider) {
    return {
      importedMatches: 0,
      results: [],
      reason: "Sportmonks availability provider is not available."
    };
  }

  for (const match of matches) {
    const payload = await provider.collect({
      id: match.id,
      competitionCode: match.competition_code,
      sourceMatchId: match.source_match_id,
      utcDate: match.utc_date,
      homeTeamId: match.home_team_id,
      awayTeamId: match.away_team_id,
      homeTeamName: match.home_team_name,
      awayTeamName: match.away_team_name
    });

    if (!payload?.expectedLineups?.length) {
      results.push({
        matchId: match.id,
        expectedLineups: 0
      });
      continue;
    }

    insertAvailabilityRows(
      {
        id: match.id,
        homeTeamId: match.home_team_id,
        awayTeamId: match.away_team_id,
        homeTeamName: match.home_team_name,
        awayTeamName: match.away_team_name
      },
      provider.name,
      {
        injuries: [],
        suspensions: [],
        expectedLineups: payload.expectedLineups
      },
      { onlyExpectedLineups: true }
    );

    results.push({
      matchId: match.id,
      expectedLineups: payload.expectedLineups.length
    });
  }

  logger.info("Historical lineup backfill finished", {
    matches: results.length,
    withLineups: results.filter((item) => item.expectedLineups > 0).length
  });

  return {
    importedMatches: results.length,
    results
  };
}
