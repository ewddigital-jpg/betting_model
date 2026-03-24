import { clamp, round } from "../../lib/math.js";
import { getActiveModelParameters, normalizeModelParameters } from "./modelParameters.js";
import { getActiveHomeAdvantage } from "./eloEngine.js";

function factorial(value) {
  if (value <= 1) {
    return 1;
  }

  let result = 1;

  for (let index = 2; index <= value; index += 1) {
    result *= index;
  }

  return result;
}

function poissonProbability(lambda, goals) {
  return (Math.exp(-lambda) * (lambda ** goals)) / factorial(goals);
}

function normalizeProbabilities(result) {
  const total = result.homeWin + result.draw + result.awayWin;

  return {
    homeWin: result.homeWin / total,
    draw: result.draw / total,
    awayWin: result.awayWin / total
  };
}

function featureValue(entity, key, fallback) {
  return entity?.[key] ?? fallback;
}

function clampSignal(value, limit = 1.5) {
  return clamp(value, -limit, limit);
}

function logit(probability) {
  const safe = clamp(probability, 0.001, 0.999);
  return Math.log(safe / (1 - safe));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function applyBinaryTemperature(probability, temperature) {
  if (!Number.isFinite(probability)) {
    return 0.5;
  }

  return clamp(sigmoid(logit(probability) / temperature), 0.001, 0.999);
}

function applyThreeWayTemperature(probabilities, temperature) {
  const logits = [
    Math.log(clamp(probabilities.homeWin, 0.001, 0.999)),
    Math.log(clamp(probabilities.draw, 0.001, 0.999)),
    Math.log(clamp(probabilities.awayWin, 0.001, 0.999))
  ];
  const scaled = logits.map((value) => Math.exp(value / temperature));
  const total = scaled.reduce((sum, value) => sum + value, 0);

  return {
    homeWin: scaled[0] / total,
    draw: scaled[1] / total,
    awayWin: scaled[2] / total
  };
}

function marketBaselineWeight(features) {
  const baseline = featureValue(features.context, "marketBaseline", null);
  if (!baseline?.bookmakerMarginAdjustedProbability) {
    return 0;
  }

  const bookmakerCount = baseline.bookmakerCount ?? 0;
  const coverageScore = featureValue(features.context, "dataCoverageScore", 0.35);
  const freshnessPenalty = baseline.latestRetrievedAt
    ? clamp((new Date() - new Date(baseline.latestRetrievedAt)) / 36_000_000, 0, 1.2)
    : 1;

  return clamp(
    0.08 +
      Math.min(bookmakerCount, 6) * 0.025 +
      coverageScore * 0.08 -
      (freshnessPenalty * 0.05),
    0,
    0.28
  );
}

function normalizeThreeWayProbabilities(probabilities) {
  const total = (probabilities.homeWin ?? 0) + (probabilities.draw ?? 0) + (probabilities.awayWin ?? 0);
  if (!total) {
    return probabilities;
  }

  return {
    homeWin: probabilities.homeWin / total,
    draw: probabilities.draw / total,
    awayWin: probabilities.awayWin / total
  };
}

function neutralThreeWayAnchor(probabilities) {
  const directionalEdge = clamp((probabilities.homeWin - probabilities.awayWin) * 0.55, -0.18, 0.18);
  const drawShare = clamp(0.28 - (Math.abs(directionalEdge) * 0.18), 0.22, 0.32);

  return normalizeThreeWayProbabilities({
    homeWin: 0.36 + directionalEdge,
    draw: drawShare,
    awayWin: 0.36 - directionalEdge
  });
}

function applyMarketBaseline(probabilities, features) {
  const marginAdjusted = featureValue(features.context?.marketBaseline, "bookmakerMarginAdjustedProbability", null);
  const weight = marketBaselineWeight(features);

  if (!marginAdjusted || weight <= 0) {
    return {
      probabilities,
      diagnostics: {
        weight: 0,
        disagreement: null
      }
    };
  }

  const blended = normalizeThreeWayProbabilities({
    homeWin: (probabilities.homeWin * (1 - weight)) + (marginAdjusted.home * weight),
    draw: (probabilities.draw * (1 - weight)) + (marginAdjusted.draw * weight),
    awayWin: (probabilities.awayWin * (1 - weight)) + (marginAdjusted.away * weight)
  });
  const disagreement = round(
    Math.abs(probabilities.homeWin - marginAdjusted.home) +
    Math.abs(probabilities.draw - marginAdjusted.draw) +
    Math.abs(probabilities.awayWin - marginAdjusted.away),
    4
  );

  return {
    probabilities: blended,
    diagnostics: {
      weight: round(weight, 3),
      disagreement
    }
  };
}

function topThreeWayKey(probabilities) {
  return [
    { key: "homeWin", value: probabilities.homeWin ?? 0 },
    { key: "draw", value: probabilities.draw ?? 0 },
    { key: "awayWin", value: probabilities.awayWin ?? 0 }
  ].sort((left, right) => right.value - left.value)[0]?.key ?? "homeWin";
}

function rebalanceThreeWayTop(probabilities, topKey, targetTopProbability) {
  const currentTopProbability = probabilities[topKey] ?? 0;
  const boundedTarget = clamp(targetTopProbability, currentTopProbability, 0.85);

  if (boundedTarget <= currentTopProbability) {
    return probabilities;
  }

  const remainderCurrent = 1 - currentTopProbability;
  const remainderTarget = 1 - boundedTarget;
  const scale = remainderCurrent > 0 ? remainderTarget / remainderCurrent : 0;

  return normalizeThreeWayProbabilities({
    homeWin: topKey === "homeWin" ? boundedTarget : (probabilities.homeWin * scale),
    draw: topKey === "draw" ? boundedTarget : (probabilities.draw * scale),
    awayWin: topKey === "awayWin" ? boundedTarget : (probabilities.awayWin * scale)
  });
}

// Disabled: pulling model probabilities toward market consensus when they agree is circular
// reasoning. It erodes the very edge we are trying to identify, since the model already
// agrees with the market direction. Keeping the function signature intact for logging
// compatibility — diagnostics will always show 0 lift.
function applyFavoriteConsensusLift(probabilities, _features, _marketAnchor) {
  return {
    probabilities,
    diagnostics: {
      favoriteConsensusLift: 0,
      favoriteConsensusKey: null,
      favoriteConsensusSupport: null
    }
  };
}

function applyOneXTwoCalibration(probabilities, features, marketDiagnostics) {
  const ordered = [probabilities.homeWin, probabilities.draw, probabilities.awayWin]
    .sort((left, right) => right - left);
  const topProbability = ordered[0] ?? 0;
  const topGap = (ordered[0] ?? 0) - (ordered[1] ?? 0);
  const lineupUncertainty = (
    featureValue(features.home, "lineupUncertainty", 0.5) +
    featureValue(features.away, "lineupUncertainty", 0.5)
  ) / 2;
  const availabilityCoverage = featureValue(features.context, "availabilityCoverageScore", 0);
  const coverageScore = featureValue(features.context, "dataCoverageScore", 0.35);
  const marketAnchor = featureValue(features.context?.marketBaseline, "bookmakerMarginAdjustedProbability", null);

  let weight = 0.03;
  weight += clamp((topProbability - 0.5) * 0.35, 0, 0.08);
  weight += clamp((topGap - 0.08) * 0.45, 0, 0.06);
  weight += clamp((lineupUncertainty - 0.4) * 0.18, 0, 0.05);
  weight += clamp((0.6 - availabilityCoverage) * 0.12, 0, 0.04);
  weight += clamp((0.55 - coverageScore) * 0.1, 0, 0.03);
  weight -= (marketDiagnostics.weight ?? 0) * 0.18;
  weight = clamp(weight, 0, 0.18);
  const temperature = clamp(
    1.04 +
    Math.max(0, topProbability - 0.52) * 0.55 +
    Math.max(0, topGap - 0.08) * 0.9 +
    Math.max(0, lineupUncertainty - 0.4) * 0.35 +
    Math.max(0, 0.6 - coverageScore) * 0.18 -
    ((marketDiagnostics.weight ?? 0) * 0.45),
    1.02,
    1.28
  );
  const temperatureScaled = applyThreeWayTemperature(probabilities, temperature);

  if (weight <= 0) {
    return {
      probabilities: temperatureScaled,
      diagnostics: {
        calibrationWeight: 0,
        calibrationTemperature: round(temperature, 3),
        calibrationAnchor: null
      }
    };
  }

  const neutralAnchor = neutralThreeWayAnchor(probabilities);
  const anchor = marketAnchor
    ? normalizeThreeWayProbabilities({
        homeWin: (neutralAnchor.homeWin * 0.45) + (marketAnchor.home * 0.55),
        draw: (neutralAnchor.draw * 0.45) + (marketAnchor.draw * 0.55),
        awayWin: (neutralAnchor.awayWin * 0.45) + (marketAnchor.away * 0.55)
      })
    : neutralAnchor;
  const anchored = normalizeThreeWayProbabilities({
    homeWin: (temperatureScaled.homeWin * (1 - weight)) + (anchor.homeWin * weight),
    draw: (temperatureScaled.draw * (1 - weight)) + (anchor.draw * weight),
    awayWin: (temperatureScaled.awayWin * (1 - weight)) + (anchor.awayWin * weight)
  });
  const favoriteConsensusLift = applyFavoriteConsensusLift(anchored, features, marketAnchor);

  return {
    probabilities: favoriteConsensusLift.probabilities,
    diagnostics: {
      calibrationWeight: round(weight, 3),
      calibrationTemperature: round(temperature, 3),
      calibrationAnchor: anchor,
      favoriteConsensusLift: favoriteConsensusLift.diagnostics.favoriteConsensusLift,
      favoriteConsensusKey: favoriteConsensusLift.diagnostics.favoriteConsensusKey,
      favoriteConsensusSupport: favoriteConsensusLift.diagnostics.favoriteConsensusSupport ?? null
    }
  };
}

function buildRiskSignals(features, probabilities, expectedGoals, diagnostics) {
  const risks = [];
  const orderedProbabilities = [
    probabilities.homeWin,
    probabilities.draw,
    probabilities.awayWin
  ].sort((left, right) => right - left);

  if ((features.context?.dataCoverageScore ?? 0.35) < 0.55) {
    risks.push("Recent data coverage is limited, so the model is shrinking toward its Elo baseline.");
  }

  if ((diagnostics.coverageBlend ?? 0.5) < 0.5) {
    risks.push("Feature-driven adjustments are being dampened because the recent sample is not strong enough.");
  }

  if (Math.abs(expectedGoals.home - expectedGoals.away) < 0.2) {
    risks.push("Expected-goal margin is narrow, which increases result volatility.");
  }

  if ((orderedProbabilities[0] - orderedProbabilities[1]) < 0.08) {
    risks.push("The top two outcomes are close together, so the edge is sensitive to small data changes.");
  }

  if ((features.context?.availabilityCoverageScore ?? 0) < 0.35) {
    risks.push("Availability data is still patchy, so lineup-related adjustments stay conservative.");
  }

  if ((diagnostics.marketBaselineWeight ?? 0) > 0) {
    if ((diagnostics.modelVsMarketDisagreement ?? 0) > 0.16) {
      risks.push("The bookmaker baseline still disagrees with the raw model by a meaningful margin.");
    } else {
      risks.push("The bookmaker baseline is helping keep the raw model grounded.");
    }
  }

  if ((diagnostics.oneXTwoCalibrationWeight ?? 0) >= 0.1) {
    risks.push("The 1X2 call is being tempered because this spot still looks easier to overstate than to price cleanly.");
  }

  if ((features.home?.missingPrimaryGoalkeeper ?? false) || (features.away?.missingPrimaryGoalkeeper ?? false)) {
    risks.push("A likely goalkeeper change adds extra volatility to the match.");
  }

  if ((features.home?.missingCoreStartersCount ?? 0) >= 2 || (features.away?.missingCoreStartersCount ?? 0) >= 2) {
    risks.push("One of the likely XIs is missing too much of its usual core.");
  }

  return risks;
}

function buildEloBaseline(avgHomeGoals, avgAwayGoals, eloDelta, parameters) {
  return {
    home: clamp(avgHomeGoals + (eloDelta / parameters.baseline.homeEloDivisor), 0.45, 2.9),
    away: clamp(avgAwayGoals - (eloDelta / parameters.baseline.awayEloDivisor), 0.35, 2.5)
  };
}

function buildFeatureAdjustments(features, avgHomeGoals, avgAwayGoals) {
  const opponentAdjustedFormDelta = clampSignal(
    (
      featureValue(features.home, "opponentAdjustedForm", featureValue(features.home, "recentFormPpg", 1.35)) -
      featureValue(features.away, "opponentAdjustedForm", featureValue(features.away, "recentFormPpg", 1.35))
    ) / 3,
    1
  );
  const shortAttackDelta = clampSignal(
    (
      featureValue(features.home, "avgGoalsLast5", featureValue(features.home, "weightedGoalsFor", 1.2)) - avgHomeGoals
    ) +
    (
      featureValue(features.away, "avgConcededLast5", featureValue(features.away, "weightedGoalsAgainst", 1.2)) - avgAwayGoals
    ),
    1.35
  );
  const shortDefenseDelta = clampSignal(
    (
      featureValue(features.away, "avgGoalsLast5", featureValue(features.away, "weightedGoalsFor", 1.2)) - avgAwayGoals
    ) +
    (
      featureValue(features.home, "avgConcededLast5", featureValue(features.home, "weightedGoalsAgainst", 1.2)) - avgHomeGoals
    ),
    1.35
  );
  const momentumDelta = clampSignal(
    featureValue(features.home, "goalDiffLast5", 0) - featureValue(features.away, "goalDiffLast5", 0),
    1.1
  );
  const homeVenueStrengthDelta = clampSignal(
    (featureValue(features.home, "homeAttackStrength", 1) - 1) +
    (featureValue(features.away, "awayDefenseStrength", 1) - 1),
    0.8
  );
  const awayVenueStrengthDelta = clampSignal(
    (featureValue(features.away, "awayAttackStrength", 1) - 1) +
    (featureValue(features.home, "homeDefenseStrength", 1) - 1),
    0.8
  );
  const scheduleDelta = clampSignal(featureValue(features.context, "homeRestEdge", 0), 1);
  const xgHomeDelta = clampSignal(
    (
      featureValue(features.home, "avgXgLast5", avgHomeGoals) - avgHomeGoals +
      featureValue(features.away, "avgXgaLast5", avgAwayGoals) - avgAwayGoals
    ) +
    ((featureValue(features.home, "xgDifferenceLast5", 0) - featureValue(features.away, "xgDifferenceLast5", 0)) * 0.35) +
    ((featureValue(features.home, "xgAttackStrength", 1) - featureValue(features.away, "xgDefenseStrength", 1)) * 0.45),
    0.8
  );
  const xgAwayDelta = clampSignal(
    (
      featureValue(features.away, "avgXgLast5", avgAwayGoals) - avgAwayGoals +
      featureValue(features.home, "avgXgaLast5", avgHomeGoals) - avgHomeGoals
    ) +
    ((featureValue(features.away, "xgDifferenceLast5", 0) - featureValue(features.home, "xgDifferenceLast5", 0)) * 0.35) +
    ((featureValue(features.away, "xgAttackStrength", 1) - featureValue(features.home, "xgDefenseStrength", 1)) * 0.45),
    0.8
  );
  const availabilityDelta = clampSignal(
    (
      featureValue(features.home, "lineupStrength", 0) +
      featureValue(features.home, "expectedLineupStrength", 0) +
      featureValue(features.home, "injuryImpact", 0) +
      (featureValue(features.home, "starterStrengthDelta", 0) * 0.45) +
      ((featureValue(features.home, "lineupContinuityScore", 0.5) - 0.5) * 0.35) -
      (featureValue(features.home, "lineupUncertainty", 0.5) * 0.18) -
      (featureValue(features.home, "missingKeyPlayers", 0) * 0.05) -
      (featureValue(features.home, "missingPrimaryGoalkeeper", false) ? 0.22 : 0)
    ) -
    (
      featureValue(features.away, "lineupStrength", 0) +
      featureValue(features.away, "expectedLineupStrength", 0) +
      featureValue(features.away, "injuryImpact", 0) +
      (featureValue(features.away, "starterStrengthDelta", 0) * 0.45) +
      ((featureValue(features.away, "lineupContinuityScore", 0.5) - 0.5) * 0.35) -
      (featureValue(features.away, "lineupUncertainty", 0.5) * 0.18) -
      (featureValue(features.away, "missingKeyPlayers", 0) * 0.05) -
      (featureValue(features.away, "missingPrimaryGoalkeeper", false) ? 0.22 : 0)
    ),
    1.1
  );
  const xgMomentumDelta = clampSignal(
    (featureValue(features.home, "xgTrendMomentum", 0) - featureValue(features.away, "xgTrendMomentum", 0)) * 0.8,
    0.45
  );
  const goalMomentumDelta = clampSignal(
    featureValue(features.home, "goalDifferenceMomentum", 0) - featureValue(features.away, "goalDifferenceMomentum", 0),
    0.7
  );
  const restAdvantageDelta = clampSignal(featureValue(features.context, "restDaysAdvantage", 0), 1);
  const attackEfficiencyDelta = clampSignal(
    featureValue(features.home, "recentAttackingEfficiency", 1) - featureValue(features.away, "recentAttackingEfficiency", 1),
    0.5
  );
  const venueProfileDelta = clampSignal(featureValue(features.context, "homeAwayStrengthDelta", 0), 0.9);

  return {
    opponentAdjustedFormDelta,
    shortAttackDelta,
    shortDefenseDelta,
    momentumDelta,
    homeVenueStrengthDelta,
    awayVenueStrengthDelta,
    scheduleDelta,
    xgHomeDelta,
    xgAwayDelta,
    availabilityDelta,
    xgMomentumDelta,
    goalMomentumDelta,
    restAdvantageDelta,
    attackEfficiencyDelta,
    venueProfileDelta
  };
}

function buildContributionMap(features, adjustments, coverageBlend, eloDelta, parameters) {
  const awayAttackWeight = parameters.away.shortAttack ?? parameters.away.shortDefense ?? parameters.home.shortAttack ?? 0.2;

  return {
    elo: {
      label: "Elo edge",
      value: round(eloDelta, 1),
      home: 0,
      away: 0,
      baselineHome: eloDelta / 900,
      baselineAway: -eloDelta / 1100
    },
    opponentAdjustedForm: {
      label: "Opponent-adjusted form",
      value: round(adjustments.opponentAdjustedFormDelta * 3, 2),
      home: adjustments.opponentAdjustedFormDelta * parameters.home.opponentAdjustedForm * coverageBlend,
      away: -adjustments.opponentAdjustedFormDelta * parameters.away.opponentAdjustedForm * coverageBlend
    },
    shortAttack: {
      label: "Short-term attack",
      value: round(adjustments.shortAttackDelta, 2),
      home: adjustments.shortAttackDelta * parameters.home.shortAttack * coverageBlend,
      away: 0
    },
    shortDefense: {
      label: "Short-term defense",
      value: round(adjustments.shortDefenseDelta, 2),
      home: 0,
      away: adjustments.shortDefenseDelta * parameters.away.shortDefense * coverageBlend
    },
    venueStrength: {
      label: "Venue strength matchup",
      value: round(adjustments.homeVenueStrengthDelta - adjustments.awayVenueStrengthDelta, 2),
      home: adjustments.homeVenueStrengthDelta * parameters.home.venueStrength * coverageBlend,
      away: adjustments.awayVenueStrengthDelta * parameters.away.venueStrength * coverageBlend
    },
    momentum: {
      label: "Goal-difference momentum",
      value: round(adjustments.momentumDelta, 2),
      home: adjustments.momentumDelta * parameters.home.momentum * coverageBlend,
      away: -adjustments.momentumDelta * parameters.away.momentum * coverageBlend
    },
    schedule: {
      label: "Rest-days edge",
      value: round(
        featureValue(features.home, "restDays", 6) - featureValue(features.away, "restDays", 6),
        1
      ),
      home: adjustments.scheduleDelta * parameters.home.schedule,
      away: -adjustments.scheduleDelta * parameters.away.schedule
    },
    restAdvantage: {
      label: "Rest advantage",
      value: round(featureValue(features.context, "restDaysAdvantage", 0), 2),
      home: adjustments.restAdvantageDelta * parameters.home.schedule * 0.55,
      away: -adjustments.restAdvantageDelta * parameters.away.schedule * 0.55
    },
    xg: {
      label: "Chance-quality context",
      value: round(adjustments.xgHomeDelta - adjustments.xgAwayDelta, 2),
      home: adjustments.xgHomeDelta * parameters.home.xg * coverageBlend,
      away: adjustments.xgAwayDelta * parameters.away.xg * coverageBlend
    },
    xgMomentum: {
      label: "Expected-goals momentum",
      value: round(adjustments.xgMomentumDelta, 2),
      home: adjustments.xgMomentumDelta * parameters.home.xg * 0.55 * coverageBlend,
      away: -adjustments.xgMomentumDelta * parameters.away.xg * 0.55 * coverageBlend
    },
    goalMomentum: {
      label: "Goal-difference momentum",
      value: round(adjustments.goalMomentumDelta, 2),
      home: adjustments.goalMomentumDelta * parameters.home.momentum * 0.55 * coverageBlend,
      away: -adjustments.goalMomentumDelta * parameters.away.momentum * 0.55 * coverageBlend
    },
    efficiency: {
      label: "Attacking efficiency",
      value: round(adjustments.attackEfficiencyDelta, 2),
      home: adjustments.attackEfficiencyDelta * parameters.home.shortAttack * 0.45 * coverageBlend,
      away: -adjustments.attackEfficiencyDelta * awayAttackWeight * 0.45 * coverageBlend
    },
    venueProfile: {
      label: "Home-away profile",
      value: round(adjustments.venueProfileDelta, 2),
      home: adjustments.venueProfileDelta * parameters.home.venueStrength * 0.4 * coverageBlend,
      away: -adjustments.venueProfileDelta * parameters.away.venueStrength * 0.4 * coverageBlend
    },
    availability: {
      label: "Team news and XI strength",
      value: round(adjustments.availabilityDelta, 2),
      home: adjustments.availabilityDelta * parameters.home.availability,
      away: -adjustments.availabilityDelta * parameters.away.availability
    }
  };
}

function buildExpectedGoals(avgHomeGoals, avgAwayGoals, baseline, contributionMap, coverageBlend) {
  const homeAdjustment = Object.values(contributionMap).reduce((sum, contribution) => sum + contribution.home, 0);
  const awayAdjustment = Object.values(contributionMap).reduce((sum, contribution) => sum + contribution.away, 0);
  const featureDriven = {
    home: clamp(baseline.home + homeAdjustment, 0.35, 3.3),
    away: clamp(baseline.away + awayAdjustment, 0.25, 3.0)
  };

  return {
    home: clamp((featureDriven.home * coverageBlend) + (baseline.home * (1 - coverageBlend)), 0.3, 3.7),
    away: clamp((featureDriven.away * coverageBlend) + (baseline.away * (1 - coverageBlend)), 0.2, 3.2),
    featureDriven,
    baseline: {
      home: clamp(baseline.home, 0.3, 3.7),
      away: clamp(baseline.away, 0.2, 3.2)
    },
    competition: {
      home: avgHomeGoals,
      away: avgAwayGoals
    }
  };
}

export function buildModelSignals(features, parameterOverrides = null) {
  const parameters = parameterOverrides
    ? normalizeModelParameters(parameterOverrides)
    : getActiveModelParameters().parameters;
  const avgHomeGoals = featureValue(features.competitionAverages, "avgHomeGoals", 1.45);
  const avgAwayGoals = featureValue(features.competitionAverages, "avgAwayGoals", 1.18);
  const eloDelta = (featureValue(features.home, "elo", 1500) + getActiveHomeAdvantage()) - featureValue(features.away, "elo", 1500);
  const coverageScore = featureValue(features.context, "dataCoverageScore", 0.35);
  const coverageBlend = clamp(0.2 + (coverageScore * 0.75), 0.25, 0.95);
  const baseline = buildEloBaseline(avgHomeGoals, avgAwayGoals, eloDelta, parameters);
  const adjustments = buildFeatureAdjustments(features, avgHomeGoals, avgAwayGoals);
  const contributionMap = buildContributionMap(features, adjustments, coverageBlend, eloDelta, parameters);
  const expectedGoalsModel = buildExpectedGoals(
    avgHomeGoals,
    avgAwayGoals,
    baseline,
    contributionMap,
    coverageBlend
  );

  return {
    parameters,
    avgHomeGoals,
    avgAwayGoals,
    eloDelta,
    coverageScore,
    coverageBlend,
    baseline,
    adjustments,
    contributionMap,
    expectedGoalsModel
  };
}

export function calculateProbabilities(features, options = {}) {
  const signals = buildModelSignals(features, options.parameters ?? null);

  const matrix = [];
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  for (let homeGoals = 0; homeGoals <= 6; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= 6; awayGoals += 1) {
      const probability = poissonProbability(signals.expectedGoalsModel.home, homeGoals) * poissonProbability(signals.expectedGoalsModel.away, awayGoals);
      matrix.push({ homeGoals, awayGoals, probability });

      if (homeGoals > awayGoals) {
        homeWin += probability;
      } else if (homeGoals === awayGoals) {
        draw += probability;
      } else {
        awayWin += probability;
      }
    }
  }

  const rawNormalized = normalizeProbabilities({ homeWin, draw, awayWin });
  const marketAdjusted = applyMarketBaseline(rawNormalized, features);
  const calibrated = applyOneXTwoCalibration(marketAdjusted.probabilities, features, marketAdjusted.diagnostics);
  const normalized = calibrated.probabilities;
  const factors = Object.entries(signals.contributionMap).map(([key, contribution]) => ({
    key,
    label: contribution.label,
    value: contribution.value,
    impact: round(
      (contribution.home + (contribution.baselineHome ?? 0)) -
      (contribution.away + (contribution.baselineAway ?? 0)),
      3
    ),
    homeImpact: round(contribution.home + (contribution.baselineHome ?? 0), 3),
    awayImpact: round(contribution.away + (contribution.baselineAway ?? 0), 3)
  }));
  const positiveDrivers = [...factors]
    .filter((factor) => factor.impact > 0)
    .sort((left, right) => right.impact - left.impact)
    .slice(0, 3);
  const negativeDrivers = [...factors]
    .filter((factor) => factor.impact < 0)
    .sort((left, right) => left.impact - right.impact)
    .slice(0, 3);
  const diagnostics = {
    dataCoverageScore: round(signals.coverageScore, 2),
    coverageBlend: round(signals.coverageBlend, 2),
    baselineExpectedGoals: {
      home: round(signals.expectedGoalsModel.baseline.home, 2),
      away: round(signals.expectedGoalsModel.baseline.away, 2)
    },
    featureDrivenExpectedGoals: {
      home: round(signals.expectedGoalsModel.featureDriven.home, 2),
      away: round(signals.expectedGoalsModel.featureDriven.away, 2)
    },
    bookmakerImpliedProbability: features.context?.marketBaseline?.bookmakerImpliedProbability ?? null,
    bookmakerMarginAdjustedProbability: features.context?.marketBaseline?.bookmakerMarginAdjustedProbability ?? null,
    bookmakerMargin: features.context?.marketBaseline?.bookmakerMargin ?? null,
    bookmakerCount: features.context?.marketBaseline?.bookmakerCount ?? 0,
    marketBaselineWeight: marketAdjusted.diagnostics.weight,
    modelVsMarketDisagreement: marketAdjusted.diagnostics.disagreement,
    oneXTwoCalibrationWeight: calibrated.diagnostics.calibrationWeight,
    oneXTwoFavoriteConsensusLift: calibrated.diagnostics.favoriteConsensusLift ?? 0,
    oneXTwoFavoriteConsensusKey: calibrated.diagnostics.favoriteConsensusKey ?? null,
    oneXTwoCalibrationAnchor: calibrated.diagnostics.calibrationAnchor
      ? {
          homeWin: round(calibrated.diagnostics.calibrationAnchor.homeWin, 4),
          draw: round(calibrated.diagnostics.calibrationAnchor.draw, 4),
          awayWin: round(calibrated.diagnostics.calibrationAnchor.awayWin, 4)
        }
      : null,
    rawProbabilities: {
      homeWin: round(rawNormalized.homeWin, 4),
      draw: round(rawNormalized.draw, 4),
      awayWin: round(rawNormalized.awayWin, 4)
    },
    marketAdjustedProbabilities: {
      homeWin: round(marketAdjusted.probabilities.homeWin, 4),
      draw: round(marketAdjusted.probabilities.draw, 4),
      awayWin: round(marketAdjusted.probabilities.awayWin, 4)
    },
    parameterSource: options.parameters ? "override" : getActiveModelParameters().source,
    activeParameterSetId: options.parameters ? null : getActiveModelParameters().id
  };
  const risks = buildRiskSignals(
    features,
    normalized,
    { home: signals.expectedGoalsModel.home, away: signals.expectedGoalsModel.away },
    diagnostics
  );

  return {
    expectedGoals: {
      home: round(signals.expectedGoalsModel.home, 2),
      away: round(signals.expectedGoalsModel.away, 2)
    },
    probabilities: {
      homeWin: round(normalized.homeWin, 4),
      draw: round(normalized.draw, 4),
      awayWin: round(normalized.awayWin, 4)
    },
    factors,
    positiveDrivers,
    negativeDrivers,
    risks,
    diagnostics,
    scoreMatrix: matrix
  };
}
