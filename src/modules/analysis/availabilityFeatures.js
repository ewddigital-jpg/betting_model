import { getDb } from "../../db/database.js";
import { average, clamp, round } from "../../lib/math.js";
import { hoursBetween } from "../../lib/time.js";
import { buildPlayerImpactSummary } from "./playerImpactService.js";

const KEY_POSITIONS = new Set(["goalkeeper", "center back", "centre back", "defender", "defensive midfield", "midfielder", "forward", "striker"]);
const SOURCE_PROFILES = {
  "sportmonks-availability": { lineupWeight: 1, absenceWeight: 1, tier: "structured" },
  "uefa-lineups": { lineupWeight: 0.98, absenceWeight: 0.65, tier: "official" },
  "api-football": { lineupWeight: 0.9, absenceWeight: 0.88, tier: "structured" },
  "uefa-preview": { lineupWeight: 0.78, absenceWeight: 0.78, tier: "official" },
  "uefa-competition-news": { lineupWeight: 0.76, absenceWeight: 0.76, tier: "official" },
  "official-club-news": { lineupWeight: 0.72, absenceWeight: 0.8, tier: "club" }
};
const STRUCTURED_TIERS = new Set(["structured", "official"]);

function normalizeRole(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z\s-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizePlayerName(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sourceProfile(provider) {
  return SOURCE_PROFILES[provider] ?? {
    lineupWeight: 0.6,
    absenceWeight: 0.6,
    tier: "public"
  };
}

function sourceWeight(row, kind) {
  const profile = sourceProfile(row.source_provider);
  return kind === "lineup" ? profile.lineupWeight : profile.absenceWeight;
}

function sourceTier(provider) {
  return sourceProfile(provider).tier;
}

function readLineupRows(matchId, teamId, asOfTime = null) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM expected_lineup_records
    WHERE match_id = ?
      AND team_id = ?
      ${asOfTime ? "AND datetime(extracted_at) <= datetime(?)" : ""}
    ORDER BY certainty_score DESC, lineup_slot ASC, extracted_at DESC
  `).all(...(asOfTime ? [matchId, teamId, asOfTime] : [matchId, teamId]));
}

function readInjuryRows(matchId, teamId, asOfTime = null) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM injury_records
    WHERE match_id = ?
      AND team_id = ?
      ${asOfTime ? "AND datetime(extracted_at) <= datetime(?)" : ""}
    ORDER BY importance_score DESC, extracted_at DESC
  `).all(...(asOfTime ? [matchId, teamId, asOfTime] : [matchId, teamId]));
}

function readSuspensionRows(matchId, teamId, asOfTime = null) {
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM suspension_records
    WHERE match_id = ?
      AND team_id = ?
      ${asOfTime ? "AND datetime(extracted_at) <= datetime(?)" : ""}
    ORDER BY importance_score DESC, extracted_at DESC
  `).all(...(asOfTime ? [matchId, teamId, asOfTime] : [matchId, teamId]));
}

function rowTrustScore(row, kind) {
  const weight = sourceWeight(row, kind);
  const certainty = kind === "lineup"
    ? (row.certainty_score ?? 0.5)
    : statusMultiplier(row.status);
  const importance = row.importance_score ?? 0.5;
  return (weight * 10) + (certainty * 4) + (importance * 2);
}

function dedupeRows(rows, kind) {
  const bestByPlayer = new Map();

  for (const row of rows) {
    const key = normalizePlayerName(row.player_name);
    if (!key) {
      continue;
    }

    const current = bestByPlayer.get(key);
    if (!current) {
      bestByPlayer.set(key, row);
      continue;
    }

    const currentScore = rowTrustScore(current, kind);
    const rowScore = rowTrustScore(row, kind);
    if (
      rowScore > currentScore ||
      (
        rowScore === currentScore &&
        new Date(row.extracted_at ?? 0).getTime() > new Date(current.extracted_at ?? 0).getTime()
      )
    ) {
      bestByPlayer.set(key, row);
    }
  }

  return [...bestByPlayer.values()].sort((left, right) => rowTrustScore(right, kind) - rowTrustScore(left, kind));
}

function statusMultiplier(status) {
  const normalized = String(status ?? "").toLowerCase();

  if (normalized === "out" || normalized === "suspended") {
    return 1;
  }

  if (normalized === "doubtful") {
    return 0.55;
  }

  if (normalized === "questionable") {
    return 0.4;
  }

  return 0.25;
}

function buildMissingStarterRows(lineupRows, unavailableRows) {
  const unavailableByName = new Map(
    unavailableRows.map((row) => [normalizePlayerName(row.player_name), row])
  );

  return lineupRows
    .filter((row) => row.expected_start)
    .filter((row) => unavailableByName.has(normalizePlayerName(row.player_name)))
    .map((row) => ({
      lineup: row,
      unavailable: unavailableByName.get(normalizePlayerName(row.player_name))
    }));
}

function summarizeSources(lineupRows, injuryRows, suspensionRows) {
  const sources = [...lineupRows, ...injuryRows, ...suspensionRows]
    .map((row) => row.source_provider)
    .filter(Boolean);
  return [...new Set(sources)];
}

function strongestSource(rows, kind) {
  const ranked = [...rows]
    .map((row) => ({
      provider: row.source_provider,
      score: rowTrustScore(row, kind),
      tier: sourceTier(row.source_provider)
    }))
    .sort((left, right) => right.score - left.score);

  return ranked[0] ?? null;
}

function hasStructuredSource(rows, kind) {
  return rows.some((row) => STRUCTURED_TIERS.has(sourceTier(row.source_provider)) && sourceWeight(row, kind) >= 0.76);
}

function availabilityConflictScore(injuryRows, suspensionRows, lineupRows) {
  const statusesByPlayer = new Map();

  for (const row of [...injuryRows, ...suspensionRows]) {
    const key = normalizePlayerName(row.player_name);
    if (!key) {
      continue;
    }

    const bucket = statusesByPlayer.get(key) ?? new Set();
    bucket.add(String(row.status ?? "").toLowerCase());
    statusesByPlayer.set(key, bucket);
  }

  let score = 0;
  for (const statuses of statusesByPlayer.values()) {
    if (statuses.size > 1) {
      score += 0.12;
    }
  }

  const lineupByPlayer = new Map();
  for (const row of lineupRows) {
    const key = normalizePlayerName(row.player_name);
    if (!key) {
      continue;
    }

    const bucket = lineupByPlayer.get(key) ?? [];
    bucket.push(row);
    lineupByPlayer.set(key, bucket);
  }

  for (const rows of lineupByPlayer.values()) {
    if (rows.length < 2) {
      continue;
    }

    const certainties = rows.map((row) => row.certainty_score ?? 0.5);
    if ((Math.max(...certainties) - Math.min(...certainties)) >= 0.18) {
      score += 0.08;
    }
  }

  return round(clamp(score, 0, 0.45), 2);
}

function latestExtractedAt(rows) {
  const ordered = rows
    .map((row) => row.extracted_at)
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime());

  return ordered[0] ?? null;
}

function lineupWindowMultiplier(hoursToKickoff, hasLineupRows) {
  if (hasLineupRows) {
    return 1;
  }

  if (hoursToKickoff <= 1.5) {
    return 0.2;
  }

  if (hoursToKickoff <= 3) {
    return 0.35;
  }

  if (hoursToKickoff <= 6) {
    return 0.55;
  }

  return 1;
}

function lineupFreshnessMultiplier(hoursSinceLineupUpdate) {
  if (hoursSinceLineupUpdate === null) {
    return 1;
  }

  if (hoursSinceLineupUpdate <= 2) {
    return 1;
  }

  if (hoursSinceLineupUpdate <= 6) {
    return 0.9;
  }

  if (hoursSinceLineupUpdate <= 12) {
    return 0.75;
  }

  return 0.6;
}

export function buildAvailabilityFeatures(matchId, teamId, kickoffTime = null, options = {}) {
  const asOfTime = options.asOfTime ?? null;
  const referenceTime = asOfTime ? new Date(asOfTime) : new Date();
  const lineupRows = dedupeRows(readLineupRows(matchId, teamId, asOfTime), "lineup");
  const injuryRows = dedupeRows(readInjuryRows(matchId, teamId, asOfTime), "absence");
  const suspensionRows = dedupeRows(readSuspensionRows(matchId, teamId, asOfTime), "absence");
  const unavailableRows = [...injuryRows, ...suspensionRows];
  const sourceConflict = availabilityConflictScore(injuryRows, suspensionRows, lineupRows);
  const strongestLineupSource = strongestSource(lineupRows, "lineup");
  const strongestAbsenceSource = strongestSource(unavailableRows, "absence");
  const structuredLineupSource = hasStructuredSource(lineupRows, "lineup");
  const structuredAbsenceSource = hasStructuredSource(unavailableRows, "absence");
  const playerImpact = buildPlayerImpactSummary({
    matchId,
    teamId,
    asOfTime: asOfTime ?? kickoffTime ?? referenceTime.toISOString(),
    lineupRows,
    injuryRows,
    suspensionRows
  });
  const missingStarterRows = buildMissingStarterRows(lineupRows, unavailableRows);
  const missingKeyPositions = [...new Set([
    ...missingStarterRows
      .map((row) => normalizeRole(row.lineup.player_role || row.unavailable.player_role))
      .filter((role) => KEY_POSITIONS.has(role)),
    ...(playerImpact.missingPrimaryGoalkeeper ? ["goalkeeper"] : []),
    ...(playerImpact.missingBuckets.defense > 0 ? ["defender"] : []),
    ...(playerImpact.missingBuckets.midfield > 0 ? ["midfielder"] : []),
    ...(playerImpact.missingBuckets.attack > 0 ? ["forward"] : [])
  ])];
  const coreAvailabilityPenalty = playerImpact.missingCorePlayers.reduce((sum, player) => {
    if (player.unavailable || !lineupRows.length) {
      return sum + (player.importanceScore * 0.45);
    }

    return sum + (player.importanceScore * 0.3);
  }, 0);
  const injuryImpactScore = round(
    clamp(
      (
        injuryRows
          .slice(0, 6)
          .reduce((sum, row) => {
            const key = normalizePlayerName(row.player_name);
            const importanceBoost = playerImpact.corePlayers.find((player) => player.key === key)?.importanceScore ?? 0;
            return sum + ((row.importance_score ?? 0.5) * statusMultiplier(row.status)) + (importanceBoost * 0.35);
          }, 0) / 4
      ) + coreAvailabilityPenalty,
      0,
      2
    ),
    2
  );
  const suspensionImpactScore = round(
    clamp(
      (
        suspensionRows
          .slice(0, 3)
          .reduce((sum, row) => {
            const key = normalizePlayerName(row.player_name);
            const importanceBoost = playerImpact.corePlayers.find((player) => player.key === key)?.importanceScore ?? 0;
            return sum + ((row.importance_score ?? 0.5) * statusMultiplier(row.status)) + (importanceBoost * 0.4);
          }, 0) / 3
      ) + (playerImpact.missingPrimaryGoalkeeper ? 0.25 : 0),
      0,
      2
    ),
    2
  );
  const lineupCertaintyScore = round(
    clamp(
      (
        lineupRows.length
          ? average(lineupRows.map((row) => (row.certainty_score ?? 0.5) * sourceWeight(row, "lineup")), 0.5)
          : 0.5
      ) *
      (strongestLineupSource ? Math.max(0.72, strongestLineupSource.score / 16) : 0.8) *
      lineupWindowMultiplier(
        kickoffTime ? Math.max(0, hoursBetween(referenceTime, new Date(kickoffTime))) : 12,
        lineupRows.length > 0
      ) *
      lineupFreshnessMultiplier(
        latestExtractedAt(lineupRows)
          ? Math.max(0, hoursBetween(new Date(latestExtractedAt(lineupRows)), referenceTime))
          : null
      ) *
      (1 - sourceConflict),
      0.15,
      1
    ),
    2
  );
  const missingStartersCount = Math.max(missingStarterRows.length, playerImpact.missingCoreStartersCount);
  const availabilityImpact = injuryImpactScore + suspensionImpactScore + (missingStartersCount * 0.18);
  const hoursToKickoff = kickoffTime ? Math.max(0, hoursBetween(referenceTime, new Date(kickoffTime))) : null;
  const latestLineupExtractedAt = latestExtractedAt(lineupRows);
  const latestAvailabilityExtractedAt = latestExtractedAt([...injuryRows, ...suspensionRows, ...lineupRows]);
  const lineupUpdateAgeHours = latestLineupExtractedAt
    ? round(Math.max(0, hoursBetween(new Date(latestLineupExtractedAt), referenceTime)), 1)
    : null;
  const availabilityCoverageScore = round(
    clamp(
      (lineupRows.length ? 0.55 : 0) +
      (injuryRows.length || suspensionRows.length ? 0.35 : 0) +
      (structuredLineupSource ? 0.1 : 0) +
      (structuredAbsenceSource ? 0.08 : 0) +
      (summarizeSources(lineupRows, injuryRows, suspensionRows).length > 1 ? 0.15 : 0) -
      (sourceConflict * 0.6) -
      (
        !lineupRows.length && hoursToKickoff !== null && hoursToKickoff <= 3
          ? 0.2
          : !lineupRows.length && hoursToKickoff !== null && hoursToKickoff <= 6
            ? 0.1
            : 0
      ),
      0,
      1
    ),
    2
  );

  return {
    injuryImpactScore,
    suspensionImpactScore,
    lineupCertaintyScore,
    lineupUncertainty: round(1 - lineupCertaintyScore, 2),
    latestLineupExtractedAt,
    latestAvailabilityExtractedAt,
    lineupUpdateAgeHours,
    hoursToKickoff,
    missingStartersCount,
    missingStarters: missingStartersCount,
    missingKeyPlayers: playerImpact.missingCorePlayers.length,
    missingKeyPositions,
    missingCoreStartersCount: playerImpact.missingCoreStartersCount,
    returningCoreStartersCount: playerImpact.returningCoreStartersCount,
    missingPrimaryGoalkeeper: playerImpact.missingPrimaryGoalkeeper,
    missingCorePlayers: playerImpact.missingCorePlayers,
    lineupContinuityScore: playerImpact.lineupContinuityScore,
    starterQualityScore: playerImpact.starterQualityScore,
    starterStrengthDelta: playerImpact.starterStrengthDelta,
    sourceConflictScore: sourceConflict,
    strongestLineupSource: strongestLineupSource?.provider ?? null,
    strongestAbsenceSource: strongestAbsenceSource?.provider ?? null,
    structuredLineupSource,
    structuredAbsenceSource,
    availabilityCoverageScore,
    expectedLineupStrength: round(
      clamp(
        (playerImpact.starterQualityScore - 0.5) +
        (playerImpact.starterStrengthDelta * 0.85) +
        ((playerImpact.lineupContinuityScore - 0.5) * 0.5) -
        (missingStartersCount * 0.06) -
        (sourceConflict * 0.3),
        -1,
        1
      ),
      2
    ),
    injuryImpact: round(-(availabilityImpact + (playerImpact.missingPrimaryGoalkeeper ? 0.2 : 0)), 2),
    lineupStrength: round(
      (lineupCertaintyScore - 0.5) +
      (playerImpact.starterStrengthDelta * 0.8) +
      ((playerImpact.lineupContinuityScore - 0.5) * 0.45) -
      (missingStartersCount * 0.08) -
      (sourceConflict * 0.35),
      2
    ),
    availabilitySources: summarizeSources(lineupRows, injuryRows, suspensionRows),
    injuries: injuryRows.map((row) => ({
      player: row.player_name,
      role: row.player_role,
      reason: row.reason,
      status: row.status
    })),
    suspensions: suspensionRows.map((row) => ({
      player: row.player_name,
      role: row.player_role,
      reason: row.reason,
      status: row.status
    })),
    expectedLineup: lineupRows.slice(0, 11).map((row) => ({
      player: row.player_name,
      role: row.player_role,
      certaintyScore: row.certainty_score,
      importanceScore: playerImpact.corePlayers.find((player) => player.key === normalizePlayerName(row.player_name))?.importanceScore ?? null
    }))
  };
}
