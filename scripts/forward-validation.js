import fs from "node:fs";
import path from "node:path";
import { buildForwardValidationLogEntry } from "../src/modules/runtime/operationsLogService.js";

process.env.DB_SKIP_MAINTENANCE = "true";

const { getForwardValidationReport } = await import("../src/modules/data/collectorService.js");

function buildMarkdown(report) {
  const renderSplit = (entry) => {
    lines.push(`- ${entry.label}`);
    lines.push(`  Tracked: ${entry.trackedMatches}`);
    lines.push(`  Bets: ${entry.bets}`);
    lines.push(`  No-bet rate: ${entry.trackedMatches ? ((entry.passes / entry.trackedMatches) * 100).toFixed(1) : "n/a"}%`);
    lines.push(`  Average edge: ${entry.averageEdge ?? "n/a"}%`);
    lines.push(`  Average ROI: ${entry.roi ?? "n/a"}%`);
    lines.push(`  Average CLV: ${entry.averageClv ?? "n/a"}`);
    lines.push(`  Beat close: ${entry.beatClosingLineRate ?? "n/a"}%`);
  };

  const lines = [];
  lines.push("# Forward Validation");
  lines.push("");
  lines.push(`- Generated at: ${report.generatedAt}`);
  lines.push(`- Tracked matches: ${report.summary.trackedMatches}`);
  lines.push(`- Bets: ${report.summary.bets}`);
  lines.push(`- Settled bets: ${report.summary.settledBets}`);
  lines.push(`- No-bet rate: ${report.summary.trackedMatches ? ((report.summary.passes / report.summary.trackedMatches) * 100).toFixed(1) : "n/a"}%`);
  lines.push(`- Average edge: ${report.summary.averageEdge ?? "n/a"}%`);
  lines.push(`- Average ROI: ${report.summary.roi ?? "n/a"}%`);
  lines.push(`- Average CLV: ${report.summary.averageClv ?? "n/a"}`);
  lines.push(`- Beat closing line rate: ${report.summary.beatClosingLineRate ?? "n/a"}%`);
  lines.push(`- Stale tracked matches: ${report.summary.staleOddsMatches}`);
  lines.push(`- Quota-degraded matches: ${report.summary.quotaDegradedMatches}`);
  lines.push(`- Weak-price bets: ${report.summary.weakPriceBets}`);
  lines.push(`- Weak-board matches: ${report.summary.weakBoardMatches}`);
  lines.push(`- Unusable-board matches: ${report.summary.unusableBoardMatches}`);
  lines.push("");

  if (report.warnings.length) {
    lines.push("## Warnings");
    report.warnings.forEach((warning) => lines.push(`- ${warning}`));
    lines.push("");
  }

  lines.push("## Market Priority");
  report.marketPriority.forEach((entry) => {
    lines.push(`- ${entry.market} (${entry.role}): ${entry.note}`);
  });
  lines.push("");

  lines.push("## Validation Splits");
  renderSplit(report.validationSplits.allTracked);
  renderSplit(report.validationSplits.strongPriceOnly);
  renderSplit(report.validationSplits.usableOrBetterOnly);
  renderSplit(report.validationSplits.settledOnly);
  renderSplit(report.validationSplits.settledStrongPriceOnly);
  lines.push("");

  lines.push("## Over / Under Focus");
  renderSplit(report.overUnderValidation.allTracked);
  renderSplit(report.overUnderValidation.strongPriceOnly);
  renderSplit(report.overUnderValidation.settledBetsOnly);
  renderSplit(report.overUnderValidation.settledStrongPriceOnly);
  lines.push("");

  lines.push("## By Market");
  report.byMarket.forEach((entry) => {
    lines.push(`- ${entry.market} [${entry.marketRole}]`);
    lines.push(`  Bets: ${entry.bets}`);
    lines.push(`  Passes: ${entry.passes}`);
    lines.push(`  Average edge: ${entry.averageEdge ?? "n/a"}%`);
    lines.push(`  Average ROI: ${entry.roi ?? "n/a"}%`);
    lines.push(`  Average CLV: ${entry.averageClv ?? "n/a"}`);
    lines.push(`  Beat close: ${entry.beatClosingLineRate ?? "n/a"}%`);
    lines.push(`  Stale odds: ${entry.staleOddsMatches}`);
    lines.push(`  Weak-price bets: ${entry.weakPriceBets}`);
  });
  lines.push("");

  lines.push("## By Confidence");
  report.byConfidence.forEach((entry) => {
    lines.push(`- ${entry.confidence}`);
    lines.push(`  Bets: ${entry.bets}`);
    lines.push(`  Settled bets: ${entry.settledBets}`);
    lines.push(`  Average ROI: ${entry.roi ?? "n/a"}%`);
  });

  lines.push("");
  lines.push("## Price Quality");
  lines.push(`- Average odds freshness: ${report.priceQuality.averageOddsFreshnessMinutes ?? "n/a"} minutes`);
  lines.push(`- Average data completeness: ${report.priceQuality.averageDataCompletenessScore ?? "n/a"}`);
  lines.push(`- Average source reliability: ${report.priceQuality.averageSourceReliabilityScore ?? "n/a"}`);
  lines.push(`- Average bookmaker depth: ${report.priceQuality.averageBookmakerDepth ?? "n/a"}`);
  lines.push(`- Usable board rate: ${report.priceQuality.usableBoardRate ?? "n/a"}%`);
  lines.push(`- Strong board rate: ${report.priceQuality.strongBoardRate ?? "n/a"}%`);
  lines.push(`- Strong-price bets: ${report.priceQuality.strongPriceBets}`);
  lines.push(`- Weak-price bets: ${report.priceQuality.weakPriceBets}`);
  lines.push(`- Fallback-used matches: ${report.priceQuality.fallbackUsedMatches}`);
  lines.push(`- Weak-board matches: ${report.priceQuality.weakBoardMatches}`);
  lines.push(`- Blocked due to unusable boards: ${report.priceQuality.blockedMatchesDueToUnusableBoards}`);
  lines.push(`- Blocked due to weak boards: ${report.priceQuality.blockedMatchesDueToWeakBoards}`);
  lines.push(`- Blocked due to any price-quality rule: ${report.priceQuality.blockedMatchesDueToPriceQuality}`);
  lines.push(`- Quota-impacted collector runs: ${report.priceQuality.quotaImpactedCollectorRuns}/${report.priceQuality.checkedCollectorRuns}`);
  lines.push("- Board tiers:");
  report.priceQuality.boardQualityTiers.forEach((entry) => lines.push(`  - ${entry.tier}: ${entry.matches}`));
  lines.push("- Board providers:");
  report.priceQuality.providers.forEach((entry) => lines.push(`  - ${entry.provider}: ${entry.matches}`));
  lines.push("- Provider health:");
  report.priceQuality.providerHealth.forEach((entry) => {
    lines.push(`  - ${entry.provider}: ${entry.matches} matches, ${entry.strongBoards} strong, ${entry.usableOrBetterBoards} usable+, ${entry.staleBoards} stale, ${entry.quotaDegradedBoards} quota-degraded, reliability ${entry.averageReliability ?? "n/a"}`);
  });
  lines.push("- Provider request health:");
  report.priceQuality.providerRequestHealth.forEach((entry) => {
    lines.push(`  - ${entry.provider}: success ${entry.successRate ?? "n/a"}%, quota-degraded ${entry.quotaDegradationRate ?? "n/a"}%, fallback ${entry.fallbackRate ?? "n/a"}%, avg odds events ${entry.averageOddsEvents ?? "n/a"}`);
  });
  lines.push("- Source reliability bands:");
  report.priceQuality.sourceReliabilityBands.forEach((entry) => lines.push(`  - ${entry.label}: ${entry.matches}`));
  lines.push("- Block reasons:");
  report.blockDiagnostics.counts.forEach((entry) => lines.push(`  - ${entry.reason}: ${entry.matches}`));

  lines.push("");
  lines.push("## Operational Diagnostics");
  lines.push(`- Aggregate tracked matches: ${report.operationalDiagnostics.aggregate.trackedMatches}`);
  lines.push(`- Aggregate stale boards: ${report.operationalDiagnostics.aggregate.staleBoards}`);
  lines.push(`- Aggregate weak boards: ${report.operationalDiagnostics.aggregate.weakBoards}`);
  lines.push(`- Aggregate unusable boards: ${report.operationalDiagnostics.aggregate.unusableBoards}`);
  lines.push(`- Aggregate usable-or-better boards: ${report.operationalDiagnostics.aggregate.usableOrBetterBoards}`);
  lines.push(`- Aggregate strong boards: ${report.operationalDiagnostics.aggregate.strongBoards}`);
  lines.push(`- Aggregate quota-degraded boards: ${report.operationalDiagnostics.aggregate.quotaDegradedBoards}`);
  lines.push(`- Aggregate fallback-used boards: ${report.operationalDiagnostics.aggregate.fallbackUsedBoards}`);
  lines.push(`- Missing board_quality_tier: ${report.operationalDiagnostics.missingFieldCounts.missingBoardQualityTier}`);
  lines.push(`- Missing market_probability: ${report.operationalDiagnostics.missingFieldCounts.missingMarketProbability}`);
  lines.push(`- Missing bookmaker_count: ${report.operationalDiagnostics.missingFieldCounts.missingBookmakerCount}`);
  lines.push(`- Settled bets: ${report.operationalDiagnostics.trustworthySampleSize.settledBets}`);
  lines.push(`- Settled price-trustworthy bets: ${report.operationalDiagnostics.trustworthySampleSize.settledPriceTrustworthyBets}`);
  lines.push(`- Settled usable-or-better bets: ${report.operationalDiagnostics.trustworthySampleSize.settledUsableOrBetterBets}`);
  lines.push(`- Settled strong-price bets: ${report.operationalDiagnostics.trustworthySampleSize.settledStrongPriceBets}`);
  lines.push("- Freshness distribution:");
  lines.push(`  - count: ${report.operationalDiagnostics.freshnessDistribution.count}`);
  lines.push(`  - median: ${report.operationalDiagnostics.freshnessDistribution.median ?? "n/a"} min`);
  lines.push(`  - p75: ${report.operationalDiagnostics.freshnessDistribution.p75 ?? "n/a"} min`);
  lines.push(`  - p90: ${report.operationalDiagnostics.freshnessDistribution.p90 ?? "n/a"} min`);
  lines.push("- Bookmaker depth distribution:");
  lines.push(`  - count: ${report.operationalDiagnostics.bookmakerDepthDistribution.count}`);
  lines.push(`  - median: ${report.operationalDiagnostics.bookmakerDepthDistribution.median ?? "n/a"}`);
  lines.push(`  - p75: ${report.operationalDiagnostics.bookmakerDepthDistribution.p75 ?? "n/a"}`);
  lines.push(`  - p90: ${report.operationalDiagnostics.bookmakerDepthDistribution.p90 ?? "n/a"}`);
  lines.push("- By provider/source:");
  report.operationalDiagnostics.byProviderSource.forEach((entry) => {
    lines.push(`  - ${entry.providerSource}: ${entry.trackedMatches} tracked, ${entry.staleBoards} stale, ${entry.weakBoards} weak, ${entry.unusableBoards} unusable, ${entry.usableOrBetterBoards} usable+, ${entry.strongBoards} strong`);
  });
  lines.push("- By provider:");
  report.operationalDiagnostics.byProvider.forEach((entry) => {
    lines.push(`  - ${entry.provider}: ${entry.trackedMatches} tracked, ${entry.staleBoards} stale, ${entry.weakBoards} weak, ${entry.unusableBoards} unusable, freshness median ${entry.freshnessDistribution.median ?? "n/a"} min`);
  });
  lines.push("- By competition:");
  report.operationalDiagnostics.byCompetition.forEach((entry) => {
    lines.push(`  - ${entry.competitionCode}: ${entry.trackedMatches} tracked, ${entry.staleBoards} stale, ${entry.weakBoards} weak, ${entry.unusableBoards} unusable, freshness median ${entry.freshnessDistribution.median ?? "n/a"} min`);
  });
  lines.push("- By provider and competition:");
  report.operationalDiagnostics.byProviderCompetition.forEach((entry) => {
    lines.push(`  - ${entry.providerCompetition}: ${entry.trackedMatches} tracked, ${entry.staleBoards} stale, ${entry.weakBoards} weak, ${entry.unusableBoards} unusable`);
  });
  lines.push("- By kickoff window:");
  report.operationalDiagnostics.byKickoffWindow.forEach((entry) => {
    lines.push(`  - ${entry.kickoffWindow}: ${entry.trackedMatches} tracked, ${entry.staleBoards} stale, ${entry.weakBoards} weak, ${entry.unusableBoards} unusable, ${entry.usableOrBetterBoards} usable+, ${entry.strongBoards} strong`);
  });
  lines.push("- Collector runs:");
  report.operationalDiagnostics.recentCollectorRuns.forEach((entry) => {
    lines.push(`  - #${entry.runId} ${entry.status} (${entry.triggerSource}): tracked ${entry.trackedMatches}, stale ${entry.staleBoards}, weak ${entry.weakBoards}, unusable ${entry.unusableBoards}, usable+ ${entry.usableOrBetterBoards}, strong ${entry.strongBoards}, quota ${entry.quotaDegradedBoards}, fallback ${entry.fallbackUsedBoards}`);
  });
  lines.push("- Run/source diagnostics:");
  lines.push(`  - cache-hit with zero events: ${report.operationalDiagnostics.runSourceDiagnostics.summary.cacheHitZeroEventsEntries} entries across ${report.operationalDiagnostics.runSourceDiagnostics.summary.cacheHitZeroEventsRuns} runs`);
  lines.push(`  - live fetch with zero events: ${report.operationalDiagnostics.runSourceDiagnostics.summary.liveFetchZeroEventsEntries} entries across ${report.operationalDiagnostics.runSourceDiagnostics.summary.liveFetchZeroEventsRuns} runs`);
  lines.push(`  - quota-degraded entries: ${report.operationalDiagnostics.runSourceDiagnostics.summary.quotaDegradedEntries} across ${report.operationalDiagnostics.runSourceDiagnostics.summary.quotaDegradedRuns} runs`);
  lines.push(`  - tracked entries with no fresh odds: ${report.operationalDiagnostics.runSourceDiagnostics.summary.noFreshOddsForTrackedEntries} across ${report.operationalDiagnostics.runSourceDiagnostics.summary.noFreshOddsForTrackedRuns} runs`);
  lines.push("- By request strategy:");
  report.operationalDiagnostics.runSourceDiagnostics.summary.byRequestStrategy.forEach((entry) => {
    lines.push(`  - ${entry.requestStrategy}: ${entry.trackedMatchCount} tracked matches, ${entry.oddsEvents} odds events, ${entry.quotaDegradedEntries} quota-degraded entries, ${entry.fallbackUsedEntries} fallback entries, ${entry.noFreshOddsEntries} no-fresh entries`);
  });
  lines.push("- Worst latest snapshot ages:");
  report.operationalDiagnostics.latestSnapshotAgeByMatch.slice(0, 10).forEach((entry) => {
    lines.push(`  - ${entry.competitionCode} ${entry.homeTeam} vs ${entry.awayTeam}: ${entry.oddsFreshnessMinutes ?? "n/a"} min, provider ${entry.boardProvider}/${entry.boardSourceMode}, tier ${entry.boardQualityTier ?? "n/a"}`);
  });

  lines.push("");
  lines.push("## Edge Diagnosis");
  lines.push(`- Verdict: ${report.edgeDiagnosis.verdict}`);
  report.edgeDiagnosis.factors.forEach((factor) => lines.push(`- ${factor}`));

  lines.push("");
  lines.push("## Calibration Audit");
  lines.push(`- Tracked rows: ${report.calibrationAudit.samples.trackedRows}`);
  lines.push(`- Bet rows: ${report.calibrationAudit.samples.betRows}`);
  lines.push(`- Settled bet rows: ${report.calibrationAudit.samples.settledBetRows}`);
  lines.push("- Settled bet probability buckets:");
  report.calibrationAudit.settledBetProbabilityBuckets.forEach((entry) => {
    lines.push(`  - ${entry.bucket}: ${entry.settledBets} bets, avg model ${entry.averagePredictedProbability ?? "n/a"}, avg market ${entry.averageMarketProbability ?? "n/a"}, hit ${entry.hitRate ?? "n/a"}%`);
  });
  lines.push("- By market:");
  report.calibrationAudit.byMarket.forEach((entry) => {
    lines.push(`  - ${entry.market}: ${entry.settledBets} settled bets`);
    entry.probabilityBuckets.forEach((bucket) => {
      lines.push(`    - ${bucket.bucket}: ${bucket.settledBets} bets, avg model ${bucket.averagePredictedProbability ?? "n/a"}, hit ${bucket.hitRate ?? "n/a"}%`);
    });
  });

  lines.push("");
  lines.push("## Edge Quality");
  lines.push(`- Tracked rows: ${report.edgeQualityAudit.samples.trackedRows}`);
  lines.push(`- Bet rows: ${report.edgeQualityAudit.samples.betRows}`);
  lines.push(`- Settled bet rows: ${report.edgeQualityAudit.samples.settledBetRows}`);
  lines.push("- Settled bet edge buckets:");
  report.edgeQualityAudit.settledBetEdgeBuckets.forEach((entry) => {
    lines.push(`  - ${entry.bucket}: ${entry.settledBets} bets, avg edge ${entry.averageEdge ?? "n/a"}%, avg ROI ${entry.averageRoi ?? "n/a"}%, avg CLV ${entry.averageClv ?? "n/a"}, hit ${entry.hitRate ?? "n/a"}%`);
  });
  lines.push("- By market:");
  report.edgeQualityAudit.byMarket.forEach((entry) => {
    lines.push(`  - ${entry.market}: ${entry.settledBets} settled bets`);
    entry.edgeBuckets.forEach((bucket) => {
      lines.push(`    - ${bucket.bucket}: ${bucket.settledBets} bets, avg ROI ${bucket.averageRoi ?? "n/a"}%, avg CLV ${bucket.averageClv ?? "n/a"}`);
    });
  });

  return `${lines.join("\n")}\n`;
}

const requestedLimit = Number(process.argv[2] ?? 300);
const limit = Number.isFinite(requestedLimit) ? requestedLimit : 300;
const report = getForwardValidationReport(limit);
const reportsDir = path.join(process.cwd(), "reports");
const operationsHistoryPath = path.join(reportsDir, "forward-validation-history.jsonl");

fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(path.join(reportsDir, "forward-validation-latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
fs.writeFileSync(path.join(reportsDir, "forward-validation-latest.md"), buildMarkdown(report), "utf8");
fs.appendFileSync(operationsHistoryPath, `${JSON.stringify(buildForwardValidationLogEntry(report))}\n`, "utf8");

console.log(JSON.stringify(report, null, 2));
