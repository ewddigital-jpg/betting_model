import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { syncFreeModeData } from "../src/modules/data/syncService.js";

getDb();

const results = await syncFreeModeData();
logger.info("Manual sync complete", { results });
