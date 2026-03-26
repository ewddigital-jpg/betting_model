import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { syncAllCompetitions } from "../src/modules/data/syncService.js";

getDb();

// --force-odds fetches odds even when no match is within 48h
const forceOdds = process.argv.includes("--force-odds");

const results = await syncAllCompetitions({ forceOdds });
logger.info("Manual sync complete", { results });
