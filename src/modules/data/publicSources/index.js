import { apiFootballAvailabilityProvider } from "./apiFootballAvailabilityProvider.js";
import { officialClubNewsProvider } from "./officialClubNewsProvider.js";
import { sportmonksAvailabilityProvider } from "./sportmonksAvailabilityProvider.js";
import { transfermarktRssProvider } from "./transfermarktRssProvider.js";
import { uefaCompetitionNewsProvider } from "./uefaCompetitionNewsProvider.js";
import { uefaLineupsProvider } from "./uefaLineupsProvider.js";
import { uefaPreviewProvider } from "./uefaPreviewProvider.js";

export const AVAILABILITY_PROVIDERS = [
  sportmonksAvailabilityProvider,
  apiFootballAvailabilityProvider,
  uefaCompetitionNewsProvider,
  uefaPreviewProvider,
  uefaLineupsProvider,
  officialClubNewsProvider,
  transfermarktRssProvider
];

export function getAvailabilityProvider(name) {
  return AVAILABILITY_PROVIDERS.find((provider) => provider.name === name) ?? null;
}
