import { env } from "./env.js";

export const APP_COMPETITIONS = [
  {
    code: "CL",
    name: "UEFA Champions League",
    sportKey: "soccer_uefa_champs_league",
    sportmonksLeagueId: 2,
    includeInApp: true,
    includeInHistory: true
  },
  {
    code: "EL",
    name: "UEFA Europa League",
    sportKey: "soccer_uefa_europa_league",
    sportmonksLeagueId: 5,
    includeInApp: true,
    includeInHistory: true
  }
];

export const HISTORY_COMPETITION_CATALOG = [
  { code: "PL", name: "Premier League", sportKey: "", includeInApp: false, includeInHistory: true },
  { code: "PD", name: "La Liga", sportKey: "", includeInApp: false, includeInHistory: true },
  { code: "BL1", name: "Bundesliga", sportKey: "", includeInApp: false, includeInHistory: true },
  { code: "SA", name: "Serie A", sportKey: "", includeInApp: false, includeInHistory: true },
  { code: "FL1", name: "Ligue 1", sportKey: "", includeInApp: false, includeInHistory: true },
  { code: "DED", name: "Eredivisie", sportKey: "", includeInApp: false, includeInHistory: true },
  { code: "PPL", name: "Primeira Liga", sportKey: "", includeInApp: false, includeInHistory: true }
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
