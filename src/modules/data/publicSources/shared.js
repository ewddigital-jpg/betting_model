export function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\b(fc|cf|sc|afc|club|the|de|da|do|di)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function teamNameSimilarity(left, right) {
  const normalizedLeft = normalizeName(left);
  const normalizedRight = normalizeName(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const leftTokens = normalizedLeft.split(" ").filter(Boolean);
  const rightTokens = normalizedRight.split(" ").filter(Boolean);
  const shared = leftTokens.filter((token) => rightTokens.includes(token));
  return shared.length / Math.max(leftTokens.length, rightTokens.length);
}

export function stripHtmlToText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])>/giu, "\n")
    .replace(/<li[^>]*>/giu, "\n- ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/\r/gu, "")
    .replace(/\n{2,}/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

export function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/gsu, "$1")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

export function splitPlayerList(value) {
  return String(value ?? "")
    .replace(/\([^)]*\)/gu, " ")
    .split(/[,;]\s*|\s+-\s+|\s+\/\s+/gu)
    .map((item) => item.trim())
    .filter((item) => item && item.length >= 3);
}

export function inferRoleFromSlot(index) {
  if (index === 0) {
    return "goalkeeper";
  }

  if (index <= 4) {
    return "defender";
  }

  if (index <= 7) {
    return "midfielder";
  }

  return "forward";
}

export async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; CodexFootballBot/1.0)"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

export function parseFeedItems(xml) {
  const source = String(xml ?? "");
  const items = [];
  const itemMatches = [...source.matchAll(/<item\b[\s\S]*?<\/item>/giu)];
  const entryMatches = [...source.matchAll(/<entry\b[\s\S]*?<\/entry>/giu)];
  const blocks = itemMatches.length ? itemMatches.map((match) => match[0]) : entryMatches.map((match) => match[0]);

  function readTag(block, tagName) {
    const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "iu");
    const found = block.match(pattern);
    return found?.[1] ? decodeHtmlEntities(found[1]).trim() : null;
  }

  function readLink(block) {
    const explicit = block.match(/<link\b[^>]*href="([^"]+)"[^>]*\/?>/iu);
    if (explicit?.[1]) {
      return explicit[1].trim();
    }

    return readTag(block, "link");
  }

  for (const block of blocks) {
    items.push({
      title: readTag(block, "title"),
      link: readLink(block),
      summary: stripHtmlToText(readTag(block, "description") ?? readTag(block, "summary") ?? ""),
      publishedAt: readTag(block, "pubDate") ?? readTag(block, "published") ?? readTag(block, "updated")
    });
  }

  return items.filter((item) => item.title && item.link);
}
