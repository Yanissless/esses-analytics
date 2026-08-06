/**
 * Incremental sync (Section 3). Catches up each source since its last successful run's
 * cursor, then refreshes the rollup.
 *
 *   pnpm sync                     # all sources
 *   pnpm sync --source=stripe     # one source
 *   pnpm sync --skip-metrics      # leave the rollup alone
 *
 * The orchestration itself lives in `src/lib/sync/run-sync.ts` so that this CLI and the
 * scheduled `/api/sync` route run identical code.
 */
import "dotenv/config";
import { logger } from "../src/lib/logger";
import { ALL_SYNC_SOURCES, runSync } from "../src/lib/sync/run-sync";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main() {
  const sources = (arg("source") ?? ALL_SYNC_SOURCES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const summary = await runSync({ sources, skipMetrics: hasFlag("skip-metrics") });

  // Non-zero exit so a scheduler notices, even though we ran everything we could.
  if (!summary.ok) {
    for (const r of summary.results.filter((x) => !x.ok)) {
      console.error(`  ✗ ${r.source}: ${r.error}`);
    }
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    logger.error("Sync failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
