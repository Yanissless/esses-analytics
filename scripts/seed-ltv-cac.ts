/**
 * Seed LTV:CAC assumptions for the two subscription products that actually exist.
 *
 * ⚠️ Ojus Jain's methodology note ("How LTV and LTV:CAC Are Calculated", 10 Aug
 * 2026) worked its formula against three tiers — Digital $60, Print+digital $100,
 * Premium $275 — plus a $155 repricing scenario. Sam confirmed (4 Sep 2026): only
 * two of those are real. There is no digital-only subscription anywhere in the
 * data (Shopify products, Skio plans and Stripe's `subscription_line` are all
 * print, always), no Premium tier, and no $155 price point. Those rows have been
 * removed rather than kept as "scenarios", because a hypothetical sitting next to
 * real numbers on the same page is exactly what made this confusing.
 *
 * What IS real, per `metrics/plan-prices.ts` (Sam-confirmed prices) and
 * `metrics/subscription-plans.ts` (the unified cadence view used on /plans):
 *
 *   Skio "Quarterly Subscription"             = Stripe "$30/quarter"  → $30/renewal, 3-month cycle
 *   Skio "Annual Payment, Quarterly Delivery" = Stripe "$100/year"    → $100/renewal, 12-month cycle
 *
 * Same product on both rails, same price. This file keys on the SAME "quarterly"
 * / "annual" cadence words `/plans` already uses, on purpose — three different
 * names for the same two products across three pages was part of the confusion.
 *
 * ## What's measured live vs assumed
 *
 * Quarterly's r1/r2 are computed from `getRenewalCycleChurn` at seed time — 1,112
 * subscriptions have reached their first quarterly renewal, so this is real, not
 * guessed. Annual's r1/r2 CANNOT be measured yet: the data starts October 2025
 * and the plan bills once every 12 months, so not one annual subscription has
 * reached a renewal — the exact caveat already on /churn for this plan. Ojus's
 * original 67%/76% ship as a placeholder for annual, flagged as such.
 *
 * CAC uses the same blended, marketing-only figure /marketing already reports
 * (ad spend ÷ new customers) — not a per-tier "fully loaded" figure, because
 * growth salary/creative/agency/martech/affiliate costs aren't tracked anywhere
 * in the app yet. Both tiers share it: nothing in the ad data splits acquisition
 * spend by which cadence a subscriber picks at checkout.
 *
 * Both tiers' COGS derive from the SAME $11.48/issue print-cost placeholder
 * /costs uses — previously this doc's $15.25/issue figure would have quietly
 * disagreed with the app's own COGS model for the same magazine. It's charged
 * per BILLING PERIOD, not per year: one issue ($11.48) for Quarterly's 3-month
 * cycle, four ($45.92) for Annual's 12-month one. Charging a full year's print
 * cost against one quarter's $30 revenue is what made an earlier version of
 * this seed produce a negative LTV for Quarterly — see `cycleMonths` on the
 * schema and in `metrics/ltv-cac.ts` for the fix.
 *
 * Processing uses Sam's actual Shopify Grow plan rate (2.7% + $0.30/transaction,
 * screenshot 4 Sep 2026), converted to an effective % per tier's price point
 * rather than Ojus's flat 3% guess — the flat fee matters more on a $30 charge
 * than a $100 one.
 *
 * Route is always 'bought': there's no evidence either plan is something
 * subscribers "upgrade" into from a cheaper tier, so the bought/upgraded split
 * from the doc doesn't apply here. Kept as a schema column (not removed) in
 * case a real upgrade path is tracked later.
 *
 * Run: pnpm seed:ltv-cac
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { ltvCacAssumptions } from "../src/db/schema";
import { getRenewalCycleChurn } from "../src/metrics/churn";
import { getSubscriptionPlans, groupByCadence } from "../src/metrics/subscription-plans";
import { getPeriodMetrics } from "../src/metrics/rollup";
import { getDataBounds } from "../src/lib/date-range.server";
import { logger } from "../src/lib/logger";

const EFF = "2026-09-04"; // date these figures were computed/confirmed
const usd = (d: number) => Math.round(d * 100);

// Sam's Shopify Grow plan, screenshot 4 Sep 2026: 2.7% + $0.30 per online transaction.
const CARD_PCT = 0.027;
const CARD_FLAT_CENTS = 30;
const effectiveProcessingPct = (priceCents: number) =>
  (priceCents * CARD_PCT + CARD_FLAT_CENTS) / priceCents;

// Same placeholder /costs uses today (intl margins sheet, May 2026) — pending Sam's real
// printer invoice. Keeping this in sync with /costs matters more than either being "right".
const PRINT_COST_PER_ISSUE_CENTS = usd(11.48);
// Magazine ships 4x/year (RELEASE_MONTHS in metrics/release-schedule.ts), so each BILLING
// PERIOD's COGS is one issue per quarterly cycle, four per annual cycle — NOT $45.92 for
// both. Charging a full year's print cost against one quarter's $30 revenue makes the
// quarterly tier's contribution silently negative; this is why `cycleMonths` exists.
const ANNUAL_COGS_CENTS = PRINT_COST_PER_ISSUE_CENTS * 4;
const QUARTERLY_COGS_CENTS = PRINT_COST_PER_ISSUE_CENTS * 1;

async function main() {
  // --- real, measured retention for Quarterly ------------------------------
  const qCycles = await getRenewalCycleChurn({
    planName: "Quarterly Subscription",
    cycleMonths: 3,
    maxCycles: 2,
  });
  const qCycle1 = qCycles.find((c) => c.cycle === 1);
  const qCycle2 = qCycles.find((c) => c.cycle === 2);
  if (!qCycle1 || qCycle1.churnRateAtCyclePct == null) {
    throw new Error(
      "No measured first-renewal churn for 'Quarterly Subscription' — refusing to seed a " +
        "guessed r1 silently. Check getRenewalCycleChurn before re-running.",
    );
  }
  const quarterlyR1 = 1 - qCycle1.churnRateAtCyclePct;
  // r2 falls back to r1 if cycle 2 isn't measurable yet either — a stated fallback, not a
  // silent one; the note on the row says so.
  const quarterlyR2 =
    qCycle2?.churnRateAtCyclePct != null ? 1 - qCycle2.churnRateAtCyclePct : quarterlyR1;

  // --- real base mix, for the portfolio blend -------------------------------
  const cadenceGroups = groupByCadence(await getSubscriptionPlans());
  const quarterlyLive = cadenceGroups.find((g) => g.cadence === "quarterly")?.live ?? 0;
  const annualLive = cadenceGroups.find((g) => g.cadence === "annual")?.live ?? 0;
  const coreLive = quarterlyLive + annualLive; // excludes the ~40-subscription monthly/other stragglers
  const quarterlyShare = coreLive > 0 ? quarterlyLive / coreLive : null;
  const annualShare = coreLive > 0 ? annualLive / coreLive : null;

  // --- real blended marketing CAC, the same figure /marketing reports -------
  const bounds = await getDataBounds();
  const period = await getPeriodMetrics(bounds.start, bounds.anchor);
  const blendedCacCents = period.cac != null ? Math.round(period.cac) : 0;

  const quarterlyPrice = usd(30);
  const annualPrice = usd(100);

  const ROWS = [
    {
      tier: "quarterly",
      tierLabel: "Quarterly — $30/renewal",
      route: "bought",
      listPriceCents: quarterlyPrice,
      introDiscountPct: 0,
      processingPct: effectiveProcessingPct(quarterlyPrice),
      annualCogsCents: QUARTERLY_COGS_CENTS,
      cycleMonths: 3,
      r1: quarterlyR1,
      r2: quarterlyR2,
      baseSharePct: quarterlyShare,
      cacCents: blendedCacCents,
      source:
        "metrics/plan-prices.ts (price, Sam-confirmed 18 Aug 2026); getRenewalCycleChurn (r1/r2, measured " +
        EFF +
        ")",
      note: `r1/r2 measured live from ${qCycle1.reachedCycle} subscriptions that have reached their first quarterly renewal — not an assumption. ${qCycle2 ? `r2 from ${qCycle2.reachedCycle} that reached the second.` : "r2 falls back to r1: fewer subscriptions have reached a SECOND renewal yet — refresh once more have."} No confirmed intro-discount rate for this plan (Esses' actual new-subscriber incentive is a free first issue, tracked separately as a comp program, not modelled here yet) — year 1 and renewal contribution are currently equal.`,
    },
    {
      tier: "annual",
      tierLabel: "Annual — $100/renewal",
      route: "bought",
      listPriceCents: annualPrice,
      introDiscountPct: 0,
      processingPct: effectiveProcessingPct(annualPrice),
      annualCogsCents: ANNUAL_COGS_CENTS,
      cycleMonths: 12,
      r1: 0.67,
      r2: 0.76,
      baseSharePct: annualShare,
      cacCents: blendedCacCents,
      source:
        "metrics/plan-prices.ts (price, Sam-confirmed 18 Aug 2026); Ojus Jain methodology doc, 10 Aug 2026 (r1/r2, placeholder)",
      note: "NEEDS CONFIRMATION — r1/r2 are Ojus's original assumption, not measured. This plan bills once every 12 months and the data starts October 2025, so literally zero annual subscriptions have reached a first renewal yet (same caveat as /churn's 'largest part of the subscriber base is still an open question'). Re-run this seed once real annual renewals exist to replace these with measured figures, the same way Quarterly's already are. No confirmed intro-discount rate — year 1 and renewal contribution are currently equal.",
    },
  ] as const;

  for (const r of ROWS) {
    const values = {
      tier: r.tier,
      tierLabel: r.tierLabel,
      route: r.route,
      effectiveDate: EFF,
      currency: "USD",
      listPriceCents: r.listPriceCents,
      introDiscountPct: r.introDiscountPct,
      processingPct: r.processingPct,
      annualCogsCents: r.annualCogsCents,
      cycleMonths: r.cycleMonths,
      r1: r.r1,
      r2: r.r2,
      discountRatePct: 0.15,
      horizonYears: 3,
      cacCents: r.cacCents,
      baseSharePct: r.baseSharePct,
      targetRatio: 3,
      source: r.source,
      note: r.note,
    };
    await db
      .insert(ltvCacAssumptions)
      .values(values)
      .onConflictDoUpdate({
        target: [ltvCacAssumptions.tier, ltvCacAssumptions.route, ltvCacAssumptions.effectiveDate],
        set: { ...values, updatedAt: new Date() },
      });
  }

  // Remove the rows that don't correspond to a real product — this is a re-seed of a
  // brand-new page nobody has built workflows around yet, so deleting (rather than leaving
  // stale) is safe. A tier confirmed real later is just a new row, same as any other.
  const removed = (await db.execute(sql`
    DELETE FROM ltv_cac_assumptions
     WHERE tier IN ('print_digital', 'digital', 'premium', 'print_digital_repriced_155')
    RETURNING tier, route
  `)) as unknown as unknown[];

  const [{ n }] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM ltv_cac_assumptions`,
  )) as unknown as Array<{ n: number }>;

  logger.info("LTV:CAC assumptions seeded", {
    rows: ROWS.length,
    removedHypothetical: removed.length,
    total: n,
  });
  console.log(
    `\nSeeded 2 real tiers (Quarterly, Annual). Removed ${removed.length} row(s) for tiers that don't exist live (digital, premium, $155 reprice).`,
  );
  console.log(
    `Blended CAC used for both: $${(blendedCacCents / 100).toFixed(2)} (ad spend ÷ new customers, all-time — same figure /marketing reports).`,
  );
  console.log("Annual's r1/r2 are still a placeholder pending real renewals — see its note. Edit any row at /ltv-cac.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
