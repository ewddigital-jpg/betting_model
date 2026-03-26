import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDb } from "../../db/database.js";
import { round } from "../../lib/math.js";
import { isoNow } from "../../lib/time.js";
import { runBlindEvaluation } from "./backtestService.js";
import { getDecisionPolicyStatus } from "./decisionPolicyParameters.js";
import { getModelTrainingStatus } from "./modelParameters.js";
import { buildTrustReadiness } from "./trustReadinessService.js";
import { getCollectorStatus, getPerformanceDashboard } from "../data/collectorService.js";
import { getBackgroundJobStatus } from "../runtime/backgroundJobs.js";
import { getUpcomingMatchesView } from "../reporting/viewModels.js";

function severityRank(priority) {
  if (priority === "P1") {
    return 1;
  }

  if (priority === "P2") {
    return 2;
  }

  return 3;
}

function matchesByStatus(matches) {
  return {
    playableLate: matches.filter((match) => match.shortlistLabel === "Playable Late"),
    checkAgain: matches.filter((match) => match.shortlistLabel === "Check Again"),
    ignore: matches.filter((match) => match.shortlistLabel === "Ignore Completely")
  };
}

function readHistoricalOddsCoverage(limit = 120) {
  const db = getDb();
  return db.prepare(`
    WITH finished_sample AS (
      SELECT id
      FROM matches
      WHERE status = 'FINISHED'
        AND home_score IS NOT NULL
        AND away_score IS NOT NULL
      ORDER BY datetime(utc_date) DESC
      LIMIT ?
    )
    SELECT
      COUNT(DISTINCT finished_sample.id) AS finished_matches,
      COUNT(DISTINCT CASE WHEN odds_snapshots.id IS NOT NULL THEN finished_sample.id END) AS with_odds
    FROM finished_sample
    LEFT JOIN odds_snapshots ON odds_snapshots.match_id = finished_sample.id
  `).get(limit);
}

function readHistoricalLineupCoverage(limit = 120) {
  const db = getDb();
  return db.prepare(`
    WITH finished_sample AS (
      SELECT id
      FROM matches
      WHERE status = 'FINISHED'
        AND home_score IS NOT NULL
        AND away_score IS NOT NULL
      ORDER BY datetime(utc_date) DESC
      LIMIT ?
    )
    SELECT
      COUNT(DISTINCT finished_sample.id) AS finished_matches,
      COUNT(DISTINCT CASE WHEN expected_lineup_records.id IS NOT NULL THEN finished_sample.id END) AS with_lineups
    FROM finished_sample
    LEFT JOIN expected_lineup_records ON expected_lineup_records.match_id = finished_sample.id
  `).get(limit);
}

function buildAuditFindings({
  trustReadiness,
  dashboard,
  blindTest,
  modelStatus,
  decisionPolicyStatus,
  collectorStatus,
  backgroundJobs,
  upcomingMatches,
  historicalOdds,
  historicalLineups
}) {
  const findings = [];
  const latestCollector = collectorStatus?.latestRun ?? null;
  const settledBets = dashboard?.summary?.settledBets ?? 0;
  const blindLeanAccuracy = blindTest?.summary?.leanAccuracy ?? null;
  const blindLogLoss = blindTest?.summary?.logLoss ?? null;
  const avgBrier = [
    blindTest?.calibration?.oneXTwo?.brier,
    blindTest?.calibration?.totals25?.brier,
    blindTest?.calibration?.btts?.brier
  ].filter(Number.isFinite);
  const calibrationAverage = avgBrier.length
    ? round(avgBrier.reduce((sum, value) => sum + value, 0) / avgBrier.length, 4)
    : null;

  if ((trustReadiness?.trustPercent ?? 0) < 60) {
    findings.push({
      priority: "P1",
      title: "System credibility is still low",
      detail: `Trust readiness is ${trustReadiness?.trustPercent ?? 0}% against an 80% target. The app is still in evidence-building mode, not proven mode.`,
      action: "Improve proof before adding more aggression: keep archiving odds, keep grading forward bets, and stay conservative on markets without late team-news clarity.",
      prompt: "Review the trust-readiness blockers and tighten whichever factor is hurting the score most right now without making the model more reckless."
    });
  }

  // Only flag collector as broken if core app competitions (CL/EL) failed.
  // History-competition failures (PL, PD, BL1 etc.) from a missing football-data key are non-critical.
  const appCompResults = latestCollector?.summary?.results?.filter((r) =>
    ["CL", "EL"].includes(r?.competition)
  ) ?? [];
  const appCompFailed = appCompResults.some((r) => r?.error);
  const noRunAtAll = !latestCollector;
  if (noRunAtAll || appCompFailed) {
    findings.push({
      priority: "P1",
      title: "Latest collector run is not fully clean",
      detail: `The latest collector status is ${latestCollector?.status ?? "unknown"}. Partial or failed syncs can poison confidence and stale the pre-match view.`,
      action: "Inspect the latest sync errors first and stabilize data freshness before changing the model logic.",
      prompt: "Inspect the latest collector summary, identify the failing provider or rate-limit issue, and make the data pipeline more robust without reducing coverage."
    });
  }

  if ((historicalOdds?.with_odds ?? 0) < Math.floor((historicalOdds?.finished_matches ?? 0) * 0.7)) {
    findings.push({
      priority: "P1",
      title: "Historical odds coverage is still too thin",
      detail: `Only ${historicalOdds?.with_odds ?? 0} of the last ${historicalOdds?.finished_matches ?? 0} finished matches have archived bookmaker prices.`,
      action: "Improve odds matching and pre-kickoff snapshot depth. Without historical prices, the betting layer cannot be trained honestly.",
      prompt: "Audit why finished matches are missing odds snapshots and improve the odds-matching or snapshot strategy so more historical bets become trainable."
    });
  }

  if ((historicalLineups?.with_lineups ?? 0) < Math.floor((historicalLineups?.finished_matches ?? 0) * 0.75)) {
    findings.push({
      priority: "P2",
      title: "Historical lineup archive is incomplete",
      detail: `Only ${historicalLineups?.with_lineups ?? 0} of the last ${historicalLineups?.finished_matches ?? 0} finished matches have stored confirmed lineups.`,
      action: "Keep backfilling finished fixtures and improve source coverage for missing lineup rows.",
      prompt: "Audit which finished competitions or teams still lack archived lineups and improve the historical lineup backfill coverage."
    });
  }

  if ((blindLeanAccuracy ?? 0) < 50) {
    findings.push({
      priority: "P1",
      title: "Blind lean accuracy is still weak",
      detail: `The latest blind sample lean accuracy is ${blindLeanAccuracy ?? 0}% with log loss ${blindLogLoss ?? "n/a"}. The football view still misses too many balanced matches.`,
      action: "Reduce overconfidence in marginal 1X2 edges and review which factors are dominating the lean too much.",
      prompt: "Analyze the last blind-sample misses, identify the recurring failure pattern in 1X2 leans, and tighten the weakest factor or guardrail."
    });
  }

  if ((calibrationAverage ?? 1) > 0.24) {
    findings.push({
      priority: "P1",
      title: "Probability calibration is still loose",
      detail: `Average Brier score across supported markets is about ${calibrationAverage}. The probabilities still read less sharply than they should.`,
      action: "Calibrate output probabilities and reduce confidence inflation in unstable bands.",
      prompt: "Audit the blind calibration buckets and tighten the most overconfident probability bands without flattening the entire model."
    });
  }

  if ((settledBets ?? 0) < 25) {
    findings.push({
      priority: "P2",
      title: "Forward graded bet sample is still small",
      detail: `Only ${settledBets} settled forward bets are graded in the live dashboard.`,
      action: "Keep collecting and grading. Do not overreact to short-term ROI noise yet.",
      prompt: "Review the forward recommendation history and improve the grading dashboard or evidence tracking rather than forcing more bets."
    });
  }

  if (!decisionPolicyStatus?.active) {
    findings.push({
      priority: "P2",
      title: "Separate decision policies are not promoted yet",
      detail: "The market-specific decision layer still has not earned promotion, which means 1X2, totals, and BTTS are still relying on conservative defaults.",
      action: "Increase priced historical evidence and refine the policy trainer before trying to promote a market layer.",
      prompt: "Inspect the decision-policy training blockers and improve the priced historical sample so market-specific policies can be trained honestly."
    });
  }

  if ((backgroundJobs?.collector?.lastStatus ?? null) === "failed" || (backgroundJobs?.reminders?.lastStatus ?? null) === "failed") {
    findings.push({
      priority: "P2",
      title: "At least one background job is unstable",
      detail: "Collector or reminder automation has failed recently, which weakens late data quality and lineup alerts.",
      action: "Stabilize the failing background job and reduce silent degradation.",
      prompt: "Inspect the background job status and harden the failing automation path so late data refreshes stay reliable."
    });
  }

  if (!upcomingMatches.length) {
    findings.push({
      priority: "P3",
      title: "No upcoming matches are in view",
      detail: "The app currently has no upcoming shortlist to judge, so the audit should focus on historical evidence and data freshness instead.",
      action: "Check sync windows and competition date coverage.",
      prompt: "Audit why the upcoming match view is empty and verify sync windows, competition scopes, and fixture ingestion."
    });
  }

  return findings.sort((left, right) => severityRank(left.priority) - severityRank(right.priority));
}

function buildRecommendedTasks(findings, upcomingMatches) {
  const shortlist = matchesByStatus(upcomingMatches);
  const tasks = findings.slice(0, 5).map((finding, index) => ({
    rank: index + 1,
    priority: finding.priority,
    title: finding.title,
    action: finding.action,
    prompt: finding.prompt
  }));

  if (shortlist.checkAgain.length) {
    tasks.push({
      rank: tasks.length + 1,
      priority: "P2",
      title: "Re-check the best shortlist matches near kickoff",
      action: `Current shortlist to re-check: ${shortlist.checkAgain.slice(0, 3).map((match) => match.matchName).join("; ")}.`,
      prompt: "Review the current 'Check Again' shortlist, inspect what is still missing on those matches, and tighten the late-match decision support."
    });
  }

  return tasks.slice(0, 6);
}

function buildMarkdownReport(audit) {
  const lines = [
    "# Project Audit",
    "",
    `Generated: ${audit.generatedAt}`,
    "",
    "## Scoreboard",
    `- Trust readiness: ${audit.scoreboard.trustPercent}% / 80% target`,
    `- Blind lean accuracy: ${audit.scoreboard.blindLeanAccuracy ?? "n/a"}%`,
    `- Blind log loss: ${audit.scoreboard.blindLogLoss ?? "n/a"}`,
    `- Settled forward bets: ${audit.scoreboard.forwardSettledBets}`,
    `- Historical odds coverage: ${audit.scoreboard.historicalOddsCoverage}`,
    `- Historical lineup coverage: ${audit.scoreboard.historicalLineupCoverage}`,
    "",
    "## Findings"
  ];

  for (const finding of audit.findings) {
    lines.push(`- [${finding.priority}] ${finding.title}: ${finding.detail}`);
    lines.push(`  Action: ${finding.action}`);
  }

  lines.push("", "## Recommended Tasks");

  for (const task of audit.recommendedTasks) {
    lines.push(`- [${task.priority}] ${task.title}: ${task.action}`);
    lines.push(`  Prompt: ${task.prompt}`);
  }

  return lines.join("\n");
}

export function buildProjectAudit({ competitionCode = null, blindLimit = 140 } = {}) {
  const dashboard = getPerformanceDashboard(blindLimit, competitionCode);
  const blindTest = runBlindEvaluation(competitionCode, blindLimit);
  const modelStatus = getModelTrainingStatus();
  const decisionPolicyStatus = getDecisionPolicyStatus();
  const collectorStatus = getCollectorStatus();
  const backgroundJobs = getBackgroundJobStatus();
  const trustReadiness = buildTrustReadiness({
    competitionCode,
    dashboard,
    blindTest,
    modelStatus,
    decisionPolicyStatus
  });
  const upcomingMatches = getUpcomingMatchesView(competitionCode);
  const historicalOdds = readHistoricalOddsCoverage(Math.max(120, blindLimit));
  const historicalLineups = readHistoricalLineupCoverage(Math.max(120, blindLimit));
  const findings = buildAuditFindings({
    trustReadiness,
    dashboard,
    blindTest,
    modelStatus,
    decisionPolicyStatus,
    collectorStatus,
    backgroundJobs,
    upcomingMatches,
    historicalOdds,
    historicalLineups
  });
  const recommendedTasks = buildRecommendedTasks(findings, upcomingMatches);

  return {
    generatedAt: isoNow(),
    competitionCode,
    scoreboard: {
      trustPercent: trustReadiness.trustPercent,
      blindLeanAccuracy: blindTest?.summary?.leanAccuracy ?? null,
      blindLogLoss: blindTest?.summary?.logLoss ?? null,
      forwardSettledBets: dashboard?.summary?.settledBets ?? 0,
      historicalOddsCoverage: `${historicalOdds?.with_odds ?? 0}/${historicalOdds?.finished_matches ?? 0}`,
      historicalLineupCoverage: `${historicalLineups?.with_lineups ?? 0}/${historicalLineups?.finished_matches ?? 0}`,
      collectorStatus: collectorStatus?.latestRun?.status ?? null,
      latestTrainingStatus: modelStatus?.latest?.status ?? null,
      latestDecisionStatus: decisionPolicyStatus?.latest?.status ?? null
    },
    findings,
    recommendedTasks,
    prompts: recommendedTasks.map((task) => task.prompt),
    trustReadiness,
    dashboardSummary: dashboard?.summary ?? null,
    blindSummary: blindTest?.summary ?? null,
    upcomingShortlist: matchesByStatus(upcomingMatches)
  };
}

export function writeProjectAuditReport(options = {}) {
  const audit = buildProjectAudit(options);
  const reportsDir = path.resolve("reports");
  mkdirSync(reportsDir, { recursive: true });

  const jsonPath = path.join(reportsDir, "project-audit-latest.json");
  const mdPath = path.join(reportsDir, "project-audit-latest.md");

  writeFileSync(jsonPath, JSON.stringify(audit, null, 2));
  writeFileSync(mdPath, buildMarkdownReport(audit));

  return {
    ...audit,
    reportPaths: {
      json: jsonPath,
      markdown: mdPath
    }
  };
}
