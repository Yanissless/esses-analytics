/**
 * Rebuild the daily_metrics rollup, then print a summary so the numbers can be
 * eyeballed against the raw-data views.
 *
 *   run.cmd metrics
 */
import "dotenv/config";
import { rebuildDailyMetrics, getPeriodMetrics } from "../src/metrics/rollup";

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const x = (v: number | null, digits = 2) => (v == null ? "—" : v.toFixed(digits));
const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

async function main() {
  console.log("Rebuilding daily_metrics…\n");
  const r = await rebuildDailyMetrics();
  console.log(`  days: ${r.daysComputed}  rows: ${r.channelRows}`);
  console.log(`  range: ${r.firstDate} → ${r.lastDate}\n`);

  if (!r.firstDate || !r.lastDate) {
    console.log("No data to summarise.");
    return;
  }

  const m = await getPeriodMetrics(r.firstDate, r.lastDate);
  console.log("Whole period (blended):");
  console.log(`  revenue (net)      ${usd(m.revenueCents)}`);
  console.log(`  new-cust revenue   ${usd(m.newCustomerRevenueCents)}`);
  console.log(`  ad spend           ${usd(m.adSpendCents)}`);
  console.log(`  COGS               ${usd(m.cogsCents)}`);
  console.log(`  CM1 / CM2 / CM3    ${usd(m.cm1Cents)} / ${usd(m.cm2Cents)} / ${usd(m.cm3Cents)}`);
  console.log(`  CM3 %              ${pct(m.cm3Pct)}`);
  console.log(`  orders             ${m.orders.toLocaleString()}`);
  console.log(`  new custs / repeat orders  ${m.newCustomers.toLocaleString()} / ${m.returningOrders.toLocaleString()}`);
  console.log(`  MER                ${x(m.mer)}`);
  console.log(`  aMER               ${x(m.amer)}`);
  console.log(`  CAC                ${m.cac == null ? "—" : usd(m.cac)}`);
  if (m.adSpendCents === 0) {
    console.log("\n  Note: MER/aMER/CAC read '—' because no ad spend is loaded yet.");
    console.log("  They populate automatically once the Meta connector has credentials.");
  }
  if (m.unknownCogsUnits > 0) {
    console.log(`\n  ${m.unknownCogsUnits.toLocaleString()} unit(s) still have no cost record — margin is overstated for those.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
