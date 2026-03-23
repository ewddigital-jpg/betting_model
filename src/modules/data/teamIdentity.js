import { teamNameSimilarity } from "./publicSources/shared.js";
import { normalizeName } from "./publicSources/historicalCrawlShared.js";

const VARIANT_PATTERNS = [
  /\bwomen\b/iu,
  /\bfeminino\b/iu,
  /\bfemeni(?:no|na)\b/iu,
  /\bu(?:17|18|19|20|21|23)\b/iu,
  /\bunder\s?(?:17|18|19|20|21|23)\b/iu,
  /\bii\b/iu,
  /\bb team\b/iu,
  /\breserve\b/iu,
  /\bacademy\b/iu
];

function hasVariantMarker(value) {
  const text = String(value ?? "");
  return VARIANT_PATTERNS.some((pattern) => pattern.test(text));
}

export function resolveMatchTeamSide(match, candidateTeamName, options = {}) {
  const minScore = options.minScore ?? 0.82;
  const minGap = options.minGap ?? 0.18;
  const candidate = String(candidateTeamName ?? "").trim();
  if (!candidate) {
    return null;
  }

  const homeName = match.homeTeamName ?? match.home_team_name ?? "";
  const awayName = match.awayTeamName ?? match.away_team_name ?? "";
  const normalizedCandidate = normalizeName(candidate);
  const normalizedHome = normalizeName(homeName);
  const normalizedAway = normalizeName(awayName);

  if (!normalizedCandidate || !normalizedHome || !normalizedAway) {
    return null;
  }

  const candidateVariant = hasVariantMarker(candidate);
  const homeVariant = hasVariantMarker(homeName);
  const awayVariant = hasVariantMarker(awayName);

  if (candidateVariant && !homeVariant && !awayVariant) {
    return null;
  }

  const exactHome = normalizedCandidate === normalizedHome;
  const exactAway = normalizedCandidate === normalizedAway;

  if (exactHome && !exactAway) {
    return "home";
  }

  if (exactAway && !exactHome) {
    return "away";
  }

  if (exactHome && exactAway) {
    return null;
  }

  const homeScore = teamNameSimilarity(candidate, homeName);
  const awayScore = teamNameSimilarity(candidate, awayName);
  const bestSide = homeScore >= awayScore ? "home" : "away";
  const bestScore = Math.max(homeScore, awayScore);
  const otherScore = Math.min(homeScore, awayScore);

  if (bestScore < minScore || (bestScore - otherScore) < minGap) {
    return null;
  }

  return bestSide;
}

export function resolveMatchTeamId(match, candidateTeamName, options = {}) {
  const side = resolveMatchTeamSide(match, candidateTeamName, options);
  if (side === "home") {
    return match.homeTeamId ?? match.home_team_id ?? null;
  }

  if (side === "away") {
    return match.awayTeamId ?? match.away_team_id ?? null;
  }

  return null;
}

export const __teamIdentityTestables = {
  hasVariantMarker,
  resolveMatchTeamSide
};
