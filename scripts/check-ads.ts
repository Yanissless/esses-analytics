/**
 * Verify each configured ad platform: credentials, account reachability, and a
 * small sample pull. Run before trusting any spend numbers.
 *
 *   run.cmd check:ads
 */
import "dotenv/config";
import { AD_PLATFORMS } from "../src/connectors/ads";

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

async function main() {
  console.log("Ad platform check\n");

  for (const p of AD_PLATFORMS) {
    console.log(`${p.label} (${p.platform})`);

    if (!p.isConfigured()) {
      console.log("  ✗ not configured — add its credentials to .env\n");
      continue;
    }

    const health = await p.healthCheck();
    if (!health.ok) {
      console.log(`  ✗ ${health.detail ?? "unreachable"}\n`);
      continue;
    }
    console.log(`  ✓ account reachable — ${health.detail ?? ""}`);

    // Sample the last 7 days so field mapping is verified against real data
    // before a full backfill writes anything.
    try {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      const rows = await p.fetchSpend({ since });
      const spend = rows.reduce((s, r) => s + r.spendAmount, 0);
      const impressions = rows.reduce((s, r) => s + r.impressions, 0);
      const clicks = rows.reduce((s, r) => s + r.clicks, 0);
      const conv = rows.reduce((s, r) => s + r.platformConversions, 0);
      const currencies = [...new Set(rows.map((r) => r.currency))];

      console.log(
        `  ✓ last 7 days: ${rows.length} ad-day row(s), ${usd(spend)} spend, ` +
          `${impressions.toLocaleString()} impressions, ${clicks.toLocaleString()} clicks, ` +
          `${conv} platform conversions`,
      );
      if (currencies.length) console.log(`     currency: ${currencies.join(", ")}`);
      if (rows.length === 0) {
        console.log("     (no rows — either no spend in the window, or the account is paused)");
      }
    } catch (e) {
      console.log(`  ✗ sample pull failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log();
  }

  const configured = AD_PLATFORMS.filter((p) => p.isConfigured()).length;
  if (configured === 0) {
    console.log("No ad platforms configured yet.");
    console.log("Meta needs: META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in .env");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
