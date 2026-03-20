import { getDb } from "../../db/database.js";
import { isoNow } from "../../lib/time.js";
import { buildExplanation } from "../reporting/explanationBuilder.js";
import { buildBettingAssessment, compareToImplied } from "./bettingEngine.js";
import { refreshTeamRatings, getTeamRatingsMap } from "./eloEngine.js";
import { buildMatchFeatures } from "./featureBuilder.js";
import { calculateProbabilities } from "./probabilityModel.js";

function storeAnalysis(matchId, model, betting, explanation) {
  const db = getDb();
  db.prepare(`
    INSERT INTO analysis_reports (
      match_id, generated_at, home_win_prob, draw_prob, away_win_prob, fair_home_odds,
      fair_draw_odds, fair_away_odds, edge_home, edge_draw, edge_away, recommended_bet,
      confidence, explanation, factors_json, market_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id) DO UPDATE SET
      generated_at = excluded.generated_at,
      home_win_prob = excluded.home_win_prob,
      draw_prob = excluded.draw_prob,
      away_win_prob = excluded.away_win_prob,
      fair_home_odds = excluded.fair_home_odds,
      fair_draw_odds = excluded.fair_draw_odds,
      fair_away_odds = excluded.fair_away_odds,
      edge_home = excluded.edge_home,
      edge_draw = excluded.edge_draw,
      edge_away = excluded.edge_away,
      recommended_bet = excluded.recommended_bet,
      confidence = excluded.confidence,
      explanation = excluded.explanation,
      factors_json = excluded.factors_json,
      market_json = excluded.market_json
  `).run(
    matchId,
    isoNow(),
    model.probabilities.homeWin,
    model.probabilities.draw,
    model.probabilities.awayWin,
    betting.fair.homeOdds,
    betting.fair.drawOdds,
    betting.fair.awayOdds,
    betting.edges.home,
    betting.edges.draw,
    betting.edges.away,
    betting.recommendation.outcome,
    betting.recommendation.confidence,
    explanation.summary,
    JSON.stringify(model.factors),
    JSON.stringify(betting.market)
  );
}

export function analyzeMatch(matchId, ratings = null, options = {}) {
  let ratingMap = ratings;
  const shouldStoreReport = options.storeReport ?? false;

  if (!ratingMap) {
    refreshTeamRatings();
    ratingMap = getTeamRatingsMap();
  }

  const features = buildMatchFeatures(matchId, ratingMap);
  const model = calculateProbabilities(features);
  const betting = buildBettingAssessment(matchId, model, {
    features,
    dataCoverageScore: features.context.dataCoverageScore,
    coverageBlend: model.diagnostics.coverageBlend,
    syncDiagnostics: options.syncDiagnostics ?? null
  });
  const impliedGap = compareToImplied(model.probabilities, betting.market);
  const explanation = buildExplanation(features, model, betting);

  if (shouldStoreReport) {
    storeAnalysis(matchId, model, betting, explanation);
  }

  return {
    features,
    model,
    betting,
    impliedGap,
    explanation
  };
}
