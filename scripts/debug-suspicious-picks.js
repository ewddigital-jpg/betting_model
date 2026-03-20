import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/db/database.js";
import { analyzeMatch } from "../src/modules/analysis/analysisService.js";
import { __bettingEngineTestables } from "../src/modules/analysis/bettingEngine.js";

function readCandidateMatches(limit = 120) {
  const db = getDb();
  return db.prepare(`
    SELECT id
    FROM matches
    WHERE datetime(utc_date) >= datetime('now', '-2 days')
      AND datetime(utc_date) <= datetime('now', '+14 days')
    ORDER BY datetime(utc_date) ASC
    LIMIT ?
  `).all(limit);
}

function buildSuspiciousEntry(matchId) {
  const analysis = analyzeMatch(matchId, null, { storeReport: false });
  const legacyPrimary = __bettingEngineTestables.buildPrimaryMarketLegacy(analysis.betting.markets);
  const currentPrimary = analysis.betting.primaryMarket;
  const oneXTwo = analysis.betting.markets.oneXTwo;
  const totals = analysis.betting.markets.totals25;

  const suspiciousBecauseLegacyTotals =
    !analysis.betting.bestBet?.hasBet &&
    legacyPrimary?.marketKey === "totals25" &&
    currentPrimary?.marketKey !== legacyPrimary?.marketKey;
  const suspiciousBecauseHighTotalUnder =
    !analysis.betting.bestBet?.hasBet &&
    totals?.bestOption?.shortLabel === "Under 2.5" &&
    ((analysis.model.expectedGoals.home + analysis.model.expectedGoals.away) >= 2.9);

  if (!suspiciousBecauseLegacyTotals && !suspiciousBecauseHighTotalUnder) {
    return null;
  }

  return {
    matchId,
    utcDate: analysis.features.match.utc_date,
    competition: analysis.features.match.competition_code,
    homeTeam: analysis.features.match.home_team_name,
    awayTeam: analysis.features.match.away_team_name,
    totalExpectedGoals: Number((analysis.model.expectedGoals.home + analysis.model.expectedGoals.away).toFixed(2)),
    expectedGoals: analysis.model.expectedGoals,
    bestBet: analysis.betting.bestBet,
    legacyPrimary,
    currentPrimary,
    oneXTwo: {
      selection: oneXTwo.bestOption.shortLabel,
      probability: oneXTwo.bestOption.modelProbability,
      odds: oneXTwo.bestOption.bookmakerOdds,
      edge: oneXTwo.bestOption.edge,
      action: oneXTwo.recommendation.action
    },
    totals25: {
      selection: totals.bestOption.shortLabel,
      probability: totals.bestOption.modelProbability,
      odds: totals.bestOption.bookmakerOdds,
      edge: totals.bestOption.edge,
      action: totals.recommendation.action,
      boardQualityTier: totals.priceQuality?.boardQualityTier ?? null,
      staleOdds: Boolean(totals.priceQuality?.staleOdds),
      blockReasons: totals.priceQuality?.blockReasons ?? []
    }
  };
}

function buildReport(limit = 20) {
  const candidates = readCandidateMatches(160);
  const suspicious = [];

  for (const match of candidates) {
    const entry = buildSuspiciousEntry(match.id);
    if (entry) {
      suspicious.push(entry);
    }
    if (suspicious.length >= limit) {
      break;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalSuspiciousMatches: suspicious.length,
    summary: {
      legacyTotalsLeadCount: suspicious.filter((entry) => entry.legacyPrimary?.marketKey === "totals25").length,
      currentOneXTwoReferenceCount: suspicious.filter((entry) => entry.currentPrimary?.marketKey === "oneXTwo").length,
      noBetCount: suspicious.filter((entry) => !entry.bestBet?.hasBet).length
    },
    matches: suspicious
  };
}

const report = buildReport(20);
const reportsDir = path.join(process.cwd(), "reports");
fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(
  path.join(reportsDir, "suspicious-picks-debug-latest.json"),
  JSON.stringify(report, null, 2)
);

console.log(JSON.stringify(report, null, 2));
