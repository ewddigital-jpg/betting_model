import { COMPETITION_BY_CODE } from "../../config/leagues.js";
import { round } from "../../lib/math.js";

function buildModelLean(features, model) {
  return [
    { label: features.home.name, probability: model.probabilities.homeWin, key: "home" },
    { label: "Draw", probability: model.probabilities.draw, key: "draw" },
    { label: features.away.name, probability: model.probabilities.awayWin, key: "away" }
  ].sort((left, right) => right.probability - left.probability)[0];
}

function secondResult(features, model) {
  return [
    { label: features.home.name, probability: model.probabilities.homeWin, key: "home" },
    { label: "Draw", probability: model.probabilities.draw, key: "draw" },
    { label: features.away.name, probability: model.probabilities.awayWin, key: "away" }
  ].sort((left, right) => right.probability - left.probability)[1];
}

function recordLine(record) {
  return `${record.wins}-${record.draws}-${record.losses}`;
}

function competitionName(features) {
  return COMPETITION_BY_CODE[features.match.competition_code]?.name ?? "this competition";
}

function formatPct(value) {
  return `${round(value * 100, 1)}%`;
}

function formatOdds(value) {
  return value === null || value === undefined ? "n/a" : round(value, 2);
}

function oneXTwoTargetOdds(fairPrice) {
  return fairPrice === null || fairPrice === undefined
    ? null
    : round(fairPrice * 1.06, 2);
}

function recentRunLine(team) {
  const matches = team.recentMatches ?? [];

  if (!matches.length) {
    return null;
  }

  const streak = [];
  for (const match of matches) {
    if (!streak.length || match.result === streak[0]) {
      streak.push(match);
      continue;
    }
    break;
  }

  const labelMap = {
    W: "wins",
    D: "draws",
    L: "defeats"
  };
  const outcome = streak[0]?.result;

  if (!outcome || streak.length < 2) {
    return null;
  }

  return `${team.name} comes in off ${streak.length} straight ${labelMap[outcome]}.`;
}

function recentResultsLine(team) {
  const results = (team.recentMatches ?? [])
    .slice(0, 3)
    .map((match) => `${match.result} ${match.scoreline} vs ${match.opponent}`)
    .join(", ");

  return results ? `Recent results: ${results}.` : null;
}

function buildFormReason(team, compareTeam) {
  if ((team.recentRecord?.played ?? 0) < 4) {
    return null;
  }

  const comparePpg = compareTeam.recentRecord?.pointsPerGame ?? compareTeam.recentFormPpg;
  if ((team.recentRecord.pointsPerGame - comparePpg) < 0.2) {
    return null;
  }

  return `${team.name} is the stronger form side right now, taking ${team.recentRecord.wins} wins from the last ${team.recentRecord.played} and running at ${round(team.recentRecord.pointsPerGame, 2)} points per game.`;
}

function buildAttackReason(team, compareTeam) {
  const goalGap = (team.avgGoalsLast5 - compareTeam.avgGoalsLast5);

  if (goalGap < 0.2) {
    return null;
  }

  return `${team.name} is carrying the stronger recent attack at ${round(team.avgGoalsLast5, 2)} goals per game over the last five, while ${compareTeam.name} is at ${round(compareTeam.avgGoalsLast5, 2)}.`;
}

function buildXgReason(team, compareTeam) {
  if ((team.xgSampleSize ?? 0) < 3 || (compareTeam.xgSampleSize ?? 0) < 3) {
    return null;
  }

  const xgTrendGap = (team.xgDifferenceLast5 ?? 0) - (compareTeam.xgDifferenceLast5 ?? 0);
  if (xgTrendGap < 0.2) {
    return null;
  }

  return `${team.name} has the stronger recent expected-goals trend, creating about ${round(team.avgXgLast5, 2)} xG and allowing ${round(team.avgXgaLast5, 2)} xGA over the last five, while ${compareTeam.name} has been looser on chance quality.`;
}

function buildDefenseReason(team, compareTeam) {
  const gap = compareTeam.avgConcededLast5 - team.avgConcededLast5;

  if (gap < 0.2) {
    return null;
  }

  return `${team.name} has been the steadier defensive side lately, conceding ${round(team.avgConcededLast5, 2)} per game across the last five against ${round(compareTeam.avgConcededLast5, 2)} for ${compareTeam.name}.`;
}

function buildRestReason(team, compareTeam, features) {
  const restEdge = features.context.restDaysAdvantage ?? 0;

  if (Math.abs(restEdge) < 1.5) {
    return null;
  }

  const advantaged = restEdge > 0 ? features.home.name : features.away.name;
  const disadvantaged = restEdge > 0 ? features.away.name : features.home.name;

  return `${advantaged} comes in with the fresher schedule, while ${disadvantaged} has had less recovery time.`;
}

function buildEfficiencyReason(team, compareTeam) {
  const efficiencyGap = (team.recentAttackingEfficiency ?? 1) - (compareTeam.recentAttackingEfficiency ?? 1);

  if (efficiencyGap < 0.08) {
    return null;
  }

  return `${team.name} has been finishing recent chances more cleanly, which supports the attack beyond the raw goal line.`;
}

function buildVenueReason(team, compareTeam, isHomeSide) {
  const sideRecord = team.sideRecord;

  if ((sideRecord?.played ?? 0) < 5) {
    return null;
  }

  const attackGap = (isHomeSide ? team.homeAttackStrength : team.awayAttackStrength) - 1;
  const compareDefenseGap = (isHomeSide ? compareTeam.awayDefenseStrength : compareTeam.homeDefenseStrength) - 1;
  const strongRecord = sideRecord.wins >= Math.ceil(sideRecord.played * 0.6);

  if (attackGap + compareDefenseGap < 0.12 && !strongRecord) {
    return null;
  }

  return isHomeSide
    ? `${team.name} has gone ${recordLine(sideRecord)} across the last ${sideRecord.played} home matches, so the venue edge is real rather than cosmetic.`
    : `${team.name} has gone ${recordLine(sideRecord)} across the last ${sideRecord.played} away matches, so this is not a side walking into an unfamiliar script.`;
}

function buildCompetitionReason(team, features, isHomeSide) {
  const record = team.competitionSideRecord;

  if ((record?.played ?? 0) < 3) {
    return null;
  }

  const venueLabel = isHomeSide ? "at home" : "away";
  return `In ${competitionName(features)} ${venueLabel} over the last two seasons, ${team.name} has gone ${recordLine(record)} in ${record.played} matches.`;
}

function buildStrongOppositionReason(team) {
  const record = team.recentRecord;

  if ((record?.strongOppPlayed ?? 0) < 3 || (record?.strongOppWins ?? 0) < 2) {
    return null;
  }

  return `${team.name} has already passed ${record.strongOppWins} strong-team tests in the last ${record.strongOppPlayed} high-level matches.`;
}

function buildAvailabilityReason(team, compareTeam) {
  const teamImpact = (team.injuryImpactScore ?? 0) + (team.suspensionImpactScore ?? 0);
  const compareImpact = (compareTeam.injuryImpactScore ?? 0) + (compareTeam.suspensionImpactScore ?? 0);
  const keyPositions = team.missingKeyPositions ?? [];
  const missingCoreNames = (team.missingCorePlayers ?? []).slice(0, 2).map((item) => item.player).filter(Boolean);
  const compareMissingNames = [...(compareTeam.injuries ?? []), ...(compareTeam.suspensions ?? [])]
    .slice(0, 2)
    .map((item) => item.player)
    .filter(Boolean);

  if ((team.sourceConflictScore ?? 0) >= 0.18) {
    return `${team.name} still has conflicting team-news signals, so the availability read is less clean than usual.`;
  }

  if ((compareTeam.sourceConflictScore ?? 0) >= 0.18) {
    return `${compareTeam.name} still has conflicting team-news signals, which lowers trust in the other side's edge too.`;
  }

  if ((team.lineupCertaintyScore ?? 0.5) < 0.55) {
    return `${team.name} still has a noisy team-news picture, so this side is less settled than the raw numbers suggest.`;
  }

  if (team.structuredLineupSource && compareTeam.structuredLineupSource && (team.lineupCertaintyScore ?? 0.5) >= 0.8) {
    return `${team.name} has a stronger official lineup read behind it, so the expected XI looks more trustworthy than a soft preview call.`;
  }

  if ((compareImpact - teamImpact) >= 0.25) {
    if (compareMissingNames.length) {
      return `${team.name} looks closer to full strength, while ${compareTeam.name} is still carrying issues around ${compareMissingNames.join(" and ")}.`;
    }

    return `${team.name} looks closer to full strength, and ${compareTeam.name} is still carrying the heavier availability load.`;
  }

  if ((team.expectedLineupStrength ?? 0) >= 0.14 && (team.lineupContinuityScore ?? 0.5) >= 0.65) {
    return `${team.name} is expected to put out a strong, settled XI rather than a patched-up version.`;
  }

  if ((team.missingPrimaryGoalkeeper ?? false)) {
    return `${team.name} may be going in without its usual goalkeeper, which is a bigger issue than a routine squad absence.`;
  }

  if ((team.missingCoreStartersCount ?? 0) >= 2 && missingCoreNames.length) {
    return `${team.name} may still be short on its usual core through ${missingCoreNames.join(" and ")}.`;
  }

  if ((team.missingStartersCount ?? 0) >= 1 && keyPositions.length) {
    return `${team.name} may still be short in a key ${keyPositions[0]} role, which keeps a lid on trust.`;
  }

  if ((team.missingStartersCount ?? 0) >= 2) {
    return `${team.name} could still be without ${team.missingStartersCount} likely starters.`;
  }

  return null;
}

function buildNoBetSummary(features, model, betting) {
  const modelLean = buildModelLean(features, model);
  const hasAnyOdds = Object.values(betting.markets).some((market) => market.hasOdds);
  const fairPrice = modelLean.key === "home"
    ? betting.fair.homeOdds
    : modelLean.key === "away"
      ? betting.fair.awayOdds
      : betting.fair.drawOdds;
  const targetOdds = oneXTwoTargetOdds(fairPrice);

  if (!hasAnyOdds) {
    return `If I were betting this match, I would wait. ${modelLean.label} is the likeliest result at ${formatPct(modelLean.probability)}, but there is still no usable price on the board${targetOdds ? ` and this only becomes interesting nearer ${targetOdds}` : ""}.`;
  }

  return `If I were betting this match, I would still pass for now. ${modelLean.label} is the likeliest result at ${formatPct(modelLean.probability)}, but the current prices are too tight${targetOdds ? ` and it only comes back into play around ${targetOdds}` : ""}.`;
}

function buildBetSummary(features, model, betting) {
  const totalGoals = round(model.expectedGoals.home + model.expectedGoals.away, 2);

  if (betting.bestBet.marketName === "1X2") {
    return `If I were betting the match result, I would lean toward ${betting.bestBet.selectionLabel}. The football case and the price are still pointing the same way.`;
  }

  if (betting.bestBet.marketName === "Over / Under 2.5") {
    return betting.bestBet.selectionLabel === "Under 2.5"
      ? `If I were betting this match, I would lean toward Under 2.5. The game does not project as openly as the current number suggests.`
      : `If I were betting this match, I would lean toward Over 2.5. The matchup still projects around ${totalGoals} goals and the market has not fully caught up.`;
  }

  return betting.bestBet.selectionLabel === "BTTS Yes"
    ? `If I were betting this match, I would lean toward ${betting.bestBet.selectionLabel}. Both teams still clear a believable scoring line and the price is still usable.`
    : `If I were betting this match, I would lean toward ${betting.bestBet.selectionLabel}. One side still looks vulnerable to a low-shot or low-quality attacking night.`;
}

function buildModelLeanText(features, model) {
  const lean = buildModelLean(features, model);
  const runnerUp = secondResult(features, model);
  const gap = lean.probability - runnerUp.probability;
  const pressure = gap >= 0.15 ? "This is a proper lean, not a coin flip." : "The lean is real, but the split is not wide.";
  return `${lean.label} is the most likely result at ${formatPct(lean.probability)}. The next closest outcome is ${runnerUp.label} at ${formatPct(runnerUp.probability)}. ${pressure}`;
}

function buildKeyReasons(features, model) {
  const home = features.home;
  const away = features.away;
  const lean = buildModelLean(features, model);
  const favoredTeam = lean.key === "home" ? home : away;
  const underdogTeam = lean.key === "home" ? away : home;
  const favoredIsHome = lean.key === "home";

  const candidates = [
    buildFormReason(favoredTeam, underdogTeam),
    buildXgReason(favoredTeam, underdogTeam),
    buildEfficiencyReason(favoredTeam, underdogTeam),
    buildAttackReason(favoredTeam, underdogTeam),
    buildDefenseReason(favoredTeam, underdogTeam),
    buildRestReason(favoredTeam, underdogTeam, features),
    buildVenueReason(favoredTeam, underdogTeam, favoredIsHome),
    buildCompetitionReason(favoredTeam, features, favoredIsHome),
    buildStrongOppositionReason(favoredTeam),
    buildAvailabilityReason(favoredTeam, underdogTeam),
    recentRunLine(favoredTeam),
    recentResultsLine(favoredTeam)
  ].filter(Boolean);

  if (!candidates.length) {
    return [
      `${favoredTeam.name} still holds the stronger overall profile.`,
      `${favoredTeam.name} projects the cleaner scoring output in this matchup.`
    ];
  }

  return [...new Set(candidates)].slice(0, 4);
}

function buildRiskFactors(features, model, betting) {
  const risks = [];
  const home = features.home;
  const away = features.away;
  const probabilities = [model.probabilities.homeWin, model.probabilities.draw, model.probabilities.awayWin]
    .sort((left, right) => right - left);
  const topMarket = betting.bestBet?.hasBet
    ? Object.values(betting.markets).find((market) => market.name === betting.bestBet.marketName)
    : betting.markets.oneXTwo;

  if ((home.recentRecord?.played ?? 0) >= 4 && (away.recentRecord?.played ?? 0) >= 4) {
    const ppgGap = Math.abs((home.recentRecord.pointsPerGame ?? home.recentFormPpg) - (away.recentRecord.pointsPerGame ?? away.recentFormPpg));
    if (ppgGap < 0.25) {
      risks.push("Recent form is tighter than the headline call.");
    }
  }

  if (Math.abs(model.expectedGoals.home - model.expectedGoals.away) < 0.25) {
    risks.push("The goal projection is still tight, so this is not a runaway setup.");
  }

  if ((probabilities[0] - probabilities[1]) < 0.08) {
    risks.push("The result split is narrow enough that one swing can flip the call.");
  }

  if ((topMarket?.trust?.bookmakerCount ?? 0) === 0) {
    risks.push("There is still no stored bookmaker price.");
  } else if ((topMarket?.trust?.bookmakerCount ?? 0) === 1) {
    risks.push("The price is still coming from a thin bookmaker view.");
  }

  if ((topMarket?.bestOption?.disagreement ?? 0) > 0.18 && topMarket?.name === "1X2") {
    risks.push("The market is far colder on this result than the model, so the price may be more trap than gift.");
  } else if ((topMarket?.bestOption?.disagreement ?? 0) > 0.1 && topMarket?.name === "1X2") {
    risks.push("The model is still noticeably more bullish than the bookmaker board.");
  }

  if ((features.context.dataCoverageScore ?? 0) < 0.6) {
    risks.push("The sample is not deep enough to push hard.");
  }

  if ((features.context.hoursToKickoff ?? 99) <= 3 && ((home.expectedLineup?.length ?? 0) < 9 || (away.expectedLineup?.length ?? 0) < 9)) {
    risks.push("Kickoff is close, but the projected lineups still are not firm enough.");
  }

  if ((home.lineupCertaintyScore ?? 0.5) < 0.65 || (away.lineupCertaintyScore ?? 0.5) < 0.65) {
    risks.push("Lineup uncertainty still lowers trust.");
  }

  if ((home.missingStartersCount ?? 0) >= 1) {
    const homePosition = home.missingKeyPositions?.[0];
    const homeName = [
      ...(home.missingCorePlayers ?? []).map((item) => item.player),
      ...(home.injuries ?? []).map((item) => item.player),
      ...(home.suspensions ?? []).map((item) => item.player)
    ].filter(Boolean)[0];
    risks.push(
      homeName
        ? `${home.name} may still be missing ${homeName}${homePosition ? ` in a key ${homePosition} role` : ""}.`
        : homePosition
          ? `${home.name} may still be light in a key ${homePosition} role.`
          : `${home.name} may still be missing an important starter.`
    );
  }

  if ((away.missingStartersCount ?? 0) >= 1) {
    const awayPosition = away.missingKeyPositions?.[0];
    const awayName = [
      ...(away.missingCorePlayers ?? []).map((item) => item.player),
      ...(away.injuries ?? []).map((item) => item.player),
      ...(away.suspensions ?? []).map((item) => item.player)
    ].filter(Boolean)[0];
    risks.push(
      awayName
        ? `${away.name} may still be missing ${awayName}${awayPosition ? ` in a key ${awayPosition} role` : ""}.`
        : awayPosition
          ? `${away.name} may still be light in a key ${awayPosition} role.`
          : `${away.name} may still be missing an important starter.`
    );
  }

  if (!betting.bestBet?.hasBet) {
    risks.push("There is still a football lean, but not a clean betting edge.");
  }

  const movement = topMarket?.bestOption?.movement ?? null;
  if (movement !== null && Math.abs(movement) >= 0.12) {
    risks.push(
      movement < 0
        ? "The price has already shortened, so some of the value may be gone."
        : "The price is drifting, which can mean the market is less convinced."
    );
  }

  return [...new Set(risks)].slice(0, 4);
}

function buildWhyNot(features, model, betting) {
  const risks = buildRiskFactors(features, model, betting);
  const lean = buildModelLean(features, model);
  const second = secondResult(features, model);

  if (!risks.length) {
    return `${second.label} still carries ${formatPct(second.probability)}, so ${lean.label} is not a free shot.`;
  }

  return risks.slice(0, 2).join(" ");
}

function buildPriceView(features, model, betting) {
  const lean = buildModelLean(features, model);
  const oneXTwo = betting.markets.oneXTwo;
  const marketOption = lean.key === "home"
    ? oneXTwo.optionStats?.home
    : lean.key === "away"
      ? oneXTwo.optionStats?.away
      : oneXTwo.optionStats?.draw;
  const fairPrice = lean.key === "home"
    ? betting.fair.homeOdds
    : lean.key === "away"
      ? betting.fair.awayOdds
      : betting.fair.drawOdds;

  if (!marketOption?.bestOdds) {
    const watchText = betting.markets.oneXTwo.bestOption?.targetOdds
      ? ` A realistic entry only starts nearer ${betting.markets.oneXTwo.bestOption.targetOdds}.`
      : "";
    return `${lean.label} comes out around ${formatOdds(fairPrice)} fair on the model, but there is still no usable bookmaker price stored for that side.${watchText}`;
  }

  const edge = betting.markets.oneXTwo.bestOption.key === lean.key
    ? betting.markets.oneXTwo.bestOption.edge
    : (
      lean.key === "home"
        ? betting.edges.home
        : lean.key === "away"
          ? betting.edges.away
          : betting.edges.draw
    );
  const lineMove = marketOption.movement;
  const disagreement = lean.key === oneXTwo.bestOption?.key
    ? oneXTwo.bestOption?.disagreement ?? null
    : null;
  const bookmakerBaseline = lean.key === "home"
    ? model.diagnostics.bookmakerMarginAdjustedProbability?.home
    : lean.key === "away"
      ? model.diagnostics.bookmakerMarginAdjustedProbability?.away
      : model.diagnostics.bookmakerMarginAdjustedProbability?.draw;
  const moveText = lineMove === null || Math.abs(lineMove) < 0.05
    ? ""
    : lineMove < 0
      ? ` The price has already shortened by roughly ${Math.abs(lineMove).toFixed(2)}.`
      : ` The price has drifted by roughly ${Math.abs(lineMove).toFixed(2)}.`;
  const averageText = marketOption.averageOdds
    ? ` The broader market has been nearer ${marketOption.averageOdds}.`
    : "";
  const targetOdds = oneXTwoTargetOdds(fairPrice);
  const targetText = targetOdds && (edge ?? 0) < 6
    ? ` To make it bettable, you would want something closer to ${targetOdds}.`
    : "";

  if ((edge ?? 0) < 0) {
    return `${lean.label} comes out around ${formatOdds(fairPrice)} fair, but the best stored number is only ${formatOdds(marketOption.bestOdds)} at ${marketOption.bestBookmakerTitle ?? "the market"}. The bookmaker baseline is already shorter too, so the price has gone.${averageText}${moveText}${targetText}`;
  }

  if ((disagreement ?? 0) > 0.12) {
    return `${lean.label} comes out around ${formatOdds(fairPrice)} fair and the best stored number is ${formatOdds(marketOption.bestOdds)} at ${marketOption.bestBookmakerTitle ?? "the market"}, but the wider bookmaker baseline is still colder on that side${bookmakerBaseline ? ` at roughly ${formatPct(bookmakerBaseline)}` : ""}.${averageText}${moveText}${targetText}`;
  }

  return `${lean.label} comes out around ${formatOdds(fairPrice)} fair and the best stored number is ${formatOdds(marketOption.bestOdds)} at ${marketOption.bestBookmakerTitle ?? "the market"}, so the price still leaves room if the football case holds.${averageText}${moveText}`;
}

function buildVerdict(features, model, betting) {
  const lean = buildModelLean(features, model);

  if (!betting.bestBet?.hasBet) {
    const fairPrice = lean.key === "home"
      ? betting.fair.homeOdds
      : lean.key === "away"
        ? betting.fair.awayOdds
        : betting.fair.drawOdds;
    const targetOdds = oneXTwoTargetOdds(fairPrice);
    return `Verdict: ${lean.label} is still the football lean, but it is a pass for now${targetOdds ? ` unless the number drifts toward ${targetOdds}` : " unless the price improves"}.`;
  }

  if (betting.bestBet.marketName === "1X2") {
    const oneXTwo = betting.markets.oneXTwo;
    if ((oneXTwo?.bestOption?.disagreement ?? 0) > 0.12) {
      return `Verdict: ${betting.bestBet.selectionLabel} is the value side on paper, but it still looks more like a price leg than a core result bet.`;
    }

    return `Verdict: ${betting.bestBet.selectionLabel} is playable on the 1X2. That is the cleanest price on the board.`;
  }

  return `Verdict: ${betting.bestBet.selectionLabel} is the better way into this match. The straight result price is already tighter than the model can support.`;
}

function buildConfidenceExplanation(features, model, betting) {
  const leadMarket = betting.bestBet?.hasBet
    ? Object.values(betting.markets).find((market) => market.name === betting.bestBet.marketName)
    : betting.markets.oneXTwo;
  const reasons = [];

  if ((features.context.dataCoverageScore ?? 0) >= 0.8) {
    reasons.push("The recent sample is strong enough to trust.");
  } else if ((features.context.dataCoverageScore ?? 0) >= 0.6) {
    reasons.push("The recent sample is usable, but not bulletproof.");
  } else {
    reasons.push("The sample is still thin.");
  }

  if ((leadMarket?.trust?.bookmakerCount ?? 0) >= 3) {
    reasons.push("There is solid bookmaker coverage on this market.");
  } else if ((leadMarket?.trust?.bookmakerCount ?? 0) === 0) {
    reasons.push("There is still no stored bookmaker price for this market.");
  } else {
    reasons.push("Bookmaker coverage is still limited.");
  }

  if ((features.home.lineupCertaintyScore ?? 0.5) < 0.65 || (features.away.lineupCertaintyScore ?? 0.5) < 0.65) {
    reasons.push(
      (features.context.hoursToKickoff ?? 99) <= 6
        ? "Lineups are still not settled close to kickoff."
        : "The team-news picture is still incomplete."
    );
  } else if (features.home.structuredLineupSource && features.away.structuredLineupSource) {
    reasons.push("Both projected XIs are backed by stronger official or structured sources.");
  } else if ((features.home.starterStrengthDelta ?? 0) > (features.away.starterStrengthDelta ?? 0) + 0.08) {
    reasons.push(`${features.home.name} is projected to field the stronger XI.`);
  } else if ((features.away.starterStrengthDelta ?? 0) > (features.home.starterStrengthDelta ?? 0) + 0.08) {
    reasons.push(`${features.away.name} is projected to field the stronger XI.`);
  } else if ((features.home.expectedLineup?.length ?? 0) >= 9 && (features.away.expectedLineup?.length ?? 0) >= 9) {
    reasons.push("Both projected XIs look strong, but they are still not official lineups.");
  } else if ((features.home.missingStartersCount ?? 0) === 0 && (features.away.missingStartersCount ?? 0) === 0) {
    reasons.push("Both teams look close to full strength.");
  } else if ((features.home.missingStartersCount ?? 0) < (features.away.missingStartersCount ?? 0)) {
    reasons.push(`${features.home.name} looks closer to full strength.`);
  } else if ((features.away.missingStartersCount ?? 0) < (features.home.missingStartersCount ?? 0)) {
    reasons.push(`${features.away.name} looks closer to full strength.`);
  }

  if (Math.abs(model.expectedGoals.home - model.expectedGoals.away) >= 0.35) {
    reasons.push("The goal projection is giving the model a clear lean.");
  } else {
    reasons.push("The goal projection is still fairly tight.");
  }

  if ((features.home.xgSampleSize ?? 0) >= 3 && (features.away.xgSampleSize ?? 0) >= 3) {
    const betterXgTeam = (features.home.xgDifferenceLast5 ?? 0) >= (features.away.xgDifferenceLast5 ?? 0)
      ? features.home.name
      : features.away.name;
    reasons.push(`${betterXgTeam} has the cleaner expected-goals trend.`);
  }

  if ((leadMarket?.recommendation?.credibilityScore ?? 0) < 50) {
    reasons.push("The wider proof base is still building.");
  } else if ((leadMarket?.recommendation?.credibilityScore ?? 0) >= 65) {
    reasons.push("The wider system evidence is supporting the call more than usual.");
  }

  if ((features.home.sourceConflictScore ?? 0) >= 0.18 || (features.away.sourceConflictScore ?? 0) >= 0.18) {
    reasons.push("Some public team-news sources are still conflicting.");
  }

  return {
    level: leadMarket?.recommendation.confidence ?? betting.recommendation.confidence,
    reasons: reasons.slice(0, 3)
  };
}

function buildWatchTriggers(features, betting) {
  const oneXTwo = betting.markets.oneXTwo;
  const bestMarket = betting.bestBet?.hasBet
    ? Object.values(betting.markets).find((market) => market.name === betting.bestBet.marketName)
    : oneXTwo;
  const triggers = [];

  if ((features.context.hoursToKickoff ?? 99) <= 6 && ((features.home.expectedLineup?.length ?? 0) < 9 || (features.away.expectedLineup?.length ?? 0) < 9)) {
    triggers.push("Re-check once the projected lineups or official XIs are firmer.");
  }

  if (!betting.bestBet?.hasBet && oneXTwo?.bestOption?.targetOdds) {
    triggers.push(`If the 1X2 price drifts toward ${oneXTwo.bestOption.targetOdds}, the match result becomes worth another look.`);
  }

  if (bestMarket?.recommendation?.triggerNote) {
    triggers.push(bestMarket.recommendation.triggerNote);
  }

  if ((bestMarket?.bestOption?.disagreement ?? 0) > 0.12 && bestMarket?.name === "1X2") {
    triggers.push("Only upgrade this if the official lineups still support it and the big price holds.");
  }

  if ((bestMarket?.selectedBookmaker?.retrievedAt ?? null) && (bestMarket?.trust?.snapshotHours ?? 0) > 12) {
    triggers.push("Re-check the price closer to kickoff because the stored number is aging.");
  }

  return [...new Set(triggers)].slice(0, 3);
}

function describeScoreline(entry, features, model) {
  if (entry.homeGoals === entry.awayGoals) {
    return "the matchup still grades as fairly balanced";
  }

  if (entry.homeGoals > entry.awayGoals) {
    return Math.abs(model.expectedGoals.home - model.expectedGoals.away) >= 0.35
      ? `${features.home.name} carries the stronger scoring projection`
      : `${features.home.name} still has the cleaner home route`;
  }

  return Math.abs(model.expectedGoals.home - model.expectedGoals.away) < 0.25
    ? `${features.away.name} still has a live away route`
    : `${features.away.name} has enough attack to punish mistakes`;
}

export function buildExplanation(features, model, betting) {
  const summary = betting.bestBet?.hasBet
    ? buildBetSummary(features, model, betting)
    : buildNoBetSummary(features, model, betting);
  const keyReasons = buildKeyReasons(features, model);
  const riskFactors = buildRiskFactors(features, model, betting);

  return {
    summary,
    modelLean: buildModelLeanText(features, model),
    priceView: buildPriceView(features, model, betting),
    verdict: buildVerdict(features, model, betting),
    whyNot: buildWhyNot(features, model, betting),
    keyReasons,
    riskFactors,
    watchTriggers: buildWatchTriggers(features, betting),
    confidence: buildConfidenceExplanation(features, model, betting),
    scorelines: [...model.scoreMatrix]
      .sort((left, right) => right.probability - left.probability)
      .slice(0, 3)
      .map((entry) => ({
        score: `${entry.homeGoals}-${entry.awayGoals}`,
        probability: entry.probability,
        note: describeScoreline(entry, features, model)
      })),
    technical: {
      factors: model.factors,
      diagnostics: model.diagnostics
    }
  };
}
