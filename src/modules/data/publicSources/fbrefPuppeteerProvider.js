import fs from "node:fs";
import path from "node:path";
import { env } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import { extractTableRows, parseCsvText, parseNumber, stripTags, normalizeName } from "./historicalCrawlShared.js";

const DUMP_MAX_AGE_HOURS = 12;

function getDumpDir(dumpKey) {
  if (!env.historicalSourceDumpsPath || !dumpKey) {
    return null;
  }
  return path.join(env.historicalSourceDumpsPath, dumpKey);
}

function getDumpFilePath(dumpKey) {
  const dir = getDumpDir(dumpKey);
  return dir ? path.join(dir, "source.html") : null;
}

function isDumpFresh(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
    return ageHours < DUMP_MAX_AGE_HOURS;
  } catch {
    return false;
  }
}

function saveDumpFile(dumpKey, html) {
  const dir = getDumpDir(dumpKey);
  if (!dir) {
    return;
  }
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(dir, "source.html"), html, "utf8");
  } catch (error) {
    logger.warn("fbrefPuppeteer: failed to save dump file", { dumpKey, error: error.message });
  }
}

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CHROME_USER_DATA = "C:\\Users\\danie\\AppData\\Local\\Google\\Chrome\\User Data";

async function launchBrowser() {
  const { default: puppeteer } = await import("puppeteer");
  const launchOptions = {
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--lang=en-US",
      "--window-size=1280,800",
      "--disable-extensions"
    ]
  };

  // Use real Chrome with actual user profile — carries real Cloudflare cookies
  if (fs.existsSync(CHROME_PATH)) {
    launchOptions.executablePath = CHROME_PATH;
  }
  if (fs.existsSync(CHROME_USER_DATA)) {
    launchOptions.userDataDir = CHROME_USER_DATA;
  }

  return puppeteer.launch(launchOptions);
}

function isCloudflareChallenge(html) {
  return html.includes("Just a moment") || html.includes("challenge-platform") || html.includes("cf-browser-verification");
}

async function fetchPageHtml(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    await page.setViewport({ width: 1280, height: 800 });

    // Remove webdriver fingerprint
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for Cloudflare challenge to resolve (up to 15 seconds)
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const html = await page.content();
      if (!isCloudflareChallenge(html) && html.length > 50000) {
        return html;
      }
    }

    // Final read regardless
    return await page.content();
  } finally {
    await page.close();
  }
}

export async function fetchFbrefScheduleWithPuppeteer(url, dumpKey) {
  const dumpFilePath = getDumpFilePath(dumpKey);

  if (isDumpFresh(dumpFilePath)) {
    logger.info("fbrefPuppeteer: using fresh dump file", { dumpKey });
    return {
      ok: true,
      source: "puppeteer-cache",
      url,
      text: fs.readFileSync(dumpFilePath, "utf8")
    };
  }

  logger.info("fbrefPuppeteer: launching browser for", { url });
  let browser;
  try {
    browser = await launchBrowser();
    const html = await fetchPageHtml(browser, url);

    if (!html || html.length < 50000 || isCloudflareChallenge(html)) {
      logger.warn("fbrefPuppeteer: page blocked or too short", { url, length: html?.length, cloudflare: isCloudflareChallenge(html ?? "") });
      return { ok: false, source: "puppeteer-blocked", url, text: null };
    }

    saveDumpFile(dumpKey, html);
    logger.info("fbrefPuppeteer: page fetched and cached", { dumpKey, bytes: html.length });

    return { ok: true, source: "puppeteer-live", url, text: html };
  } catch (error) {
    logger.error("fbrefPuppeteer: browser error", { url, error: error.message });
    return { ok: false, source: "puppeteer-error", url, text: null };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function parseScheduleRows(rows, competitionCode) {
  return rows
    .filter((row) => row.date && row.home_team && row.away_team)
    .map((row) => {
      const [homeScore, awayScore] = String(row.score ?? "").split(/[–-]/u).map((value) => parseNumber(value));
      return {
        competitionCode,
        matchDate: row.date,
        homeTeam: stripTags(row.home_team),
        awayTeam: stripTags(row.away_team),
        normalizedHome: normalizeName(row.home_team),
        normalizedAway: normalizeName(row.away_team),
        homeScore,
        awayScore,
        homeXg: parseNumber(row.home_xg ?? row.xg_home),
        awayXg: parseNumber(row.away_xg ?? row.xg_away),
        homeShots: parseNumber(row.home_sh ?? row.sh_home ?? row.home_shots),
        awayShots: parseNumber(row.away_sh ?? row.sh_away ?? row.away_shots),
        venue: row.venue ? stripTags(row.venue) : null,
        sourceProvider: "fbref",
        sourceType: "schedule"
      };
    });
}

function extractRows(html, competitionCode) {
  for (const tableId of ["sched_all", "sched_2025-2026_1", "sched_2024-2025_1", "sched_2023-2024_1", "sched_2022-2023_1"]) {
    const rows = parseScheduleRows(extractTableRows(html, tableId), competitionCode);
    if (rows.length) {
      return rows;
    }
  }
  return [];
}

const SEASON_TARGETS = [
  // CL
  {
    code: "CL",
    season: "current",
    dumpKey: "fbref-cl-schedule-current",
    url: "https://fbref.com/en/comps/8/schedule/Champions-League-Scores-and-Fixtures"
  },
  {
    code: "CL",
    season: "2024-2025",
    dumpKey: "fbref-cl-schedule-2024-2025",
    url: "https://fbref.com/en/comps/8/2024-2025/schedule/2024-2025-Champions-League-Scores-and-Fixtures"
  },
  {
    code: "CL",
    season: "2023-2024",
    dumpKey: "fbref-cl-schedule-2023-2024",
    url: "https://fbref.com/en/comps/8/2023-2024/schedule/2023-2024-Champions-League-Scores-and-Fixtures"
  },
  {
    code: "CL",
    season: "2022-2023",
    dumpKey: "fbref-cl-schedule-2022-2023",
    url: "https://fbref.com/en/comps/8/2022-2023/schedule/2022-2023-Champions-League-Scores-and-Fixtures"
  },
  // EL
  {
    code: "EL",
    season: "current",
    dumpKey: "fbref-el-schedule-current",
    url: "https://fbref.com/en/comps/19/schedule/Europa-League-Scores-and-Fixtures"
  },
  {
    code: "EL",
    season: "2024-2025",
    dumpKey: "fbref-el-schedule-2024-2025",
    url: "https://fbref.com/en/comps/19/2024-2025/schedule/2024-2025-Europa-League-Scores-and-Fixtures"
  },
  {
    code: "EL",
    season: "2023-2024",
    dumpKey: "fbref-el-schedule-2023-2024",
    url: "https://fbref.com/en/comps/19/2023-2024/schedule/2023-2024-Europa-League-Scores-and-Fixtures"
  },
  {
    code: "EL",
    season: "2022-2023",
    dumpKey: "fbref-el-schedule-2022-2023",
    url: "https://fbref.com/en/comps/19/2022-2023/schedule/2022-2023-Europa-League-Scores-and-Fixtures"
  }
];

export async function crawlFbrefWithPuppeteer() {
  const results = [];

  for (const target of SEASON_TARGETS) {
    const document = await fetchFbrefScheduleWithPuppeteer(target.url, target.dumpKey);

    let matches = [];
    let parseError = null;

    if (document.ok && document.text) {
      try {
        matches = extractRows(document.text, target.code);
      } catch (error) {
        parseError = error.message;
      }
    }

    const xgMatches = matches.filter((row) => row.homeXg !== null && row.awayXg !== null);

    logger.info("fbrefPuppeteer: season crawled", {
      code: target.code,
      season: target.season,
      source: document.source,
      totalRows: matches.length,
      xgRows: xgMatches.length
    });

    results.push({
      competitionCode: target.code,
      season: target.season,
      dumpKey: target.dumpKey,
      scheduleSource: document.source,
      matches: xgMatches,
      allMatches: matches.length,
      parseError: parseError ?? null
    });
  }

  return results;
}
