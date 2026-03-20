import { clamp, round } from "../../lib/math.js";
import { getUpcomingMatchesView } from "../reporting/viewModels.js";

function ratio(part, whole) {
  if (!whole) {
    return 0;
  }

  return part / whole;
}

function averageBrier(calibration) {
  const values = [
    calibration?.oneXTwo?.brier,
    calibration?.totals25?.brier,
    calibration?.btts?.brier
  ].filter(Number.isFinite);

  if (!values.length) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calibrationScore(calibration) {
  const avgBrier = averageBrier(calibration);

  if (!Number.isFinite(avgBrier)) {
    return {
      avgBrier: null,
      score: 0
    };
  }

  return {
    avgBrier,
    score: clamp((0.3 - avgBrier) / 0.1, 0, 1)
  };
}

function evidenceScore(count, target) {
  return clamp((count ?? 0) / target, 0, 1);
}

export function buildTrustReadiness({
  competitionCode = null,
  dashboard,
  blindTest,
  modelStatus,
  decisionPolicyStatus
}) {
  const upcoming = getUpcomingMatchesView(competitionCode);
  const upcomingCount = upcoming.length;
  const upcomingWithOdds = upcoming.filter((match) => match.hasOdds).length;
  const likelyLineups = upcoming.filter((match) => match.lineupStatus === "Likely").length;
  const confirmedLineups = upcoming.filter((match) => match.lineupStatus === "Confirmed").length;
  const waitingLineups = upcoming.filter((match) => match.lineupStatus === "Waiting").length;
  const fragileTrust = upcoming.filter((match) => (match.trust?.label ?? "Fragile") === "Fragile").length;

  const oddsCoverage = ratio(upcomingWithOdds, upcomingCount);
  const lineupCoverage = ratio((confirmedLineups + (likelyLineups * 0.7)), upcomingCount);
  const forwardSettledBets = dashboard?.summary?.settledBets ?? 0;
  const blindModeledMatches = blindTest?.summary?.modeledMatches ?? 0;
  const blindLeanAccuracy = (blindTest?.summary?.leanAccuracy ?? 0) / 100;
  const activeModel = Boolean(modelStatus?.active);
  const activeDecisionPolicy = Boolean(decisionPolicyStatus?.active);

  const calibration = calibrationScore(blindTest?.calibration);
  const score =
    (oddsCoverage * 0.24) +
    (lineupCoverage * 0.22) +
    (evidenceScore(forwardSettledBets, 80) * 0.16) +
    (evidenceScore(blindModeledMatches, 140) * 0.12) +
    (calibration.score * 0.14) +
    (clamp((blindLeanAccuracy - 0.45) / 0.2, 0, 1) * 0.08) +
    ((activeModel ? 1 : 0.35) * 0.02) +
    ((activeDecisionPolicy ? 1 : 0.25) * 0.02);

  const trustPercent = Math.round(score * 100);
  const blockers = [];
  const nextSteps = [];

  if (oddsCoverage < 0.9) {
    blockers.push(`Odds are only attached to ${upcomingWithOdds} of ${upcomingCount || 0} upcoming matches.`);
    nextSteps.push("Keep the collector and reminder jobs running so more pre-kickoff odds snapshots are saved.");
  }

  if (lineupCoverage < 0.65) {
    blockers.push(`Expected lineups are only Likely or Confirmed on ${confirmedLineups + likelyLineups} of ${upcomingCount || 0} upcoming matches.`);
    nextSteps.push("Wait for the final pre-kickoff refresh window. Trust should only rise when matches move to Likely or Confirmed lineups.");
  }

  if (forwardSettledBets < 40) {
    blockers.push(`Only ${forwardSettledBets} settled forward bets are graded so far.`);
    nextSteps.push("Let the app build a bigger graded sample before trusting small ROI swings.");
  }

  if ((calibration.avgBrier ?? 1) > 0.22) {
    blockers.push(`Calibration is still loose with an average Brier score around ${round(calibration.avgBrier ?? 0, 3)}.`);
    nextSteps.push("Keep archiving results and prices so calibration can tighten over the next training cycles.");
  }

  if (!activeDecisionPolicy) {
    blockers.push("The separate trained market decision layer has not earned promotion yet.");
    nextSteps.push("More settled priced samples are needed before the app can promote trained 1X2, totals, and BTTS decision rules.");
  }

  if (waitingLineups > 0 || fragileTrust > 0) {
    nextSteps.push("Tomorrow, prefer matches tagged Likely or Confirmed and avoid Fragile trust unless the price moves far enough.");
  }

  return {
    trustPercent,
    targetPercent: 80,
    status: trustPercent >= 80 ? "ready" : trustPercent >= 65 ? "improving" : "building",
    components: {
      oddsCoverage: {
        score: Math.round(oddsCoverage * 100),
        current: `${upcomingWithOdds}/${upcomingCount}`,
        label: "Odds coverage"
      },
      lineupCoverage: {
        score: Math.round(lineupCoverage * 100),
        current: `${confirmedLineups} confirmed, ${likelyLineups} likely`,
        label: "Lineup readiness"
      },
      forwardEvidence: {
        score: Math.round(evidenceScore(forwardSettledBets, 80) * 100),
        current: String(forwardSettledBets),
        label: "Forward graded bets"
      },
      blindEvidence: {
        score: Math.round(evidenceScore(blindModeledMatches, 140) * 100),
        current: String(blindModeledMatches),
        label: "Blind sample"
      },
      calibration: {
        score: Math.round(calibration.score * 100),
        current: calibration.avgBrier === null ? "n/a" : round(calibration.avgBrier, 3),
        label: "Calibration"
      }
    },
    blockers: blockers.slice(0, 5),
    nextSteps: Array.from(new Set(nextSteps)).slice(0, 5)
  };
}
