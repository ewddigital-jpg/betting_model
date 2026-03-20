import { getDb } from "../src/db/database.js";
import { importHistoricalOddsData, getHistoricalOddsImportStatus } from "../src/modules/data/importers/historicalOddsImporter.js";

getDb();

const result = importHistoricalOddsData();
const status = getHistoricalOddsImportStatus();

console.log(JSON.stringify({
  result,
  status
}, null, 2));
