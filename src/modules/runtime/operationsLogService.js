import { round } from "../../lib/math.js";

function toRoundedNumber(value, digits = 1) {
  return Number.isFinite(value) ? round(value, digits) : null;
}

export function buildForwardValidationLogEntry(report) {
  const summary = report?.summary ?? {};
  const diagnostics = report?.operationalDiagnostics ?? {};
  const freshness = diagnostics.freshnessDistribution ?? {};
  const trustworthy = diagnostics.trustworthySampleSize ?? {};

  return {
    generatedAt: report?.generatedAt ?? null,
    trackedMatches: Number(summary.trackedMatches ?? 0),
    bets: Number(summary.bets ?? 0),
    settledBets: Number(summary.settledBets ?? 0),
    staleBoards: Number(summary.staleOddsMatches ?? 0),
    weakBoards: Number(summary.weakBoardMatches ?? 0),
    unusableBoards: Number(summary.unusableBoardMatches ?? 0),
    usableOrBetterMatches: Number(report?.validationSplits?.usableOrBetterOnly?.trackedMatches ?? 0),
    strongPriceMatches: Number(report?.validationSplits?.strongPriceOnly?.trackedMatches ?? 0),
    settledPriceTrustworthyBets: Number(trustworthy.settledPriceTrustworthyBets ?? 0),
    settledUsableOrBetterBets: Number(trustworthy.settledUsableOrBetterBets ?? 0),
    settledStrongPriceBets: Number(trustworthy.settledStrongPriceBets ?? 0),
    freshnessMedianMinutes: toRoundedNumber(freshness.median, 1),
    freshnessP75Minutes: toRoundedNumber(freshness.p75, 1),
    freshnessP90Minutes: toRoundedNumber(freshness.p90, 1)
  };
}
