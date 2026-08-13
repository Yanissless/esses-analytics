/**
 * Pull Instagram follower data through the Graph API.
 *
 *   pnpm sync:instagram
 *
 * Records today's exact follower total plus reconstructed history for the ~29 days Meta's
 * rolling `follower_count` insight covers. Run it daily and the series becomes all-observed;
 * a reconstructed row never overwrites a real reading. See `connectors/instagram/ingest.ts`.
 */
import "dotenv/config";
import { syncInstagramAudience } from "../src/connectors/instagram/ingest";
import { getAccountInsights } from "../src/connectors/instagram/client";
import { logger } from "../src/lib/logger";

async function main() {
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

  // Reach/impressions are the other half of what the scopes unlocked. Reported here rather
  // than stored yet — there is no table for them, and inventing one before the numbers have
  // been eyeballed is how a schema gets shaped wrong.
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 27 * 86_400_000).toISOString().slice(0, 10);
  const insights = await getAccountInsights(since, until);
  const n = (v: number | null) => v?.toLocaleString("en-US") ?? "unavailable";
  console.log(`\nAccount insights ${since} → ${until} (not stored yet):`);
  console.log(`  reach              ${n(insights.reach)}`);
  console.log(`  views              ${n(insights.views)}`);
  console.log(`  profile views      ${n(insights.profileViews)}`);
  console.log(`  accounts engaged   ${n(insights.accountsEngaged)}`);
  console.log(`  interactions       ${n(insights.totalInteractions)}`);
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
