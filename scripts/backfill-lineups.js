import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { importHistoricalLineupBackfill } from "../src/modules/data/importers/availabilityImporter.js";

getDb();

const firstArg = process.argv[2] ?? null;
const secondArg = process.argv[3] ?? null;
const competitionCode = firstArg && Number.isNaN(Number(firstArg)) ? firstArg : null;
const limit = Number(competitionCode ? (secondArg ?? 120) : (firstArg ?? 120));

const result = await importHistoricalLineupBackfill({
  competitionCode,
  limit: Number.isFinite(limit) && limit > 0 ? limit : 120
});

logger.info("Historical lineup backfill complete", result);
console.log(JSON.stringify(result, null, 2));
