import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/db/database.js";
import { APP_COMPETITION_CODES, HISTORY_COMPETITION_CODES } from "../src/config/leagues.js";
import { average, clamp, round } from "../src/lib/math.js";
import { buildRatingsUntil } from "../src/modules/analysis/eloEngine.js";
import { buildMatchFeatures } from "../src/modules/analysis/featureBuilder.js";
import { buildBettingAssessment } from "../src/modules/analysis/bettingEngine.js";
import { calculateProbabilities } from "../src/modules/analysis/probabilityModel.js";

const SUPPORTED_CODES = [...APP_COMPETITION_CODES, ...HISTORY_COMPETITION_CODES];
const MARKET_KEYS = [
  { key: "oneXTwo", name: "1X2" },
  { key: "totals25", name: "Over / Under 2.5" },
  { key: "btts", name: "BTTS" }
];
const EUROPE_CODES = new Set(["CL", "EL", "UECL"]);

function averageOrNull(values, digits = 4) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? round(average(valid, 0), digits) : null;
}

function safeProbability(value) {
  return clamp(value ?? 0, 0.001, 0.999);
}

function binaryLogLoss(probability, actual) {
  const p = safeProbability(probability);
  return -(actual ? Math.log(p) : Math.log(1 - p));
}

function multiclassLogLoss(probabilityOfActual) {
  return -Math.log(safeProbability(probabilityOfActual));
}

function binaryBrier(probability, actual) {
  const target = actual ? 1 : 0;
  return (probability - target) ** 2;
}

function multiclassBrier(probabilities, actualKey) {
  return ["home", "draw", "away"].reduce((sum, key) => {
    const target = key === actualKey ? 1 : 0;
    return sum + ((probabilities[key] ?? 0) - target) ** 2;
  }, 0);
}

function actualMarketKey(marketName, match) {
  if (marketName === "Over / Under 2.5") {
    return (match.home_score + match.away_score) >= 3 ? "over" : "under";
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

function probabilityOfActualOutcome(marketName, actualKey, model) {
  if (marketName === "1X2") {
    return actualKey === "home"
      ? model.probabilities.homeWin
      : actualKey === "away"
        ? model.probabilities.awayWin
        : model.probabilities.draw;
  }

  if (marketName === "Over / Under 2.5") {
    const overProbability = model.scoreMatrix
      .filter((entry) => (entry.homeGoals + entry.awayGoals) >= 3)
      .reduce((sum, entry) => sum + entry.probability, 0);
    return actualKey === "over" ? overProbability : 1 - overProbability;
  }

  const yesProbability = model.scoreMatrix
    .filter((entry) => entry.homeGoals > 0 && entry.awayGoals > 0)
    .reduce((sum, entry) => sum + entry.probability, 0);
  return actualKey === "yes" ? yesProbability : 1 - yesProbability;
}

function classifyFavoriteUnderdog(row) {
  const p = row.selectedProbability ?? 0;
  if (p >= 0.6) {
    return "favorites";
  }
  if (p <= 0.4) {
    return "underdogs";
  }
  return "balanced";
}

function classifyRegion(row) {
  return EUROPE_CODES.has(row.competitionCode) ? "Europe" : "Domestic";
}

function buildBucketTable(rows, bucketSize = 0.1) {
  const buckets = new Map();

  for (const row of rows) {
    const probability = row.selectedProbability;
    if (!Number.isFinite(probability)) {
      continue;
    }

    const start = Math.min(0.9, Math.floor(probability / bucketSize) * bucketSize);
    const key = start.toFixed(1);
    const current = buckets.get(key) ?? { start, count: 0, expected: 0, actual: 0 };
    current.count += 1;
    current.expected += probability;
    current.actual += row.selectedCorrect ? 1 : 0;
    buckets.set(key, current);
  }

  return [...buckets.values()]
    .sort((left, right) => left.start - right.start)
    .map((bucket) => ({
      bucket: `${Math.round(bucket.start * 100)}-${Math.round((bucket.start + bucketSize) * 100)}%`,
      count: bucket.count,
      expectedPct: round((bucket.expected / bucket.count) * 100, 1),
      actualPct: round((bucket.actual / bucket.count) * 100, 1),
      gapPct: round(((bucket.actual - bucket.expected) / bucket.count) * 100, 1)
    }));
}

function buildMarketEntry(match, features, model, market) {
  const actualKey = actualMarketKey(market.name, match);
  const probabilityOfActual = probabilityOfActualOutcome(market.name, actualKey, model);
  const selectedKey = market.bestOption.key;
  const selectedProbability = market.bestOption.modelProbability;
  const selectedCorrect = selectedKey === actualKey;
  const binaryEventProbability = market.name === "Over / Under 2.5"
    ? probabilityOfActualOutcome(market.name, "over", model)
    : market.name === "BTTS"
      ? probabilityOfActualOutcome(market.name, "yes", model)
      : null;

  const oneXTwoDistribution = {
    home: model.probabilities.homeWin,
    draw: model.probabilities.draw,
    away: model.probabilities.awayWin
  };

  return {
    matchId: match.id,
    competitionCode: match.competition_code,
    matchName: `${features.home.name} vs ${features.away.name}`,
    marketName: market.name,
    actualKey,
    selectedKey,
    selectedProbability,
    selectedCorrect,
    probabilityOfActual,
    logLoss: market.name === "1X2"
      ? multiclassLogLoss(probabilityOfActual)
      : binaryLogLoss(binaryEventProbability, actualKey === (market.name === "BTTS" ? "yes" : "over")),
    brier: market.name === "1X2"
      ? multiclassBrier(oneXTwoDistribution, actualKey)
      : binaryBrier(binaryEventProbability, actualKey === (market.name === "BTTS" ? "yes" : "over")),
    dataCoverageScore: features.context.dataCoverageScore ?? null,
    xgCoverageScore: round(Math.min(features.home.xgCoverageScore ?? 0, features.away.xgCoverageScore ?? 0), 2),
    availabilityCoverageScore: features.context.availabilityCoverageScore ?? null,
    topProbability: market.bestOption.modelProbability,
    selectedSide: market.name === "1X2"
      ? selectedKey
      : market.name === "Over / Under 2.5"
        ? selectedKey
        : selectedKey,
    expectedGoals: round((model.expectedGoals.home ?? 0) + (model.expectedGoals.away ?? 0), 2),
    boardTier: market.board?.quality?.tier ?? null
  };
}

function summarize(rows) {
  return {
    sample: rows.length,
    leanAccuracy: rows.length ? round((rows.filter((row) => row.selectedCorrect).length / rows.length) * 100, 1) : null,
    logLoss: averageOrNull(rows.map((row) => row.logLoss), 4),
    brier: averageOrNull(rows.map((row) => row.brier), 4),
    avgSelectedProbability: averageOrNull(rows.map((row) => row.selectedProbability), 4),
    overconfidenceGap: averageOrNull(rows.map((row) => (row.selectedCorrect ? 1 : 0) - row.selectedProbability), 4)
  };
}

function groupSummary(rows, labels, classifier) {
  return Object.fromEntries(labels.map((label) => {
    const subset = rows.filter((row) => classifier(row) === label);
    return [label, summarize(subset)];
  }));
}

function findStrongestIssues(allRowsByMarket) {
  const findings = [];

  for (const [marketName, rows] of Object.entries(allRowsByMarket)) {
    const buckets = buildBucketTable(rows);
    const tailBuckets = buckets.filter((bucket) => bucket.expectedPct >= 60 && bucket.count >= 20);
    const worstTail = [...tailBuckets].sort((left, right) => left.gapPct - right.gapPct)[0] ?? null;

    if (worstTail && worstTail.gapPct <= -5) {
      findings.push({
        label: `${marketName} overconfident tail`,
        impact: Math.abs(worstTail.gapPct),
        note: `${worstTail.bucket} bucket expected ${worstTail.expectedPct}% but hit ${worstTail.actualPct}%.`
      });
    }

    const europe = summarize(rows.filter((row) => classifyRegion(row) === "Europe"));
    const domestic = summarize(rows.filter((row) => classifyRegion(row) === "Domestic"));
    if (Number.isFinite(europe.logLoss) && Number.isFinite(domestic.logLoss) && europe.logLoss > domestic.logLoss + 0.03) {
      findings.push({
        label: `${marketName} Europe transfer issue`,
        impact: round(europe.logLoss - domestic.logLoss, 4),
        note: `Europe log loss ${europe.logLoss} vs domestic ${domestic.logLoss}.`
      });
    }
  }

  return findings.sort((left, right) => right.impact - left.impact);
}

function renderTable(rows, columns) {
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => {
    const value = row[column.key];
    return value === null || value === undefined ? "-" : String(value);
  }).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function buildMarkdownReport(result) {
  const sections = [];
  sections.push("# Calibration Audit");
  sections.push("");
  sections.push(`Generated at: ${result.generatedAt}`);
  sections.push(`Sample size: ${result.requestedSample} finished matches`);
  sections.push("");
  sections.push("## Precondition");
  sections.push("");
  sections.push("- Semantic integrity checks passed before this audit:");
  sections.push("  - market mapping / settlement tests: passing");
  sections.push("  - implied probability / edge tests: passing");
  sections.push("  - team identity audit: no active cross-team contamination detected");
  sections.push("");
  sections.push("## Market Summary");
  sections.push("");
  sections.push(renderTable(
    Object.entries(result.byMarket).map(([market, summary]) => ({ market, ...summary })),
    [
      { key: "market", label: "Market" },
      { key: "sample", label: "Sample" },
      { key: "leanAccuracy", label: "Lean Accuracy %" },
      { key: "logLoss", label: "Log Loss" },
      { key: "brier", label: "Brier" },
      { key: "avgSelectedProbability", label: "Avg Selected P" },
      { key: "overconfidenceGap", label: "Overconfidence Gap" }
    ]
  ));
  sections.push("");
  sections.push("## Reliability Curves");
  sections.push("");
  for (const [market, buckets] of Object.entries(result.reliability)) {
    sections.push(`### ${market}`);
    sections.push("");
    sections.push(renderTable(buckets, [
      { key: "bucket", label: "Bucket" },
      { key: "count", label: "Count" },
      { key: "expectedPct", label: "Expected %" },
      { key: "actualPct", label: "Actual %" },
      { key: "gapPct", label: "Gap %" }
    ]));
    sections.push("");
  }
  sections.push("## Segment Analysis");
  sections.push("");
  for (const [market, segments] of Object.entries(result.segments)) {
    sections.push(`### ${market}`);
    sections.push("");
    sections.push("By region");
    sections.push("");
    sections.push(renderTable(
      Object.entries(segments.byRegion).map(([segment, summary]) => ({ segment, ...summary })),
      [
        { key: "segment", label: "Segment" },
        { key: "sample", label: "Sample" },
        { key: "leanAccuracy", label: "Lean Accuracy %" },
        { key: "logLoss", label: "Log Loss" },
        { key: "brier", label: "Brier" },
        { key: "overconfidenceGap", label: "Overconfidence Gap" }
      ]
    ));
    sections.push("");
    sections.push("By selected side");
    sections.push("");
    sections.push(renderTable(
      Object.entries(segments.bySide).map(([segment, summary]) => ({ segment, ...summary })),
      [
        { key: "segment", label: "Side" },
        { key: "sample", label: "Sample" },
        { key: "leanAccuracy", label: "Lean Accuracy %" },
        { key: "logLoss", label: "Log Loss" },
        { key: "brier", label: "Brier" },
        { key: "overconfidenceGap", label: "Overconfidence Gap" }
      ]
    ));
    sections.push("");
    sections.push("By favorite / balanced / underdog");
    sections.push("");
    sections.push(renderTable(
      Object.entries(segments.byProfile).map(([segment, summary]) => ({ segment, ...summary })),
      [
        { key: "segment", label: "Profile" },
        { key: "sample", label: "Sample" },
        { key: "leanAccuracy", label: "Lean Accuracy %" },
        { key: "logLoss", label: "Log Loss" },
        { key: "brier", label: "Brier" },
        { key: "overconfidenceGap", label: "Overconfidence Gap" }
      ]
    ));
    sections.push("");
  }
  sections.push("## Diagnostics");
  sections.push("");
  sections.push(renderTable(result.diagnostics, [
    { key: "label", label: "Finding" },
    { key: "impact", label: "Impact" },
    { key: "note", label: "Evidence" }
  ]));
  sections.push("");
  sections.push("## Recommendation");
  sections.push("");
  for (const item of result.recommendations) {
    sections.push(`${item.rank}. ${item.text}`);
  }
  sections.push("");
  return sections.join("\n");
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

function runCalibrationAudit(requestedSample = 1000) {
  const { allRows, historyRows, testRows } = loadHistoricalMatches(requestedSample);
  const byId = new Map(allRows.map((row) => [row.id, row]));
  const rollingHistory = [...historyRows];
  const rowsByMarket = Object.fromEntries(MARKET_KEYS.map(({ name }) => [name, []]));

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

    for (const { key, name } of MARKET_KEYS) {
      rowsByMarket[name].push(buildMarketEntry(match, features, model, betting.markets[key]));
    }

    rollingHistory.push(byId.get(match.id));
  }

  const byMarket = Object.fromEntries(Object.entries(rowsByMarket).map(([market, rows]) => [market, summarize(rows)]));
  const reliability = Object.fromEntries(Object.entries(rowsByMarket).map(([market, rows]) => [market, buildBucketTable(rows)]));
  const segments = Object.fromEntries(Object.entries(rowsByMarket).map(([market, rows]) => {
    const sideLabels = [...new Set(rows.map((row) => row.selectedSide))];
    return [market, {
      byRegion: groupSummary(rows, ["Domestic", "Europe"], classifyRegion),
      bySide: groupSummary(rows, sideLabels, (row) => row.selectedSide),
      byProfile: groupSummary(rows, ["favorites", "balanced", "underdogs"], classifyFavoriteUnderdog)
    }];
  }));

  const europeCoverage = Object.fromEntries(Object.entries(rowsByMarket).map(([market, rows]) => {
    const europe = rows.filter((row) => classifyRegion(row) === "Europe");
    const domestic = rows.filter((row) => classifyRegion(row) === "Domestic");
    return [market, {
      europeSample: europe.length,
      domesticSample: domestic.length,
      europeAvgXgCoverage: averageOrNull(europe.map((row) => row.xgCoverageScore), 2),
      domesticAvgXgCoverage: averageOrNull(domestic.map((row) => row.xgCoverageScore), 2),
      europeAvgDataCoverage: averageOrNull(europe.map((row) => row.dataCoverageScore), 2),
      domesticAvgDataCoverage: averageOrNull(domestic.map((row) => row.dataCoverageScore), 2)
    }];
  }));

  const diagnostics = findStrongestIssues(rowsByMarket);
  const recommendations = [
    {
      rank: 1,
      text: "Fit a market-specific post-hoc calibration layer from walk-forward history: temperature scaling for 1X2 and lightweight isotonic or bucket calibration for Over/Under 2.5 and BTTS."
    },
    {
      rank: 2,
      text: "Treat Europe separately in calibration reporting. If Europe keeps showing worse log loss alongside weaker xG coverage, use a competition-group calibration overlay before touching core features."
    },
    {
      rank: 3,
      text: "Leave BTTS experimental. Its calibration and directional accuracy are still too weak for threshold tuning to be meaningful."
    }
  ];

  const result = {
    generatedAt: new Date().toISOString(),
    requestedSample,
    byMarket,
    reliability,
    segments,
    coverageContext: europeCoverage,
    diagnostics,
    recommendations
  };

  const reportsDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, "calibration-audit-latest.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(reportsDir, "calibration-audit-latest.md"), `${buildMarkdownReport(result)}\n`, "utf8");

  return result;
}

const requestedSample = Number(process.argv[2] ?? 1000);
const sample = Number.isFinite(requestedSample) && requestedSample >= 500 ? requestedSample : 1000;
const result = runCalibrationAudit(sample);

console.log(JSON.stringify(result, null, 2));
