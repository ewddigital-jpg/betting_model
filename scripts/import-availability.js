import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { importAvailabilityData } from "../src/modules/data/importers/availabilityImporter.js";

getDb();

const result = await importAvailabilityData();
logger.info("Availability import script complete", result);
