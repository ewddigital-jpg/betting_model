/**
 * Standalone runner for the fbref match importer.
 *
 * Fetches real UCL/EL fixtures and results from fbref.com (no API key needed)
 * and populates the database with team records and match records.
 *
 * Run once to bootstrap, then let the collector keep things updated:
 *   node scripts/import-fbref-fixtures.js
 */

import { getDb } from "../src/db/database.js";
import { importFbrefMatches } from "../src/modules/data/importers/fbrefMatchImporter.js";

getDb();

console.log("Importing UCL and EL fixtures from fbref.com...");
console.log("(fetching current season + 2022-23, 2023-24, 2024-25 — takes ~15s)\n");

const result = await importFbrefMatches({ competitionCodes: ["CL", "EL"] });

console.log("Done.");
console.log(`  Created: ${result.created} new matches`);
console.log(`  Updated: ${result.updated} existing matches with scores`);
console.log(`  Fetch errors: ${result.fetchErrors}`);
console.log("\nDB totals:");
for (const [key, count] of Object.entries(result.totals)) {
  console.log(`  ${key}: ${count}`);
}
