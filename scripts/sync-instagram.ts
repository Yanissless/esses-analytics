/**
 * Pull Instagram follower data and organic performance through the Graph API.
 *
 *   pnpm sync:instagram              nightly shape — followers + last 2 days of insights
 *   pnpm sync:instagram --days=30    one-off backfill of the daily insight series
 *
 * Records today's exact follower total plus reconstructed history for the ~29 days Meta's
 * rolling `follower_count` insight covers. Run it daily and the series becomes all-observed;
 * a reconstructed row never overwrites a real reading. See `connectors/instagram/ingest.ts`.
 *
 * `--days` only affects the insight series. Follower history is always the full 30 days Meta
 * will serve, because that window is all there is.
 */
import "dotenv/config";
import { syncInstagramAudience, syncInstagramInsights } from "../src/connectors/instagram/ingest";
import { getAccountInsights } from "../src/connectors/instagram/client";
import { logger } from "../src/lib/logger";

const days = Number(
  process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? "2",
);

async function main() {
  if (!Number.isFinite(days) || days < 1) {
    console.error(`\n--days must be a positive number, got "${days}"\n`);
    process.exit(1);
  }
  const r = await syncInstagramAudience();

  if (!r.accountId) {
    console.error("\nNo Instagram business account reachable.\n");
    for (const w of r.warnings) console.error(`  - ${w}`);
    process.exit(1);
  }

  console.log(`\nInstagram @${r.username ?? r.accountId}`);
  console.log(`  followers now        ${r.followersNow?.toLocaleString("en-US")}`);
  console.log(`  exact rows written   ${r.observedWritten}`);
  console.log(`  reconstructed rows   ${r.reconstructedWritten}`);
  console.log(`  left alone           ${r.skippedObserved} (already a real reading)`);
  for (const w of r.warnings) console.log(`  ⚠ ${w}`);

  const stored = await syncInstagramInsights(days);
  console.log(`\nDaily insights  ${stored.daysWritten}/${stored.daysRequested} days stored`);
  for (const u of stored.unavailable) console.log(`  ⚠ ${u.metric}: ${u.reason}`);

  // Printed alongside the daily rows because window reach is NOT their sum — Meta
  // de-duplicates accounts across the window, so the sum of 30 daily figures is always larger.
  // Seeing both is the clearest way to keep that straight.
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 27 * 86_400_000).toISOString().slice(0, 10);
  const insights = await getAccountInsights(since, until);
  const n = (v: number | null) => v?.toLocaleString("en-US") ?? "unavailable";
  console.log(`\n28-day window totals ${since} → ${until}:`);
  console.log(`  reach              ${n(insights.reach)}`);
  console.log(`  views              ${n(insights.views)}`);
  console.log(`  profile views      ${n(insights.profileViews)}`);
  console.log(`  accounts engaged   ${n(insights.accountsEngaged)}`);
  console.log(`  interactions       ${n(insights.totalInteractions)}`);
  console.log(
    "\n  Window reach counts distinct accounts, so it is LOWER than the sum of the daily\n" +
      "  rows — anyone who saw you on three days is one account here and three there.\n" +
      "  That gap is repeat viewership, not a discrepancy.",
  );
  if (insights.summedMetrics.length > 0) {
    console.log(
      `\n  ⚠ summed from a daily series (double-counts repeat viewers, not unique):\n` +
        `    ${insights.summedMetrics.join(", ")}`,
    );
  }
  for (const u of insights.unavailable) {
    console.log(`  ⚠ ${u.metric}: ${u.reason}`);
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("instagram sync failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
