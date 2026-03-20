import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { importNewsData } from "../src/modules/data/importers/newsImporter.js";

getDb();

const result = await importNewsData();
logger.info("News import script complete", result);
