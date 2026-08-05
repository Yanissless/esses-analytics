/**
 * Seed the cost/margin model from Esses' existing spreadsheets.
 *
 * ⚠️ EVERY NUMBER HERE IS A PLACEHOLDER pending refresh — Sam flagged the COGS
 * sheets as out of date, and the international model's own notes call shipping a
 * placeholder. Each row records its source and date so nothing here can be
 * mistaken for a verified cost. All of it is editable in the app (/costs).
 *
 * Sources:
 *  - "Esses Magazine — International Subscription Margins" (May 2026): COGS
 *    $11.48/issue, per-market VAT/FX/uplift, shipping placeholders, 20% target.
 *  - "E-commerce Profit Calculator — US Mag Distribution" (Jan 2025): packaging
 *    $0.75, processing 2.9%, shipping $7.46.
 *  - "…DieKuere Europe Fulfillment" (Nov 2024): packaging $0.60, processing 3.9%,
 *    freight/duties $11.59/unit, return cost $1.00.
 *
 * Run: pnpm seed:costs
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import {
  costAssumptions,
  marginSettings,
  marketConfig,
  productCosts,
  shippingRateRules,
} from "../src/db/schema";
import { logger } from "../src/lib/logger";

const EFF = "2025-10-01"; // start of the analysis window
const usd = (d: number) => Math.round(d * 100);

/** Per-market model from the international margins sheet (FX = ECB 08-May-2026). */
const MARKETS = [
  // country, name, ccy, uplift, printVat, stdVat, vatBasis, zone, origin, fx
  ["US", "United States", "USD", 0.0, 0.0, 0.0, "print", "us", "US", 1.0],
  ["GB", "United Kingdom", "GBP", 0.2, 0.0, 0.2, "print", "uk", "UK", 0.7347],
  ["DE", "Germany", "EUR", 0.2, 0.09, 0.19, "print", "eu", "UK", 0.8503],
  ["FR", "France", "EUR", 0.2, 0.021, 0.2, "print", "eu", "UK", 0.8503],
  ["IT", "Italy", "EUR", 0.2, 0.04, 0.22, "print", "eu", "UK", 0.8503],
  ["ES", "Spain", "EUR", 0.2, 0.04, 0.21, "print", "eu", "UK", 0.8503],
  ["NL", "Netherlands", "EUR", 0.2, 0.09, 0.21, "print", "eu", "UK", 0.8503],
  ["SE", "Sweden", "SEK", 0.2, 0.06, 0.25, "print", "eu", "UK", 9.2185],
  // No print reduction in DK/NO — standard rate applies, which is why margin dies.
  ["DK", "Denmark", "DKK", 0.2, 0.25, 0.25, "standard", "eu", "UK", 6.3537],
  ["PL", "Poland", "PLN", 0.2, 0.08, 0.23, "print", "eu", "UK", 3.5982],
  ["CA", "Canada", "CAD", 0.2, 0.05, 0.05, "print", "row", "US", 1.3658],
  ["AU", "Australia", "AUD", 0.5, 0.1, 0.1, "standard", "row", "US", 1.3824],
  ["JP", "Japan", "JPY", 0.5, 0.1, 0.1, "standard", "row", "US", 156.76],
  ["CH", "Switzerland", "CHF", 0.5, 0.026, 0.081, "print", "row", "UK", 0.7785],
  ["NO", "Norway", "NOK", 0.5, 0.25, 0.25, "standard", "row", "UK", 9.2011],
  ["NZ", "New Zealand", "NZD", 0.5, 0.15, 0.15, "standard", "row", "US", 1.6779],
  ["SG", "Singapore", "SGD", 0.5, 0.09, 0.09, "standard", "row", "US", 1.2679],
  ["HK", "Hong Kong", "HKD", 0.5, 0.0, 0.0, "print", "row", "US", 7.8281],
  ["MX", "Mexico", "MXN", 0.5, 0.0, 0.16, "print", "row", "US", 17.2363],
] as const;

/**
 * Zone cost assumptions. Shipping figures come from the international sheet's
 * per-quarter (= per-shipment) placeholders; packaging/processing/freight from the
 * profit calculators. US has no inbound freight line; EU/UK carry DieKuere's.
 */
const ZONES = [
  {
    zone: "us",
    shipCost: usd(5.0),
    freightPerUnit: usd(0),
    packaging: usd(0.75),
    pickPack: usd(0),
    processingPct: 0.029,
    returnRatePct: 0,
    returnCost: usd(0),
    source: "US profit calculator (Jan 2025) + intl margins sheet (May 2026)",
    note: "PLACEHOLDER — shipping per shipment; verify against carrier invoices.",
  },
  {
    zone: "uk",
    shipCost: usd(12.0),
    freightPerUnit: usd(0),
    packaging: usd(0.6),
    pickPack: usd(0),
    processingPct: 0.039,
    returnRatePct: 0,
    returnCost: usd(1.0),
    source: "intl margins sheet (May 2026) + DieKuere EU calc (Nov 2024)",
    note: "PLACEHOLDER — fulfilled from the UK printer park; no inbound freight assumed.",
  },
  {
    zone: "eu",
    shipCost: usd(12.0),
    freightPerUnit: usd(0),
    packaging: usd(0.6),
    pickPack: usd(0),
    processingPct: 0.039,
    returnRatePct: 0,
    returnCost: usd(1.0),
    source: "intl margins sheet (May 2026) + DieKuere EU calc (Nov 2024)",
    note:
      "PLACEHOLDER — EU served from UK printer park. DieKuere sheet carried $11.59/unit inbound freight; set to 0 here since UK-printed copies skip that leg. Verify.",
  },
  {
    zone: "row",
    shipCost: usd(18.0),
    freightPerUnit: usd(0),
    packaging: usd(0.75),
    pickPack: usd(0),
    processingPct: 0.039,
    returnRatePct: 0,
    returnCost: usd(1.0),
    source: "intl margins sheet (May 2026)",
    note: "PLACEHOLDER — AU/JP/NZ/SG/HK/MX/CH/NO/CA long-haul shipping.",
  },
] as const;

/**
 * Per-unit print cost by fulfilment origin. The newest figure ($11.48/issue) comes
 * from the May 2026 international sheet; the older calculators said ~$5.50-5.58,
 * which is why these need a refresh. UK-printed copies are seeded at the same
 * figure until the printer park's real cost is supplied.
 */
const ISSUE_SKUS = ["ME2", "ME3", "ME4", "ME5", "Subscription", "SUB"];
const UNIT_COST_USD = 11.48;

async function main() {
  // --- margin settings -----------------------------------------------------
  await db
    .insert(marginSettings)
    .values({
      effectiveDate: EFF,
      targetMarginPct: 0.2,
      baseQuarterlyAmount: usd(30),
      baseAnnualAmount: usd(100),
      issuesPerQuarter: 1,
      issuesPerYear: 4,
      note: "From international margins sheet Assumptions tab (May 2026).",
    })
    .onConflictDoUpdate({
      target: marginSettings.effectiveDate,
      set: { targetMarginPct: 0.2, updatedAt: new Date() },
    });

  // --- markets -------------------------------------------------------------
  for (const [code, name, ccy, uplift, printVat, stdVat, basis, zone, origin, fx] of MARKETS) {
    const values = {
      countryCode: code,
      marketName: name,
      currency: ccy,
      upliftPct: uplift,
      printVatPct: printVat,
      stdVatPct: stdVat,
      vatBasis: basis,
      shippingZone: zone,
      fulfillmentOrigin: origin,
      fxPerUsd: fx,
      fxAsOf: "2026-05-08",
      note: "Seeded from international margins sheet; verify VAT with an advisor.",
    };
    await db
      .insert(marketConfig)
      .values(values)
      .onConflictDoUpdate({
        target: marketConfig.countryCode,
        set: { ...values, updatedAt: new Date() },
      });
  }

  // --- zone cost assumptions ----------------------------------------------
  for (const z of ZONES) {
    const values = {
      zone: z.zone,
      effectiveDate: EFF,
      shipCostAmount: z.shipCost,
      freightPerUnitAmount: z.freightPerUnit,
      packagingAmount: z.packaging,
      pickPackAmount: z.pickPack,
      processingPct: z.processingPct,
      returnRatePct: z.returnRatePct,
      returnCostAmount: z.returnCost,
      source: z.source,
      note: z.note,
    };
    await db
      .insert(costAssumptions)
      .values(values)
      .onConflictDoUpdate({
        target: [costAssumptions.zone, costAssumptions.effectiveDate],
        set: { ...values, updatedAt: new Date() },
      });
  }

  // --- per-unit product costs (per origin) --------------------------------
  for (const skuRaw of ISSUE_SKUS) {
    for (const origin of ["US", "UK"]) {
      const values = {
        sku: skuRaw,
        origin,
        costAmount: usd(UNIT_COST_USD),
        currency: "USD",
        effectiveDate: EFF,
        source: "manual" as const,
        note: `PLACEHOLDER $${UNIT_COST_USD}/issue from intl margins sheet (May 2026). Older calculators said ~$5.50 — needs refresh.${
          origin === "UK" ? " UK printer park cost not yet supplied." : ""
        }`,
      };
      await db
        .insert(productCosts)
        .values(values)
        .onConflictDoUpdate({
          target: [productCosts.sku, productCosts.origin, productCosts.effectiveDate],
          set: { ...values, updatedAt: new Date() },
        });
    }
  }

  // --- per-label rate rules -----------------------------------------------
  // Sam: "most subscription fulfillment orders go media mail, just under $5 per
  // label". These weight batch allocations and estimate cost where no invoice
  // line exists. Higher priority = more specific.
  const RATE_RULES = [
    {
      label: "USPS Media Mail",
      carrierPattern: "usps",
      servicePattern: null,
      countryCode: "US",
      zone: "us",
      expectedCostAmount: usd(4.95),
      priority: 30,
      source: "Sam: just under $5/label for media mail",
    },
    {
      label: "USPS domestic (other)",
      carrierPattern: "usps",
      servicePattern: null,
      countryCode: null,
      zone: null,
      expectedCostAmount: usd(6.5),
      priority: 20,
      source: "placeholder — refine from Shopify shipping report",
    },
    {
      label: "UPS domestic",
      carrierPattern: "ups",
      servicePattern: null,
      countryCode: "US",
      zone: null,
      expectedCostAmount: usd(12.0),
      priority: 20,
      source: "placeholder — refine from Shopify shipping report",
    },
    {
      label: "Royal Mail (UK park)",
      carrierPattern: "royal mail",
      servicePattern: null,
      countryCode: null,
      zone: null,
      expectedCostAmount: usd(4.0),
      priority: 25,
      source: "placeholder — replace with UK park batch invoices",
    },
    {
      label: "International (any carrier)",
      carrierPattern: null,
      servicePattern: null,
      countryCode: null,
      zone: "row",
      expectedCostAmount: usd(18.0),
      priority: 5,
      source: "intl margins sheet placeholder",
    },
  ] as const;

  for (const r of RATE_RULES) {
    const values = { ...r, effectiveDate: EFF, currency: "USD" };
    await db
      .insert(shippingRateRules)
      .values(values)
      .onConflictDoUpdate({
        target: [shippingRateRules.label, shippingRateRules.effectiveDate],
        set: { ...values, updatedAt: new Date() },
      });
  }

  const [{ markets }] = (await db.execute(
    sql`SELECT count(*)::int AS markets FROM market_config`,
  )) as unknown as Array<{ markets: number }>;
  const [{ costs }] = (await db.execute(
    sql`SELECT count(*)::int AS costs FROM product_costs`,
  )) as unknown as Array<{ costs: number }>;

  logger.info("Cost model seeded", { markets, productCosts: costs, zones: ZONES.length });
  console.log(
    "\n⚠️  All seeded figures are PLACEHOLDERS from existing sheets. Update them at /costs.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
