import { getDb } from "../../db/database.js";
import { crawlFbrefHistoricalData } from "./publicSources/fbrefHistoricalProvider.js";
import { crawlTransfermarktHistoricalData } from "./publicSources/transfermarktHistoricalProvider.js";
import { crawlUnderstatHistoricalData } from "./publicSources/understatHistoricalProvider.js";
import { namesShareCoreTokens, normalizeName } from "./publicSources/historicalCrawlShared.js";

const VALID_COMPETITIONS = new Set(["CL", "EL", "UECL", "PL", "PD", "BL1", "SA", "FL1"]);
const MATCH_CONFIDENCE_THRESHOLD = 0.86;

function readMatchLookup() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      matches.id,
      matches.competition_code,
      matches.season,
      matches.utc_date,
      matches.home_team_id,
      matches.away_team_id,
      matches.home_score,
      matches.away_score,
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

function readTeams() {
  const db = getDb();
  return db.prepare("SELECT id, name, short_name, tla FROM teams").all().map((team) => ({
    ...team,
    normalizedName: normalizeName(team.name),
    normalizedShortName: normalizeName(team.short_name),
    normalizedTla: String(team.tla ?? "").trim().toLowerCase()
  }));
}

function parseDateParts(matchDate) {
  const value = String(matchDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return { year, month, day, value };
}

function deriveSeason(matchDate) {
  const parsed = parseDateParts(matchDate);
  if (!parsed) {
    return null;
  }

  return parsed.month >= 7 ? parsed.year : parsed.year - 1;
}

function dateDistanceInDays(left, right) {
  const leftDate = parseDateParts(left);
  const rightDate = parseDateParts(right);

  if (!leftDate || !rightDate) {
    return null;
  }

  const leftUtc = Date.UTC(leftDate.year, leftDate.month - 1, leftDate.day);
  const rightUtc = Date.UTC(rightDate.year, rightDate.month - 1, rightDate.day);
  return Math.round((leftUtc - rightUtc) / 86400000);
}

function resolveTeamCandidates(teams, normalizedName) {
  const exact = teams.filter((team) =>
    team.normalizedName === normalizedName ||
    team.normalizedShortName === normalizedName
  );

  if (exact.length) {
    return { mode: "exact", teams: exact };
  }

  const fuzzy = teams.filter((team) =>
    namesShareCoreTokens(team.normalizedName, normalizedName) ||
    namesShareCoreTokens(team.normalizedShortName, normalizedName)
  );

  if (fuzzy.length) {
    return { mode: "fuzzy", teams: fuzzy };
  }

  return { mode: "missing", teams: [] };
}

function summarizeCandidate(match, score) {
  return {
    matchId: match.id,
    competitionCode: match.competition_code,
    matchDate: match.matchDate,
    homeTeam: match.home_team_name,
    awayTeam: match.away_team_name,
    homeScore: match.home_score,
    awayScore: match.away_score,
    score
  };
}

function scoreCandidate(match, row) {
  let score = 0;

  if (row.competitionCode && match.competition_code === row.competitionCode) {
    score += 0.24;
  }

  const dayDistance = Math.abs(dateDistanceInDays(match.matchDate, row.matchDate) ?? 99);
  if (dayDistance === 0) {
    score += 0.3;
  } else if (dayDistance === 1) {
    score += 0.16;
  } else if (dayDistance === 2) {
    score += 0.05;
  }

  if (match.normalizedHome === row.normalizedHome) {
    score += 0.2;
  } else if (namesShareCoreTokens(match.normalizedHome, row.normalizedHome)) {
    score += 0.08;
  }

  if (match.normalizedAway === row.normalizedAway) {
    score += 0.2;
  } else if (namesShareCoreTokens(match.normalizedAway, row.normalizedAway)) {
    score += 0.08;
  }

  const rowSeason = deriveSeason(row.matchDate);
  if (rowSeason !== null && match.season === rowSeason) {
    score += 0.04;
  }

  const hasSourceScore = row.homeScore !== null && row.awayScore !== null;
  const hasMatchScore = match.home_score !== null && match.away_score !== null;
  if (hasSourceScore && hasMatchScore) {
    if (match.home_score === row.homeScore && match.away_score === row.awayScore) {
      score += 0.12;
    } else {
      score -= 0.18;
    }
  }

  return Math.max(0, Math.min(1, score));
}

function findCandidates(matchLookup, row) {
  const rowSeason = deriveSeason(row.matchDate);

  return matchLookup
    .filter((match) => !row.competitionCode || match.competition_code === row.competitionCode)
    .filter((match) => rowSeason === null || match.season === null || match.season === rowSeason)
    .filter((match) => {
      const dayDistance = Math.abs(dateDistanceInDays(match.matchDate, row.matchDate) ?? 99);
      return dayDistance <= 2;
    })
    .filter((match) => (
      match.normalizedHome === row.normalizedHome ||
      namesShareCoreTokens(match.normalizedHome, row.normalizedHome)
    ))
    .filter((match) => (
      match.normalizedAway === row.normalizedAway ||
      namesShareCoreTokens(match.normalizedAway, row.normalizedAway)
    ))
    .map((match) => ({
      match,
      score: scoreCandidate(match, row)
    }))
    .sort((left, right) => right.score - left.score);
}

function classifyNoMatch(matchLookup, teams, row) {
  const homeCandidates = resolveTeamCandidates(teams, row.normalizedHome);
  const awayCandidates = resolveTeamCandidates(teams, row.normalizedAway);

  if (homeCandidates.mode === "missing" || awayCandidates.mode === "missing") {
    return {
      reason: "missing_local_team_identity",
      details: `No local team identity for ${homeCandidates.mode === "missing" ? row.homeTeam : row.awayTeam}`
    };
  }

  const sameTeamsAnyCompetition = matchLookup.filter((match) =>
    match.normalizedHome === row.normalizedHome &&
    match.normalizedAway === row.normalizedAway
  );

  if (sameTeamsAnyCompetition.some((match) => match.competition_code !== row.competitionCode)) {
    return {
      reason: "wrong_competition_mapping",
      details: "Same team pairing exists locally, but under a different competition code"
    };
  }

  const nearbySameTeams = sameTeamsAnyCompetition.filter((match) =>
    Math.abs(dateDistanceInDays(match.matchDate, row.matchDate) ?? 99) <= 2
  );

  if (nearbySameTeams.length) {
    return {
      reason: "wrong_fixture_date_match",
      details: "Team pairing exists locally, but only on a nearby date"
    };
  }

  if (homeCandidates.mode === "fuzzy" || awayCandidates.mode === "fuzzy") {
    return {
      reason: "wrong_alias_mapping",
      details: "Only fuzzy local team candidates exist; normalization is still incomplete"
    };
  }

  return {
    reason: "missing_db_match_row",
    details: "Local fixture row is missing for this source match"
  };
}

function resolveMatch(matchLookup, teams, row) {
  const exact = matchLookup.find((match) =>
    match.competition_code === row.competitionCode &&
    match.matchDate === row.matchDate &&
    match.normalizedHome === row.normalizedHome &&
    match.normalizedAway === row.normalizedAway
  );

  if (exact) {
    return {
      status: "matched",
      confidence: 1,
      reason: "exact_match",
      match: exact,
      candidates: [summarizeCandidate(exact, 1)]
    };
  }

  const candidates = findCandidates(matchLookup, row);
  if (!candidates.length) {
    const diagnosis = classifyNoMatch(matchLookup, teams, row);
    return {
      status: "unmatched",
      confidence: 0,
      reason: diagnosis.reason,
      details: diagnosis.details,
      match: null,
      candidates: []
    };
  }

  const [best, second] = candidates;
  if (best.score < MATCH_CONFIDENCE_THRESHOLD) {
    return {
      status: "rejected",
      confidence: best.score,
      reason: "low_confidence_fixture_match",
      details: "Best candidate score is below the acceptance threshold",
      match: null,
      candidates: candidates.slice(0, 5).map((candidate) => summarizeCandidate(candidate.match, candidate.score))
    };
  }

  if (second && Math.abs(best.score - second.score) < 0.05) {
    return {
      status: "rejected",
      confidence: best.score,
      reason: "duplicate_fixture_candidates",
      details: "Multiple local fixtures score too closely to accept a safe match",
      match: null,
      candidates: candidates.slice(0, 5).map((candidate) => summarizeCandidate(candidate.match, candidate.score))
    };
  }

  return {
    status: "matched",
    confidence: best.score,
    reason: "scored_match",
    match: best.match,
    candidates: candidates.slice(0, 3).map((candidate) => summarizeCandidate(candidate.match, candidate.score))
  };
}

function buildRecordKey(row) {
  return `${row.competitionCode}::${row.matchDate}::${row.normalizedHome}::${row.normalizedAway}`;
}

function resolveTeam(teams, normalizedName) {
  return teams.find((team) =>
    team.normalizedName === normalizedName ||
    team.normalizedShortName === normalizedName
  ) ?? null;
}

function upsertAdvancedStats(db, record) {
  db.prepare(`
    INSERT INTO team_match_advanced_stats (
      match_id, team_id, source_provider, xg, xga, shots, shots_on_target, big_chances, possession, extracted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(match_id, team_id, source_provider) DO UPDATE SET
      xg = COALESCE(excluded.xg, team_match_advanced_stats.xg),
      xga = COALESCE(excluded.xga, team_match_advanced_stats.xga),
      shots = COALESCE(excluded.shots, team_match_advanced_stats.shots),
      shots_on_target = COALESCE(excluded.shots_on_target, team_match_advanced_stats.shots_on_target),
      big_chances = COALESCE(excluded.big_chances, team_match_advanced_stats.big_chances),
      possession = COALESCE(excluded.possession, team_match_advanced_stats.possession),
      extracted_at = COALESCE(excluded.extracted_at, team_match_advanced_stats.extracted_at)
  `).run(
    record.matchId,
    record.teamId,
    record.sourceProvider,
    record.xg,
    record.xga,
    record.shots,
    record.shotsOnTarget,
    record.bigChances,
    record.possession,
    record.extractedAt ?? null
  );
}

function hasDuplicateAdvancedStats(db, homeRecord, awayRecord) {
  const existing = db.prepare(`
    SELECT team_id, xg, xga, shots
    FROM team_match_advanced_stats
    WHERE match_id = ? AND source_provider = ?
  `).all(homeRecord.matchId, homeRecord.sourceProvider);

  if (existing.length !== 2) {
    return false;
  }

  const existingByTeam = new Map(existing.map((row) => [row.team_id, row]));
  const home = existingByTeam.get(homeRecord.teamId);
  const away = existingByTeam.get(awayRecord.teamId);

  return Boolean(
    home &&
    away &&
    home.xg === homeRecord.xg &&
    home.xga === homeRecord.xga &&
    home.shots === homeRecord.shots &&
    away.xg === awayRecord.xg &&
    away.xga === awayRecord.xga &&
    away.shots === awayRecord.shots
  );
}

function upsertTransfermarktLink(db, teamId, entry) {
  db.prepare(`
    INSERT OR IGNORE INTO availability_source_links (
      match_id, team_id, provider, source_type, url, notes, created_at, updated_at
    )
    VALUES (NULL, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    teamId,
    entry.sourceProvider,
    entry.sourceType,
    entry.url,
    `${entry.competitionCode} competition team source`
  );
}

function clearRepairLog(db) {
  db.prepare("DELETE FROM historical_enrichment_repairs WHERE resolved_at IS NULL").run();
}

function logRepairRow(db, source, row, resolution) {
  db.prepare(`
    INSERT INTO historical_enrichment_repairs (
      source_provider,
      competition_code,
      source_match_date,
      source_home_team,
      source_away_team,
      normalized_home,
      normalized_away,
      reason_code,
      reason_details,
      candidate_matches_json,
      raw_payload_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    source,
    row.competitionCode ?? null,
    row.matchDate ?? null,
    row.homeTeam ?? null,
    row.awayTeam ?? null,
    row.normalizedHome ?? null,
    row.normalizedAway ?? null,
    resolution.reason,
    resolution.details ?? null,
    JSON.stringify(resolution.candidates ?? []),
    JSON.stringify(row)
  );
}

function ensureTeam(db, team) {
  const existing = db.prepare("SELECT id FROM teams WHERE lower(name) = lower(?)").get(team.name);
  if (existing) {
    return existing.id;
  }

  const inserted = db.prepare(`
    INSERT INTO teams (source_team_id, name, short_name, tla, crest, created_at, updated_at)
    VALUES (NULL, ?, ?, ?, NULL, datetime('now'), datetime('now'))
    RETURNING id
  `).get(team.name, team.shortName ?? null, team.tla ?? null);

  return inserted.id;
}

function repairKnownIdentityIssues(db) {
  const brest = db.prepare("SELECT id FROM teams WHERE name = 'Stade Brestois 29'").get();
  if (!brest) {
    return { repairedBrentfordMatches: 0, createdBrentfordTeam: false };
  }

  const brentfordId = ensureTeam(db, {
    name: "Brentford",
    shortName: "Brentford",
    tla: "BRE"
  });
  const createdBrentfordTeam = !db.prepare("SELECT source_team_id FROM teams WHERE id = ?").get(brentfordId).source_team_id;

  const homeRepair = db.prepare(`
    UPDATE matches
    SET home_team_id = ?, last_synced_at = datetime('now')
    WHERE competition_code = 'PL' AND home_team_id = ?
  `).run(brentfordId, brest.id).changes;
  const awayRepair = db.prepare(`
    UPDATE matches
    SET away_team_id = ?, last_synced_at = datetime('now')
    WHERE competition_code = 'PL' AND away_team_id = ?
  `).run(brentfordId, brest.id).changes;
  const advancedDelete = db.prepare(`
    DELETE FROM team_match_advanced_stats
    WHERE team_id = ?
      AND match_id IN (SELECT id FROM matches WHERE competition_code = 'PL')
      AND EXISTS (
        SELECT 1
        FROM team_match_advanced_stats existing
        WHERE existing.match_id = team_match_advanced_stats.match_id
          AND existing.team_id = ?
          AND existing.source_provider = team_match_advanced_stats.source_provider
      )
  `).run(brest.id, brentfordId).changes;
  const advancedRepair = db.prepare(`
    UPDATE team_match_advanced_stats
    SET team_id = ?
    WHERE team_id = ?
      AND match_id IN (SELECT id FROM matches WHERE competition_code = 'PL')
      AND NOT EXISTS (
        SELECT 1
        FROM team_match_advanced_stats existing
        WHERE existing.match_id = team_match_advanced_stats.match_id
          AND existing.team_id = ?
          AND existing.source_provider = team_match_advanced_stats.source_provider
      )
  `).run(brentfordId, brest.id, brentfordId).changes;

  return {
    repairedBrentfordMatches: homeRepair + awayRepair,
    repairedAdvancedRows: advancedDelete + advancedRepair,
    createdBrentfordTeam
  };
}

export function repairTeamIdentityLeaks() {
  const db = getDb();
  return repairKnownIdentityIssues(db);
}

function validateAdvancedRow(row) {
  if (!row.matchDate) {
    return { valid: false, reason: "missing_date", details: "Source row is missing a match date" };
  }
  if (!row.homeTeam || !row.awayTeam) {
    return { valid: false, reason: "missing_teams", details: "Source row is missing one or both team names" };
  }
  if (row.homeXg === null || row.awayXg === null) {
    return { valid: false, reason: "missing_xg", details: "Source row is missing xG values" };
  }
  if (!VALID_COMPETITIONS.has(row.competitionCode)) {
    return { valid: false, reason: "invalid_competition", details: "Source row competition is not recognized locally" };
  }

  return { valid: true };
}

function makeAdvancedRecords(match, row, sourceProvider) {
  return {
    home: {
      matchId: match.id,
      teamId: match.home_team_id,
      sourceProvider,
      xg: row.homeXg,
      xga: row.awayXg,
      shots: row.homeShots ?? null,
      shotsOnTarget: null,
      bigChances: null,
      possession: null
    },
    away: {
      matchId: match.id,
      teamId: match.away_team_id,
      sourceProvider,
      xg: row.awayXg,
      xga: row.homeXg,
      shots: row.awayShots ?? null,
      shotsOnTarget: null,
      bigChances: null,
      possession: null
    }
  };
}

function recordReason(counter, reason) {
  counter[reason] = (counter[reason] ?? 0) + 1;
}

function processAdvancedRow({
  db,
  source,
  row,
  matchLookup,
  teams,
  processedRecords,
  matchedMatchIds,
  unresolved,
  unmatchedTeams,
  reasonCounts
}) {
  const validation = validateAdvancedRow(row);
  if (!validation.valid) {
    recordReason(reasonCounts.rejected, validation.reason);
    logRepairRow(db, source, row, {
      reason: validation.reason,
      details: validation.details,
      candidates: []
    });
    unresolved.push({ source, row, reason: validation.reason });
    return { parsed: false, matched: false, insertedRows: 0, rejectedLowConfidence: false };
  }

  const recordKey = `${source}::${buildRecordKey(row)}`;
  if (processedRecords.has(recordKey)) {
    recordReason(reasonCounts.rejected, "duplicate_source_row");
    return { parsed: false, matched: false, insertedRows: 0, rejectedLowConfidence: false };
  }
  processedRecords.add(recordKey);

  const resolution = resolveMatch(matchLookup, teams, row);
  if (resolution.status !== "matched") {
    recordReason(reasonCounts.unresolved, resolution.reason);
    unmatchedTeams.add(`${row.homeTeam} / ${row.awayTeam}`);
    logRepairRow(db, source, row, resolution);
    unresolved.push({ source, row, reason: resolution.reason, details: resolution.details, candidates: resolution.candidates });
    return {
      parsed: true,
      matched: false,
      insertedRows: 0,
      rejectedLowConfidence: resolution.reason === "low_confidence_fixture_match"
    };
  }

  const records = makeAdvancedRecords(resolution.match, row, source);
  if (hasDuplicateAdvancedStats(db, records.home, records.away)) {
    recordReason(reasonCounts.rejected, "duplicate_advanced_stat_row");
    return { parsed: true, matched: true, insertedRows: 0, rejectedLowConfidence: false };
  }

  const beforeCount = db.prepare("SELECT COUNT(*) AS count FROM team_match_advanced_stats").get().count;
  upsertAdvancedStats(db, records.home);
  upsertAdvancedStats(db, records.away);
  const afterCount = db.prepare("SELECT COUNT(*) AS count FROM team_match_advanced_stats").get().count;
  matchedMatchIds.add(resolution.match.id);

  return {
    parsed: true,
    matched: true,
    insertedRows: Math.max(0, afterCount - beforeCount),
    rejectedLowConfidence: false
  };
}

export async function crawlHistoricalDataset() {
  const db = getDb();
  const repairStats = repairKnownIdentityIssues(db);
  const matchLookup = readMatchLookup();
  const teams = readTeams();
  clearRepairLog(db);

  const fbref = await crawlFbrefHistoricalData();
  const understat = await crawlUnderstatHistoricalData();
  const transfermarkt = await crawlTransfermarktHistoricalData();

  let totalMatchesParsed = 0;
  let fbrefMatchesParsed = 0;
  let understatMatchesParsed = 0;
  let matchedAdvancedRows = 0;
  let insertedAdvancedRows = 0;
  let unmatchedAdvancedRows = 0;
  let rejectedRows = 0;
  let rejectedLowConfidence = 0;
  let transfermarktLinks = 0;

  const matchedMatchIds = new Set();
  const processedRecords = new Set();
  const unmatchedTeams = new Set();
  const unresolved = [];
  const failedPages = [];
  const reasonCounts = {
    unresolved: {},
    rejected: {}
  };

  for (const competition of fbref) {
    if (competition.scheduleSource === "missing" || competition.statsSource === "missing") {
      failedPages.push({
        source: "fbref",
        competitionCode: competition.competitionCode,
        scheduleSource: competition.scheduleSource,
        statsSource: competition.statsSource
      });
    }

    for (const row of competition.matches) {
      const result = processAdvancedRow({
        db,
        source: "fbref",
        row,
        matchLookup,
        teams,
        processedRecords,
        matchedMatchIds,
        unresolved,
        unmatchedTeams,
        reasonCounts
      });

      if (result.parsed) {
        totalMatchesParsed += 1;
        fbrefMatchesParsed += 1;
      }
      if (result.matched) {
        matchedAdvancedRows += 2;
        insertedAdvancedRows += result.insertedRows;
      } else if (result.parsed) {
        unmatchedAdvancedRows += 2;
      } else {
        rejectedRows += 1;
      }
      if (result.rejectedLowConfidence) {
        rejectedLowConfidence += 1;
      }
    }
  }

  for (const league of understat) {
    if (league.source === "missing") {
      failedPages.push({
        source: "understat",
        competitionCode: league.competitionCode,
        leagueKey: league.leagueKey,
        mode: "missing"
      });
    }

    for (const row of league.matches) {
      const result = processAdvancedRow({
        db,
        source: "understat",
        row,
        matchLookup,
        teams,
        processedRecords,
        matchedMatchIds,
        unresolved,
        unmatchedTeams,
        reasonCounts
      });

      if (result.parsed) {
        totalMatchesParsed += 1;
        understatMatchesParsed += 1;
      }
      if (result.matched) {
        matchedAdvancedRows += 2;
        insertedAdvancedRows += result.insertedRows;
      } else if (result.parsed) {
        unmatchedAdvancedRows += 2;
      } else {
        rejectedRows += 1;
      }
      if (result.rejectedLowConfidence) {
        rejectedLowConfidence += 1;
      }
    }
  }

  for (const competition of transfermarkt) {
    for (const entry of competition.teamLinks) {
      const team = resolveTeam(teams, entry.normalizedTeam);
      if (!team) {
        continue;
      }

      upsertTransfermarktLink(db, team.id, entry);
      transfermarktLinks += 1;
    }
  }

  const repairLogRows = db.prepare("SELECT COUNT(*) AS count FROM historical_enrichment_repairs WHERE resolved_at IS NULL").get().count;

  return {
    fbref,
    understat,
    transfermarkt,
    totalMatchesParsed,
    fbrefMatchesParsed,
    understatMatchesParsed,
    matchedAdvancedRows,
    insertedAdvancedRows,
    unmatchedAdvancedRows,
    rejectedRows,
    rejectedLowConfidence,
    matchedMatches: matchedMatchIds.size,
    transfermarktLinks,
    repairLogRows,
    repairStats,
    unmatchedTeams: [...unmatchedTeams].slice(0, 50),
    unresolvedReasonCounts: reasonCounts.unresolved,
    rejectedReasonCounts: reasonCounts.rejected,
    failedPages,
    unmatchedSample: unresolved.slice(0, 25)
  };
}
