import { getDb } from "../src/db/database.js";
import { crawlHistoricalDataset } from "../src/modules/data/historicalCrawlerService.js";

getDb();

const result = await crawlHistoricalDataset();
console.log(JSON.stringify(result, null, 2));
