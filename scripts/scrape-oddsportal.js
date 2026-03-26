/**
 * OddsPortal Historical Odds Scraper (Puppeteer)
 *
 * Scrapes historical 1X2 odds for Champions League + Europa League
 * from OddsPortal (up to 3 seasons) and writes CSV files into:
 *   ./data/historical-odds/
 *
 * Confirmed selectors (verified 2025-03):
 *   - Match rows:    [data-testid="game-row"]
 *   - Team names:    p tags inside [data-testid="event-participants"]
 *   - Date headers:  [data-testid="date-header"]
 *   - Odds cells:    div.flex-center.border-black-main.min-w-\\[60px\\]
 *
 * Usage:
 *   node scripts/scrape-oddsportal.js
 *   node scripts/scrape-oddsportal.js --seasons=2024-2025,2023-2024
 *   node scripts/scrape-oddsportal.js --dry-run
 *   node scripts/scrape-oddsportal.js --max-matches=30
 */

import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, "../data/historical-odds");

// ─── Config ──────────────────────────────────────────────────────────────────

const SEASONS = ["2024-2025", "2023-2024", "2022-2023"];

const TOURNAMENTS = [
  { slug: "champions-league", competitionCode: "CL", label: "Champions League" },
  { slug: "europa-league",    competitionCode: "EL", label: "Europa League" }
];

const PAGE_DELAY_MS  = 3500;
const NAV_TIMEOUT_MS = 35000;
const MAX_PAGES      = 20;

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isDryRun   = args.includes("--dry-run");
const seasonsArg = args.find((a) => a.startsWith("--seasons="));
const maxArg     = args.find((a) => a.startsWith("--max-matches="));
const maxMatches = maxArg ? Number(maxArg.split("=")[1]) : Infinity;

const activeSaisons = seasonsArg
  ? seasonsArg.split("=")[1].split(",").map((s) => s.trim())
  : SEASONS;

const compsArg = args.find((a) => a.startsWith("--competitions="));
const activeComps = compsArg
  ? compsArg.split("=")[1].split(",").map((s) => s.trim().toUpperCase())
  : null; // null = all

const activeTournaments = activeComps
  ? TOURNAMENTS.filter((t) => activeComps.includes(t.competitionCode))
  : TOURNAMENTS;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms + Math.random() * 500));
}

function normKey(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseDate(text) {
  // "07 May 2025  - Play Offs" → "2025-05-07"
  const months = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
                   Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const m = String(text ?? "").match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (!m) return null;
  const day = m[1].padStart(2, "0");
  const mon = months[m[2]] ?? null;
  if (!mon) return null;
  return `${m[3]}-${mon}-${day}`;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  "match_date", "home_team", "away_team", "competition_code",
  "bookmaker_key", "bookmaker_title", "market", "outcome_key",
  "odds", "recorded_at", "is_live"
];

function escapeCsv(v) {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath, rows) {
  const lines = [CSV_HEADERS.join(","), ...rows.map((r) => r.map(escapeCsv).join(","))];
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

function matchToCsvRows(match) {
  if (!match.matchDate || !match.homeTeam || !match.awayTeam) return [];
  if (!match.homeOdds || !match.awayOdds) return [];

  const recordedAt = `${match.matchDate}T12:00:00Z`;
  const bkKey      = match.bookmakerKey ?? "oddsportal-avg";
  const bkTitle    = match.bookmakerTitle ?? "OddsPortal Average";
  const rows       = [];

  if (match.homeOdds > 1.01) {
    rows.push([match.matchDate, match.homeTeam, match.awayTeam, match.competitionCode,
      bkKey, bkTitle, "h2h", "home", match.homeOdds.toFixed(2), recordedAt, "0"]);
  }
  if (match.drawOdds && match.drawOdds > 1.01) {
    rows.push([match.matchDate, match.homeTeam, match.awayTeam, match.competitionCode,
      bkKey, bkTitle, "h2h", "draw", match.drawOdds.toFixed(2), recordedAt, "0"]);
  }
  if (match.awayOdds > 1.01) {
    rows.push([match.matchDate, match.homeTeam, match.awayTeam, match.competitionCode,
      bkKey, bkTitle, "h2h", "away", match.awayOdds.toFixed(2), recordedAt, "0"]);
  }

  return rows;
}

// ─── Browser setup ────────────────────────────────────────────────────────────

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--window-size=1280,900"
    ],
    defaultViewport: { width: 1280, height: 900 }
  });
}

async function newPage(browser) {
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // Block only images/media (not stylesheets — needed for Vue/React rendering)
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "font", "media"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  return page;
}

async function safeGoto(page, url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      return true;
    } catch (err) {
      if (attempt === retries) {
        console.warn(`    Failed to load ${url}: ${err.message}`);
        return false;
      }
      await sleep(3000 * attempt);
    }
  }
  return false;
}

// ─── Core: extract matches from a loaded results page ────────────────────────

async function extractMatchesFromPage(page, competitionCode) {
  // Wait for game rows to appear (OddsPortal renders client-side)
  try {
    await page.waitForSelector("[data-testid='game-row']", { timeout: 12000 });
  } catch {
    // No game rows appeared — page might be empty or layout changed
  }
  await sleep(800);

  return page.evaluate((compCode) => {
    const matches = [];
    let currentDate = null;

    // Walk through eventRow containers (each groups a date + its matches)
    const eventRows = document.querySelectorAll(".eventRow");

    for (const eventRow of eventRows) {
      // Update current date if this row has a date header
      const dateHeader = eventRow.querySelector("[data-testid='date-header']");
      if (dateHeader) {
        currentDate = dateHeader.textContent.trim();
      }

      // Find game-rows inside this eventRow
      const gameRows = eventRow.querySelectorAll("[data-testid='game-row']");

      for (const gameRow of gameRows) {
        // Match URL
        const link = gameRow.querySelector("a[href*='/football/europe/']");
        if (!link) continue;
        const href = link.getAttribute("href");
        if (!href || href.endsWith("/results/") || href.endsWith("/standings/")) continue;

        // Team names: p tags inside event-participants
        const participants = gameRow.querySelector("[data-testid='event-participants']");
        const teams = participants
          ? Array.from(participants.querySelectorAll("p"))
              .map((p) => p.textContent.trim())
              .filter((t) => t.length > 0)
          : [];

        if (teams.length < 2) continue;

        const homeTeam = teams[0];
        const awayTeam = teams[1];

        // Odds: divs with flex-center + border-black-main + min-w-[60px]
        // (first 3 unique values = home/draw/away)
        const oddsDivs = Array.from(
          gameRow.querySelectorAll("div[class*='flex-center'][class*='border-black-main'][class*='min-w-[60px]']")
        );
        const oddsValues = [];
        const seen = new Set();
        for (const div of oddsDivs) {
          const val = div.textContent.trim();
          if (/^\d+\.\d{2}$/.test(val) && !seen.has(val)) {
            seen.add(val);
            oddsValues.push(parseFloat(val));
            if (oddsValues.length === 3) break;
          }
        }

        // Fallback: extract from full text (last 3 decimal numbers)
        if (oddsValues.length < 2) {
          const fullText = gameRow.textContent.trim();
          const decimals = fullText.match(/\d+\.\d{2}/g) || [];
          const last3    = decimals.slice(-3).map(Number);
          if (last3.length >= 2 && !oddsValues.length) {
            oddsValues.push(...last3);
          }
        }

        matches.push({
          homeTeam,
          awayTeam,
          matchDate: currentDate,   // raw string — will parse later
          homeOdds:  oddsValues[0] ?? null,
          drawOdds:  oddsValues[1] ?? null,
          awayOdds:  oddsValues[2] ?? null,
          matchUrl:  `https://www.oddsportal.com${href}`,
          competitionCode: compCode
        });
      }
    }

    return matches;
  }, competitionCode);
}

// ─── Pagination ────────────────────────────────────────────────────────────────

async function getPageCount(page) {
  return page.evaluate(() => {
    // Primary: OddsPortal uses .pagination-link elements with data-number attribute
    const pagLinks = document.querySelectorAll("a.pagination-link[data-number]");
    let max = 1;
    for (const a of pagLinks) {
      const n = parseInt(a.getAttribute("data-number"), 10);
      if (!isNaN(n)) max = Math.max(max, n);
    }
    if (max > 1) return max;

    // Fallback: text-based pagination
    const pagNums = document.querySelectorAll("[class*='pagination'] a, [class*='paging'] a");
    for (const a of pagNums) {
      const n = parseInt(a.textContent.trim(), 10);
      if (!isNaN(n)) max = Math.max(max, n);
    }
    return max;
  });
}

/**
 * Navigate to a specific page using OddsPortal's client-side pagination.
 * For page 1, the page is already loaded. For pages 2+, we click the
 * pagination link (identified by data-number attribute) and wait for
 * new content to appear.
 */
async function navigateToPage(page, pageNum, baseUrl) {
  if (pageNum === 1) return true;

  // Try clicking the pagination link with matching data-number
  // If the exact page isn't visible, click "Next" to advance one page at a time
  try {
    const clickResult = await page.evaluate((num) => {
      // Direct link for this page number
      const directLink = document.querySelector(`a.pagination-link[data-number="${num}"]`);
      if (directLink) { directLink.click(); return 'direct'; }
      // Fallback: "Next" button (no data-number, text = "Next")
      const allLinks = Array.from(document.querySelectorAll("a.pagination-link"));
      const nextLink = allLinks.find(a => !a.getAttribute("data-number") && a.textContent.trim() === "Next");
      if (nextLink) { nextLink.click(); return 'next'; }
      return 'none';
    }, pageNum);

    if (clickResult !== 'none') {
      // Wait for the active pagination link to change to our target page
      await page.waitForFunction(
        (num) => {
          const active = document.querySelector("a.pagination-link.active, a.pagination-link[class*='active']");
          if (!active) return false;
          const n = parseInt(active.getAttribute("data-number") || active.textContent.trim(), 10);
          return n === num;
        },
        { timeout: 15000 },
        pageNum
      );
      await sleep(1200); // extra buffer for content to render
      return true;
    }
  } catch (err) {
    console.warn(`    Pagination click failed for page ${pageNum}: ${err.message}`);
  }

  // Fallback: navigate via hash URL
  try {
    await page.goto(`${baseUrl}#/page/${pageNum}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await sleep(2500);
    return true;
  } catch (err) {
    console.warn(`    Hash navigation failed for page ${pageNum}: ${err.message}`);
    return false;
  }
}

// ─── Season scraper ───────────────────────────────────────────────────────────

async function scrapeSeason(browser, tournament, season) {
  const label = `${tournament.label} ${season}`;
  // "current" = no-year URL for the ongoing season (e.g. 2025-2026)
  const baseUrl = season === "current"
    ? `https://www.oddsportal.com/football/europe/${tournament.slug}/results/`
    : `https://www.oddsportal.com/football/europe/${tournament.slug}-${season}/results/`;

  console.log(`\n── ${label} ──`);
  console.log(`   ${baseUrl}`);

  const page = await newPage(browser);
  const allRaw = [];

  try {
    const loaded = await safeGoto(page, baseUrl);
    if (!loaded) return [];

    // Extract page 1 first (this also waits for content to fully load)
    const page1 = await extractMatchesFromPage(page, tournament.competitionCode);
    console.log(`   Page 1: ${page1.length} matches`);
    allRaw.push(...page1);

    // Get page count AFTER content is loaded (pagination is rendered after game rows)
    const totalPages = Math.min(await getPageCount(page), MAX_PAGES);
    console.log(`   Pages: ${totalPages}`);

    // Additional pages
    for (let p = 2; p <= totalPages; p++) {
      if (allRaw.length >= maxMatches) break;
      await sleep(PAGE_DELAY_MS);

      const navOk = await navigateToPage(page, p, baseUrl);
      if (!navOk) continue;

      const pageMatches = await extractMatchesFromPage(page, tournament.competitionCode);
      console.log(`   Page ${p}: ${pageMatches.length} matches`);
      allRaw.push(...pageMatches);
    }

  } finally {
    await page.close();
  }

  // Parse dates and filter
  const matches = allRaw
    .slice(0, maxMatches)
    .map((m) => ({ ...m, matchDate: parseDate(m.matchDate) }))
    .filter((m) => m.matchDate && m.homeTeam && m.awayTeam);

  console.log(`   Valid: ${matches.length} (with date + teams)`);
  const withOdds = matches.filter((m) => m.homeOdds && m.awayOdds);
  console.log(`   With odds: ${withOdds.length}`);

  return matches;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log("══════════════════════════════════════════════");
  console.log("  OddsPortal Historical Odds Scraper");
  console.log("══════════════════════════════════════════════");
  console.log(`Seasons:  ${activeSaisons.join(", ")}`);
  console.log(`Dry run:  ${isDryRun}`);
  console.log(`Max:      ${isFinite(maxMatches) ? maxMatches : "unlimited"}`);
  console.log(`Output:   ${OUTPUT_DIR}`);

  if (!isDryRun) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await launchBrowser();
  const totals  = { matches: 0, csvRows: 0, files: 0 };

  try {
    for (const tournament of activeTournaments) {
      for (const season of activeSaisons) {
        let matches;
        try {
          matches = await scrapeSeason(browser, tournament, season);
        } catch (err) {
          console.error(`   ERROR: ${err.message}`);
          continue;
        }

        if (!matches.length) {
          console.log("   No matches found — skipping.");
          continue;
        }

        // Build CSV rows
        const csvRows = matches.flatMap((m) => matchToCsvRows(m));
        console.log(`   CSV rows: ${csvRows.length}`);

        totals.matches += matches.length;
        totals.csvRows += csvRows.length;

        if (!isDryRun && csvRows.length > 0) {
          const seasonLabel = season === "current" ? "2025-2026" : season;
          const fileName = `oddsportal-${tournament.competitionCode.toLowerCase()}-${seasonLabel}.csv`;
          const filePath = path.join(OUTPUT_DIR, fileName);
          writeCsv(filePath, csvRows);
          console.log(`   Saved → ${fileName}`);
          totals.files++;
        } else if (isDryRun && csvRows.length > 0) {
          console.log("   [DRY RUN] preview:");
          csvRows.slice(0, 4).forEach((r) => console.log("    ", r.join(",")));
        }

        await sleep(PAGE_DELAY_MS);
      }
    }
  } finally {
    await browser.close().catch(() => {}); // ignore EBUSY cleanup errors on Windows
  }

  console.log("\n══════════════════════════════════════════════");
  console.log(`  Total matches: ${totals.matches}`);
  console.log(`  Total CSV rows: ${totals.csvRows}`);
  console.log(`  Files written: ${totals.files}`);

  if (totals.csvRows > 0 && !isDryRun) {
    console.log("\nNext step → import into DB:");
    console.log("  node scripts/import-historical-odds.js");
  }
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
