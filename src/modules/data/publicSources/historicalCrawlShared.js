import fs from "node:fs";
import path from "node:path";
import { env } from "../../../config/env.js";

const DEFAULT_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9"
};

const NAME_ALIASES = new Map([
  ["man united", "manchester united"],
  ["man utd", "manchester united"],
  ["manchester utd", "manchester united"],
  ["man city", "manchester city"],
  ["manchester city fc", "manchester city"],
  ["psg", "paris saint germain"],
  ["paris sg", "paris saint germain"],
  ["paris saint germain fc", "paris saint germain"],
  ["bayern", "bayern munich"],
  ["bayern munchen", "bayern munich"],
  ["fc bayern munchen", "bayern munich"],
  ["inter", "inter milan"],
  ["internazionale", "inter milan"],
  ["internazionale milano", "inter milan"],
  ["fc internazionale milano", "inter milan"],
  ["barca", "barcelona"],
  ["fc barcelona", "barcelona"],
  ["atletico", "atletico madrid"],
  ["club atletico de madrid", "atletico madrid"],
  ["athletic club", "athletic bilbao"],
  ["athletic club bilbao", "athletic bilbao"],
  ["athletic", "athletic bilbao"],
  ["sporting", "sporting cp"],
  ["sporting lisbon", "sporting cp"],
  ["newcastle", "newcastle united"],
  ["galatasaray sk", "galatasaray"],
  ["tottenham", "tottenham hotspur"],
  ["tottenham hotspur fc", "tottenham hotspur"],
  ["spurs", "tottenham hotspur"],
  ["liverpool fc", "liverpool"],
  ["arsenal fc", "arsenal"],
  ["chelsea fc", "chelsea"],
  ["fc copenhagen", "copenhagen"],
  ["brighton", "brighton hove albion"],
  ["brighton hove albion", "brighton hove albion"],
  ["west ham", "west ham united"],
  ["west ham united fc", "west ham united"],
  ["leeds", "leeds united"],
  ["wolves", "wolverhampton wanderers"],
  ["wolverhampton", "wolverhampton wanderers"],
  ["nottingham forest", "nottingham forest"],
  ["aston villa", "aston villa"],
  ["crystal palace", "crystal palace"],
  ["bournemouth", "afc bournemouth"],
  ["fulham", "fulham"],
  ["everton", "everton"],
  ["sunderland", "sunderland"],
  ["burnley", "burnley"],
  ["brentford", "brentford"],
  ["brentford fc", "brentford"],
  ["fc cologne", "koln"],
  ["cologne", "koln"],
  ["koln", "koln"],
  ["koln fc", "koln"],
  ["1 fc koln", "koln"],
  ["1 fc koln 01 07", "koln"],
  ["mainz 05", "mainz 05"],
  ["1 fsv mainz 05", "mainz 05"],
  ["rasenballsport leipzig", "rb leipzig"],
  ["leipzig", "rb leipzig"],
  ["rb leipzig", "rb leipzig"],
  ["borussia m gladbach", "borussia monchengladbach"],
  ["borussia mgladbach", "borussia monchengladbach"],
  ["monchengladbach", "borussia monchengladbach"],
  ["gladbach", "borussia monchengladbach"],
  ["vfb stuttgart", "stuttgart"],
  ["stuttgart", "stuttgart"],
  ["vfl wolfsburg", "wolfsburg"],
  ["wolfsburg", "wolfsburg"],
  ["fc augsburg", "augsburg"],
  ["augsburg", "augsburg"],
  ["fc heidenheim", "heidenheim"],
  ["1 fc heidenheim 1846", "heidenheim"],
  ["1 heidenheim 1846", "heidenheim"],
  ["heidenheim", "heidenheim"],
  ["st pauli", "st pauli"],
  ["fc st pauli 1910", "st pauli"],
  ["st pauli 1910", "st pauli"],
  ["real sociedad de futbol", "real sociedad"],
  ["real sociedad futbol", "real sociedad"],
  ["real betis balompie", "real betis"],
  ["real betis", "real betis"],
  ["rcd espanyol de barcelona", "espanyol"],
  ["rcd espanyol barcelona", "espanyol"],
  ["espanyol", "espanyol"],
  ["deportivo alaves", "alaves"],
  ["alaves", "alaves"],
  ["rc celta de vigo", "celta vigo"],
  ["rc celta vigo", "celta vigo"],
  ["celta vigo", "celta vigo"],
  ["rayo vallecano de madrid", "rayo vallecano"],
  ["rayo vallecano madrid", "rayo vallecano"],
  ["rayo vallecano", "rayo vallecano"],
  ["girona fc", "girona"],
  ["girona", "girona"],
  ["getafe cf", "getafe"],
  ["getafe", "getafe"],
  ["levante ud", "levante"],
  ["levante", "levante"],
  ["villarreal cf", "villarreal"],
  ["villarreal", "villarreal"],
  ["ca osasuna", "osasuna"],
  ["osasuna", "osasuna"],
  ["rcd mallorca", "mallorca"],
  ["mallorca", "mallorca"],
  ["valencia cf", "valencia"],
  ["valencia", "valencia"],
  ["elche cf", "elche"],
  ["elche", "elche"],
  ["real madrid cf", "real madrid"],
  ["real madrid", "real madrid"],
  ["bayer 04 leverkusen", "bayer leverkusen"],
  ["bayer leverkusen", "bayer leverkusen"],
  ["tsg 1899 hoffenheim", "hoffenheim"],
  ["hoffenheim", "hoffenheim"],
  ["sv werder bremen", "werder bremen"],
  ["werder bremen", "werder bremen"],
  ["1 fc union berlin", "union berlin"],
  ["1 union berlin", "union berlin"],
  ["union berlin", "union berlin"],
  ["1 fc koln", "koln"],
  ["1 koln", "koln"],
  ["genoa cfc", "genoa"],
  ["genoa", "genoa"],
  ["us lecce", "lecce"],
  ["lecce", "lecce"],
  ["us sassuolo calcio", "sassuolo"],
  ["sassuolo", "sassuolo"],
  ["ssc napoli", "napoli"],
  ["napoli", "napoli"],
  ["as roma", "roma"],
  ["roma", "roma"],
  ["bologna fc 1909", "bologna"],
  ["bologna 1909", "bologna"],
  ["bologna", "bologna"],
  ["cagliari calcio", "cagliari"],
  ["cagliari", "cagliari"],
  ["acf fiorentina", "fiorentina"],
  ["fiorentina", "fiorentina"],
  ["como 1907", "como"],
  ["como", "como"],
  ["ss lazio", "lazio"],
  ["lazio", "lazio"],
  ["atalanta bc", "atalanta"],
  ["atalanta", "atalanta"],
  ["ac pisa 1909", "pisa"],
  ["pisa", "pisa"],
  ["udinese calcio", "udinese"],
  ["udinese", "udinese"],
  ["hellas verona fc", "verona"],
  ["hellas verona", "verona"],
  ["verona", "verona"],
  ["torino fc", "torino"],
  ["torino", "torino"],
  ["juventus fc", "juventus"],
  ["juventus", "juventus"],
  ["us cremonese", "cremonese"],
  ["cremonese", "cremonese"],
  ["manchester united", "manchester united"],
  ["manchester city", "manchester city"],
  ["fk bodo glimt", "bodo glimt"],
  ["bodo glimt", "bodo glimt"]
]);

export function normalizeName(value) {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\b(fc|cf|sc|afc|club|the|de|da|do|di)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return NAME_ALIASES.get(cleaned) ?? cleaned;
}

export function tokenizeName(value) {
  return new Set(normalizeName(value).split(" ").filter(Boolean));
}

export function namesShareCoreTokens(left, right) {
  const leftTokens = [...tokenizeName(left)];
  const rightTokens = [...tokenizeName(right)];

  if (!leftTokens.length || !rightTokens.length) {
    return false;
  }

  const shared = leftTokens.filter((token) => rightTokens.includes(token));
  return shared.length >= Math.max(1, Math.min(leftTokens.length, rightTokens.length) - 1);
}

function readFirstDumpFile(dumpDirectory, extension) {
  if (!dumpDirectory || !fs.existsSync(dumpDirectory)) {
    return null;
  }

  const entries = fs.readdirSync(dumpDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .sort((left, right) => left.name.localeCompare(right.name));

  return entries.length ? path.join(dumpDirectory, entries[0].name) : null;
}

export function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/&apos;/gu, "'")
    .replace(/&nbsp;/gu, " ")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#x2F;/gu, "/")
    .replace(/&#x27;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

export function stripTags(value) {
  return decodeHtml(String(value ?? "").replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(String(value).replace(/,/gu, ".").replace(/[^\d.-]/gu, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseCsvText(contents) {
  const lines = String(contents ?? "").split(/\r?\n/u).filter((line) => line.trim());

  if (!lines.length) {
    return [];
  }

  const parseCsvLine = (line) => {
    const cells = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];

      if (char === "\"") {
        if (inQuotes && next === "\"") {
          current += "\"";
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === "," && !inQuotes) {
        cells.push(current.trim());
        current = "";
        continue;
      }

      current += char;
    }

    cells.push(current.trim());
    return cells;
  };

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

export function extractTableRows(html, tableId) {
  const directPattern = new RegExp(`<table[^>]*id="${tableId}"[^>]*>([\\s\\S]*?)</table>`, "iu");
  const direct = html.match(directPattern)?.[0];
  const commentedPattern = new RegExp(`<!--([\\s\\S]*?<table[^>]*id="${tableId}"[^>]*>[\\s\\S]*?</table>[\\s\\S]*?)-->`, "iu");
  const commented = html.match(commentedPattern)?.[1];
  const tableHtml = direct ?? commented ?? null;

  if (!tableHtml) {
    return [];
  }

  const rows = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/giu;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
    const rowHtml = rowMatch[1];
    const cellPattern = /<(td|th)([^>]*)data-stat="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/giu;
    let cellMatch;
    const row = {};

    while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
      const key = cellMatch[3];
      row[key] = stripTags(cellMatch[4]);
    }

    if (Object.keys(row).length) {
      rows.push(row);
    }
  }

  return rows;
}

export function decodeUnderstatJson(value) {
  return JSON.parse(
    String(value)
      .replace(/\\'/gu, "'")
      .replace(/\\"/gu, "\"")
      .replace(/\\\\/gu, "\\")
  );
}

export async function fetchSourceDocument(url, dumpKey, options = {}) {
  const dumpDirectory = env.historicalSourceDumpsPath && dumpKey
    ? path.join(env.historicalSourceDumpsPath, dumpKey)
    : null;
  const preferredHtmlDumpPath = dumpDirectory ? path.join(dumpDirectory, "source.html") : null;
  const preferredJsonDumpPath = dumpDirectory ? path.join(dumpDirectory, "source.json") : null;
  const preferredCsvDumpPath = dumpDirectory ? path.join(dumpDirectory, "source.csv") : null;
  const htmlDumpPath = preferredHtmlDumpPath && fs.existsSync(preferredHtmlDumpPath)
    ? preferredHtmlDumpPath
    : readFirstDumpFile(dumpDirectory, ".html");
  const jsonDumpPath = preferredJsonDumpPath && fs.existsSync(preferredJsonDumpPath)
    ? preferredJsonDumpPath
    : readFirstDumpFile(dumpDirectory, ".json");
  const csvDumpPath = preferredCsvDumpPath && fs.existsSync(preferredCsvDumpPath)
    ? preferredCsvDumpPath
    : readFirstDumpFile(dumpDirectory, ".csv");
  const headers = { ...DEFAULT_HEADERS, ...(options.headers ?? {}) };

  try {
    const response = await fetch(url, {
      headers,
      redirect: "follow"
    });

    if (response.ok) {
      return {
        ok: true,
        source: "remote",
        url,
        text: await response.text()
      };
    }
  } catch {
    // fall through to dump files
  }

  if (htmlDumpPath && fs.existsSync(htmlDumpPath)) {
    return {
      ok: true,
      source: "dump-html",
      url,
      text: fs.readFileSync(htmlDumpPath, "utf8")
    };
  }

  if (jsonDumpPath && fs.existsSync(jsonDumpPath)) {
    return {
      ok: true,
      source: "dump-json",
      url,
      text: fs.readFileSync(jsonDumpPath, "utf8")
    };
  }

  if (csvDumpPath && fs.existsSync(csvDumpPath)) {
    return {
      ok: true,
      source: "dump-csv",
      url,
      text: fs.readFileSync(csvDumpPath, "utf8")
    };
  }

  return {
    ok: false,
    source: "missing",
    url,
    text: null
  };
}
