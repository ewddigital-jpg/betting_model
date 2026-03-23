import { logger } from "../../../lib/logger.js";
import { isoNow } from "../../../lib/time.js";
import { fetchText, inferRoleFromSlot, splitPlayerList, stripHtmlToText, teamNameSimilarity } from "./shared.js";

function buildStartingLineups(text, match, sourceUrl) {
  const extractedAt = isoNow();
  const lineups = [];
  const pattern = /(Starting(?: line-?up)?|Possible line(?:-?up)?)\s*:\s*([^\n]+)/giu;
  const matches = [...text.matchAll(pattern)];

  for (const entry of matches) {
    const precedingText = text.slice(Math.max(0, entry.index - 120), entry.index);
    const teamName = [match.homeTeamName, match.awayTeamName]
      .find((candidate) => teamNameSimilarity(precedingText, candidate) >= 0.35);

    if (!teamName) {
      continue;
    }

    splitPlayerList(entry[2]).forEach((playerName, index) => {
      lineups.push({
        teamName,
        playerName,
        playerRole: inferRoleFromSlot(index),
        lineupSlot: index + 1,
        expectedStart: true,
        certaintyScore: entry[1].toLowerCase().includes("starting") ? 0.98 : 0.8,
        sourceProvider: "uefa-lineups",
        sourceUrl,
        extractedAt
      });
    });
  }

  return lineups;
}

export const uefaLineupsProvider = {
  name: "uefa-lineups",

  async collect(match, seed) {
    if (!seed?.url) {
      return null;
    }

    try {
      const html = await fetchText(seed.url);
      const text = stripHtmlToText(html);
      return {
        injuries: [],
        suspensions: [],
        expectedLineups: buildStartingLineups(text, match, seed.url)
      };
    } catch (error) {
      logger.warn("UEFA lineups import failed", {
        matchId: match.id,
        url: seed.url,
        message: error.message
      });
      return null;
    }
  }
};
