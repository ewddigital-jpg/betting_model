import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/db/database.js";
import { repairTeamIdentityLeaks } from "../src/modules/data/historicalCrawlerService.js";

const REPORT_JSON = "team-identity-audit-latest.json";
const REPORT_MD = "team-identity-audit-latest.md";

function readRows(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

function readRow(sql, ...params) {
  return getDb().prepare(sql).get(...params);
}

function buildMatchingLogicInventory() {
  return [
    {
      area: "odds ingestion and event matching",
      file: "src/modules/data/syncService.js",
      functions: ["teamNameSimilarity", "matchOddsEvent", "pickOutcomePrice", "mapBookmakerMarketRows"]
    },
    {
      area: "historical enrichment and team normalization",
      file: "src/modules/data/historicalCrawlerService.js",
      functions: ["resolveTeamCandidates", "resolveMatch", "scoreCandidate", "repairKnownIdentityIssues"]
    },
    {
      area: "shared source-side normalization",
      file: "src/modules/data/publicSources/historicalCrawlShared.js",
      functions: ["normalizeName", "namesShareCoreTokens"]
    },
    {
      area: "availability import team assignment",
      file: "src/modules/data/importers/availabilityImporter.js",
      functions: ["teamIdForName"]
    },
    {
      area: "news import team assignment",
      file: "src/modules/data/importers/newsImporter.js",
      functions: ["teamIdForName"]
    },
    {
      area: "advanced stats import matching",
      file: "src/modules/data/importers/xgImporter.js",
      functions: ["resolveMatch", "resolveTeamId"]
    },
    {
      area: "historical odds import matching",
      file: "src/modules/data/importers/historicalOddsImporter.js",
      functions: ["resolveMatch", "normalizeOutcomeKey"]
    },
    {
      area: "shared safe team-side resolution",
      file: "src/modules/data/teamIdentity.js",
      functions: ["resolveMatchTeamSide", "resolveMatchTeamId"]
    }
  ];
}

function readAnomalies() {
  const advancedWrongTeamCount = readRow(`
    SELECT COUNT(*) AS count
    FROM team_match_advanced_stats s
    JOIN matches m ON m.id = s.match_id
    WHERE s.team_id NOT IN (m.home_team_id, m.away_team_id)
  `).count;

  const advancedWrongTeamExamples = readRows(`
    SELECT
      s.id,
      s.match_id,
      m.competition_code,
      m.utc_date,
      home.name AS home_team,
      away.name AS away_team,
      t.name AS stat_team,
      s.source_provider,
      s.xg,
      s.xga
    FROM team_match_advanced_stats s
    JOIN matches m ON m.id = s.match_id
    JOIN teams home ON home.id = m.home_team_id
    JOIN teams away ON away.id = m.away_team_id
    JOIN teams t ON t.id = s.team_id
    WHERE s.team_id NOT IN (m.home_team_id, m.away_team_id)
    ORDER BY datetime(m.utc_date) DESC
    LIMIT 20
  `);

  const domesticCompetitionLeaks = readRows(`
    SELECT
      t.id,
      t.name,
      GROUP_CONCAT(DISTINCT m.competition_code) AS competitions,
      COUNT(DISTINCT CASE WHEN m.competition_code IN ('PL','PD','BL1','SA','FL1') THEN m.competition_code END) AS domestic_comp_count,
      COUNT(*) AS appearances
    FROM teams t
    JOIN matches m ON m.home_team_id = t.id OR m.away_team_id = t.id
    GROUP BY t.id, t.name
    HAVING domestic_comp_count > 1
    ORDER BY domestic_comp_count DESC, appearances DESC
  `);

  const tlaCollisions = readRows(`
    SELECT tla, COUNT(*) AS count, GROUP_CONCAT(name, ' | ') AS teams
    FROM teams
    WHERE tla IS NOT NULL AND trim(tla) != ''
    GROUP BY tla
    HAVING COUNT(*) > 1
    ORDER BY count DESC, tla ASC
    LIMIT 25
  `);

  const nullOrWrongTeamAssignments = {
    sourceLinksWrongTeam: readRow(`
      SELECT COUNT(*) AS count
      FROM availability_source_links r
      JOIN matches m ON m.id = r.match_id
      WHERE r.team_id IS NOT NULL AND r.team_id NOT IN (m.home_team_id, m.away_team_id)
    `).count,
    newsWrongTeam: readRow(`
      SELECT COUNT(*) AS count
      FROM team_news_records r
      JOIN matches m ON m.id = r.match_id
      WHERE r.team_id IS NOT NULL AND r.team_id NOT IN (m.home_team_id, m.away_team_id)
    `).count,
    injuriesWrongTeam: readRow(`
      SELECT COUNT(*) AS count
      FROM injury_records r
      JOIN matches m ON m.id = r.match_id
      WHERE r.team_id NOT IN (m.home_team_id, m.away_team_id)
    `).count,
    lineupsWrongTeam: readRow(`
      SELECT COUNT(*) AS count
      FROM expected_lineup_records r
      JOIN matches m ON m.id = r.match_id
      WHERE r.team_id NOT IN (m.home_team_id, m.away_team_id)
    `).count
  };

  const mergedSample = readRows(`
    SELECT
      m.id AS match_id,
      m.competition_code,
      m.utc_date,
      home.name AS home_team,
      away.name AS away_team,
      (SELECT COUNT(*) FROM odds_snapshots os WHERE os.match_id = m.id) AS odds_rows,
      (SELECT COUNT(*) FROM team_match_advanced_stats ts WHERE ts.match_id = m.id) AS advanced_rows,
      (SELECT COUNT(*) FROM expected_lineup_records el WHERE el.match_id = m.id) AS lineup_rows,
      (SELECT COUNT(*) FROM team_news_records tn WHERE tn.match_id = m.id) AS news_rows
    FROM matches m
    JOIN teams home ON home.id = m.home_team_id
    JOIN teams away ON away.id = m.away_team_id
    WHERE (
      (SELECT COUNT(*) FROM odds_snapshots os WHERE os.match_id = m.id) > 0
      OR (SELECT COUNT(*) FROM team_match_advanced_stats ts WHERE ts.match_id = m.id) > 0
      OR (SELECT COUNT(*) FROM expected_lineup_records el WHERE el.match_id = m.id) > 0
      OR (SELECT COUNT(*) FROM team_news_records tn WHERE tn.match_id = m.id) > 0
    )
    ORDER BY datetime(m.utc_date) DESC
    LIMIT 30
  `);

  return {
    advancedWrongTeamCount,
    advancedWrongTeamExamples,
    domesticCompetitionLeaks,
    tlaCollisions,
    nullOrWrongTeamAssignments,
    mergedSample
  };
}

function summarizeSeverity(anomalies) {
  const findings = [];

  if (anomalies.advancedWrongTeamCount > 0) {
    findings.push({
      severity: "critical",
      title: "Advanced stats attached to non-match teams",
      count: anomalies.advancedWrongTeamCount,
      details: "These rows poison feature generation directly because xG and shot data are attached to a team that is not the home or away side."
    });
  }

  for (const leak of anomalies.domesticCompetitionLeaks) {
    findings.push({
      severity: "critical",
      title: `Team appears in multiple domestic leagues: ${leak.name}`,
      count: leak.appearances,
      details: `Competitions: ${leak.competitions}`
    });
  }

  if (anomalies.tlaCollisions.length) {
    findings.push({
      severity: "high",
      title: "TLA collisions make abbreviation-based matching unsafe",
      count: anomalies.tlaCollisions.length,
      details: anomalies.tlaCollisions.map((row) => `${row.tla}: ${row.teams}`).join("; ")
    });
  }

  return findings;
}

function buildMarkdown(report) {
  const lines = [];
  lines.push("# Team Identity Audit");
  lines.push("");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Matching Logic");
  lines.push("");
  for (const item of report.matchingLogic) {
    lines.push(`- ${item.area}: \`${item.file}\` -> ${item.functions.join(", ")}`);
  }
  lines.push("");
  lines.push("## Severity Summary");
  lines.push("");
  for (const finding of report.severitySummary) {
    lines.push(`- ${finding.severity.toUpperCase()}: ${finding.title} (${finding.count})`);
    lines.push(`  ${finding.details}`);
  }
  lines.push("");
  lines.push("## Repair Result");
  lines.push("");
  lines.push(`- Brentford/Brest repair applied: ${report.repair.applied ? "yes" : "no"}`);
  lines.push(`- Matches repaired: ${report.repair.repairedBrentfordMatches}`);
  lines.push(`- Advanced-stat rows repaired: ${report.repair.repairedAdvancedRows}`);
  lines.push("");
  lines.push("## Post-Repair Validation");
  lines.push("");
  lines.push(`- Advanced stats on non-match teams: ${report.postRepair.advancedWrongTeamCount}`);
  lines.push(`- Domestic competition leaks remaining: ${report.postRepair.domesticCompetitionLeaks.length}`);
  lines.push("");
  lines.push("## Example Mismatches");
  lines.push("");
  for (const example of report.preRepair.advancedWrongTeamExamples.slice(0, 10)) {
    lines.push(`- ${example.competition_code} ${example.utc_date}: ${example.home_team} vs ${example.away_team} had advanced stats for ${example.stat_team} (${example.source_provider})`);
  }
  lines.push("");
  lines.push("## Remaining Risks");
  lines.push("");
  for (const risk of report.remainingRisks) {
    lines.push(`- ${risk}`);
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const preRepair = readAnomalies();
  const repairStats = repairTeamIdentityLeaks();
  const postRepair = readAnomalies();
  const report = {
    generatedAt: new Date().toISOString(),
    matchingLogic: buildMatchingLogicInventory(),
    preRepair,
    repair: {
      applied: (repairStats.repairedBrentfordMatches ?? 0) > 0 || (repairStats.repairedAdvancedRows ?? 0) > 0,
      ...repairStats
    },
    postRepair,
    severitySummary: summarizeSeverity(preRepair),
    remainingRisks: [
      "Historical enrichment previously allowed exact TLA matching, which is unsafe for collisions like BRE and FCB. This audit removed TLA from exact historical team matching.",
      "Odds rows do not preserve source-side team labels, so odds-side identity validation is limited to event linkage and not raw source labels.",
      "Provider-specific source IDs are still stored in a single teams.source_team_id column, which limits multi-provider identity provenance."
    ]
  };

  const reportsDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, REPORT_JSON), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(reportsDir, REPORT_MD), buildMarkdown(report));

  console.log(JSON.stringify({
    generatedAt: report.generatedAt,
    repaired: report.repair,
    preRepair: {
      advancedWrongTeamCount: report.preRepair.advancedWrongTeamCount,
      domesticCompetitionLeaks: report.preRepair.domesticCompetitionLeaks.length
    },
    postRepair: {
      advancedWrongTeamCount: report.postRepair.advancedWrongTeamCount,
      domesticCompetitionLeaks: report.postRepair.domesticCompetitionLeaks.length
    }
  }, null, 2));
}

main();
