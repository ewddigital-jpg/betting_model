import { fetchSourceDocument, normalizeName, stripTags } from "./historicalCrawlShared.js";

const TRANSFERMARKT_COMPETITIONS = [
  {
    code: "CL",
    url: "https://www.transfermarkt.com/champions-league/startseite/wettbewerb/CL",
    dumpKey: "transfermarkt-cl"
  },
  {
    code: "EL",
    url: "https://www.transfermarkt.com/europa-league/startseite/wettbewerb/EL",
    dumpKey: "transfermarkt-el"
  },
  {
    code: "UECL",
    url: "https://www.transfermarkt.com/europa-conference-league/startseite/wettbewerb/UECL",
    dumpKey: "transfermarkt-uecl"
  }
];

function extractTeamLinks(html, competitionCode) {
  const links = [];
  const pattern = /<a([^>]+)href="([^"]*\/verein\/[^"]+)"([^>]*)>([\s\S]*?)<\/a>/giu;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const attributes = `${match[1]} ${match[3]}`;
    const href = match[2];
    const anchorBody = match[4];
    const titleAttribute = attributes.match(/title="([^"]+)"/iu)?.[1] ?? null;
    const title = stripTags(titleAttribute ?? anchorBody);

    if (!title) {
      continue;
    }

    links.push({
      competitionCode,
      teamName: title,
      normalizedTeam: normalizeName(title),
      url: href.startsWith("http") ? href : `https://www.transfermarkt.com${href}`,
      sourceProvider: "transfermarkt",
      sourceType: "competition-team-link"
    });
  }

  return Array.from(
    new Map(links.map((entry) => [`${entry.competitionCode}::${entry.normalizedTeam}`, entry])).values()
  );
}

export async function crawlTransfermarktHistoricalData() {
  const results = [];

  for (const competition of TRANSFERMARKT_COMPETITIONS) {
    const document = await fetchSourceDocument(competition.url, competition.dumpKey, {
      headers: { referer: "https://www.transfermarkt.com/" }
    });

    results.push({
      competitionCode: competition.code,
      source: document.source,
      teamLinks: document.ok ? extractTeamLinks(document.text, competition.code) : []
    });
  }

  return results;
}
