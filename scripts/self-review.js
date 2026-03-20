import { getDb } from "../src/db/database.js";
import { logger } from "../src/lib/logger.js";
import { writeProjectAuditReport } from "../src/modules/analysis/projectAuditService.js";

getDb();

const firstArg = process.argv[2] ?? null;
const secondArg = process.argv[3] ?? null;
const competitionCode = firstArg && Number.isNaN(Number(firstArg)) ? firstArg : null;
const blindLimit = Number(competitionCode ? (secondArg ?? 100) : (firstArg ?? 100));

const result = writeProjectAuditReport({
  competitionCode,
  blindLimit: Number.isFinite(blindLimit) && blindLimit > 0 ? blindLimit : 100
});

logger.info("Project audit complete", {
  trustPercent: result.scoreboard.trustPercent,
  findings: result.findings.length,
  topFinding: result.findings[0]?.title ?? null
});

console.log(JSON.stringify(result, null, 2));
