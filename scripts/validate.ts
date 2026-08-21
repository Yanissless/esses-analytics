/**
 * Check the live data against its invariants.
 *
 *   run.cmd validate
 *
 * Read-only. Run it after a backfill, after any schema change, and before quoting a figure to
 * anyone outside the team.
 *
 * Exits 1 on any error so it can gate a deploy. Warnings exit 0 — they need a human to read
 * them, not a blocked pipeline.
 */
import "dotenv/config";
import { runValidation, type Severity } from "../src/lib/validate/checks";

const MARK: Record<Severity, string> = {
  ok: "✓",
  warn: "!",
  error: "✗",
  skip: "–",
};

async function main() {
  console.log("\nData validation\n");

  const report = await runValidation();

  for (const r of report.results) {
    console.log(`  ${MARK[r.severity]}  ${r.name}`);
    console.log(`     ${r.detail}`);
    if (r.severity !== "ok" && r.severity !== "skip") {
      // The failure this check exists to catch, printed only when it fires. Printing it always
      // would bury the finding in history nobody needs at that moment.
      console.log(`     guards: ${r.guards}`);
      if (r.remedy) console.log(`     → ${r.remedy}`);
    }
    console.log("");
  }

  const passed = report.results.length - report.errors - report.warnings - report.skipped;
  console.log(
    `${passed} passed, ${report.errors} error(s), ${report.warnings} warning(s), ` +
      `${report.skipped} skipped — ${report.ms}ms\n`,
  );

  if (report.errors > 0) {
    console.log("Errors mean a number somewhere is wrong right now. Fix before quoting.\n");
    process.exit(1);
  }

  // Explicit, and not redundant: the postgres.js pool holds the event loop open, so falling off
  // the end of main() leaves the process running forever with nothing to do. That was invisible
  // while any check still failed — the error path above exits — and appeared the moment they all
  // passed, which is the worst possible time for a script to start hanging.
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
