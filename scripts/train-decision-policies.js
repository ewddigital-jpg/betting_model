import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { trainDecisionPolicies } from "../src/modules/analysis/decisionTrainingService.js";

getDb();

const result = trainDecisionPolicies();
logger.info("Decision policy training complete", result);
