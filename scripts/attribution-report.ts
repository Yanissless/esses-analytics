/**
 * Compare channel performance across every attribution model.
 *
 *   run.cmd attribution
 *   run.cmd attribution --since=2026-01-01 --until=2026-07-29
 *
 * Showing all models side by side is the point: where they disagree, the channel's
 * true contribution is uncertain.
 */
import "dotenv/config";
import {
  getAttributionCoverage,
  getChannelPerformance,
} from "../src/attribution/report";
import type { AttributionModel } from "../src/attribution/models";

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function arg(name: string, fallback: string): string {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
}

const MODELS: AttributionModel[] = ["last-non-direct", "linear", "time-decay", "first-touch"];

async function main() {
  const since = arg("since", "2025-10-01");
  const until = arg("until", new Date().toISOString().slice(0, 10));

  const cov = await getAttributionCoverage(since, until);
  console.log(`Attribution ${since} → ${until}\n`);
  console.log("Coverage:");
  console.log(`  orders with journey data : ${cov.ordersWithTouchpoints.toLocaleString()} / ${cov.ordersTotal.toLocaleString()}`);
  console.log(`  revenue attributable     : ${usd(cov.revenueAttributableCents)} of ${usd(cov.revenueTotalCents)} (${pct(cov.coveragePct)})`);
  console.log(`  average path length      : ${cov.avgPathLength}`);
  console.log("");
  console.log("  Why the rest isn't attributable:");
  console.log(`    no session possible (API renewals/comps): ${cov.ordersNoSessionPossible.toLocaleString()} orders, ${usd(cov.revenueNoSessionPossibleCents)}`);
  console.log(`    coverage of orders that COULD have one  : ${pct(cov.coverageOfAddressablePct)}  ← the fair number`);
  console.log(`    recoverable by inheriting acq. channel  : ${usd(cov.revenueInheritableCents)}`);

  const basis = (process.argv.includes("--inherit")
    ? "inherit-from-customer"
    : "session-only") as "session-only" | "inherit-from-customer";
  console.log(`\nBasis: ${basis}${basis === "session-only" ? "  (pass --inherit to credit renewals to the acquiring channel)" : ""}`);

  for (const model of MODELS) {
    const rows = await getChannelPerformance(since, until, model, 7, basis);
    console.log(`\n── ${model} ──`);
    if (!rows.length) {
      console.log("  no attributed revenue in range");
      continue;
    }
    console.log(
      "channel".padEnd(18) + "revenue".padStart(13) + "conv".padStart(9) +
        "spend".padStart(12) + "ROAS".padStart(8) + "CAC".padStart(11) +
        "inherited".padStart(13),
    );
    for (const r of rows) {
      console.log(
        r.channel.padEnd(18) +
          usd(r.attributedRevenueCents).padStart(13) +
          r.attributedConversions.toFixed(1).padStart(9) +
          (r.spendCents ? usd(r.spendCents) : "—").padStart(12) +
          (r.roas == null ? "—" : r.roas.toFixed(2)).padStart(8) +
          (r.cac == null ? "—" : usd(r.cac)).padStart(11) +
          (r.inheritedRevenueCents ? usd(r.inheritedRevenueCents) : "—").padStart(13),
      );
    }
  }

  console.log(
    "\nROAS/CAC read '—' until ad spend is loaded; attributed revenue is already real.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
