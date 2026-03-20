import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { runCollector } from "../src/modules/data/collectorService.js";

getDb();

const result = await runCollector({ triggerSource: "script" });
logger.info("Collector script complete", result);
