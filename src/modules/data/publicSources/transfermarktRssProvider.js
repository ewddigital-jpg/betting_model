import { isoNow } from "../../../lib/time.js";
import { fetchText, normalizeName, parseFeedItems, teamNameSimilarity } from "./shared.js";

function scoreHeadline(item, match) {
  const title = normalizeName(item.title);
  const summary = normalizeName(item.summary);
  const homeName = normalizeName(match.homeTeamName);
  const awayName = normalizeName(match.awayTeamName);
  const teamName = normalizeName(match.seedTeamName ?? "");

  let score = 0;

  if (teamName && (title.includes(teamName) || summary.includes(teamName))) {
    score += 0.55;
  }

  if (homeName && (title.includes(homeName) || summary.includes(homeName))) {
    score += 0.35;
  }

  if (awayName && (title.includes(awayName) || summary.includes(awayName))) {
    score += 0.35;
  }

  if (teamNameSimilarity(item.title, match.homeTeamName) >= 0.75 || teamNameSimilarity(item.title, match.awayTeamName) >= 0.75) {
    score += 0.25;
  }

  if (/(injur|suspend|return|comeback|lineup|line-up|team news|absence|doubtful|out|fit)/iu.test(`${item.title} ${item.summary}`)) {
    score += 0.15;
  }

  return Math.min(1, score);
}

export const transfermarktRssProvider = {
  name: "transfermarkt-rss",

  async collect(match, seed) {
    if (!seed?.url) {
      return null;
    }

    const xml = await fetchText(seed.url);
    const extractedAt = isoNow();
    const items = parseFeedItems(xml)
      .map((item) => ({
        ...item,
        relevanceScore: scoreHeadline(item, {
          ...match,
          seedTeamName: seed.teamName ?? null
        })
      }))
      .filter((item) => item.relevanceScore >= 0.35)
      .slice(0, 8)
      .map((item) => ({
        teamName: seed.teamName ?? null,
        title: item.title,
        summary: item.summary || null,
        url: item.link,
        publishedAt: item.publishedAt ?? null,
        relevanceScore: item.relevanceScore,
        sourceProvider: "transfermarkt-rss",
        sourceType: "rss",
        extractedAt
      }));

    if (!items.length) {
      return null;
    }

    return {
      headlines: items,
      discoveredSources: [
        {
          provider: "transfermarkt-rss",
          sourceType: "rss",
          url: seed.url,
          notes: "RSS-based news feed, no page scraping."
        }
      ]
    };
  }
};
