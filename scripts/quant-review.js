import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/db/database.js";
import { APP_COMPETITION_CODES, HISTORY_COMPETITION_CODES } from "../src/config/leagues.js";
import { average, clamp, round } from "../src/lib/math.js";
import { buildRatingsUntil } from "../src/modules/analysis/eloEngine.js";
import { buildMatchFeatures } from "../src/modules/analysis/featureBuilder.js";
import { buildBettingAssessment } from "../src/modules/analysis/bettingEngine.js";
import { actualOutcomeLabelForMarket } from "../src/modules/analysis/marketOutcomeUtils.js";
import { calculateProbabilities } from "../src/modules/analysis/probabilityModel.js";
import { getOddsCoverageDiagnostics } from "../src/modules/data/oddsCoverageService.js";

const SUPPORTED_CODES = [...APP_COMPETITION_CODES, ...HISTORY_COMPETITION_CODES];
const REVIEW_COMPETITIONS = ["CL", "EL", "UECL"];
const MARKET_KEYS = [
  { key: "oneXTwo", name: "1X2" },
  { key: "totals25", name: "Over / Under 2.5" },
  { key: "btts", name: "BTTS" }
];
const EDGE_BUCKETS = [
  { label: "0-2%", min: 0, max: 2 },
  { label: "2-4%", min: 2, max: 4 },
  { label: "4-6%", min: 4, max: 6 },
  { label: "6%+", min: 6, max: Number.POSITIVE_INFINITY }
];

function marketSnapshotName(marketName) {
  if (marketName === "Over / Under 2.5") {
    return "totals_2_5";
  }

  if (marketName === "BTTS") {
    return "btts";
  }

  return "h2h";
}

function safeProbability(value) {
  return clamp(value ?? 0, 0.001, 0.999);
}

function binaryLogLoss(probability, actual) {
  const p = safeProbability(probability);
  return -(actual ? Math.log(p) : Math.log(1 - p));
}

function multiClassLogLoss(probability) {
  return -Math.log(safeProbability(probability));
}

function binaryBrier(probability, actual) {
  return (probability - (actual ? 1 : 0)) ** 2;
}

function averageOrNull(values, digits = 2) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? round(average(valid, 0), digits) : null;
}

function confidenceDistribution(rows) {
  return rows.reduce((distribution, row) => {
    const label = row.confidence ?? "Unknown";
    distribution[label] = (distribution[label] ?? 0) + 1;
    return distribution;
  }, {});
}

function actualMarketKey(marketName, match) {
  if (marketName === "Over / Under 2.5") {
    return match.home_score + match.away_score >= 3 ? "over" : "under";
  }

  if (marketName === "BTTS") {
    return match.home_score > 0 && match.away_score > 0 ? "yes" : "no";
  }

  if (match.home_score > match.away_score) {
    return "home";
  }

  if (match.home_score < match.away_score) {
    return "away";
  }

  return "draw";
}

function actualMarketProbability(marketName, match, modelProbabilities, scoreMatrix) {
  if (marketName === "1X2") {
    if (match.home_score > match.away_score) {
      return modelProbabilities.homeWin;
    }

    if (match.home_score < match.away_score) {
      return modelProbabilities.awayWin;
    }

    return modelProbabilities.draw;
  }

  if (marketName === "Over / Under 2.5") {
    const overProbability = scoreMatrix
      .filter((entry) => (entry.homeGoals + entry.awayGoals) >= 3)
      .reduce((sum, entry) => sum + entry.probability, 0);
    return match.home_score + match.away_score >= 3 ? overProbability : 1 - overProbability;
  }

  const bttsYesProbability = scoreMatrix
    .filter((entry) => entry.homeGoals > 0 && entry.awayGoals > 0)
    .reduce((sum, entry) => sum + entry.probability, 0);
  return match.home_score > 0 && match.away_score > 0 ? bttsYesProbability : 1 - bttsYesProbability;
}

function resolvePriceForSelection(snapshot, row) {
  if (snapshot.marketName === "Over / Under 2.5") {
    return snapshot.selectionKey === "over" ? row.home_price : row.away_price;
  }

  if (snapshot.marketName === "BTTS") {
    return snapshot.selectionKey === "yes" ? row.home_price : row.away_price;
  }

  if (snapshot.selectionKey === "draw") {
    return row.draw_price;
  }

  if (snapshot.selectionKey === "home") {
    return row.home_price;
  }

  if (snapshot.selectionKey === "away") {
    return row.away_price;
  }

  return null;
}

function readClvStats(db, matchId, marketName, selectionKey, matchUtcDate) {
  const market = marketSnapshotName(marketName);
  const rows = db.prepare(`
    SELECT bookmaker_key, home_price, draw_price, away_price, retrieved_at
    FROM odds_snapshots
    WHERE match_id = ?
      AND market = ?
      AND datetime(retrieved_at) <= datetime(?)
    ORDER BY datetime(retrieved_at) ASC, id ASC
  `).all(matchId, market, matchUtcDate);

  if (!rows.length) {
    return {
      openingOdds: null,
      closingOdds: null,
      closingLineValue: null
    };
  }

  const openingByBookmaker = new Map();
  const closingByBookmaker = new Map();

  for (const row of rows) {
    if (!openingByBookmaker.has(row.bookmaker_key)) {
      openingByBookmaker.set(row.bookmaker_key, row);
    }

    closingByBookmaker.set(row.bookmaker_key, row);
  }

  const snapshot = { marketName, selectionKey };
  const openingPrices = [...openingByBookmaker.values()].map((row) => resolvePriceForSelection(snapshot, row)).filter(Number.isFinite);
  const closingPrices = [...closingByBookmaker.values()].map((row) => resolvePriceForSelection(snapshot, row)).filter(Number.isFinite);

  return {
    openingOdds: openingPrices.length ? round(average(openingPrices, 0), 2) : null,
    closingOdds: closingPrices.length ? round(average(closingPrices, 0), 2) : null,
    closingLineValue: null
  };
}

function classifyOneXTwoProfile(row) {
  const probability = row.bookmakerProbability ?? row.modelProbability ?? 0;

  if (probability >= 0.5) {
    return "favorites";
  }

  if (probability >= 0.33) {
    return "balanced";
  }

  return "underdogs";
}

function classifyCoverage(row) {
  if ((row.dataCoverageScore ?? 0) >= 0.75) {
    return "high";
  }

  if ((row.dataCoverageScore ?? 0) >= 0.55) {
    return "medium";
  }

  return "low";
}

function classifyLineup(row) {
  if ((row.lineupUncertainty ?? 1) <= 0.3) {
    return "clear";
  }

  if ((row.lineupUncertainty ?? 1) <= 0.55) {
    return "mixed";
  }

  return "uncertain";
}

function classifyMissingData(row) {
  if ((row.availabilityCoverageScore ?? 0) >= 0.55 && (row.xgCoverageScore ?? 0) >= 0.55) {
    return "strong";
  }

  if ((row.availabilityCoverageScore ?? 0) >= 0.35 || (row.xgCoverageScore ?? 0) >= 0.35) {
    return "partial";
  }

  return "thin";
}

function calibrationBuckets(rows, bucketSize = 0.1) {
  const buckets = new Map();

  for (const row of rows) {
    const probability = row.selectedProbability ?? row.probability;
    const actual = row.selectedCorrect ?? row.actual;

    if (!Number.isFinite(probability) || actual === null || actual === undefined) {
      continue;
    }

    const start = Math.min(0.9, Math.floor(probability / bucketSize) * bucketSize);
    const key = start.toFixed(1);
    const current = buckets.get(key) ?? { start, count: 0, expected: 0, actual: 0 };
    current.count += 1;
    current.expected += probability;
    current.actual += actual ? 1 : 0;
    buckets.set(key, current);
  }

  return [...buckets.values()]
    .sort((left, right) => left.start - right.start)
    .map((bucket) => ({
      bucket: `${Math.round(bucket.start * 100)}-${Math.round((bucket.start + bucketSize) * 100)}%`,
      count: bucket.count,
      expected: round((bucket.expected / bucket.count) * 100, 1),
      actual: round((bucket.actual / bucket.count) * 100, 1),
      gap: round(((bucket.actual - bucket.expected) / bucket.count) * 100, 1)
    }));
}

function summarizeBetRows(rows) {
  const bets = rows.filter((row) => row.isBet);
  const settled = bets.filter((row) => row.roi !== null);
  const wins = settled.filter((row) => row.won);
  const netUnits = settled.reduce((sum, row) => sum + row.roi, 0);

  return {
    bets: bets.length,
    noBetFrequency: rows.length ? round(((rows.length - bets.length) / rows.length) * 100, 1) : null,
    hitRate: settled.length ? round((wins.length / settled.length) * 100, 1) : null,
    averageEdge: averageOrNull(bets.map((row) => row.edge), 2),
    averageOdds: averageOrNull(settled.map((row) => row.odds), 2),
    averageRoi: settled.length ? round((netUnits / settled.length) * 100, 2) : null,
    totalRoi: settled.length ? round((netUnits / settled.length) * 100, 2) : null,
    netUnits: settled.length ? round(netUnits, 2) : null,
    confidenceDistribution: confidenceDistribution(bets)
  };
}

function summarizeProbabilityRows(rows) {
  return {
    modeledMatches: rows.length,
    leanAccuracy: rows.length ? round((rows.filter((row) => row.selectedCorrect).length / rows.length) * 100, 1) : null,
    logLoss: rows.length ? round(average(rows.map((row) => row.logLoss), 0), 4) : null,
    brier: rows.length ? round(average(rows.map((row) => row.brier), 0), 4) : null,
    bookmakerBaselineLogLoss: averageOrNull(rows.map((row) => row.bookmakerLogLoss), 4),
    bookmakerBaselineBrier: averageOrNull(rows.map((row) => row.bookmakerBrier), 4)
  };
}

function buildMarketSummary(rows) {
  return {
    ...summarizeBetRows(rows),
    ...summarizeProbabilityRows(rows)
  };
}

function bucketEntries(rows, classifier, labels) {
  return labels.reduce((accumulator, label) => {
    const groupRows = rows.filter((row) => classifier(row) === label);
    accumulator[label] = {
      count: groupRows.length,
      ...summarizeBetRows(groupRows)
    };
    return accumulator;
  }, {});
}

function edgeBucket(row) {
  if (!row.isBet || !Number.isFinite(row.edge) || row.edge < 0) {
    return null;
  }

  return EDGE_BUCKETS.find((bucket) => row.edge >= bucket.min && row.edge < bucket.max)?.label ?? "6%+";
}

function compareAgainstBookmakerBaseline(entries) {
  const comparable = entries.filter((row) => row.bookmakerLogLoss !== null && row.bookmakerBrier !== null);
  if (!comparable.length) {
    return {
      comparableMatches: 0,
      logLossDelta: null,
      brierDelta: null,
      modelBetterLogLoss: null,
      modelBetterBrier: null
    };
  }

  const modelLogLoss = average(comparable.map((row) => row.logLoss), 0);
  const baselineLogLoss = average(comparable.map((row) => row.bookmakerLogLoss), 0);
  const modelBrier = average(comparable.map((row) => row.brier), 0);
  const baselineBrier = average(comparable.map((row) => row.bookmakerBrier), 0);

  return {
    comparableMatches: comparable.length,
    modelLogLoss: round(modelLogLoss, 4),
    bookmakerLogLoss: round(baselineLogLoss, 4),
    logLossDelta: round(modelLogLoss - baselineLogLoss, 4),
    modelBetterLogLoss: modelLogLoss < baselineLogLoss,
    modelBrier: round(modelBrier, 4),
    bookmakerBrier: round(baselineBrier, 4),
    brierDelta: round(modelBrier - baselineBrier, 4),
    modelBetterBrier: modelBrier < baselineBrier
  };
}

function buildMarkdownReport(result) {
  const lines = [];
  lines.push("# Quant Review");
  lines.push("");
  lines.push(`- Generated at: ${result.generatedAt}`);
  lines.push(`- Requested sample: ${result.requestedSample}`);
  lines.push(`- Evaluated matches: ${result.summary.totalModeledMatches}`);
  lines.push(`- Test window: ${result.summary.firstMatchDate} to ${result.summary.lastMatchDate}`);
  lines.push("");
  lines.push("## Overall Summary");
  lines.push(`- Total modeled matches: ${result.summary.totalModeledMatches}`);
  lines.push(`- Total market opportunities: ${result.summary.totalMarketOpportunities}`);
  lines.push(`- Total bets: ${result.summary.totalBets}`);
  lines.push(`- No-bet frequency: ${result.summary.noBetFrequency}%`);
  lines.push(`- Average edge: ${result.summary.averageEdge ?? "n/a"}%`);
  lines.push(`- Average ROI: ${result.summary.averageRoi ?? "n/a"}%`);
  lines.push(`- Net units: ${result.summary.netUnits ?? "n/a"}`);
  lines.push(`- Finished matches with pre-kickoff odds: ${result.summary.oddsArchive?.finishedMatchesWithPreKickoffOdds ?? 0}/${result.summary.oddsArchive?.totalFinishedMatches ?? 0} (${result.summary.oddsArchive?.preKickoffCoveragePct ?? 0}%)`);
  if (result.warnings.length) {
    lines.push("");
    lines.push("## Warnings");
    result.warnings.forEach((warning) => lines.push(`- ${warning}`));
  }
  lines.push("");
  lines.push("## Final Diagnosis");
  for (const bullet of result.finalDiagnosis.highlights) {
    lines.push(`- ${bullet}`);
  }
  lines.push("");
  lines.push("## Top 5 Improvements");
  result.finalDiagnosis.topImprovements.forEach((item, index) => {
    lines.push(`${index + 1}. ${item}`);
  });
  lines.push("");
  return lines.join("\n");
}

function buildFinalDiagnosis(result) {
  const overallBets = result.summary.totalBets;
  const overallRoi = result.summary.averageRoi;
  const oneXTwo = result.byMarket["1X2"];
  const totals = result.byMarket["Over / Under 2.5"];
  const btts = result.byMarket.BTTS;
  const bestMarket = [oneXTwo, totals, btts]
    .filter((market) => market.bets > 0)
    .sort((left, right) => (right.averageRoi ?? -999) - (left.averageRoi ?? -999))[0] ?? null;
  const worstMarket = [oneXTwo, totals, btts]
    .filter((market) => market.bets > 0)
    .sort((left, right) => (left.averageRoi ?? 999) - (right.averageRoi ?? 999))[0] ?? null;
  const showsSignal = (
    (totals?.averageRoi ?? -999) > 0 ||
    (btts?.averageRoi ?? -999) > 0 ||
    (oneXTwo?.averageRoi ?? -999) > 0 ||
    ((totals?.logLoss ?? 999) < (totals?.bookmakerBaselineLogLoss ?? 0)) ||
    ((btts?.logLoss ?? 999) < (btts?.bookmakerBaselineLogLoss ?? 0)) ||
    ((oneXTwo?.logLoss ?? 999) < (oneXTwo?.bookmakerBaselineLogLoss ?? 0))
  );

  const strengths = [];
  if ((totals?.averageRoi ?? -999) > 0) {
    strengths.push(`Totals is the cleanest betting market in this sample, with ${totals.averageRoi}% ROI over ${totals.bets} bets.`);
  }
  if ((btts?.averageRoi ?? -999) > 0) {
    strengths.push(`BTTS is at least directionally alive, with ${btts.averageRoi}% ROI over ${btts.bets} bets.`);
  }
  if ((oneXTwo?.bookmakerBaselineLogLoss ?? 0) !== null && (oneXTwo?.logLoss ?? 999) < (oneXTwo?.bookmakerBaselineLogLoss ?? -999)) {
    strengths.push("The 1X2 probability model beats the naive bookmaker baseline on log loss.");
  }
  if (!strengths.length) {
    strengths.push("The model does not show a strong repeatable strength across all three markets.");
  }

  const weaknesses = [];
  if ((result.summary.historicalOddsCoverage ?? 0) < 15) {
    weaknesses.push(`Historical odds coverage is only ${result.summary.historicalOddsCoverage}%, so the betting layer is being judged on a starved price archive.`);
  }
  if ((oneXTwo?.averageRoi ?? 0) <= 0) {
    weaknesses.push(`1X2 is weak or negative, with ${oneXTwo?.averageRoi ?? "n/a"}% ROI over ${oneXTwo?.bets ?? 0} bets.`);
  }
  if ((btts?.averageRoi ?? 0) <= 0) {
    weaknesses.push(`BTTS is weak or negative, with ${btts?.averageRoi ?? "n/a"}% ROI over ${btts?.bets ?? 0} bets.`);
  }
  if ((result.summary.noBetFrequency ?? 0) > 75) {
    weaknesses.push(`The system passes too often for a practical betting workflow, with a ${result.summary.noBetFrequency}% no-bet rate.`);
  }
  if ((result.summary.averageClv ?? -999) <= 0) {
    weaknesses.push("CLV is not convincingly positive, so the edge is not clearly beating the market before kickoff.");
  }
  if ((result.summary.forwardSettledLikeSample ?? 0) < 100) {
    weaknesses.push("Even this larger replay still leans on historical simulation rather than a large forward tracked sample.");
  }

  const highlights = [
    `This review used ${result.summary.totalModeledMatches} historical matches and ${result.summary.totalMarketOpportunities} market opportunities.`,
    overallBets
      ? `The model placed ${overallBets} bets with ${result.summary.averageRoi}% average ROI and ${result.summary.netUnits} net units.`
      : "The model barely bet at all, which means the betting layer is still too thin to validate seriously.",
    bestMarket
      ? `${bestMarket.market} was the best market by ROI.`
      : "No market stood out positively.",
    worstMarket
      ? `${worstMarket.market} was the weakest market by ROI.`
      : "No market had enough bets to rank.",
    showsSignal
      ? "There is at least some signal in the model, but it is not broad or proven enough yet."
      : "The current model reads more like noise plus bookmaker anchoring than a robust betting edge."
  ];

  return {
    biggestStrengths: strengths,
    biggestWeaknesses: weaknesses,
    showsRealSignal: showsSignal,
    beatsNaiveBookmakerBaseline: {
      oneXTwo: oneXTwo?.logLoss !== null && oneXTwo?.bookmakerBaselineLogLoss !== null ? oneXTwo.logLoss < oneXTwo.bookmakerBaselineLogLoss : null,
      totals25: totals?.logLoss !== null && totals?.bookmakerBaselineLogLoss !== null ? totals.logLoss < totals.bookmakerBaselineLogLoss : null,
      btts: btts?.logLoss !== null && btts?.bookmakerBaselineLogLoss !== null ? btts.logLoss < btts.bookmakerBaselineLogLoss : null
    },
    shouldTrustForRealBetting: Boolean(overallBets >= 150 && (overallRoi ?? -999) > 0 && (result.summary.averageClv ?? -999) > 0),
    highlights,
    topImprovements: [
      "Archive much deeper historical odds so the betting layer is not judged on thin price coverage.",
      "Import real xG data into team_match_advanced_stats so the new xG hooks stop running on neutral fallbacks.",
      "Improve lineup quality near kickoff and keep penalizing uncertain lineups hard.",
      "Retune the 1X2 decision policy separately from totals and BTTS, because those markets behave differently.",
      "Build a larger forward tracked sample and grade it; historical replay alone is not enough proof."
    ]
  };
}

function buildSummary(allEntries, marketMap, matches) {
  const oddsArchive = getOddsCoverageDiagnostics();
  const bets = allEntries.filter((entry) => entry.isBet);
  const settled = bets.filter((entry) => entry.roi !== null);
  const netUnits = settled.reduce((sum, entry) => sum + entry.roi, 0);
  const clvRows = settled.filter((entry) => Number.isFinite(entry.closingLineValue));
  const dataCoverageRows = allEntries.filter((entry) => Number.isFinite(entry.dataCoverageScore));

  return {
    totalModeledMatches: matches.length,
    totalMarketOpportunities: allEntries.length,
    totalBets: bets.length,
    totalWithOdds: allEntries.filter((entry) => entry.hasOdds).length,
    betsPerMarket: Object.fromEntries(Object.entries(marketMap).map(([market, rows]) => [market, rows.filter((row) => row.isBet).length])),
    oddsCoveragePerMarket: Object.fromEntries(Object.entries(marketMap).map(([market, rows]) => [
      market,
      rows.length ? round((rows.filter((row) => row.hasOdds).length / rows.length) * 100, 1) : null
    ])),
    noBetFrequency: allEntries.length ? round(((allEntries.length - bets.length) / allEntries.length) * 100, 1) : null,
    averageEdge: averageOrNull(bets.map((entry) => entry.edge), 2),
    averageRoi: settled.length ? round((netUnits / settled.length) * 100, 2) : null,
    totalRoi: settled.length ? round((netUnits / settled.length) * 100, 2) : null,
    netUnits: settled.length ? round(netUnits, 2) : null,
    averageOdds: averageOrNull(settled.map((entry) => entry.odds), 2),
    averageClv: averageOrNull(clvRows.map((entry) => entry.closingLineValue), 2),
    historicalOddsCoverage: allEntries.length ? round((allEntries.filter((entry) => entry.hasOdds).length / allEntries.length) * 100, 1) : null,
    oddsArchive,
    leanAccuracy: {
      oneXTwo: marketMap["1X2"].length ? round((marketMap["1X2"].filter((entry) => entry.selectedCorrect).length / marketMap["1X2"].length) * 100, 1) : null,
      totals25: marketMap["Over / Under 2.5"].length ? round((marketMap["Over / Under 2.5"].filter((entry) => entry.selectedCorrect).length / marketMap["Over / Under 2.5"].length) * 100, 1) : null,
      btts: marketMap.BTTS.length ? round((marketMap.BTTS.filter((entry) => entry.selectedCorrect).length / marketMap.BTTS.length) * 100, 1) : null
    },
    logLoss: {
      oneXTwo: marketMap["1X2"].length ? round(average(marketMap["1X2"].map((entry) => entry.logLoss), 0), 4) : null,
      totals25: marketMap["Over / Under 2.5"].length ? round(average(marketMap["Over / Under 2.5"].map((entry) => entry.logLoss), 0), 4) : null,
      btts: marketMap.BTTS.length ? round(average(marketMap.BTTS.map((entry) => entry.logLoss), 0), 4) : null
    },
    dataCoverageAverage: averageOrNull(dataCoverageRows.map((entry) => entry.dataCoverageScore), 2),
    forwardSettledLikeSample: settled.length,
    firstMatchDate: matches[0]?.utc_date ?? null,
    lastMatchDate: matches[matches.length - 1]?.utc_date ?? null
  };
}

function buildAnalysis(entries, marketMap) {
  const betEntries = entries.filter((entry) => entry.isBet);
  const oneXTwoBets = marketMap["1X2"].filter((entry) => entry.isBet);
  const edgeAnalysis = EDGE_BUCKETS.reduce((accumulator, bucket) => {
    const rows = betEntries.filter((entry) => edgeBucket(entry) === bucket.label);
    accumulator[bucket.label] = {
      count: rows.length,
      hitRate: rows.length ? round((rows.filter((row) => row.won).length / rows.length) * 100, 1) : null,
      averageOdds: averageOrNull(rows.map((row) => row.odds), 2),
      roi: rows.length ? round((rows.reduce((sum, row) => sum + (row.roi ?? 0), 0) / rows.length) * 100, 2) : null
    };
    return accumulator;
  }, {});

  const competitionSplit = Object.fromEntries(REVIEW_COMPETITIONS.map((competitionCode) => {
    const rows = betEntries.filter((entry) => entry.competitionCode === competitionCode);
    return [competitionCode, {
      matches: new Set(entries.filter((entry) => entry.competitionCode === competitionCode).map((entry) => entry.matchId)).size,
      bets: rows.length,
      hitRate: rows.length ? round((rows.filter((row) => row.won).length / rows.length) * 100, 1) : null,
      averageEdge: averageOrNull(rows.map((row) => row.edge), 2),
      roi: rows.length ? round((rows.reduce((sum, row) => sum + (row.roi ?? 0), 0) / rows.length) * 100, 2) : null
    }];
  }));

  const dataQualityRows = betEntries.filter((entry) => entry.marketName !== "1X2" || entry.selectionKey !== "draw" || entry.isBet);

  const clvRows = betEntries.filter((entry) => Number.isFinite(entry.closingLineValue));
  const clvByMarket = Object.fromEntries(MARKET_KEYS.map(({ name }) => {
    const rows = clvRows.filter((entry) => entry.marketName === name);
    return [name, {
      bets: rows.length,
      averageClv: averageOrNull(rows.map((row) => row.closingLineValue), 2),
      beatClosingLineRate: rows.length ? round((rows.filter((row) => row.closingLineValue < 0).length / rows.length) * 100, 1) : null
    }];
  }));

  return {
    performanceByMarket: Object.fromEntries(MARKET_KEYS.map(({ name }) => [name, buildMarketSummary(marketMap[name])])),
    edgeBucketAnalysis: edgeAnalysis,
    favoriteVsUnderdogAnalysis: {
      favorites: {
        count: oneXTwoBets.filter((row) => classifyOneXTwoProfile(row) === "favorites").length,
        ...summarizeBetRows(oneXTwoBets.filter((row) => classifyOneXTwoProfile(row) === "favorites"))
      },
      balanced: {
        count: oneXTwoBets.filter((row) => classifyOneXTwoProfile(row) === "balanced").length,
        ...summarizeBetRows(oneXTwoBets.filter((row) => classifyOneXTwoProfile(row) === "balanced"))
      },
      underdogs: {
        count: oneXTwoBets.filter((row) => classifyOneXTwoProfile(row) === "underdogs").length,
        ...summarizeBetRows(oneXTwoBets.filter((row) => classifyOneXTwoProfile(row) === "underdogs"))
      }
    },
    competitionSplit,
    dataQualityAnalysis: {
      coverage: bucketEntries(dataQualityRows, classifyCoverage, ["high", "medium", "low"]),
      lineupUncertainty: bucketEntries(dataQualityRows, classifyLineup, ["clear", "mixed", "uncertain"]),
      missingData: bucketEntries(dataQualityRows, classifyMissingData, ["strong", "partial", "thin"])
    },
    closingLineAnalysis: {
      totalClvBets: clvRows.length,
      averageClv: averageOrNull(clvRows.map((row) => row.closingLineValue), 2),
      beatClosingLineRate: clvRows.length ? round((clvRows.filter((row) => row.closingLineValue < 0).length / clvRows.length) * 100, 1) : null,
      byMarket: clvByMarket
    },
    calibration: Object.fromEntries(MARKET_KEYS.map(({ name }) => {
      const rows = marketMap[name];
      return [name, {
        brier: averageOrNull(rows.map((row) => row.brier), 4),
        bookmakerBaselineBrier: averageOrNull(rows.map((row) => row.bookmakerBrier), 4),
        calibrationBuckets: calibrationBuckets(rows.map((row) => ({
          selectedProbability: row.selectedProbability,
          selectedCorrect: row.selectedCorrect
        }))),
        overconfidenceGap: averageOrNull(rows.map((row) => (row.selectedCorrect ? 1 : 0) - row.selectedProbability), 4)
      }];
    })),
    bookmakerBaselineComparison: Object.fromEntries(MARKET_KEYS.map(({ name }) => [name, compareAgainstBookmakerBaseline(marketMap[name])]))
  };
}

function buildMarketEntry(match, features, model, marketAssessment) {
  const actualLabel = actualOutcomeLabelForMarket(marketAssessment.name, match, features);
  const actualKey = actualMarketKey(marketAssessment.name, match);
  const actualProbability = actualMarketProbability(
    marketAssessment.name,
    match,
    model.probabilities,
    model.scoreMatrix
  );
  const isBet = !marketAssessment.recommendation.isNoBet;
  const won = isBet ? marketAssessment.bestOption.shortLabel === actualLabel : null;
  const bookmakerProbability = marketAssessment.bestOption.bookmakerMarginAdjustedProbability;
  const bookmakerActualProbability = marketAssessment.name === "1X2"
    ? features.context.marketBaseline?.bookmakerMarginAdjustedProbability?.[actualKey] ?? null
    : marketAssessment.consensus?.[actualKey] ?? null;
  const bookmakerSelectedProbability = marketAssessment.name === "1X2"
    ? features.context.marketBaseline?.bookmakerMarginAdjustedProbability?.[marketAssessment.bestOption.key] ?? marketAssessment.bestOption.bookmakerMarginAdjustedProbability ?? null
    : marketAssessment.consensus?.[marketAssessment.bestOption.key] ?? marketAssessment.bestOption.bookmakerMarginAdjustedProbability ?? null;
  const clvStats = isBet
    ? readClvStats(getDb(), match.id, marketAssessment.name, marketAssessment.bestOption.key, match.utc_date)
    : { openingOdds: null, closingOdds: null, closingLineValue: null };

  if (Number.isFinite(clvStats.closingOdds) && Number.isFinite(marketAssessment.bestOption.bookmakerOdds)) {
    clvStats.closingLineValue = round(clvStats.closingOdds - marketAssessment.bestOption.bookmakerOdds, 2);
  }

  return {
    matchId: match.id,
    match,
    matchName: `${features.home.name} vs ${features.away.name}`,
    competitionCode: match.competition_code,
    date: match.utc_date,
    marketName: marketAssessment.name,
    marketKey: marketAssessment.key,
    action: marketAssessment.recommendation.action,
    hasOdds: marketAssessment.hasOdds,
    bookmakerCount: marketAssessment.trust.bookmakerCount ?? marketAssessment.rows.length,
    selectionLabel: marketAssessment.bestOption.shortLabel,
    selectionKey: marketAssessment.bestOption.key,
    actualLabel,
    actualKey,
    isBet,
    won,
    odds: isBet ? marketAssessment.bestOption.bookmakerOdds : null,
    edge: isBet ? marketAssessment.bestOption.edge : null,
    confidence: marketAssessment.recommendation.confidence,
    trustLabel: marketAssessment.recommendation.trustLabel,
    trustScore: marketAssessment.recommendation.trustScore,
    credibilityLabel: marketAssessment.recommendation.credibilityLabel,
    credibilityScore: marketAssessment.recommendation.credibilityScore,
    modelProbability: marketAssessment.bestOption.modelProbability,
    bookmakerProbability,
    selectedProbability: marketAssessment.bestOption.modelProbability,
    selectedCorrect: marketAssessment.bestOption.shortLabel === actualLabel,
    bookmakerSelectedProbability,
    logLoss: marketAssessment.name === "1X2"
      ? multiClassLogLoss(actualProbability)
      : binaryLogLoss(actualProbability, true),
    brier: marketAssessment.name === "1X2"
      ? (1 - actualProbability) ** 2
      : binaryBrier(
          marketAssessment.name === "Over / Under 2.5"
            ? model.scoreMatrix.filter((entry) => (entry.homeGoals + entry.awayGoals) >= 3).reduce((sum, entry) => sum + entry.probability, 0)
            : model.scoreMatrix.filter((entry) => entry.homeGoals > 0 && entry.awayGoals > 0).reduce((sum, entry) => sum + entry.probability, 0),
          actualKey === "over" || actualKey === "yes"
        ),
    bookmakerLogLoss: Number.isFinite(bookmakerActualProbability)
      ? (marketAssessment.name === "1X2"
          ? multiClassLogLoss(bookmakerActualProbability)
          : binaryLogLoss(bookmakerActualProbability, true))
      : null,
    bookmakerBrier: Number.isFinite(bookmakerActualProbability)
      ? (marketAssessment.name === "1X2"
          ? (1 - bookmakerActualProbability) ** 2
          : binaryBrier(bookmakerActualProbability, actualKey === "over" || actualKey === "yes"))
      : null,
    roi: isBet && Number.isFinite(marketAssessment.bestOption.bookmakerOdds)
      ? round(won ? marketAssessment.bestOption.bookmakerOdds - 1 : -1, 4)
      : null,
    dataCoverageScore: features.context.dataCoverageScore,
    availabilityCoverageScore: features.context.availabilityCoverageScore,
    lineupUncertainty: round(Math.max(features.home.lineupUncertainty ?? 0.5, features.away.lineupUncertainty ?? 0.5), 2),
    missingStarters: (features.home.missingStartersCount ?? 0) + (features.away.missingStartersCount ?? 0),
    xgCoverageScore: round(Math.min(features.home.xgCoverageScore ?? 0, features.away.xgCoverageScore ?? 0), 2),
    sourceConflictScore: Math.max(features.home.sourceConflictScore ?? 0, features.away.sourceConflictScore ?? 0),
    openingOdds: clvStats.openingOdds,
    closingOdds: clvStats.closingOdds,
    closingLineValue: clvStats.closingLineValue
  };
}

function loadHistoricalMatches(limit) {
  const db = getDb();
  const placeholders = SUPPORTED_CODES.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT *
    FROM matches
    WHERE status = 'FINISHED'
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND competition_code IN (${placeholders})
    ORDER BY datetime(utc_date) ASC
  `).all(...SUPPORTED_CODES);

  const sampleSize = Math.min(limit, rows.length);
  return {
    allRows: rows,
    historyRows: rows.slice(0, Math.max(0, rows.length - sampleSize)),
    testRows: rows.slice(-sampleSize)
  };
}

function runQuantReview(requestedSample = 1000) {
  getDb();
  const { allRows, historyRows, testRows } = loadHistoricalMatches(requestedSample);
  const byId = new Map(allRows.map((row) => [row.id, row]));
  const entries = [];
  const rollingHistory = [...historyRows];

  for (const match of testRows) {
    const ratings = buildRatingsUntil(rollingHistory, match.utc_date);
    const features = buildMatchFeatures(match.id, ratings, { asOfTime: match.utc_date });
    const model = calculateProbabilities(features);
    const betting = buildBettingAssessment(match.id, model, {
      beforeDate: match.utc_date,
      features,
      dataCoverageScore: features.context.dataCoverageScore,
      coverageBlend: model.diagnostics.coverageBlend
    });

    for (const { key } of MARKET_KEYS) {
      entries.push(buildMarketEntry(match, features, model, betting.markets[key]));
    }

    rollingHistory.push(byId.get(match.id));
  }

  const marketMap = Object.fromEntries(MARKET_KEYS.map(({ name }) => [name, entries.filter((entry) => entry.marketName === name)]));
  const summary = buildSummary(entries, marketMap, testRows);
  const analysis = buildAnalysis(entries, marketMap);
  const result = {
    generatedAt: new Date().toISOString(),
    requestedSample,
    warnings: [],
    summary,
    byMarket: analysis.performanceByMarket,
    edgeBucketAnalysis: analysis.edgeBucketAnalysis,
    favoriteVsUnderdogAnalysis: analysis.favoriteVsUnderdogAnalysis,
    competitionSplit: analysis.competitionSplit,
    dataQualityAnalysis: analysis.dataQualityAnalysis,
    closingLineAnalysis: analysis.closingLineAnalysis,
    calibration: analysis.calibration,
    bookmakerBaselineComparison: analysis.bookmakerBaselineComparison
  };
  if ((summary.historicalOddsCoverage ?? 0) === 0) {
    result.warnings.push("Historical price archive missing - betting performance cannot be validated.");
  }
  for (const warning of summary.oddsArchive?.warnings ?? []) {
    if (!result.warnings.includes(warning)) {
      result.warnings.push(warning);
    }
  }
  if ((summary.totalBets ?? 0) === 0) {
    result.warnings.push("The current historical replay generated zero bets, so ROI and CLV conclusions are not yet available.");
  }
  result.finalDiagnosis = buildFinalDiagnosis(result);

  const reportsDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, "quant-review-latest.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(reportsDir, "quant-review-latest.md"), `${buildMarkdownReport(result)}\n`, "utf8");

  return result;
}

const requestedSample = Number(process.argv[2] ?? 1000);
const sample = Number.isFinite(requestedSample) && requestedSample >= 500 ? requestedSample : 1000;
const result = runQuantReview(sample);

console.log(JSON.stringify(result, null, 2));
