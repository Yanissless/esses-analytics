/**
 * Every subscription plan on both platforms, in one taxonomy.
 *
 * ## The problem this solves
 *
 * There is no shared plan concept between the two systems, only two sets of names that mean the
 * same things:
 *
 *   Skio   "Quarterly Subscription"              billed every 3 months
 *   Stripe "$30/quarter"                         billed every 3 months
 *   Skio   "Annual Payment, Quarterly Delivery"  billed every 12 months
 *   Stripe "$100/year"                           billed every 1 year
 *
 * Answering "how many quarterly subscribers are there" therefore meant knowing both naming
 * schemes and both interval conventions, and no page did it. `/churn` splits by Skio plan name,
 * `/forecast` splits by source. Nothing showed the book as one thing.
 *
 * ## Cadence is the canonical key, and price deliberately is not
 *
 * The one property both systems state truthfully is how often they bill. Names are free text
 * and differ; prices vary WITHIN a cadence, which is the finding that settles the design:
 * Stripe's annual subscribers sit on three different prices ($100/year, $50 a year, $80 a
 * year), all legacy, plus a single $5-a-month holdout. So a view keyed on price would invent
 * four "plans" out of one product, and a view that assumed one price per cadence would be
 * wrong about a third of the annual book.
 *
 * Cadence groups them correctly and the price points are shown underneath, where the variation
 * is visible rather than averaged away.
 *
 * ## Normalising the interval
 *
 * Skio always states months. Stripe states a unit — `month` or `year` — so a yearly plan
 * arrives as `interval='year', interval_count=1` and reads as ONE month if the unit is ignored,
 * overstating its renewal frequency twelvefold. `renewal-forecast.ts` already carries this
 * conversion in SQL; this module is where it lives for the plan view.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { PLAN_RENEWAL_PRICES, planForInterval } from "./plan-prices";

export type Cadence = "monthly" | "quarterly" | "annual" | "other";

export type Platform = "skio" | "stripe";

/**
 * Billing months → cadence.
 *
 * `other` is a visible outcome, not a dustbin: a cadence nobody sells is either a legacy price
 * still billing or a mapping bug, and both are worth seeing rather than folding into annual.
 */
export function cadenceFromMonths(months: number | null): Cadence {
  if (months === 1) return "monthly";
  if (months === 3) return "quarterly";
  if (months === 12) return "annual";
  return "other";
}

/**
 * Stripe's interval expressed in months.
 *
 * Exported and tested because getting it wrong is silent: a yearly plan read as monthly still
 * produces a plausible number, just a twelvefold wrong one.
 */
export function stripeIntervalMonths(
  unit: string | null,
  count: number | null,
): number | null {
  const c = count ?? 1;
  if (c <= 0) return null;
  switch ((unit ?? "").toLowerCase()) {
    case "year":
      return c * 12;
    case "month":
      return c;
    case "week":
      // Not sold today. Rounded rather than dropped so it lands in `other` and is countable.
      return Math.max(1, Math.round((c * 7) / 30));
    case "day":
      return Math.max(1, Math.round(c / 30));
    default:
      return null;
  }
}

/** Statuses that mean the subscription is still expected to bill again. */
const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function isLive(status: string | null): boolean {
  return status !== null && LIVE_STATUSES.has(status);
}

export interface PlanRow {
  cadence: Cadence;
  platform: Platform;
  /** The provider's own name, or null where it gives none. */
  planName: string | null;
  /** Line, where the platform distinguishes one. Skio is print-only today. */
  line: string | null;
  status: string | null;
  subscriptions: number;
  /** Summed monthly-normalised MRR. Tax-inclusive on some rows — see the caveat below. */
  mrrCents: number;
  billingMonths: number | null;
}

export interface CadenceGroup {
  cadence: Cadence;
  /** Live subscriptions only — the ones that will bill again. */
  live: number;
  /** Everything ever, so churn is visible next to the current book. */
  total: number;
  liveMrrCents: number;
  /**
   * What one full billing cycle of the live subscriptions collects, where a price is known.
   *
   * Not annualised: an annual plan's cycle is a year and a quarterly plan's is three months,
   * so these are not comparable across cadences and are deliberately not summed into one
   * headline. `annualisedCents` is the comparable figure.
   */
  cycleRevenueCents: number;
  /** One cycle scaled to twelve months, which IS comparable across cadences. */
  annualisedCents: number;
  /** Live subscriptions whose price could not be established. */
  unpricedLive: number;
  byPlatform: Array<{
    platform: Platform;
    live: number;
    total: number;
    liveMrrCents: number;
  }>;
  /** Distinct provider plan names inside this cadence, with their live counts. */
  plans: Array<{
    platform: Platform;
    planName: string | null;
    live: number;
    total: number;
    /** List price per cycle where known, else null. */
    priceCents: number | null;
  }>;
}

/**
 * Price per billing cycle for a row, or null.
 *
 * Skio prices come from the shared table so this view and the renewal forecast cannot disagree.
 * Stripe states its price in the plan nickname ("$30/quarter", "$100/year"), which is a label
 * rather than data — so it is parsed, and a nickname that does not carry a number yields null
 * rather than a guess.
 */
export function cyclePriceCents(row: {
  platform: Platform;
  planName: string | null;
  billingMonths: number | null;
}): number | null {
  if (row.platform === "skio") {
    const named = row.planName ? PLAN_RENEWAL_PRICES[row.planName] : undefined;
    if (named !== undefined) return named;
    // Same cadence fallback the forecast uses, so the two views agree on the 46 nameless ones.
    const matched = planForInterval(row.billingMonths);
    return matched ? (PLAN_RENEWAL_PRICES[matched] ?? null) : null;
  }

  // Stripe: the nickname is the price list. "$30/quarter" → 3000.
  const m = row.planName?.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

const CADENCE_ORDER: Cadence[] = ["quarterly", "annual", "monthly", "other"];

/**
 * Roll raw rows into one group per cadence.
 *
 * Pure, so the arithmetic that matters — what a cycle collects, what that is annualised, how
 * many are unpriced — is testable without a database.
 */
export function groupByCadence(rows: PlanRow[]): CadenceGroup[] {
  const groups = new Map<Cadence, CadenceGroup>();

  for (const r of rows) {
    let g = groups.get(r.cadence);
    if (!g) {
      g = {
        cadence: r.cadence,
        live: 0,
        total: 0,
        liveMrrCents: 0,
        cycleRevenueCents: 0,
        annualisedCents: 0,
        unpricedLive: 0,
        byPlatform: [],
        plans: [],
      };
      groups.set(r.cadence, g);
    }

    const live = isLive(r.status) ? r.subscriptions : 0;
    g.total += r.subscriptions;
    g.live += live;
    if (live) g.liveMrrCents += r.mrrCents;

    const price = cyclePriceCents(r);
    if (live) {
      if (price === null) {
        g.unpricedLive += live;
      } else {
        g.cycleRevenueCents += price * live;
        // Cycles per year, from the row's own cadence rather than the group's — `other` can
        // hold mixed intervals, and assuming the group's would misprice them.
        const months = r.billingMonths ?? 12;
        g.annualisedCents += Math.round((price * live * 12) / months);
      }
    }

    const plat = g.byPlatform.find((p) => p.platform === r.platform);
    if (plat) {
      plat.live += live;
      plat.total += r.subscriptions;
      plat.liveMrrCents += live ? r.mrrCents : 0;
    } else {
      g.byPlatform.push({
        platform: r.platform,
        live,
        total: r.subscriptions,
        liveMrrCents: live ? r.mrrCents : 0,
      });
    }

    const plan = g.plans.find(
      (p) => p.platform === r.platform && p.planName === r.planName,
    );
    if (plan) {
      plan.live += live;
      plan.total += r.subscriptions;
    } else {
      g.plans.push({
        platform: r.platform,
        planName: r.planName,
        live,
        total: r.subscriptions,
        priceCents: price,
      });
    }
  }

  for (const g of groups.values()) {
    g.byPlatform.sort((a, b) => b.live - a.live || a.platform.localeCompare(b.platform));
    g.plans.sort((a, b) => b.live - a.live);
  }

  // Quarterly first because it is the largest book, then annual. Stable regardless of what the
  // query happened to return.
  return CADENCE_ORDER.map((c) => groups.get(c)).filter((g): g is CadenceGroup => Boolean(g));
}

/**
 * Both platforms' subscriptions, one row per (cadence, platform, plan, line, status).
 *
 * A UNION rather than a join: they share no key, and the whole point is to present them as one
 * book while keeping the platform visible underneath.
 */
export async function getSubscriptionPlans(): Promise<PlanRow[]> {
  const rows = await db.execute<{
    platform: string;
    plan_name: string | null;
    line: string | null;
    status: string | null;
    billing_months: number | null;
    subscriptions: number;
    mrr_cents: number;
  }>(sql`
    SELECT 'skio'                              AS platform,
           NULLIF(selling_plan_name, '')       AS plan_name,
           'print'                             AS line,
           status::text                        AS status,
           -- Skio always states months, so the count IS the month count.
           billing_interval_count              AS billing_months,
           count(*)::int                       AS subscriptions,
           COALESCE(sum(mrr_amount), 0)::bigint AS mrr_cents
      FROM subscription_meta
     GROUP BY 2, 3, 4, 5

    UNION ALL

    SELECT 'stripe'                            AS platform,
           NULLIF(plan_nickname, '')           AS plan_name,
           subscription_line::text             AS line,
           status::text                        AS status,
           -- Stripe states a UNIT. A yearly plan is interval='year', count=1, which reads as
           -- one month if the unit is ignored — a twelvefold error in how often it bills.
           CASE lower(COALESCE(interval, ''))
             WHEN 'year'  THEN COALESCE(interval_count, 1) * 12
             WHEN 'month' THEN COALESCE(interval_count, 1)
             ELSE NULL
           END                                 AS billing_months,
           count(*)::int                       AS subscriptions,
           COALESCE(sum(mrr_amount), 0)::bigint AS mrr_cents
      FROM stripe_subscriptions
     GROUP BY 2, 3, 4, 5
  `);

  return [...rows].map((r) => {
    const months =
      r.platform === "stripe"
        ? (r.billing_months === null ? null : Number(r.billing_months))
        : (r.billing_months === null ? null : Number(r.billing_months));
    return {
      cadence: cadenceFromMonths(months),
      platform: r.platform as Platform,
      planName: r.plan_name,
      line: r.line,
      status: r.status,
      subscriptions: Number(r.subscriptions),
      mrrCents: Number(r.mrr_cents),
      billingMonths: months,
    };
  });
}
