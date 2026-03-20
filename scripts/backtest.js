import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { runBacktest } from "../src/modules/analysis/backtestService.js";

getDb();

const firstArg = process.argv[2] ?? null;
const secondArg = process.argv[3] ?? null;
const competition = firstArg && Number.isNaN(Number(firstArg)) ? firstArg : null;
const limit = Number(competition ? (secondArg ?? 80) : (firstArg ?? 80));
const result = runBacktest(competition, Number.isFinite(limit) && limit > 0 ? limit : 80);
logger.info("Backtest complete", result.summary);
console.log(JSON.stringify(result, null, 2));
