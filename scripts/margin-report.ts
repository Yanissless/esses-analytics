/** Print the international margin actuals to the terminal. */
import "dotenv/config";
import { getMarginSummary, getMarketMargins } from "../src/metrics/cogs";

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

async function main() {
  const s = await getMarginSummary();
  console.log("=== OVERALL ===");
  console.log(`orders ${s.orders}  units ${s.units}  uncosted units ${s.uncostedUnits}`);
  console.log(`net ex-VAT   ${usd(s.netExVatCents)}`);
  console.log(`COGS         ${usd(s.cogsCents)}`);
  console.log(`CM1          ${usd(s.cm1Cents)}  (${pct(s.cm1Pct)})`);
  console.log(`variable     ${usd(s.variableCostsCents)}`);
  console.log(`CM2          ${usd(s.cm2Cents)}  (${pct(s.cm2Pct)})`);
  console.log(
    `shipping     charged ${usd(s.shipChargedCents)} vs cost ${usd(s.shipCostCents)} → gap ${usd(s.shippingGapCents)}`,
  );

  const m = await getMarketMargins();
  console.log("\n=== BY MARKET ===");
  console.log(
    "market".padEnd(18) + "ord".padStart(6) + "net".padStart(13) + "cogs".padStart(12) +
      "ship$".padStart(11) + "cm2".padStart(12) + "cm2%".padStart(9) + "  origin",
  );
  for (const r of m) {
    console.log(
      (r.marketName ?? r.country ?? "?").slice(0, 17).padEnd(18) +
        String(r.orders).padStart(6) +
        usd(r.netExVatCents).padStart(13) +
        usd(r.cogsCents).padStart(12) +
        usd(r.shipCostCents).padStart(11) +
        usd(r.cm2Cents).padStart(12) +
        pct(r.cm2Pct).padStart(9) +
        "  " + (r.origin ?? "") + (r.marketName ? "" : "  [unmapped]"),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
