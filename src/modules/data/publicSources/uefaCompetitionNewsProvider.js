import { logger } from "../../../lib/logger.js";
import { isoNow } from "../../../lib/time.js";
import { fetchText, inferRoleFromSlot, normalizeName, splitPlayerList, stripHtmlToText, teamNameSimilarity } from "./shared.js";

const COMPETITION_NEWS_URLS = {
  CL: "https://www.uefa.com/uefachampionsleague/news/",
  EL: "https://www.uefa.com/uefaeuropaleague/news/"
};

const LINK_KEYWORDS = [
  "starting-line",
  "starting-and-predicted-line",
  "predicted-line",
  "possible-line",
  "team-news",
  "line-up",
  "lineup"
];

function absoluteUefaUrl(href) {
  if (!href) {
    return null;
  }

  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  if (href.startsWith("/")) {
    return `https://www.uefa.com${href}`;
  }

  return null;
}

function extractNewsLinks(html) {
  const matches = [...String(html).matchAll(/href="([^"]+)"/giu)];
  const links = [];
  const seen = new Set();

  for (const match of matches) {
    const url = absoluteUefaUrl(match[1]);

    if (!url || seen.has(url)) {
      continue;
    }

    if (!url.includes("/news/")) {
      continue;
    }

    seen.add(url);
    links.push(url);
  }

  return links;
}

function scoreNewsLink(url) {
  const normalized = normalizeName(url);

  if (LINK_KEYWORDS.some((keyword) => url.toLowerCase().includes(keyword))) {
    return 3;
  }

  if (normalized.includes("line up") || normalized.includes("team news")) {
    return 2;
  }

  return 0;
}

function articleLooksRelevant(text, match) {
  const normalizedText = normalizeName(text);
  const homeName = normalizeName(match.homeTeamName);
  const awayName = normalizeName(match.awayTeamName);

  if (homeName && awayName && normalizedText.includes(homeName) && normalizedText.includes(awayName)) {
    return true;
  }

  const articleLines = normalizedText.split(/\n+/u);
  return articleLines.some((line) =>
    teamNameSimilarity(line, match.homeTeamName) >= 0.6 &&
    teamNameSimilarity(line, match.awayTeamName) >= 0.6
  );
}

function teamHeaderMatch(line, match) {
  if (teamNameSimilarity(line, match.homeTeamName) >= 0.75) {
    return match.homeTeamName;
  }

  if (teamNameSimilarity(line, match.awayTeamName) >= 0.75) {
    return match.awayTeamName;
  }

  return null;
}

function splitSections(text, match) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const sections = [];
  let currentTeam = null;
  let currentLines = [];

  for (const line of lines) {
    const matchedTeam = teamHeaderMatch(line, match);

    if (matchedTeam) {
      if (currentTeam && currentLines.length) {
        sections.push({ teamName: currentTeam, text: currentLines.join("\n") });
      }

      currentTeam = matchedTeam;
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

function parseSection(sectionText, teamName, sourceUrl) {
  const extractedAt = isoNow();
  const injuries = [];
  const suspensions = [];
  const expectedLineups = [];
  const lineupPatterns = [
    /(?:Possible|Predicted|Starting)(?: line-?up| XI| 11)?\s*:\s*([^\n]+)/iu,
    /(?:Likely|Expected)(?: line-?up| XI| 11)?\s*:\s*([^\n]+)/iu
  ];

  for (const pattern of lineupPatterns) {
    const found = sectionText.match(pattern);

    if (found?.[1]) {
      splitPlayerList(found[1]).forEach((playerName, index) => {
        expectedLineups.push({
          teamName,
          playerName,
          playerRole: inferRoleFromSlot(index),
          lineupSlot: index + 1,
          expectedStart: true,
          certaintyScore: pattern.source.toLowerCase().includes("starting") ? 0.92 : 0.78,
          sourceProvider: "uefa-competition-news",
          sourceUrl,
          extractedAt
        });
      });
      break;
    }
  }

  const suspended = sectionText.match(/Suspended\s*:\s*([^\n]+)/iu);
  if (suspended?.[1]) {
    splitPlayerList(suspended[1]).forEach((playerName) => {
      suspensions.push({
        teamName,
        playerName,
        playerRole: null,
        status: "suspended",
        reason: "Listed as suspended in UEFA competition news.",
        returnDate: null,
        importanceScore: 0.7,
        sourceProvider: "uefa-competition-news",
        sourceUrl,
        extractedAt
      });
    });
  }

  const unavailable = sectionText.match(/(?:Unavailable|Out|Injured|Missing)\s*:\s*([^\n]+)/iu);
  if (unavailable?.[1]) {
    splitPlayerList(unavailable[1]).forEach((playerName) => {
      injuries.push({
        teamName,
        playerName,
        playerRole: null,
        status: "out",
        reason: "Listed as unavailable in UEFA competition news.",
        expectedReturn: null,
        importanceScore: 0.65,
        sourceProvider: "uefa-competition-news",
        sourceUrl,
        extractedAt
      });
    });
  }

  return { injuries, suspensions, expectedLineups };
}

async function discoverRelevantArticle(match) {
  const listingUrl = COMPETITION_NEWS_URLS[match.competitionCode];

  if (!listingUrl) {
    return null;
  }

  const html = await fetchText(listingUrl);
  const candidates = extractNewsLinks(html)
    .map((url) => ({ url, score: scoreNewsLink(url) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);

  for (const candidate of candidates) {
    try {
      const articleHtml = await fetchText(candidate.url);
      const articleText = stripHtmlToText(articleHtml);

      if (articleLooksRelevant(articleText, match)) {
        return {
          url: candidate.url,
          text: articleText
        };
      }
    } catch (error) {
      logger.warn("UEFA competition article fetch failed", {
        matchId: match.id,
        url: candidate.url,
        message: error.message
      });
    }
  }

  return null;
}

export const uefaCompetitionNewsProvider = {
  name: "uefa-competition-news",

  async collect(match) {
    const listingUrl = COMPETITION_NEWS_URLS[match.competitionCode];

    if (!listingUrl) {
      return null;
    }

    try {
      const article = await discoverRelevantArticle(match);

      if (!article) {
        return null;
      }

      const sections = splitSections(article.text, match);
      if (!sections.length) {
        return null;
      }

      const payload = sections.reduce((accumulator, section) => {
        const parsed = parseSection(section.text, section.teamName, article.url);
        accumulator.injuries.push(...parsed.injuries);
        accumulator.suspensions.push(...parsed.suspensions);
        accumulator.expectedLineups.push(...parsed.expectedLineups);
        return accumulator;
      }, { injuries: [], suspensions: [], expectedLineups: [], discoveredSources: [] });

      payload.discoveredSources.push({
        provider: "uefa-competition-news",
        sourceType: "article",
        url: article.url,
        notes: `Auto-discovered from ${listingUrl}`
      });

      return payload;
    } catch (error) {
      logger.warn("UEFA competition news discovery failed", {
        matchId: match.id,
        competitionCode: match.competitionCode,
        message: error.message
      });
      return null;
    }
  }
};
