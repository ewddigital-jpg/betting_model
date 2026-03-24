import { env } from "./env.js";

export const APP_COMPETITIONS = [
  {
    code: "CL",
    name: "UEFA Champions League",
    sportKey: "soccer_uefa_champs_league",
    hasLiveOddsPath: true,
    sportmonksLeagueId: 2,
    includeInApp: true,
    includeInHistory: true
  },
  {
    code: "EL",
    name: "UEFA Europa League",
    sportKey: "soccer_uefa_europa_league",
    hasLiveOddsPath: true,
    sportmonksLeagueId: 5,
    includeInApp: true,
    includeInHistory: true
  }
];

export const HISTORY_COMPETITION_CATALOG = [
  { code: "PL", name: "Premier League", sportKey: "", hasLiveOddsPath: false, includeInApp: false, includeInHistory: true },
  { code: "PD", name: "La Liga", sportKey: "", hasLiveOddsPath: false, includeInApp: false, includeInHistory: true },
  { code: "BL1", name: "Bundesliga", sportKey: "", hasLiveOddsPath: false, includeInApp: false, includeInHistory: true },
  { code: "SA", name: "Serie A", sportKey: "", hasLiveOddsPath: false, includeInApp: false, includeInHistory: true },
  { code: "FL1", name: "Ligue 1", sportKey: "", hasLiveOddsPath: false, includeInApp: false, includeInHistory: true },
  { code: "DED", name: "Eredivisie", sportKey: "", hasLiveOddsPath: false, includeInApp: false, includeInHistory: true },
  { code: "PPL", name: "Primeira Liga", sportKey: "", hasLiveOddsPath: false, includeInApp: false, includeInHistory: true }
];

export const HISTORY_COMPETITIONS = HISTORY_COMPETITION_CATALOG.filter((competition) =>
  env.historyCompetitionCodes.includes(competition.code)
);

export const SUPPORTED_COMPETITIONS = [...APP_COMPETITIONS, ...HISTORY_COMPETITIONS];

export const APP_COMPETITION_CODES = APP_COMPETITIONS.map((competition) => competition.code);
export const HISTORY_COMPETITION_CODES = HISTORY_COMPETITIONS.map((competition) => competition.code);

export const COMPETITION_BY_CODE = Object.fromEntries(
  SUPPORTED_COMPETITIONS.map((competition) => [competition.code, competition])
);

export function isSupportedCompetition(code) {
  return Boolean(COMPETITION_BY_CODE[code]);
}

export function hasCompetitionLiveOddsPath(codeOrCompetition) {
  const competition = typeof codeOrCompetition === "string"
    ? COMPETITION_BY_CODE[codeOrCompetition]
    : codeOrCompetition;

  if (!competition) {
    return false;
  }

  return Boolean(competition.hasLiveOddsPath && competition.sportKey);
}
