import fs from "node:fs";
import { APP_COMPETITION_CODES } from "../../../config/leagues.js";
import { env } from "../../../config/env.js";
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
    logger.warn("News seed file could not be parsed", {
      path: env.publicSourceSeedsPath,
      message: error.message
    });
    return [];
  }
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

function teamIdForName(match, teamName) {
  return resolveMatchTeamId(match, teamName);
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
    teamIdForName(match, seed.teamName),
    seed.provider,
    seed.sourceType ?? "rss",
    seed.url,
    seed.notes ?? null,
    isoNow(),
    isoNow()
  );
}

function upsertHeadline(match, row) {
  const db = getDb();
  db.prepare(`
    INSERT INTO team_news_records (
      match_id, team_id, provider, source_type, title, summary, url, published_at, relevance_score, extracted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, url) DO UPDATE SET
      match_id = excluded.match_id,
      team_id = excluded.team_id,
      title = excluded.title,
      summary = excluded.summary,
      published_at = excluded.published_at,
      relevance_score = excluded.relevance_score,
      extracted_at = excluded.extracted_at
  `).run(
    match.id,
    teamIdForName(match, row.teamName),
    row.sourceProvider,
    row.sourceType ?? "rss",
    row.title,
    row.summary ?? null,
    row.url,
    row.publishedAt ?? null,
    row.relevanceScore ?? 0.5,
    row.extractedAt ?? isoNow()
  );
}

export async function importNewsData({ limitDays = 7 } = {}) {
  const seeds = readSeedFile().filter((seed) => seed.provider === "transfermarkt-rss");
  const matches = readUpcomingMatches(limitDays);
  const results = [];

  for (const match of matches) {
    const matchSeeds = seeds.filter((seed) =>
      Number(seed.matchId) === Number(match.id) ||
      seed.teamName === match.home_team_name ||
      seed.teamName === match.away_team_name
    );

    let imported = 0;
    const providers = [];

    for (const seed of matchSeeds) {
      const provider = getAvailabilityProvider(seed.provider);
      if (!provider) {
        continue;
      }

      storeSourceSeed(match, seed);
      const payload = await provider.collect({
        id: match.id,
        competitionCode: match.competition_code,
        sourceMatchId: match.source_match_id,
        utcDate: match.utc_date,
        homeTeamId: match.home_team_id,
        awayTeamId: match.away_team_id,
        homeTeamName: match.home_team_name,
        awayTeamName: match.away_team_name
      }, seed);

      if (!payload?.headlines?.length) {
        continue;
      }

      for (const headline of payload.headlines) {
        upsertHeadline(match, headline);
        imported += 1;
      }

      for (const source of payload.discoveredSources ?? []) {
        if (source?.provider && source?.url) {
          storeSourceSeed(match, {
            ...source,
            teamName: seed.teamName ?? null
          });
        }
      }

      providers.push(provider.name);
    }

    results.push({
      matchId: match.id,
      providers,
      headlines: imported
    });
  }

  logger.info("News import finished", {
    matches: results.length,
    withHeadlines: results.filter((item) => item.headlines > 0).length
  });

  return {
    importedMatches: results.length,
    results
  };
}
