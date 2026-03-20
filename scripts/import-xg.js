import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { importAdvancedStatsData } from "../src/modules/data/importers/xgImporter.js";

getDb();

const result = importAdvancedStatsData();
logger.info("Advanced stats import complete", result);
