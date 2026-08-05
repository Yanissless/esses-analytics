/**
 * Import Shopify's "Shipping labels by order" report — actual label cost per order.
 *
 *   pnpm import:shipping --file="C:\path\Shipping labels by order.csv"
 *   pnpm import:shipping --file="..." --rates-only     # just refresh rate rules
 *
 * Also refreshes `shipping_rate_rules` from the real averages, so shipments the
 * report doesn't cover get a credible estimate instead of a guess.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { shippingCharges, shippingInvoices, shippingRateRules } from "../src/db/schema";
import {
  deriveRates,
  parseShippingLabelReport,
  reportRowsToLines,
} from "../src/connectors/shopify/shipping-report";
import { attachItemisedCharges } from "../src/lib/shipping/match";
import { logger } from "../src/lib/logger";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}
const has = (name: string) => process.argv.includes(`--${name}`);
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

async function main() {
  const file = arg("file");
  if (!file) throw new Error('Usage: pnpm import:shipping --file="path/to/report.csv"');

  const rows = parseShippingLabelReport(readFileSync(file, "utf8"));
  const totalCents = rows.reduce((s, r) => s + r.costCents, 0);
  console.log(`Parsed ${rows.length} label rows, total ${usd(totalCents)}`);

  // --- refresh rate rules from actuals ------------------------------------
  const rates = deriveRates(rows);
  console.log("\nActual cost per label by carrier:");
  console.log("carrier".padEnd(16) + "scope".padEnd(16) + "n".padStart(6) + "median".padStart(10) + "mean".padStart(10));
  for (const r of rates) {
    console.log(
      r.carrier.slice(0, 15).padEnd(16) +
        r.scope.padEnd(16) +
        String(r.shipments).padStart(6) +
        usd(r.medianCents).padStart(10) +
        usd(r.avgCents).padStart(10),
    );
  }

  const effectiveDate = "2025-10-01";
  for (const r of rates) {
    if (r.shipments < 3) continue; // too thin to generalise from
    const label = `${r.carrier} ${r.scope} (from report)`;
    const values = {
      label,
      carrierPattern: r.carrier,
      servicePattern: null,
      // Domestic rules are country-scoped so they outrank the carrier-generic
      // international rule for US orders — but only for carriers that HAVE a
      // domestic rule. Excluding US from the international rule closes the gap
      // for the rest (e.g. DHL eCommerce, international-only in the report).
      countryCode: r.scope === "domestic" ? "US" : null,
      excludeCountryCode: r.scope === "domestic" ? null : "US",
      zone: null,
      currency: "USD",
      // Median, not mean — a handful of express labels skew the average.
      expectedCostAmount: r.medianCents,
      priority: r.scope === "domestic" ? 60 : 50,
      effectiveDate,
      source: `Shopify shipping-label report (${r.shipments} labels)`,
      note: `median ${usd(r.medianCents)}, mean ${usd(r.avgCents)}`,
    };
    await db
      .insert(shippingRateRules)
      .values(values)
      .onConflictDoUpdate({
        target: [shippingRateRules.label, shippingRateRules.effectiveDate],
        set: { ...values, updatedAt: new Date() },
      });
  }
  console.log(`\n✓ Refreshed ${rates.filter((r) => r.shipments >= 3).length} rate rule(s) from actuals.`);

  if (has("rates-only")) return;

  // --- attach itemised charges -------------------------------------------
  const invoiceRef = `shopify-labels-${rows[0]?.month ?? "all"}-${rows[rows.length - 1]?.month ?? ""}`;
  const [invoice] = await db
    .insert(shippingInvoices)
    .values({
      vendor: "shopify_shipping",
      invoiceRef,
      invoiceDate: new Date().toISOString().slice(0, 10),
      periodStart: rows[0]?.month ?? null,
      periodEnd: rows[rows.length - 1]?.month ?? null,
      totalAmount: totalCents,
      statedShipmentCount: rows.length,
      allocationMethod: "itemised",
      note: "Shopify 'Shipping labels by order' report — actual label costs.",
    })
    .onConflictDoUpdate({
      target: [shippingInvoices.vendor, shippingInvoices.invoiceRef],
      set: { totalAmount: totalCents, statedShipmentCount: rows.length, updatedAt: new Date() },
    })
    .returning({ id: shippingInvoices.id });

  // Replace prior rows for this invoice so re-import is idempotent.
  await db.delete(shippingCharges).where(eq(shippingCharges.invoiceId, invoice.id));

  const res = await attachItemisedCharges(invoice.id, "shopify_shipping", reportRowsToLines(rows));

  console.log(
    `\n✓ Matched ${res.matched} of ${rows.length} labels (${usd(res.totalAttributedCents)} attributed).`,
  );
  if (res.unmatched > 0) {
    console.log(
      `  ${res.unmatched} unmatched — expected for orders before our 2025-10-01 window ` +
        `(report starts ${rows[0]?.month}). Examples: ${res.unmatchedRefs.slice(0, 5).join(", ")}`,
    );
  }
  logger.info("Shipping report imported", {
    labels: rows.length,
    matched: res.matched,
    attributedCents: res.totalAttributedCents,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Import failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
