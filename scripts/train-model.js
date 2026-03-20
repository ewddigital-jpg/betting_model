import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { getModelTrainingStatus } from "../src/modules/analysis/modelParameters.js";
import { trainModelParameters } from "../src/modules/analysis/trainingService.js";

getDb();

const limit = Number(process.argv[2] ?? 450);
const result = trainModelParameters({ limit });
logger.info("Model training finished", result);
console.log(JSON.stringify({
  result,
  status: getModelTrainingStatus()
}, null, 2));
