/**
 * Cohort churn analysis — by issue, promo, plan, channel or signup month, plus
 * per-renewal-cycle churn.
 *
 * The question this exists to answer is "did THIS thing produce subscribers who
 * stay?", so every cohort has to be comparable to every other one. Two things make
 * that hard, and both are handled explicitly here:
 *
 * 1. **Observation window.** A cohort acquired last month cannot have churned at
 *    its first renewal yet. Reading raw churn % down a list of cohorts therefore
 *    makes recent cohorts look loyal and old ones look leaky, which is an artefact,
 *    not a finding. (This project already hit the same trap with cohort LTV, where
 *    it read as $88 → $37 "collapsing" until a fixed 3-month window showed LTV was
 *    actually rising.) So `churnByFirstRenewalPct` — churn among only those
 *    subscriptions old enough to have FACED a first renewal — is the column to
 *    compare, and `matureSubscriptions` states that denominator.
 *
 * 2. **Renewal cadence differs by plan.** "Quarterly Subscription" bills every 3
 *    months; "Annual Payment, Quarterly Delivery" bills every 12. A renewal cycle
 *    is therefore NOT a fixed number of months, and a blended month-by-month
 *    survival curve silently mixes two different decision schedules. Cycles are
 *    computed from each subscription's own BILLING interval.
 *
 * ⚠️ Note the asymmetry with MRR: `lineMrrCents` in the Skio connector uses the
 * DELIVERY cadence, because that's what spreads revenue. Churn uses the BILLING
 * cadence, because that's when a human can decide to stop paying. Same two fields,
 * opposite choice, on purpose.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "./formulas";

async function rows<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/** Average days per month, matching the constant used elsewhere in metrics. */
const SECONDS_PER_MONTH = 2629800;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested, no DB)
// ---------------------------------------------------------------------------

/**
 * Discount codes that are operational adjustments rather than marketing promos.
 *
 * Shopify's `discountCodes` mixes both: `FREEFIRSTISSUE` is an acquisition offer,
 * while `Delivery Issue` and `Custom discount` are goodwill/service credits applied
 * after something went wrong. Counting the latter as promos would attribute churn
 * to a "campaign" that is really a record of a delivery complaint — and would
 * invert the finding, since customers who had a problem are likelier to leave.
 *
 * Extend via `OPS_DISCOUNT_PATTERNS` as new codes appear; unmatched codes are
 * treated as marketing promos.
 */
const OPS_DISCOUNT_PATTERN_SOURCES = [
  "delivery\\s*issue",
  "custom\\s*discount",
  "replace|reship|resend",
  "damage|lost|missing|broken",
  "goodwill|apolog|courtesy",
  "refund|adjust",
  // A save offer made DURING cancellation. Its cohort is by definition people who
  // were already leaving, so scoring it as an acquisition promo would report the
  // causality backwards — the discount didn't cause the churn, the churn caused
  // the discount.
  "cancel\\s*flow",
  // Account credit applied to a renewal, not an offer that won a customer.
  "prepaid\\s*credit",
  // Bare generic labels used for manual adjustments. Anchored so real campaign
  // codes like SUBSCRIBE25 / SUBSCRIBER15 are unaffected.
  "^discount$",
  "^subscriber$",
  "^test",
];

/**
 * Single source of truth for the ops-code patterns, shared with the SQL in
 * `keyExpression('promo')` via `OPS_DISCOUNT_SQL_REGEX`. Defining these twice —
 * once in TS and once inline in SQL — is exactly the drift bug this codebase keeps
 * producing, so they are generated from one list.
 */
const OPS_DISCOUNT_PATTERNS = OPS_DISCOUNT_PATTERN_SOURCES.map((s) => new RegExp(s, "i"));

/** POSIX-compatible alternation for use with Postgres `!~*`. */
export const OPS_DISCOUNT_SQL_REGEX = OPS_DISCOUNT_PATTERN_SOURCES.join("|");

export function isMarketingPromo(code: string | null | undefined): boolean {
  const c = (code ?? "").trim();
  if (!c) return false;
  return !OPS_DISCOUNT_PATTERNS.some((re) => re.test(c));
}

/**
 * Issue number from a product or line-item title.
 *
 * Live titles are inconsistent — "Esses Issue 04", "Esses Issue 03 (pre sale)",
 * "Esses Issue 04 Pre-Order", "Issue 03 VIP", "Esses Issue 05 Contributor Copy" —
 * so this reads the number and ignores the decoration. Returns null for anything
 * with no issue in it ("Esses Subscription", merch), which is most subscription
 * acquisitions and is why `issue_at_signup` exists as a separate dimension.
 */
export function parseIssueNumber(title: string | null | undefined): number | null {
  if (!title) return null;
  const m = /issue\s*#?\s*0*(\d{1,2})\b/i.exec(title);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** True when the title is a pre-order/pre-sale rather than the issue's real release. */
export function isPreOrderTitle(title: string | null | undefined): boolean {
  return /pre[\s-]?(order|sale)/i.test(title ?? "");
}

/**
 * Length of one billing cycle in months. Returns null when the cadence is unknown,
 * so callers can exclude the subscription from cycle maths rather than assume 1.
 */
export function billingCycleMonths(
  interval: string | null | undefined,
  count: number | null | undefined,
): number | null {
  const n = count && count > 0 ? count : null;
  if (!interval || !n) return null;
  switch (interval.toLowerCase()) {
    case "month":
      return n;
    case "year":
      return n * 12;
    case "week":
      return Math.max(Math.round((n * 7) / 30.44), 1);
    case "day":
      return Math.max(Math.round(n / 30.44), 1);
    default:
      return null;
  }
}

/**
 * How many renewals a subscription has been ALIVE long enough to face.
 *
 * Cycle 1 is the first renewal, so a 3-month plan reaches cycle 1 at month 3. A
 * subscription exactly at the boundary counts as having reached it.
 */
export function cyclesReached(
  monthsLived: number,
  cycleMonths: number | null,
): number {
  if (!cycleMonths || cycleMonths <= 0 || monthsLived < 0) return 0;
  return Math.floor(monthsLived / cycleMonths + 1e-9);
}

// ---------------------------------------------------------------------------
// Issue release windows
// ---------------------------------------------------------------------------

/**
 * Issue release windows, derived from order history.
 *
 * The anchor is the first NON-pre-order sale: pre-orders open months ahead, so the
 * earliest order of any kind would stretch windows backwards and overlap them.
 *
 * ⚠️ Back catalogue is the trap. Issues already on sale when the data window opens
 * (here issues 01–03, still selling on 2025-10-01) get a first-sale date equal to
 * the start of our data, not their real release. Worse, issue 01's first sale in
 * range happened to fall on 2025-10-17 — AFTER issue 03's — which naively produced
 * an "Issue 01" window spanning mid-October, mislabelling everyone who subscribed
 * while issue 03 was actually current.
 *
 * So an issue counts as released in-window only when its NUMBER exceeds every issue
 * already selling at the start of the data. Everything at or below that is collapsed
 * into a single "or earlier" cohort, which is the honest statement: we cannot tell
 * which of the back catalogue was current before our data begins.
 */
const ISSUE_RELEASE_CTE = sql`
  data_bounds AS (
    SELECT min(o.processed_at) AS data_start
      FROM orders o
     WHERE o.test = false AND o.cancelled_at IS NULL AND o.processed_at IS NOT NULL
  ),
  issue_first_sale AS (
    SELECT (regexp_match(lower(li.title), 'issue\\s*#?\\s*0*([0-9]{1,2})'))[1]::int AS issue_no,
           min(o.processed_at) FILTER (
             WHERE lower(li.title) !~ 'pre[ -]?(order|sale)'
           ) AS released_at,
           count(*) AS orders
      FROM order_line_items li
      JOIN orders o ON o.id = li.order_id
     WHERE o.test = false AND o.cancelled_at IS NULL AND o.processed_at IS NOT NULL
       AND (regexp_match(lower(li.title), 'issue\\s*#?\\s*0*([0-9]{1,2})'))[1] IS NOT NULL
     GROUP BY 1
  ),
  -- Highest issue number already on sale as our data opens = the back catalogue.
  early_max AS (
    SELECT COALESCE(max(s.issue_no), 0) AS max_early
      FROM issue_first_sale s CROSS JOIN data_bounds b
     WHERE s.released_at IS NOT NULL
       AND s.released_at <= b.data_start + interval '7 days'
  ),
  issue_release AS (
    SELECT s.issue_no, s.released_at, s.orders,
           (s.issue_no > e.max_early) AS in_window,
           e.max_early
      FROM issue_first_sale s CROSS JOIN early_max e
     WHERE s.released_at IS NOT NULL
  )
`;

export interface IssueWindow {
  issueNumber: number;
  /** First non-pre-order sale — the practical release date. */
  releasedOn: string;
  /** Release of the next issue; null for the current one. */
  supersededOn: string | null;
  ordersInWindow: number;
  /**
   * False for back-catalogue issues that were already selling when the data window
   * opened — their release date is an artefact of the backfill start, not a fact.
   */
  releasedInWindow: boolean;
}

/**
 * Issue release windows. Derived, not authoritative — if Sam supplies real on-sale
 * dates, replace this with a table; the rest of the module only needs
 * (issueNumber, releasedOn, releasedInWindow).
 */
export async function getIssueWindows(): Promise<IssueWindow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH ${ISSUE_RELEASE_CTE}
    SELECT issue_no, released_at::date AS released_on, orders, in_window,
           -- Successor is the next IN-WINDOW release, so a back-catalogue issue
           -- can't appear to supersede a newer one.
           CASE WHEN in_window THEN
             lead(released_at::date) OVER (
               PARTITION BY in_window ORDER BY released_at
             )
           END AS superseded_on
      FROM issue_release
     ORDER BY in_window DESC, released_at
  `);

  return data.map((r) => ({
    issueNumber: num(r.issue_no),
    releasedOn: String(r.released_on),
    supersededOn: r.superseded_on == null ? null : String(r.superseded_on),
    ordersInWindow: num(r.orders),
    releasedInWindow: Boolean(r.in_window),
  }));
}

// ---------------------------------------------------------------------------
// Cohort churn
// ---------------------------------------------------------------------------

export type ChurnDimension =
  /** Issue in market when the subscription started. Covers every subscription. */
  | "issue_at_signup"
  /** Issue actually on the acquiring order. Precise but sparse — most subscription
   *  signups buy a generic "Esses Subscription" with no issue in the title. */
  | "issue_purchased"
  /** Marketing discount code on the acquiring order ('none' when undiscounted). */
  | "promo"
  /** Skio selling plan / Stripe plan nickname — the cadence cohort. */
  | "plan"
  /** Calendar month the subscription started. */
  | "signup_month"
  /** The customer's stamped marketing acquisition channel. */
  | "channel";

export type ChurnSource = "skio" | "stripe" | "all";

export interface ChurnCohort {
  dimension: ChurnDimension;
  /** Stable grouping key, e.g. "4", "FREEFIRSTISSUE", "2026-03", "none". */
  key: string;
  /** Human label for the key. */
  label: string;
  subscriptions: number;
  customers: number;
  active: number;
  churned: number;
  /** Cumulative churn over all ages — NOT comparable across cohorts of different
   *  ages. Present because it's the intuitive number people ask for. */
  churnRatePct: number | null;
  /**
   * Churn among subscriptions old enough to have faced their first renewal. THIS
   * is the cross-cohort comparable figure. Null when no subscription in the cohort
   * is mature enough yet.
   */
  churnByFirstRenewalPct: number | null;
  matureSubscriptions: number;
  avgLifetimeMonths: number | null;
  medianLifetimeMonths: number | null;
  mrrCents: number;
  /** Realised revenue per subscriber in the cohort (Shopify + Stripe). */
  ltvPerSubscriberCents: number | null;
  /** Promo dimension only: how deep the discount was, to relate depth to churn. */
  avgDiscountCents: number | null;
  /** Churned but with no cancellation date, so excluded from timing maths. */
  churnedWithoutDate: number;
}

/**
 * Shared subscription view across both systems, with churn + cadence resolved.
 *
 * Exported so other modules (e.g. `personas.ts`) reuse the churn/maturity/cadence
 * logic rather than reimplementing it. The cadence rule in particular is subtle
 * enough that a second copy would drift — see the header note on billing vs
 * delivery cadence. Provides CTEs named `subs` and `enriched`.
 */
export const SUBS_CTE = sql`
  subs AS (
    SELECT 'skio'::text AS source, sm.id, sm.customer_id, sm.started_at,
           sm.cancelled_at AS churned_at, sm.status::text AS status,
           COALESCE(sm.selling_plan_name, 'unknown') AS plan_name,
           sm.billing_interval AS interval, sm.billing_interval_count AS interval_count,
           sm.mrr_amount
      FROM subscription_meta sm
     WHERE sm.started_at IS NOT NULL
    UNION ALL
    SELECT 'stripe', ss.id, ss.customer_id, ss.started_at,
           ss.canceled_at, ss.status::text,
           COALESCE(ss.plan_nickname, ss.subscription_line::text, 'unknown'),
           ss.interval, ss.interval_count, ss.mrr_amount
      FROM stripe_subscriptions ss
     WHERE ss.started_at IS NOT NULL
  ),
  enriched AS (
    SELECT s.*,
           -- Churn is keyed off the DATE first and status second: 1,145 of 1,152
           -- Skio cancellations carry a date, and 270 subscriptions have a NULL
           -- status while clearly live (they hold a next_billing_at). Trusting
           -- status alone would misclassify both groups.
           (s.churned_at IS NOT NULL OR s.status = 'canceled') AS is_churned,
           (s.churned_at IS NULL AND s.status = 'canceled') AS churned_no_date,
           EXTRACT(EPOCH FROM (now() - s.started_at)) / ${SECONDS_PER_MONTH} AS age_months,
           EXTRACT(EPOCH FROM (COALESCE(s.churned_at, now()) - s.started_at))
             / ${SECONDS_PER_MONTH} AS lived_months,
           CASE lower(s.interval)
             WHEN 'month' THEN s.interval_count
             WHEN 'year'  THEN s.interval_count * 12
             WHEN 'week'  THEN GREATEST(ROUND(s.interval_count * 7 / 30.44), 1)
             WHEN 'day'   THEN GREATEST(ROUND(s.interval_count / 30.44), 1)
           END::numeric AS cycle_months
      FROM subs s
  )
`;

/**
 * The customer's acquiring PAID order.
 *
 * Paid-only on purpose: prepaid subscription deliveries are $0 orders that still
 * carry a discount code (`FREEFIRSTISSUE` zeroing a $30 renewal), so including
 * them would credit the acquisition promo to every subsequent shipment and wildly
 * overstate how many customers a promo brought in.
 */
const ACQ_CTE = sql`
  acq AS (
    SELECT DISTINCT ON (o.customer_id)
           o.customer_id, o.id AS order_id, o.processed_at, o.discount_codes,
           o.total_discounts_amount
      FROM orders o
     WHERE o.customer_id IS NOT NULL AND o.test = false AND o.cancelled_at IS NULL
       AND o.counts_as_revenue = true AND o.total_amount > 0
     ORDER BY o.customer_id, o.processed_at ASC
  )
`;

/** Realised revenue per customer, both systems, for cohort LTV. */
const VALUE_CTE = sql`
  cust_value AS (
    SELECT c.id AS customer_id,
           COALESCE((SELECT sum(o.total_amount - o.total_refunded_amount) FROM orders o
                      WHERE o.customer_id = c.id AND o.test = false
                        AND o.cancelled_at IS NULL AND o.counts_as_revenue = true), 0)
         + COALESCE((SELECT sum(si.amount_paid_amount) FROM stripe_invoices si
                      WHERE si.customer_id = c.id AND si.paid = true), 0) AS value
      FROM customers c
  )
`;

/**
 * SQL expression producing the cohort key for a dimension, plus any extra CTEs it
 * needs. Kept in one place so every dimension shares the same churn/maturity maths.
 */
function keyExpression(dimension: ChurnDimension): { extraCte: SQL | null; keyExpr: SQL } {
  switch (dimension) {
    case "issue_at_signup":
      return {
        extraCte: ISSUE_RELEASE_CTE,
        // The most recent IN-WINDOW release at or before signup. Anyone who
        // subscribed before the first in-window release falls into the collapsed
        // back-catalogue bucket rather than being assigned a spurious issue.
        keyExpr: sql`COALESCE((
          SELECT ir.issue_no::text FROM issue_release ir
           WHERE ir.in_window AND ir.released_at <= e.started_at
           ORDER BY ir.released_at DESC LIMIT 1
        ), (
          SELECT '<=' || max(ir.issue_no)::text FROM issue_release ir
           WHERE NOT ir.in_window
        ), 'unknown')`,
      };

    case "issue_purchased":
      return {
        extraCte: null,
        keyExpr: sql`COALESCE((
          SELECT max((regexp_match(lower(li.title), 'issue\\s*#?\\s*0*([0-9]{1,2})'))[1]::int)::text
            FROM order_line_items li
           WHERE li.order_id = a.order_id
        ), 'no issue on order')`,
      };

    case "promo":
      // First MARKETING code on the acquiring order. The exclusion regex is
      // generated from the same list isMarketingPromo() uses, so the two can't drift.
      return {
        extraCte: null,
        keyExpr: sql`COALESCE((
          SELECT dc FROM unnest(a.discount_codes) AS dc
           WHERE dc IS NOT NULL AND btrim(dc) <> ''
             AND dc !~* ${OPS_DISCOUNT_SQL_REGEX}
           ORDER BY dc LIMIT 1
        ), 'none')`,
      };

    case "plan":
      return { extraCte: null, keyExpr: sql`e.plan_name` };

    case "signup_month":
      return {
        extraCte: null,
        keyExpr: sql`to_char(date_trunc('month', e.started_at), 'YYYY-MM')`,
      };

    case "channel":
      return {
        extraCte: null,
        keyExpr: sql`COALESCE(cu.acquisition_channel, 'unattributed')`,
      };
  }
}

function issueLabel(k: string): string {
  if (/^\d+$/.test(k)) return `Issue ${k.padStart(2, "0")}`;
  // Collapsed back-catalogue bucket, e.g. "<=3".
  const m = /^<=(\d+)$/.exec(k);
  if (m) return `Issue ${m[1].padStart(2, "0")} or earlier`;
  return k;
}

const LABELS: Record<ChurnDimension, (key: string) => string> = {
  issue_at_signup: issueLabel,
  issue_purchased: issueLabel,
  promo: (k) => (k === "none" ? "No promo code" : k),
  plan: (k) => k,
  signup_month: (k) => k,
  channel: (k) => k,
};

export interface ChurnCohortOptions {
  source?: ChurnSource;
  /** Drop cohorts with fewer than this many subscriptions (thin cohorts mislead). */
  minSubscriptions?: number;
}

/**
 * Churn and retention per cohort on one dimension.
 *
 * Sorted by subscription count so the cohorts that actually carry the business come
 * first, rather than by churn rate, which would put three-subscriber flukes on top.
 */
export async function getChurnCohorts(
  dimension: ChurnDimension,
  opts: ChurnCohortOptions = {},
): Promise<ChurnCohort[]> {
  const { source = "all", minSubscriptions = 1 } = opts;
  const { extraCte, keyExpr } = keyExpression(dimension);

  const sourceFilter =
    source === "all" ? sql`` : sql`AND e.source = ${source}`;

  const data = await rows<Record<string, unknown>>(sql`
    WITH ${SUBS_CTE}, ${ACQ_CTE}, ${VALUE_CTE}
    ${extraCte ? sql`, ${extraCte}` : sql``}
    , cohorted AS (
      SELECT ${keyExpr} AS cohort_key,
             e.id, e.customer_id, e.is_churned, e.churned_no_date,
             e.age_months, e.lived_months, e.cycle_months, e.mrr_amount, e.status,
             cv.value AS customer_value,
             a.total_discounts_amount AS acq_discount
        FROM enriched e
        LEFT JOIN acq a ON a.customer_id = e.customer_id
        LEFT JOIN customers cu ON cu.id = e.customer_id
        LEFT JOIN cust_value cv ON cv.customer_id = e.customer_id
       WHERE true ${sourceFilter}
    )
    SELECT cohort_key,
           count(*)::int AS subscriptions,
           count(DISTINCT customer_id)::int AS customers,
           count(*) FILTER (WHERE NOT is_churned)::int AS active,
           count(*) FILTER (WHERE is_churned)::int AS churned,
           count(*) FILTER (WHERE churned_no_date)::int AS churned_no_date,
           -- Maturity denominator: reached its first renewal (age >= one cycle).
           count(*) FILTER (WHERE cycle_months IS NOT NULL
                              AND age_months >= cycle_months)::int AS mature,
           -- Of those, the ones that did not survive to that first renewal.
           count(*) FILTER (WHERE cycle_months IS NOT NULL
                              AND age_months >= cycle_months
                              AND is_churned
                              AND lived_months < cycle_months)::int AS churned_by_first,
           avg(lived_months) FILTER (WHERE NOT churned_no_date) AS avg_lived,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY lived_months
           ) FILTER (WHERE NOT churned_no_date) AS median_lived,
           COALESCE(sum(mrr_amount) FILTER (WHERE NOT is_churned), 0)::bigint AS mrr,
           avg(customer_value) AS avg_value,
           avg(acq_discount) FILTER (WHERE acq_discount > 0) AS avg_discount
      FROM cohorted
     GROUP BY cohort_key
    HAVING count(*) >= ${minSubscriptions}
     ORDER BY count(*) DESC
  `);

  return data.map((r) => {
    const key = String(r.cohort_key ?? "unknown");
    const mature = num(r.mature);
    return {
      dimension,
      key,
      label: LABELS[dimension](key),
      subscriptions: num(r.subscriptions),
      customers: num(r.customers),
      active: num(r.active),
      churned: num(r.churned),
      churnRatePct: ratio(num(r.churned), num(r.subscriptions)),
      churnByFirstRenewalPct: mature > 0 ? ratio(num(r.churned_by_first), mature) : null,
      matureSubscriptions: mature,
      avgLifetimeMonths: numOrNull(r.avg_lived),
      medianLifetimeMonths: numOrNull(r.median_lived),
      mrrCents: num(r.mrr),
      ltvPerSubscriberCents: r.avg_value == null ? null : Math.round(Number(r.avg_value)),
      avgDiscountCents: r.avg_discount == null ? null : Math.round(Number(r.avg_discount)),
      churnedWithoutDate: num(r.churned_no_date),
    };
  });
}

// ---------------------------------------------------------------------------
// Renewal-cycle churn
// ---------------------------------------------------------------------------

export interface RenewalCycleChurn {
  /** 1 = the first renewal after signup. */
  cycle: number;
  /** Subscriptions old enough to have faced this renewal — the fair denominator. */
  reachedCycle: number;
  /** Of those, how many were already gone before reaching it. */
  churnedBeforeCycle: number;
  /** Churn AT this renewal: lost between the previous cycle and this one. */
  churnedAtCycle: number;
  /** Conditional churn — of those who survived to the previous renewal. */
  churnRateAtCyclePct: number | null;
  /** Share of the mature population still alive at this cycle. */
  survivingPct: number | null;
  /** Months of tenure this cycle represents, when the cohort shares a cadence. */
  approxMonths: number | null;
}

export interface RenewalCycleOptions {
  source?: ChurnSource;
  maxCycles?: number;
  /** Restrict to one plan — strongly recommended, since cadence differs by plan. */
  planName?: string;
  /**
   * Restrict to one billing cadence. Needed because a plan NAME does not
   * guarantee a single cadence: the `unknown` Skio bucket holds both 3-month and
   * 12-month subscriptions, and filtering on name alone silently re-created the
   * blended-cycle error this function exists to avoid (it reported a "first
   * renewal" at ~month 7, which is neither plan's actual rebill).
   */
  cycleMonths?: number;
}

/**
 * Churn at each renewal, using each subscription's own billing cadence.
 *
 * This is the cadence-correct replacement for reading a month-by-month survival
 * curve: on a blended curve the drop at months 3–4 looks like a universal cliff,
 * but only the 3-month plan bills then — for the annual plan month 4 is not a
 * renewal at all. Grouping by cycle instead of by month puts every plan's first
 * renewal in the same column.
 *
 * `churnRateAtCyclePct` is CONDITIONAL: the share of those who reached the previous
 * renewal who then failed to reach this one. That's the number that answers "how
 * risky is each rebill", as opposed to cumulative loss.
 *
 * Pass `planName` when comparing cadences is not the point — a blended result still
 * mixes a 3-month and a 12-month decision into "cycle 1".
 */
export async function getRenewalCycleChurn(
  opts: RenewalCycleOptions = {},
): Promise<RenewalCycleChurn[]> {
  const { source = "all", maxCycles = 6, planName, cycleMonths } = opts;
  const sourceFilter = source === "all" ? sql`` : sql`AND e.source = ${source}`;
  const planFilter = planName ? sql`AND e.plan_name = ${planName}` : sql``;
  const cadenceFilter =
    cycleMonths == null ? sql`` : sql`AND e.cycle_months = ${cycleMonths}`;

  const data = await rows<Record<string, unknown>>(sql`
    WITH ${SUBS_CTE},
    pop AS (
      SELECT e.* FROM enriched e
       WHERE e.cycle_months IS NOT NULL ${sourceFilter} ${planFilter} ${cadenceFilter}
    ),
    cycles AS (SELECT generate_series(1, ${maxCycles}) AS cycle)
    SELECT c.cycle,
           count(*) FILTER (WHERE p.age_months >= p.cycle_months * c.cycle)::int
             AS reached,
           count(*) FILTER (WHERE p.age_months >= p.cycle_months * c.cycle
                              AND p.is_churned
                              AND p.lived_months < p.cycle_months * c.cycle)::int
             AS churned_before,
           -- Lost in THIS interval: survived the previous renewal, not this one.
           count(*) FILTER (WHERE p.age_months >= p.cycle_months * c.cycle
                              AND p.is_churned
                              AND p.lived_months >= p.cycle_months * (c.cycle - 1)
                              AND p.lived_months < p.cycle_months * c.cycle)::int
             AS churned_at,
           -- Denominator for conditional churn: reached the PREVIOUS renewal alive.
           count(*) FILTER (WHERE p.age_months >= p.cycle_months * c.cycle
                              AND p.lived_months >= p.cycle_months * (c.cycle - 1))::int
             AS at_risk,
           avg(p.cycle_months * c.cycle) AS approx_months
      FROM cycles c CROSS JOIN pop p
     GROUP BY c.cycle ORDER BY c.cycle
  `);

  return data
    .filter((r) => num(r.reached) > 0)
    .map((r) => {
      const reached = num(r.reached);
      const churnedBefore = num(r.churned_before);
      return {
        cycle: num(r.cycle),
        reachedCycle: reached,
        churnedBeforeCycle: churnedBefore,
        churnedAtCycle: num(r.churned_at),
        churnRateAtCyclePct: ratio(num(r.churned_at), num(r.at_risk)),
        survivingPct: ratio(reached - churnedBefore, reached),
        approxMonths: numOrNull(r.approx_months),
      };
    });
}

/**
 * Distinct (plan, source, cadence) combinations present in the data, so a caller
 * can drive the per-plan renewal comparison without hardcoding plan names.
 *
 * Grouped by cadence as well as name — NOT `max(cycle_months)` per name — because a
 * plan name can cover more than one cadence (the `unknown` Skio bucket holds both
 * 3-month and 12-month subscriptions). Collapsing those would hand the caller a
 * single cadence that misrepresents half the rows.
 */
export async function getPlanCadences(): Promise<
  Array<{ planName: string; source: string; cycleMonths: number | null; subscriptions: number }>
> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH ${SUBS_CTE}
    SELECT e.plan_name, e.source, e.cycle_months, count(*)::int AS subs
      FROM enriched e GROUP BY 1, 2, 3 ORDER BY subs DESC
  `);
  return data.map((r) => ({
    planName: String(r.plan_name),
    source: String(r.source),
    cycleMonths: numOrNull(r.cycle_months),
    subscriptions: num(r.subs),
  }));
}
