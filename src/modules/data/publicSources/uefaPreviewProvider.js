import { logger } from "../../../lib/logger.js";
import { isoNow } from "../../../lib/time.js";
import { fetchText, inferRoleFromSlot, normalizeName, splitPlayerList, stripHtmlToText, teamNameSimilarity } from "./shared.js";

function selectTeamName(rawLabel, match) {
  const candidates = [match.homeTeamName, match.awayTeamName];
  return candidates.find((name) => teamNameSimilarity(rawLabel, name) >= 0.5) ?? rawLabel;
}

function parseTeamSection(sectionText, teamName, sourceUrl) {
  const extractedAt = isoNow();
  const injuries = [];
  const suspensions = [];
  const expectedLineups = [];

  const possibleLineupMatch = sectionText.match(/Possible line(?:-?up|ups?)\s*:\s*([^\n]+)/iu);
  if (possibleLineupMatch) {
    splitPlayerList(possibleLineupMatch[1]).forEach((playerName, index) => {
      expectedLineups.push({
        teamName,
        playerName,
        playerRole: inferRoleFromSlot(index),
        lineupSlot: index + 1,
        expectedStart: true,
        certaintyScore: 0.72,
        sourceProvider: "uefa-preview",
        sourceUrl,
        extractedAt
      });
    });
  }

  const suspendedMatch = sectionText.match(/Suspended\s*:\s*([^\n]+)/iu);
  if (suspendedMatch) {
    splitPlayerList(suspendedMatch[1]).forEach((playerName) => {
      suspensions.push({
        teamName,
        playerName,
        playerRole: null,
        status: "suspended",
        reason: "Listed as suspended in UEFA preview.",
        returnDate: null,
        importanceScore: 0.7,
        sourceProvider: "uefa-preview",
        sourceUrl,
        extractedAt
      });
    });
  }

  const unavailableMatch = sectionText.match(/(?:Unavailable|Missing|Out)\s*:\s*([^\n]+)/iu);
  if (unavailableMatch) {
    splitPlayerList(unavailableMatch[1]).forEach((playerName) => {
      injuries.push({
        teamName,
        playerName,
        playerRole: null,
        status: "out",
        reason: "Listed as unavailable in UEFA preview.",
        expectedReturn: null,
        importanceScore: 0.65,
        sourceProvider: "uefa-preview",
        sourceUrl,
        extractedAt
      });
    });
  }

  return { injuries, suspensions, expectedLineups };
}

function splitPreviewSections(text, match) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const sections = [];
  let currentTeam = null;
  let currentLines = [];

  for (const line of lines) {
    const isTeamHeader = [match.homeTeamName, match.awayTeamName].some((name) => teamNameSimilarity(line, name) >= 0.75);
    if (isTeamHeader) {
      if (currentTeam && currentLines.length) {
        sections.push({ teamName: currentTeam, text: currentLines.join("\n") });
      }
      currentTeam = selectTeamName(line, match);
      currentLines = [];
      continue;
    }

    if (currentTeam) {
      currentLines.push(line);
    }
  }

  if (currentTeam && currentLines.length) {
    sections.push({ teamName: currentTeam, text: currentLines.join("\n") });
  }

  return sections;
}

export const uefaPreviewProvider = {
  name: "uefa-preview",

  async collect(match, seed) {
    if (!seed?.url) {
      return null;
    }

    try {
      const html = await fetchText(seed.url);
      const text = stripHtmlToText(html);
      const sections = splitPreviewSections(text, match);

      if (!sections.length) {
        return null;
      }

      return sections.reduce((accumulator, section) => {
        const parsed = parseTeamSection(section.text, section.teamName, seed.url);
        accumulator.injuries.push(...parsed.injuries);
        accumulator.suspensions.push(...parsed.suspensions);
        accumulator.expectedLineups.push(...parsed.expectedLineups);
        return accumulator;
      }, { injuries: [], suspensions: [], expectedLineups: [] });
    } catch (error) {
      logger.warn("UEFA preview import failed", {
        matchId: match.id,
        url: seed.url,
        message: error.message
      });
      return null;
    }
  }
};
