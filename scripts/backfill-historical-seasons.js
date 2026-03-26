/**
 * Backfill Historical CL/EL Seasons from Sportmonks
 *
 * Syncs the 2023/24 and 2024/25 seasons of Champions League and
 * Europa League into the DB so that OddsPortal historical odds
 * can be matched to actual match records.
 *
 * Season IDs (verified 2025-03):
 *   CL 2024/25 → 23619
 *   CL 2023/24 → 21638
 *   EL 2024/25 → 23620
 *   EL 2023/24 → 22130
 *
 * Usage:
 *   node scripts/backfill-historical-seasons.js
 */

import { getDb } from "../src/db/database.js";
import { syncHistoricalSeason } from "../src/modules/data/syncService.js";

getDb(); // initialize DB

const SEASONS_TO_SYNC = [
  { code: "CL", seasonId: 23619, label: "Champions League 2024/25" },
  { code: "CL", seasonId: 21638, label: "Champions League 2023/24" },
  { code: "EL", seasonId: 23620, label: "Europa League 2024/25" },
  { code: "EL", seasonId: 22130, label: "Europa League 2023/24" }
];

async function run() {
  console.log("Backfilling historical CL/EL seasons from Sportmonks…\n");

  for (const { code, seasonId, label } of SEASONS_TO_SYNC) {
    process.stdout.write(`  ${label} (seasonId=${seasonId})… `);
    try {
      const result = await syncHistoricalSeason(code, seasonId);
      console.log(`✓ ${result.matches} matches imported`);
    } catch (error) {
      console.log(`✗ FAILED: ${error.message}`);
    }
    // polite delay between API calls
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("\nDone. Now re-run the odds importer:");
  console.log("  node scripts/import-historical-odds.js");
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
