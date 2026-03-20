export function actualOutcomeLabelForMarket(marketName, match, features) {
  if (marketName === "Over / Under 2.5") {
    return match.home_score + match.away_score >= 3 ? "Over 2.5" : "Under 2.5";
  }

  if (marketName === "BTTS") {
    return match.home_score > 0 && match.away_score > 0 ? "BTTS Yes" : "BTTS No";
  }

  if (match.home_score > match.away_score) {
    return features.home.name;
  }

  if (match.home_score < match.away_score) {
    return features.away.name;
  }

  return "Draw";
}
