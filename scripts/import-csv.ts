/**
 * Import a Shopify Orders CSV export (Section 4).
 *   pnpm import:csv --file="C:\path\to\orders_export.csv"
 */
import "dotenv/config";
import { importOrdersCsvFile } from "../src/connectors/shopify/csv-import";
import { logger } from "../src/lib/logger";
import { withSyncRun } from "../src/lib/sync/sync-run";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main() {
  const file = arg("file") ?? process.argv[2];
  if (!file) throw new Error('Usage: pnpm import:csv --file="path/to/orders_export.csv"');

  const result = await withSyncRun("shopify", "backfill", async () => {
    const r = await importOrdersCsvFile(file);
    return {
      source: "shopify" as const,
      rowsIn: r.ordersIn,
      rowsUpserted: r.ordersInserted,
      warnings: r.skippedExisting
        ? [`${r.skippedExisting} orders already existed and were skipped`]
        : [],
    };
  });
  logger.info("CSV import done", {
    parsed: result.rowsIn,
    inserted: result.rowsUpserted,
    warnings: result.warnings,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("CSV import failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
