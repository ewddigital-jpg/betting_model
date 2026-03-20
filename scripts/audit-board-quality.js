import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/db/database.js";
import { isoNow } from "../src/lib/time.js";
import { scoreOddsBoard } from "../src/modules/data/oddsBoardService.js";

const REPORT_JSON = path.resolve("reports/board-quality-audit-latest.json");
const REPORT_MD = path.resolve("reports/board-quality-audit-latest.md");
const SAMPLE_LIMIT = 24;

function readRecentMatches(limit = SAMPLE_LIMIT) {
  const db = getDb();
  return db.prepare(`
    SELECT
      matches.id,
      matches.competition_code,
      matches.utc_date,
      matches.status,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM matches
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE datetime(matches.utc_date) >= datetime('now', '-12 hours')
      AND datetime(matches.utc_date) <= datetime('now', '+48 hours')
    ORDER BY datetime(matches.utc_date) ASC, matches.id ASC
    LIMIT ?
  `).all(limit);
}

function readLatestSyncDiagnostics() {
  const db = getDb();
  const run = db.prepare(`
    SELECT summary_json
    FROM collector_runs
    WHERE summary_json IS NOT NULL AND summary_json != '{}'
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT 1
  `).get();

  if (!run?.summary_json) {
    return new Map();
  }

  try {
    const summary = JSON.parse(run.summary_json);
    const syncResults = Array.isArray(summary?.syncResults) ? summary.syncResults : [];
    return new Map(syncResults.map((entry) => [entry?.competition, entry ?? null]));
  } catch {
    return new Map();
  }
}

function collapseLatestPerBookmaker(rows) {
  const latest = new Map();

  for (const row of rows) {
    if (!latest.has(row.bookmaker_key)) {
      latest.set(row.bookmaker_key, row);
    }
  }

  return Array.from(latest.values());
}

function readMarketRows(matchId, market) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      bookmaker_key,
      bookmaker_title,
      source_provider,
      source_label,
      market,
      home_price,
      draw_price,
      away_price,
      is_live,
      retrieved_at
    FROM odds_snapshots
    WHERE match_id = ?
      AND market = ?
    ORDER BY datetime(retrieved_at) DESC, id DESC
  `).all(matchId, market);

  return collapseLatestPerBookmaker(rows);
}

function boardMarketName(market) {
  if (market === "h2h") {
    return "1X2";
  }
  if (market === "totals_2_5") {
    return "Over / Under 2.5";
  }
  return "BTTS";
}

function marketDefinitions() {
  return [
    { key: "h2h", label: "1X2" },
    { key: "totals_2_5", label: "Over / Under 2.5" },
    { key: "btts", label: "BTTS" }
  ];
}

function providerFromRows(rows) {
  const counts = new Map();

  for (const row of rows) {
    const provider = row.source_provider ?? "unknown";
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }

  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? "unknown";
}

function buildBlockReasons(boardQuality, rows, syncEntry) {
  const reasons = [];
  const quotaDegraded = String(syncEntry?.error ?? "").includes("OUT_OF_USAGE_CREDITS") ||
    String(syncEntry?.error ?? "").includes("Usage quota has been reached");

  if (!rows.length) {
    reasons.push("missing-board");
  }
  if (boardQuality.freshnessMinutes !== null && !boardQuality.refreshedRecently) {
    reasons.push("stale-odds");
  }
  if (boardQuality.bookmakerCount < 2) {
    reasons.push("missing-bookmaker-depth");
  }
  if (boardQuality.tier === "weak") {
    reasons.push("weak-board");
  }
  if (boardQuality.tier === "unusable") {
    reasons.push("unusable-board");
  }
  if (quotaDegraded) {
    reasons.push("quota-degraded");
  }

  return [...new Set(reasons)];
}

function maybeFalseNegative(boardQuality, rows, syncEntry) {
  const quotaDegraded = String(syncEntry?.error ?? "").includes("OUT_OF_USAGE_CREDITS") ||
    String(syncEntry?.error ?? "").includes("Usage quota has been reached");

  if (quotaDegraded) {
    return false;
  }

  if (!rows.length) {
    return false;
  }

  const looksOperationallyHealthy =
    boardQuality.bookmakerCount >= 3 &&
    boardQuality.refreshedRecently &&
    boardQuality.completenessScore >= 0.95 &&
    boardQuality.impliedConsistencyScore >= 0.75 &&
    boardQuality.sourceReliabilityScore >= 0.87;

  return looksOperationallyHealthy && !["strong", "usable"].includes(boardQuality.tier);
}

function summarize(auditedBoards) {
  const all = auditedBoards;
  const byTier = ["strong", "usable", "weak", "unusable"].map((tier) => ({
    tier,
    boards: all.filter((row) => row.boardQuality.tier === tier).length
  }));
  const falseNegatives = all.filter((row) => row.falseNegative);
  const stale = all.filter((row) => row.blockReasons.includes("stale-odds")).length;
  const quota = all.filter((row) => row.blockReasons.includes("quota-degraded")).length;
  const noDepth = all.filter((row) => row.blockReasons.includes("missing-bookmaker-depth")).length;

  return {
    sampledBoards: all.length,
    byTier,
    staleBoards: stale,
    quotaDegradedBoards: quota,
    missingDepthBoards: noDepth,
    falseNegatives: falseNegatives.length
  };
}

function buildMarkdown(report) {
  const lines = [
    "# Board Quality Audit",
    "",
    `Generated at: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Sampled boards: ${report.summary.sampledBoards}`,
    `- Strong: ${report.summary.byTier.find((row) => row.tier === "strong")?.boards ?? 0}`,
    `- Usable: ${report.summary.byTier.find((row) => row.tier === "usable")?.boards ?? 0}`,
    `- Weak: ${report.summary.byTier.find((row) => row.tier === "weak")?.boards ?? 0}`,
    `- Unusable: ${report.summary.byTier.find((row) => row.tier === "unusable")?.boards ?? 0}`,
    `- Stale boards: ${report.summary.staleBoards}`,
    `- Quota-degraded boards: ${report.summary.quotaDegradedBoards}`,
    `- Missing-depth boards: ${report.summary.missingDepthBoards}`,
    `- Suspected false negatives: ${report.summary.falseNegatives}`,
    "",
    "## Diagnosis",
    "",
    `- odds_market_boards rows present: ${report.inventory.persistedBoards}`,
    `- odds_snapshots in last 12h: ${report.inventory.recentOddsSnapshots}`,
    `- latest collector quota-degraded competitions: ${report.inventory.latestQuotaCompetitions.join(", ") || "none"}`,
    "",
    "## Sample",
    ""
  ];

  for (const row of report.boards.slice(0, 20)) {
    lines.push(`- ${row.match.competitionCode} ${row.match.homeTeam} vs ${row.match.awayTeam} | ${row.market.label}`);
    lines.push(`  tier=${row.boardQuality.tier} score=${row.boardQuality.score} books=${row.boardQuality.bookmakerCount} freshness=${row.boardQuality.freshnessMinutes ?? "n/a"}m target=${row.boardQuality.acceptableFreshnessMinutes}m provider=${row.provider}`);
    lines.push(`  blockReasons=${row.blockReasons.join(", ") || "none"} boardRecordedAt=${row.boardRecordedAt ?? "n/a"} syncError=${row.syncError ?? "none"}`);
  }

  if (report.falseNegativeExamples.length) {
    lines.push("");
    lines.push("## False Negative Candidates");
    lines.push("");
    for (const row of report.falseNegativeExamples) {
      lines.push(`- ${row.match.competitionCode} ${row.match.homeTeam} vs ${row.match.awayTeam} | ${row.market.label} | tier=${row.boardQuality.tier} score=${row.boardQuality.score}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const now = isoNow();
  const syncDiagnostics = readLatestSyncDiagnostics();
  const matches = readRecentMatches();
  const boards = [];

  for (const match of matches) {
    const syncEntry = syncDiagnostics.get(match.competition_code) ?? null;

    for (const market of marketDefinitions()) {
      const rows = readMarketRows(match.id, market.key);
      const boardQuality = scoreOddsBoard(rows, market.key, {
        kickoffTime: match.utc_date,
        now,
        quotaDegraded: Boolean(
          String(syncEntry?.error ?? "").includes("OUT_OF_USAGE_CREDITS") ||
          String(syncEntry?.error ?? "").includes("Usage quota has been reached")
        ),
        sourceProvider: providerFromRows(rows),
        sourceMode: "live"
      });
      const reasons = buildBlockReasons(boardQuality, rows, syncEntry);
      boards.push({
        match: {
          id: match.id,
          competitionCode: match.competition_code,
          kickoffTime: match.utc_date,
          status: match.status,
          homeTeam: match.home_team_name,
          awayTeam: match.away_team_name
        },
        market,
        provider: providerFromRows(rows),
        sourceTimestamps: rows.map((row) => row.retrieved_at).filter(Boolean),
        boardRecordedAt: rows.map((row) => row.retrieved_at).filter(Boolean).sort().at(-1) ?? null,
        bookmakerTitles: rows.map((row) => row.bookmaker_title),
        boardQuality,
        blockReasons: reasons,
        syncError: syncEntry?.error ?? null,
        falseNegative: maybeFalseNegative(boardQuality, rows, syncEntry)
      });
    }
  }

  const db = getDb();
  const inventory = {
    persistedBoards: db.prepare("SELECT COUNT(*) AS c FROM odds_market_boards").get().c,
    totalOddsSnapshots: db.prepare("SELECT COUNT(*) AS c FROM odds_snapshots").get().c,
    recentOddsSnapshots: db.prepare("SELECT COUNT(*) AS c FROM odds_snapshots WHERE datetime(retrieved_at) >= datetime('now','-12 hours')").get().c,
    latestQuotaCompetitions: Array.from(syncDiagnostics.entries())
      .filter(([, entry]) => String(entry?.error ?? "").includes("OUT_OF_USAGE_CREDITS") || String(entry?.error ?? "").includes("Usage quota has been reached"))
      .map(([competition]) => competition)
  };
  const summary = summarize(boards);
  const report = {
    generatedAt: now,
    inventory,
    summary,
    boards,
    falseNegativeExamples: boards.filter((row) => row.falseNegative).slice(0, 10)
  };

  fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(REPORT_MD, buildMarkdown(report));
  console.log(JSON.stringify({
    generatedAt: report.generatedAt,
    summary,
    inventory
  }, null, 2));
}

main();
