const PLACEHOLDER_PATTERNS = [
  /^tbc$/i,
  /^to be confirmed$/i,
  /^winner\b/i,
  /^loser\b/i,
  /\bquarter[- ]final\b/i,
  /\bsemi[- ]final\b/i,
  /\bfinal\b/i,
  /\bplay[- ]off\b/i,
  /\bround of\b/i
];

export function isPlaceholderTeamName(name) {
  const value = String(name ?? "").trim();

  if (!value) {
    return true;
  }

  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

export function isResolvedFixtureTeams(homeTeam, awayTeam) {
  return !isPlaceholderTeamName(homeTeam) && !isPlaceholderTeamName(awayTeam);
}
