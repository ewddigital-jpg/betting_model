import { logger } from "../../../lib/logger.js";
import { isoNow } from "../../../lib/time.js";
import { fetchText, inferRoleFromSlot, splitPlayerList, stripHtmlToText } from "./shared.js";

function collectPatternMatches(text, patterns = []) {
  const results = [];

  for (const rawPattern of patterns) {
    const pattern = new RegExp(rawPattern, "giu");
    const matches = [...text.matchAll(pattern)];

    for (const entry of matches) {
      if (entry[1]) {
        results.push(entry[1]);
      }
    }
  }

  return results;
}

export const officialClubNewsProvider = {
  name: "official-club-news",

  async collect(match, seed) {
    if (!seed?.url || !seed.patterns) {
      return null;
    }

    try {
      const html = await fetchText(seed.url);
      const text = stripHtmlToText(html);
      const extractedAt = isoNow();
      const teamName = seed.teamName;

      const injuries = collectPatternMatches(text, seed.patterns.injuries).flatMap((value) =>
        splitPlayerList(value).map((playerName) => ({
          teamName,
          playerName,
          playerRole: null,
          status: "out",
          reason: "Listed in official club team news.",
          expectedReturn: null,
          importanceScore: 0.7,
          sourceProvider: "official-club-news",
          sourceUrl: seed.url,
          extractedAt
        }))
      );

      const suspensions = collectPatternMatches(text, seed.patterns.suspensions).flatMap((value) =>
        splitPlayerList(value).map((playerName) => ({
          teamName,
          playerName,
          playerRole: null,
          status: "suspended",
          reason: "Listed in official club team news.",
          returnDate: null,
          importanceScore: 0.7,
          sourceProvider: "official-club-news",
          sourceUrl: seed.url,
          extractedAt
        }))
      );

      const expectedLineups = collectPatternMatches(text, seed.patterns.expectedLineups).flatMap((value) =>
        splitPlayerList(value).map((playerName, index) => ({
          teamName,
          playerName,
          playerRole: inferRoleFromSlot(index),
          lineupSlot: index + 1,
          expectedStart: true,
          certaintyScore: 0.7,
          sourceProvider: "official-club-news",
          sourceUrl: seed.url,
          extractedAt
        }))
      );

      return { injuries, suspensions, expectedLineups };
    } catch (error) {
      logger.warn("Official club news import failed", {
        matchId: match.id,
        url: seed.url,
        message: error.message
      });
      return null;
    }
  }
};
