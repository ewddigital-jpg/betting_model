import { getDb } from "../src/db/database.js";
import { getOddsCoverageDiagnostics } from "../src/modules/data/oddsCoverageService.js";

getDb();

console.log(JSON.stringify(getOddsCoverageDiagnostics(), null, 2));
