import { fetchFixtureAvailability } from "../sportmonksClient.js";

const SPORTMONKS_ID_OFFSET = 2_000_000_000;

function rawFixtureId(sourceMatchId) {
  const numeric = Number(sourceMatchId);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  return numeric >= SPORTMONKS_ID_OFFSET ? numeric - SPORTMONKS_ID_OFFSET : numeric;
}

function teamNameByParticipant(match, participantId, participants = []) {
  const participant = participants.find((item) => Number(item.id) === Number(participantId));
  const providerName = participant?.name ?? "";

  const normalizedProviderName = providerName.toLowerCase();
  if (normalizedProviderName && match.homeTeamName.toLowerCase().includes(normalizedProviderName)) {
    return match.homeTeamName;
  }

  if (normalizedProviderName && match.awayTeamName.toLowerCase().includes(normalizedProviderName)) {
    return match.awayTeamName;
  }

  if (participant?.meta?.location === "home") {
    return match.homeTeamName;
  }

  if (participant?.meta?.location === "away") {
    return match.awayTeamName;
  }

  return providerName || null;
}

function roleFromPlayer(player) {
  const positionId = Number(player?.position_id);

  if (positionId === 24) {
    return "goalkeeper";
  }

  if (positionId === 25) {
    return "defender";
  }

  if (positionId === 26) {
    return "midfielder";
  }

  if (positionId === 27) {
    return "forward";
  }

  return null;
}

function importanceFromRole(role) {
  if (role === "goalkeeper") {
    return 0.95;
  }

  if (role === "defender" || role === "midfielder" || role === "forward") {
    return 0.75;
  }

  return 0.6;
}

function classifyStatus(reason, sideline) {
  const normalized = String(reason ?? "").toLowerCase();

  if (String(sideline?.category ?? "").toLowerCase() === "suspension") {
    return "suspended";
  }

  if (normalized.includes("fitness") || normalized.includes("illness") || normalized.includes("knock")) {
    return "questionable";
  }

  return "out";
}

function mapSidelinedEntries(match, payload) {
  const participants = payload?.data?.participants ?? [];
  const sidelined = payload?.data?.sidelined ?? [];

  return sidelined.flatMap((entry) => {
    if (entry.sideline?.completed) {
      return [];
    }

    const teamName = teamNameByParticipant(match, entry.participant_id, participants);
    const playerName = entry.player?.display_name ?? entry.player?.name ?? null;

    if (!teamName || !playerName) {
      return [];
    }

    const reason = entry.type?.name ?? entry.sideline?.category ?? "Unavailable";
    const category = String(entry.sideline?.category ?? "").toLowerCase();
    const status = classifyStatus(reason, entry.sideline);
    const role = roleFromPlayer(entry.player);
    const importance = importanceFromRole(role) + (entry.sideline?.games_missed >= 8 ? 0.1 : 0);
    const shared = {
      teamName,
      playerName,
      playerRole: role,
      reason,
      importanceScore: Math.min(1, importance),
      sourceProvider: "sportmonks-availability",
      sourceUrl: null,
      extractedAt: new Date().toISOString()
    };

    if (status === "suspended") {
      return [{
        ...shared,
        status: "suspended",
        returnDate: entry.sideline?.end_date ?? null
      }];
    }

    return [{
      ...shared,
      status: "out",
      expectedReturn: entry.sideline?.end_date ?? null
    }];
  });
}

function mapLineupEntries(match, payload) {
  const participants = payload?.data?.participants ?? [];
  const lineups = payload?.data?.lineups ?? [];
  const extractedAt = (() => {
    const kickoff = match.utcDate ? new Date(match.utcDate) : null;
    if (kickoff && kickoff.getTime() <= Date.now()) {
      return new Date(kickoff.getTime() - (15 * 60 * 1000)).toISOString();
    }

    return new Date().toISOString();
  })();

  return lineups.flatMap((entry, index) => {
    const typeId = Number(entry.type_id);
    const isStarter = typeId === 11;
    const teamName = teamNameByParticipant(match, entry.team_id ?? entry.participant_id, participants);
    const playerName = entry.player?.display_name ?? entry.player?.name ?? entry.player_name ?? null;

    if (!teamName || !playerName || !isStarter) {
      return [];
    }

    return [{
      teamName,
      playerName,
      playerRole: roleFromPlayer(entry.player),
      lineupSlot: entry.formation_position ?? entry.position ?? entry.lineup_position ?? index + 1,
      expectedStart: true,
      certaintyScore: kickoffHasStarted(match.utcDate) ? 1 : 0.98,
      sourceProvider: "sportmonks-availability",
      sourceUrl: null,
      extractedAt
    }];
  });
}

function kickoffHasStarted(utcDate) {
  if (!utcDate) {
    return false;
  }

  return new Date(utcDate).getTime() <= Date.now();
}

export const sportmonksAvailabilityProvider = {
  name: "sportmonks-availability",

  async collect(match) {
    const fixtureId = rawFixtureId(match.sourceMatchId);

    if (!fixtureId) {
      return null;
    }

    try {
      const payload = await fetchFixtureAvailability(fixtureId);
      const records = mapSidelinedEntries(match, payload);
      const lineups = mapLineupEntries(match, payload);

      return {
        injuries: records.filter((entry) => entry.status !== "suspended").map((entry) => ({
          teamName: entry.teamName,
          playerName: entry.playerName,
          playerRole: entry.playerRole,
          status: entry.status,
          reason: entry.reason,
          expectedReturn: entry.expectedReturn ?? null,
          importanceScore: entry.importanceScore,
          sourceProvider: entry.sourceProvider,
          sourceUrl: entry.sourceUrl,
          extractedAt: entry.extractedAt
        })),
        suspensions: records.filter((entry) => entry.status === "suspended").map((entry) => ({
          teamName: entry.teamName,
          playerName: entry.playerName,
          playerRole: entry.playerRole,
          status: entry.status,
          reason: entry.reason,
          returnDate: entry.returnDate ?? null,
          importanceScore: entry.importanceScore,
          sourceProvider: entry.sourceProvider,
          sourceUrl: entry.sourceUrl,
          extractedAt: entry.extractedAt
        })),
        expectedLineups: lineups
      };
    } catch {
      return null;
    }
  }
};
