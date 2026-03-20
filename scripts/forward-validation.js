import fs from "node:fs";
import path from "node:path";
import { getForwardValidationReport } from "../src/modules/data/collectorService.js";

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
  lines.push(`- No-bet rate: ${report.summary.noBetRate ?? "n/a"}%`);
  lines.push(`- Average edge: ${report.summary.averageEdge ?? "n/a"}%`);
  lines.push(`- Average ROI: ${report.summary.averageRoi ?? "n/a"}%`);
  lines.push(`- Average CLV: ${report.summary.averageClv ?? "n/a"}`);
  lines.push(`- Beat closing line rate: ${report.summary.beatClosingLineRate ?? "n/a"}%`);
  lines.push(`- Stale tracked matches: ${report.summary.staleTrackedMatches}`);
  lines.push(`- Quota-degraded matches: ${report.summary.quotaDegradedMatches}`);
  lines.push(`- Weak-price bets: ${report.summary.weakPriceBets}`);
  lines.push(`- Weak-board matches: ${report.summary.weakBoardMatches}`);
  lines.push(`- Unusable-board matches: ${report.priceQuality.unusableBoardMatches}`);
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
  lines.push("## Edge Diagnosis");
  lines.push(`- Verdict: ${report.edgeDiagnosis.verdict}`);
  report.edgeDiagnosis.factors.forEach((factor) => lines.push(`- ${factor}`));

  return `${lines.join("\n")}\n`;
}

const requestedLimit = Number(process.argv[2] ?? 300);
const limit = Number.isFinite(requestedLimit) ? requestedLimit : 300;
const report = getForwardValidationReport(limit);
const reportsDir = path.join(process.cwd(), "reports");

fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(path.join(reportsDir, "forward-validation-latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
fs.writeFileSync(path.join(reportsDir, "forward-validation-latest.md"), buildMarkdown(report), "utf8");

console.log(JSON.stringify(report, null, 2));
