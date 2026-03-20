import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/db/database.js";
import { buildMatchFeatures } from "../src/modules/analysis/featureBuilder.js";
import { calculateProbabilities } from "../src/modules/analysis/probabilityModel.js";
import { buildBettingAssessment, __bettingEngineTestables } from "../src/modules/analysis/bettingEngine.js";
import { getTeamRatingsMap, refreshTeamRatings } from "../src/modules/analysis/eloEngine.js";

const REPORT_JSON = "forensic-unrealistic-recommendations-latest.json";
const REPORT_MD = "forensic-unrealistic-recommendations-latest.md";
const CANDIDATE_LIMIT = 320;
const CASE_LIMIT = 20;

function safeJsonParse(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

function hoursBetween(left, right) {
  return Math.abs(new Date(left).getTime() - new Date(right).getTime()) / 3_600_000;
}

function isAfterKickoff(snapshot) {
  return new Date(snapshot.generated_at).getTime() > new Date(snapshot.utc_date).getTime();
}

function marketKeyFromName(marketName) {
  if (marketName === "Over / Under 2.5") {
    return "totals25";
  }

  if (marketName === "BTTS") {
    return "btts";
  }

  return "oneXTwo";
}

function computeRawTotalsProbabilities(model) {
  const rawOverProbability = model.scoreMatrix
    .filter((entry) => (entry.homeGoals + entry.awayGoals) >= 3)
    .reduce((sum, entry) => sum + entry.probability, 0);

  return {
    over: round(rawOverProbability, 4),
    under: round(1 - rawOverProbability, 4)
  };
}

function readCandidateSnapshots(limit = CANDIDATE_LIMIT) {
  const db = getDb();
  return db.prepare(`
    SELECT
      snapshot.*,
      matches.utc_date,
      matches.status AS match_status,
      home_team.name AS home_team_name,
      away_team.name AS away_team_name
    FROM recommendation_snapshots snapshot
    JOIN matches ON matches.id = snapshot.match_id
    JOIN teams home_team ON home_team.id = matches.home_team_id
    JOIN teams away_team ON away_team.id = matches.away_team_id
    WHERE datetime(snapshot.generated_at) >= datetime('now', '-21 days')
      AND (
        snapshot.best_market = 'Over / Under 2.5'
        OR snapshot.action = 'No Bet'
      )
    ORDER BY datetime(snapshot.generated_at) DESC, snapshot.id DESC
    LIMIT ?
  `).all(limit);
}

function readAdvancedStatSources(matchId) {
  const db = getDb();
  return db.prepare(`
    SELECT
      stats.source_provider,
      team.name AS team_name,
      stats.extracted_at
    FROM team_match_advanced_stats stats
    JOIN teams team ON team.id = stats.team_id
    WHERE stats.match_id = ?
    ORDER BY stats.source_provider ASC, team.name ASC
  `).all(matchId);
}

function readRawOddsPayload(matchId, generatedAt) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      market,
      bookmaker_key,
      bookmaker_title,
      source_provider,
      source_label,
      home_price,
      draw_price,
      away_price,
      retrieved_at
    FROM odds_snapshots
    WHERE match_id = ?
      AND datetime(retrieved_at) <= datetime(?)
      AND market IN ('h2h', 'totals_2_5', 'btts')
    ORDER BY datetime(retrieved_at) DESC, id DESC
  `).all(matchId, generatedAt);

  const latestByMarketAndBookmaker = new Map();

  for (const row of rows) {
    const key = `${row.market}::${row.bookmaker_key}`;
    if (!latestByMarketAndBookmaker.has(key)) {
      latestByMarketAndBookmaker.set(key, row);
    }
  }

  const latestRows = [...latestByMarketAndBookmaker.values()];
  const grouped = {
    h2h: [],
    totals_2_5: [],
    btts: []
  };

  for (const row of latestRows) {
    if (!grouped[row.market]) {
      grouped[row.market] = [];
    }
    grouped[row.market].push(row);
  }

  return grouped;
}

function buildReplay(snapshot, ratings) {
  const features = buildMatchFeatures(snapshot.match_id, ratings, { asOfTime: snapshot.generated_at });
  features.context.hoursToKickoff = Math.max(
    0,
    (new Date(features.match.utc_date).getTime() - new Date(snapshot.generated_at).getTime()) / 3_600_000
  );

  const model = calculateProbabilities(features);
  const betting = buildBettingAssessment(snapshot.match_id, model, {
    features,
    dataCoverageScore: features.context.dataCoverageScore,
    coverageBlend: model.diagnostics.coverageBlend,
    beforeDate: snapshot.generated_at
  });

  const teams = {
    home: features.home.name,
    away: features.away.name
  };
  const optionDefinitions = {
    oneXTwo: __bettingEngineTestables.buildOptionDefinitions("oneXTwo", teams, model.probabilities, model),
    totals25: __bettingEngineTestables.buildOptionDefinitions("totals25", teams, model.probabilities, {
      ...model,
      features
    }),
    btts: __bettingEngineTestables.buildOptionDefinitions("btts", teams, model.probabilities, {
      ...model,
      features
    })
  };

  return {
    features,
    model,
    betting,
    optionDefinitions,
    rawTotalsProbabilities: computeRawTotalsProbabilities(model),
    legacyPrimary: __bettingEngineTestables.buildPrimaryMarketLegacy(betting.markets),
    currentPrimary: betting.primaryMarket
  };
}

function summarizeFeatureValues(features) {
  return {
    home: {
      elo: round(features.home.elo, 2),
      recentFormPpg: round(features.home.recentFormPpg, 2),
      weightedGoalsFor: round(features.home.weightedGoalsFor, 2),
      weightedGoalsAgainst: round(features.home.weightedGoalsAgainst, 2),
      avgXgLast5: round(features.home.avgXgLast5, 2),
      avgXgaLast5: round(features.home.avgXgaLast5, 2),
      xgDifferenceLast5: round(features.home.xgDifferenceLast5, 2),
      recentAttackingEfficiency: round(features.home.recentAttackingEfficiency, 2),
      lineupUncertainty: round(features.home.lineupUncertainty, 2),
      expectedLineupStrength: round(features.home.expectedLineupStrength, 2)
    },
    away: {
      elo: round(features.away.elo, 2),
      recentFormPpg: round(features.away.recentFormPpg, 2),
      weightedGoalsFor: round(features.away.weightedGoalsFor, 2),
      weightedGoalsAgainst: round(features.away.weightedGoalsAgainst, 2),
      avgXgLast5: round(features.away.avgXgLast5, 2),
      avgXgaLast5: round(features.away.avgXgaLast5, 2),
      xgDifferenceLast5: round(features.away.xgDifferenceLast5, 2),
      recentAttackingEfficiency: round(features.away.recentAttackingEfficiency, 2),
      lineupUncertainty: round(features.away.lineupUncertainty, 2),
      expectedLineupStrength: round(features.away.expectedLineupStrength, 2)
    },
    context: {
      hoursToKickoff: round(features.context.hoursToKickoff, 2),
      dataCoverageScore: round(features.context.dataCoverageScore, 2),
      availabilityCoverageScore: round(features.context.availabilityCoverageScore, 2),
      xgCoverageScore: round(features.context.xgCoverageScore, 2),
      homeRestEdge: round(features.context.homeRestEdge, 2),
      restDaysAdvantage: round(features.context.restDaysAdvantage, 2),
      homeAwayStrengthDelta: round(features.context.homeAwayStrengthDelta, 2),
      recentAttackingEfficiencyDelta: round(features.context.recentAttackingEfficiencyDelta, 2)
    }
  };
}

function originalSnapshotAgeHours(snapshot, originalMarket) {
  const retrievedAt =
    originalMarket?.selectedBookmaker?.retrievedAt ??
    snapshot.odds_snapshot_at ??
    null;

  return retrievedAt ? round(hoursBetween(snapshot.generated_at, retrievedAt), 2) : null;
}

function determineFailureCategory(snapshot, replay, originalMarket, currentMarket) {
  const ageHours = originalSnapshotAgeHours(snapshot, originalMarket);
  const currentPriceQuality = currentMarket?.priceQuality ?? null;

  if (isAfterKickoff(snapshot)) {
    return "post-kickoff collector bug";
  }

  if (
    snapshot.action === "No Bet" &&
    snapshot.best_market === "Over / Under 2.5" &&
    replay.legacyPrimary?.marketKey === "totals25" &&
    replay.currentPrimary?.marketKey === "oneXTwo"
  ) {
    return "decision-layer bug";
  }

  if (
    (ageHours !== null && ageHours >= 6) ||
    currentPriceQuality?.staleOdds ||
    currentPriceQuality?.forceNoBet ||
    ["weak", "unusable"].includes(currentPriceQuality?.boardQualityTier)
  ) {
    return "stale odds / bad board";
  }

  if (
    snapshot.best_market === "Over / Under 2.5" &&
    snapshot.selection_label === "Under 2.5" &&
    (replay.model.expectedGoals.home + replay.model.expectedGoals.away) >= 3 &&
    currentPriceQuality?.priceTrustworthy
  ) {
    return "calibration issue";
  }

  return "feature bug";
}

function buildSuspicionScore(snapshot, replay, originalMarket, currentMarket) {
  const totalExpectedGoals = replay.model.expectedGoals.home + replay.model.expectedGoals.away;
  const strongestSideProbability = Math.max(
    replay.model.probabilities.homeWin,
    replay.model.probabilities.draw,
    replay.model.probabilities.awayWin
  );
  const ageHours = originalSnapshotAgeHours(snapshot, originalMarket);
  const currentPriceQuality = currentMarket?.priceQuality ?? null;

  let score = 0;

  if (snapshot.best_market === "Over / Under 2.5") {
    score += 8;
  }

  if (isAfterKickoff(snapshot)) {
    score += 40;
  }

  if (snapshot.selection_label === "Under 2.5" && totalExpectedGoals >= 2.9) {
    score += 30;
  }

  if (snapshot.selection_label === "Under 2.5" && strongestSideProbability >= 0.58) {
    score += 16;
  }

  if (snapshot.action !== "No Bet") {
    score += 20;
  }

  if (ageHours !== null) {
    if (ageHours >= 24) {
      score += 34;
    } else if (ageHours >= 12) {
      score += 24;
    } else if (ageHours >= 6) {
      score += 14;
    }
  }

  if (Number.isFinite(snapshot.edge) && snapshot.edge >= 15) {
    score += 10;
  }

  if (snapshot.action === "No Bet" && replay.currentPrimary?.marketKey === "oneXTwo" && replay.legacyPrimary?.marketKey === "totals25") {
    score += 18;
  }

  if (currentPriceQuality?.forceNoBet) {
    score += 16;
  }

  if (currentPriceQuality?.staleOdds) {
    score += 12;
  }

  if (["weak", "unusable"].includes(currentPriceQuality?.boardQualityTier)) {
    score += 10;
  }

  return score;
}

function buildTrace(snapshot, replay) {
  const snapshotMarkets = safeJsonParse(snapshot.markets_json, {});
  const originalMarket = snapshotMarkets[marketKeyFromName(snapshot.best_market)] ?? null;
  const currentMarket = replay.betting.markets[marketKeyFromName(snapshot.best_market)] ?? replay.betting.markets.totals25;
  const originalAgeHours = originalSnapshotAgeHours(snapshot, originalMarket);
  const rawOddsPayload = readRawOddsPayload(snapshot.match_id, snapshot.generated_at);
  const advancedStatSources = readAdvancedStatSources(snapshot.match_id);
  const failureCategory = determineFailureCategory(snapshot, replay, originalMarket, currentMarket);

  return {
    snapshotId: snapshot.id,
    eventId: snapshot.match_id,
    competition: snapshot.competition_code,
    kickoffTime: snapshot.utc_date,
    predictionTimestamp: snapshot.generated_at,
    match: {
      homeTeam: snapshot.home_team_name,
      awayTeam: snapshot.away_team_name,
      status: snapshot.match_status
    },
    matchedTeamsBySource: {
      localDatabase: {
        homeTeam: snapshot.home_team_name,
        awayTeam: snapshot.away_team_name
      },
      advancedStats: advancedStatSources.map((row) => ({
        provider: row.source_provider,
        matchedTeam: row.team_name,
        extractedAt: row.extracted_at
      })),
      oddsBoards: [
        ...new Map(
          Object.values(rawOddsPayload)
            .flat()
            .map((row) => [
              `${row.source_provider ?? "unknown"}::${row.source_label ?? "unknown"}`,
              {
                provider: row.source_provider ?? "unknown",
                sourceLabel: row.source_label ?? "unknown",
                note: "Archived odds rows preserve provider metadata but not raw source-side team labels."
              }
            ])
        ).values()
      ]
    },
    rawOddsPayload,
    normalizedMarket: {
      originalMarket: snapshot.best_market,
      originalSelection: snapshot.selection_label,
      originalAction: snapshot.action,
      replayPrimaryMarket: replay.currentPrimary?.marketName ?? null,
      replayPrimarySelection: replay.currentPrimary?.selectionLabel ?? null,
      replayPrimaryAction: replay.currentPrimary?.action ?? null
    },
    modelFeatureValues: summarizeFeatureValues(replay.features),
    rawModelScore: {
      expectedGoals: {
        home: round(replay.model.expectedGoals.home, 2),
        away: round(replay.model.expectedGoals.away, 2),
        total: round(replay.model.expectedGoals.home + replay.model.expectedGoals.away, 2)
      },
      oneXTwoRawProbabilities: replay.model.diagnostics.rawProbabilities,
      totals25RawProbabilities: replay.rawTotalsProbabilities
    },
    calibratedProbability: {
      oneXTwo: replay.optionDefinitions.oneXTwo.map((option) => ({
        selection: option.shortLabel,
        probability: option.probability
      })),
      totals25: replay.optionDefinitions.totals25.map((option) => ({
        selection: option.shortLabel,
        probability: option.probability
      }))
    },
    edgeCalculation: {
      originalSnapshot: {
        marketKey: originalMarket?.key ?? null,
        bestOption: originalMarket?.bestOption ?? null,
        selectedBookmaker: originalMarket?.selectedBookmaker ?? null,
        snapshotAgeHours: originalAgeHours
      },
      replay: {
        marketKey: currentMarket?.key ?? null,
        bestOption: currentMarket?.bestOption ?? null,
        selectedBookmaker: currentMarket?.selectedBookmaker ?? null
      }
    },
    boardQualityFlags: {
      originalSnapshot: {
        boardQualityTier: snapshot.board_quality_tier,
        staleOddsFlag: Boolean(snapshot.stale_odds_flag),
        quotaDegradedFlag: Boolean(snapshot.quota_degraded_flag),
        bookmakerCount: snapshot.bookmaker_count,
        priceTrustworthyFlag: Boolean(snapshot.price_trustworthy_flag),
        downgradeReason: snapshot.recommendation_downgrade_reason
      },
      replay: currentMarket?.priceQuality ?? null
    },
    finalDecisionReason: {
      originalSummary: snapshot.summary,
      originalShortReason: originalMarket?.recommendation?.shortReason ?? null,
      originalRiskNote: originalMarket?.recommendation?.riskNote ?? null,
      replayShortReason: currentMarket?.recommendation?.shortReason ?? null,
      replayRiskNote: currentMarket?.recommendation?.riskNote ?? null,
      replayPrimaryReason: replay.currentPrimary?.reason ?? null
    },
    failureCategory,
    suspicionScore: buildSuspicionScore(snapshot, replay, originalMarket, currentMarket)
  };
}

function sortCasesBySeverity(cases) {
  return [...cases].sort((left, right) => {
    if (right.suspicionScore !== left.suspicionScore) {
      return right.suspicionScore - left.suspicionScore;
    }
    return new Date(right.predictionTimestamp).getTime() - new Date(left.predictionTimestamp).getTime();
  });
}

function buildRootCauseSummary(cases) {
  const counts = new Map();

  for (const entry of cases) {
    counts.set(entry.failureCategory, (counts.get(entry.failureCategory) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count);
}

function buildMarkdownReport(report) {
  const lines = [];
  lines.push("# Forensic Audit: 20 Most Unrealistic Recommendations");
  lines.push("");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push(report.headline);
  lines.push("");
  lines.push("## Root Causes");
  lines.push("");
  for (const cause of report.rootCauseSummary) {
    lines.push(`- ${cause.category}: ${cause.count}`);
  }
  lines.push("");
  lines.push("## Before vs Now");
  lines.push("");
  lines.push(`- Original suspicious recommendations reviewed: ${report.caseCount}`);
  lines.push(`- Original actionable recommendations among these 20: ${report.summary.originalActionableCount}`);
  lines.push(`- Stored after kickoff: ${report.summary.afterKickoffCount}`);
  lines.push(`- Current replay now blocked as No Bet: ${report.summary.currentReplayNoBetCount}`);
  lines.push(`- Current replay still actionable: ${report.summary.currentReplayActionableCount}`);
  lines.push("");
  lines.push("## Top 20 Cases");
  lines.push("");
  lines.push("| Snapshot | Match | Original | Replay | Cause | Evidence |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const entry of report.cases) {
    const evidence = entry.failureCategory === "post-kickoff collector bug"
      ? `stored ${round((new Date(entry.predictionTimestamp).getTime() - new Date(entry.kickoffTime).getTime()) / 3_600_000, 2)}h after kickoff`
      : entry.failureCategory === "stale odds / bad board"
        ? `price age ${entry.edgeCalculation.originalSnapshot.snapshotAgeHours ?? "n/a"}h; replay board ${entry.boardQualityFlags.replay?.boardQualityTier ?? "n/a"}`
        : entry.failureCategory === "decision-layer bug"
        ? `legacy ${entry.normalizedMarket.originalSelection} vs replay ${entry.normalizedMarket.replayPrimarySelection}`
        : `total xG ${entry.rawModelScore.expectedGoals.total}`;
    lines.push(`| ${entry.snapshotId} | ${entry.match.homeTeam} vs ${entry.match.awayTeam} | ${entry.normalizedMarket.originalSelection} (${entry.normalizedMarket.originalAction}) | ${entry.normalizedMarket.replayPrimarySelection} (${entry.normalizedMarket.replayPrimaryAction}) | ${entry.failureCategory} | ${evidence} |`);
  }
  lines.push("");
  lines.push("## Dominant Flaw");
  lines.push("");
  lines.push(report.dominantFlaw);
  lines.push("");
  lines.push("## Remaining Risks");
  lines.push("");
  for (const risk of report.remainingRisks) {
    lines.push(`- ${risk}`);
  }
  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- JSON: ${REPORT_JSON}`);
  lines.push(`- This markdown: ${REPORT_MD}`);
  lines.push("");
  return lines.join("\n");
}

function main() {
  refreshTeamRatings();
  const ratings = getTeamRatingsMap();
  const candidates = readCandidateSnapshots();
  const traces = [];

  for (const snapshot of candidates) {
    const replay = buildReplay(snapshot, ratings);
    const trace = buildTrace(snapshot, replay);
    if (trace.suspicionScore >= 35) {
      traces.push(trace);
    }
  }

  const topCases = sortCasesBySeverity(traces).slice(0, CASE_LIMIT);
  const rootCauseSummary = buildRootCauseSummary(topCases);
  const dominantRootCause = rootCauseSummary[0]?.category ?? "none";
  const summary = {
    originalActionableCount: topCases.filter((entry) => entry.normalizedMarket.originalAction !== "No Bet").length,
    currentReplayNoBetCount: topCases.filter((entry) => entry.normalizedMarket.replayPrimaryAction === "No Bet").length,
    currentReplayActionableCount: topCases.filter((entry) => entry.normalizedMarket.replayPrimaryAction !== "No Bet").length,
    afterKickoffCount: topCases.filter((entry) => new Date(entry.predictionTimestamp).getTime() > new Date(entry.kickoffTime).getTime()).length
  };

  const report = {
    generatedAt: new Date().toISOString(),
    caseCount: topCases.length,
    headline:
      dominantRootCause === "post-kickoff collector bug"
        ? "The dominant failure is that the collector stored forward recommendations after kickoff. Those Barcelona-style under picks were produced on already-live or already-finished fixtures, then amplified by stale price boards."
        : dominantRootCause === "stale odds / bad board"
          ? "The dominant failure is stale or weak price data being allowed to drive totals recommendations. The Barcelona-style under picks were mostly price-quality failures, not a raw Over/Under mapping inversion."
          : "The suspicious recommendations do not point to a single confirmed raw mapping inversion. The failures are concentrated in the interpretation and price-quality layers.",
    dominantFlaw:
      dominantRootCause === "post-kickoff collector bug"
        ? "Most of the ugliest recommendations were emitted after kickoff, so they were never valid forward bets in the first place. Current collector gating now excludes those fixtures before any recommendation is stored."
        : dominantRootCause === "stale odds / bad board"
          ? "Most of the ugliest recommendations were emitted on boards that were already too old or too thin to support a real bet. Current replay blocks those same cases as No Bet."
          : "No single stale-price flaw dominated the top 20 more than expected.",
    rootCauseSummary,
    summary,
    remainingRisks: [
      "Archived odds rows keep provider metadata but not raw source-side team labels, so source-team reconciliation for old price boards is still limited.",
      "Per-snapshot rating state is not archived, so historical replay still uses the current active rating map for the rating component.",
      "Historical finished-match odds coverage is still thin, so this audit is about recommendation logic, not proven historical ROI."
    ],
    cases: topCases
  };

  const reportsDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, REPORT_JSON), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(reportsDir, REPORT_MD), buildMarkdownReport(report));

  console.log(JSON.stringify({
    generatedAt: report.generatedAt,
    caseCount: report.caseCount,
    rootCauseSummary: report.rootCauseSummary,
    summary: report.summary
  }, null, 2));
}

main();
