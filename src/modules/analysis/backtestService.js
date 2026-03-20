import { APP_COMPETITION_CODES } from "../../config/leagues.js";
import { getDb } from "../../db/database.js";
import { average, round } from "../../lib/math.js";
import { buildRatingsUntil } from "./eloEngine.js";
import { buildMatchFeatures } from "./featureBuilder.js";
import { buildBettingAssessment } from "./bettingEngine.js";
import { actualOutcomeLabelForMarket } from "./marketOutcomeUtils.js";
import { calculateProbabilities } from "./probabilityModel.js";

function competitionFilter(competitionCode = null) {
  return competitionCode
    ? {
        clause: "AND competition_code = ?",
        values: [competitionCode]
      }
    : {
        clause: `AND competition_code IN (${APP_COMPETITION_CODES.map(() => "?").join(", ")})`,
        values: APP_COMPETITION_CODES
      };
}

function scoredOutcomeProbability(probabilities, match) {
  if (match.home_score > match.away_score) {
    return probabilities.homeWin;
  }

  if (match.home_score === match.away_score) {
    return probabilities.draw;
  }

  return probabilities.awayWin;
}

function topLean(probabilities, features) {
  return [
    { label: features.home.name, probability: probabilities.homeWin },
    { label: "Draw", probability: probabilities.draw },
    { label: features.away.name, probability: probabilities.awayWin }
  ].sort((left, right) => right.probability - left.probability)[0];
}

function assessPickResult(selectionLabel, marketName, match, features) {
  return selectionLabel === actualOutcomeLabelForMarket(marketName, match, features);
}

function calibrationBuckets(entries, bucketSize = 0.1) {
  const buckets = new Map();

  for (const entry of entries) {
    const bucket = Math.min(0.9, Math.floor(entry.probability / bucketSize) * bucketSize);
    const key = bucket.toFixed(1);
    const current = buckets.get(key) ?? { bucketStart: bucket, count: 0, probability: 0, actual: 0 };
    current.count += 1;
    current.probability += entry.probability;
    current.actual += entry.actual;
    buckets.set(key, current);
  }

  return Array.from(buckets.values())
    .sort((left, right) => left.bucketStart - right.bucketStart)
    .map((bucket) => ({
      bucket: `${Math.round(bucket.bucketStart * 100)}-${Math.round((bucket.bucketStart + bucketSize) * 100)}%`,
      count: bucket.count,
      expected: round((bucket.probability / bucket.count) * 100, 1),
      actual: round((bucket.actual / bucket.count) * 100, 1)
    }));
}

function calibrationSummary(rows) {
  const oneXTwoRows = rows.map((row) => ({
    probability: row.modelLean.probability,
    actual: row.modelLean.correct ? 1 : 0
  }));
  const totalsRows = rows
    .filter((row) => row.marketProbabilities?.totalsOver25 !== null)
    .map((row) => ({
      probability: row.marketProbabilities.totalsOver25,
      actual: row.marketOutcomes.over25 ? 1 : 0
    }));
  const bttsRows = rows
    .filter((row) => row.marketProbabilities?.bttsYes !== null)
    .map((row) => ({
      probability: row.marketProbabilities.bttsYes,
      actual: row.marketOutcomes.bttsYes ? 1 : 0
    }));

  const brier = (entries) => entries.length
    ? round(entries.reduce((sum, entry) => sum + ((entry.probability - entry.actual) ** 2), 0) / entries.length, 4)
    : null;

  return {
    oneXTwo: {
      brier: brier(oneXTwoRows),
      buckets: calibrationBuckets(oneXTwoRows)
    },
    totals25: {
      brier: brier(totalsRows),
      buckets: calibrationBuckets(totalsRows)
    },
    btts: {
      brier: brier(bttsRows),
      buckets: calibrationBuckets(bttsRows)
    }
  };
}

function summarizeRows(rows) {
  const bets = rows.filter((row) => row.pick.action !== "No Bet");
  const settledBets = bets.filter((row) => row.pick.roi !== null);
  const wins = settledBets.filter((row) => row.pick.result === "won");
  const losses = settledBets.filter((row) => row.pick.result === "lost");
  const leanCorrect = rows.filter((row) => row.modelLean.correct);

  return {
    modeledMatches: rows.length,
    bets: bets.length,
    passes: rows.length - bets.length,
    settledBets: settledBets.length,
    wins: wins.length,
    losses: losses.length,
    leanAccuracy: rows.length ? round((leanCorrect.length / rows.length) * 100, 1) : null,
    hitRate: settledBets.length ? round((wins.length / settledBets.length) * 100, 1) : null,
    averageEdge: bets.length ? round(average(bets.map((row) => row.pick.edge).filter(Number.isFinite), 0), 2) : null,
    averageOdds: settledBets.length ? round(average(settledBets.map((row) => row.pick.bookmakerOdds).filter(Number.isFinite), 0), 2) : null,
    averageRoi: settledBets.length ? round((settledBets.reduce((sum, row) => sum + row.pick.roi, 0) / settledBets.length) * 100, 2) : null
  };
}

function simulateHistoricalRows(competitionCode = null, limit = 100) {
  const db = getDb();
  const filter = competitionFilter(competitionCode);
  const rows = db.prepare(`
    SELECT *
    FROM matches
    WHERE status = 'FINISHED'
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      ${filter.clause}
    ORDER BY datetime(utc_date) ASC
  `).all(...filter.values);

  const testRows = rows.slice(-limit);
  const historyRows = rows.slice(0, Math.max(0, rows.length - testRows.length));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const results = [];

  for (const match of testRows) {
    const ratings = buildRatingsUntil(historyRows, match.utc_date);
    const features = buildMatchFeatures(match.id, ratings, { asOfTime: match.utc_date });
    const model = calculateProbabilities(features);
    const betting = buildBettingAssessment(match.id, model, {
      beforeDate: match.utc_date,
      features,
      dataCoverageScore: features.context.dataCoverageScore,
      coverageBlend: model.diagnostics.coverageBlend
    });
    const lean = topLean(model.probabilities, features);
    const topMarket = betting.bestBet?.hasBet
      ? Object.values(betting.markets).find((market) => market.name === betting.bestBet.marketName)
      : betting.markets.oneXTwo;
    const selection = topMarket?.bestOption?.shortLabel ?? "No Bet";
    const hasBet = Boolean(betting.bestBet?.hasBet);
    const won = hasBet ? assessPickResult(selection, topMarket.name, match, features) : null;

    results.push({
      id: match.id,
      competition: match.competition_code,
      date: match.utc_date,
      probabilities: model.probabilities,
      outcomeProbability: scoredOutcomeProbability(model.probabilities, match),
      modelLean: {
        label: lean.label,
        probability: lean.probability,
        correct: lean.label === actualOutcomeLabelForMarket("1X2", match, features)
      },
      pick: {
        market: topMarket?.name ?? null,
        label: selection,
        action: hasBet ? topMarket.recommendation.action : "No Bet",
        edge: topMarket?.bestOption?.edge ?? null,
        confidence: topMarket?.recommendation.confidence ?? "Low",
        trust: topMarket?.recommendation.trustLabel ?? "Fragile",
        bookmakerOdds: topMarket?.bestOption?.bookmakerOdds ?? null,
        result: hasBet ? (won ? "won" : "lost") : "pass",
        roi: hasBet && topMarket?.bestOption?.bookmakerOdds
          ? round(won ? topMarket.bestOption.bookmakerOdds - 1 : -1, 4)
          : null,
        outcomeLabel: actualOutcomeLabelForMarket(topMarket?.name ?? "1X2", match, features)
      },
      marketProbabilities: {
        totalsOver25: round(
          model.scoreMatrix
            .filter((entry) => (entry.homeGoals + entry.awayGoals) >= 3)
            .reduce((sum, entry) => sum + entry.probability, 0),
          4
        ),
        bttsYes: round(
          model.scoreMatrix
            .filter((entry) => entry.homeGoals > 0 && entry.awayGoals > 0)
            .reduce((sum, entry) => sum + entry.probability, 0),
          4
        )
      },
      marketOutcomes: {
        over25: (match.home_score + match.away_score) >= 3,
        bttsYes: match.home_score > 0 && match.away_score > 0
      },
      matchName: `${features.home.name} vs ${features.away.name}`
    });

    historyRows.push(byId.get(match.id));
  }

  return results;
}

export function runBlindEvaluation(competitionCode = null, limit = 100) {
  const rows = simulateHistoricalRows(competitionCode, limit);
  const byMarket = ["1X2", "Over / Under 2.5", "BTTS"].map((marketName) => ({
    market: marketName,
    ...summarizeRows(rows.filter((row) => row.pick.market === marketName))
  }));
  const modeled = rows.length;
  const logLoss = modeled
    ? -rows.reduce((sum, row) => sum + Math.log(Math.max(row.outcomeProbability, 0.01)), 0) / modeled
    : null;

  return {
    summary: {
      ...summarizeRows(rows),
      logLoss: logLoss === null ? null : round(logLoss, 3),
      warning: "Blind sample uses only data and odds snapshots available before kickoff. It is still limited by missing historical odds coverage."
    },
    byMarket,
    calibration: calibrationSummary(rows),
    matches: rows.slice(-25)
  };
}

export function runBacktest(competitionCode = null, limit = 100) {
  return runBlindEvaluation(competitionCode, limit);
}
