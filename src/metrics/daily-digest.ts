/**
 * Daily digest — CPR, churn, new subscribers, and ad spend breakdown for one
 * calendar day. Built for the "what happened yesterday" email to Ojus,
 * Johnny, Hugh and Sam (Section 9/14 in the original brief: "Automated daily
 * email reports adopted as the strategy for ongoing data validation" — the
 * Sep 3 review call's own agreed plan, finally wired up 22 Sep 2026).
 *
 * ## Why this reads `ad_spend` directly rather than `daily_metrics`
 *
 * `daily_metrics` is the validated rollup for period totals, but it's grained
 * `(date, channel)` where `channel` is our OWN attribution channel — it
 * doesn't carry Meta's campaign_id, so it can't produce a per-campaign
 * breakdown. `ad_spend` is the raw platform table (Section 6), already used
 * the same way by `flagship-cac.ts` for the same reason. Both draw from the
 * same sync, so the two never disagree about which day's data they're reading.
 *
 * ## Why churn and new-subscriber counts are Skio+Stripe, not Shopify
 *
 * Subscription status changes (`cancelled_at`, `started_at`) live on the
 * subscription systems, not on orders — Shopify has no concept of "this
 * subscription churned today". Matches the boundary `renewal-counting.ts`
 * and `churn.ts` already use.
 *
 * ## Rapid cancellations — added 22 Sep 2026, corrected the same day
 *
 * Sam asked to cross-reference each day's new signups against who cancels
 * right away. `promoCode` covers both sources: Skio's comes from the
 * earliest linked Shopify order; Stripe's comes from the earliest invoice
 * (the discount lives there, not on the subscription — verified live
 * against Stripe, see `connectors/stripe/ingest.ts`) and traces almost every
 * rapid Stripe case to ONE code, `cr76878bub`, on the $20-first-year annual
 * offer.
 *
 * ## `outcome` exists because "cancelled" was the wrong word for most of these
 *
 * The first version of this reported every row as a flat "cancelled" count
 * and called it instant buyer's remorse. Checking `status`,
 * `cancel_at_period_end` and whether a payment actually succeeded (per
 * subscription, from `stripe_invoices`) split the Stripe rapid-cancel
 * population three ways, and the split changes the story:
 *
 *  - **`abandoned_checkout`** — no invoice for that subscription was ever
 *    PAID. Stripe's raw status is `incomplete_expired`. This was the
 *    majority case (57% in the first full check) and it is NOT a
 *    cancellation in the ordinary sense — checked Stripe's own Events API
 *    for several of these (23 Sep 2026) and it isn't quiet abandonment
 *    either: a DELIBERATE, separate API call voids the invoice and expires
 *    the subscription roughly 10–75 seconds after creation (`attempted:
 *    false` throughout — payment was never even tried), and 55% of the time
 *    that void is followed, often within 1 second, by a SECOND subscription
 *    for the same customer that IS paid — a create-then-retry pattern in
 *    the checkout flow itself, not the customer walking away. The other 45%
 *    never retry and really did abandon. Either way it isn't a paying
 *    subscriber, which is why `getDailyDigest`'s `newSubscribers` and
 *    `churn` counts now exclude `status = 'expired'` (fixed 23 Sep 2026,
 *    same day as this finding — see the identical fix in `metrics/churn.ts`'s
 *    `SUBS_CTE`) while THIS table deliberately still shows them, because
 *    surfacing the pattern is the point.
 *  - **`kept_access`** — `cancel_at_period_end = true` but `status` is still
 *    `active`/`trialing`. The customer turned off auto-renew, immediately,
 *    but kept the subscription they just paid for. Esses was paid and this
 *    person has real access right now. Arguably not a problem at all —
 *    price-conscious behaviour, not regret.
 *  - **`cancelled`** — actually paid, then actually lost access. The
 *    smallest of the three groups, and the only one that matches "signed up
 *    and immediately regretted it" in the literal sense.
 *
 * Skio has no equivalent of Stripe's incomplete-payment state in this
 * schema (a Skio subscription only exists once its originating Shopify
 * order has been created, i.e. paid), so Skio rows are only ever
 * `kept_access` or `cancelled`, never `abandoned_checkout`.
 *
 * `@essesmag.com` addresses are excluded — Johnny's own Skio test account
 * (`skiotest4@essesmag.com`) showed up in the very first run and would
 * otherwise pollute every day's numbers.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "./formulas";
import { OPS_DISCOUNT_SQL_REGEX } from "./churn";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}
const num = (v: unknown): number => Number(v ?? 0);

export interface DigestCampaignRow {
  platform: string;
  campaignName: string;
  spendCents: number;
  results: number;
  /** Null when there were 0 results — an infinite CPR is not a number. */
  cprCents: number | null;
}

export interface DigestPlatformRow {
  platform: string;
  spendCents: number;
  results: number;
}

export interface DailyDigest {
  /** The day this reports on — always yesterday relative to when it's sent. */
  date: string;
  adSpend: {
    totalCents: number;
    totalResults: number;
    /** Blended CPR across every platform and campaign. Null with zero results. */
    blendedCprCents: number | null;
    byPlatform: DigestPlatformRow[];
    /** Every campaign with spend that day, highest spend first. */
    byCampaign: DigestCampaignRow[];
  };
  newSubscribers: {
    skio: number;
    stripe: number;
    total: number;
  };
  churn: {
    skio: number;
    stripe: number;
    total: number;
  };
  /** Live subscriber count as of this day (Skio active + Stripe active/trialing) —
   *  context for whether the day's churn/adds moved the needle at all. INCLUDES
   *  Stripe subscribers who set `cancel_at_period_end` (they turned off auto-renew
   *  but are still paid and active right now — the `kept_access` outcome above) —
   *  they have real access today, so excluding them would understate the active
   *  count, not correct it. `pendingCancellation` states how many of this total
   *  are in that state, so the number is auditable rather than a number you have
   *  to trust includes them correctly. Added 28 Sep 2026, Sam's request. */
  activeSubscribers: number;
  /** Of `activeSubscribers`, how many have already requested cancellation (Stripe
   *  `cancel_at_period_end = true`) but haven't lost access yet. Stripe only —
   *  Skio's schema has no equivalent "will not renew but still active" flag (see
   *  `getRapidCancellations`'s cohort CTE, which sets it NULL for Skio rows). */
  pendingCancellation: number;
  /** Of THIS DAY's new signups, whoever has already requested cancellation as
   *  of when the digest runs (the next morning) — see the module docstring,
   *  especially the `outcome` field before treating this as pure churn. */
  rapidCancellations: RapidCancellation[];
  rapidCancelSummary: RapidCancelSummary;
  /** What's already due to renew or lapse over the coming week — see
   *  `getExpiringForecast` below. Forward-looking companion to everything
   *  else in this digest, which only reports what already happened. */
  expiringForecast: ExpiringForecast;
}

/** See the module docstring's "outcome" section — these are NOT interchangeable. */
export type RapidCancelOutcome = "abandoned_checkout" | "kept_access" | "cancelled";

export interface RapidCancellation {
  source: "skio" | "stripe";
  customerName: string | null;
  customerEmail: string;
  planName: string | null;
  promoCode: string | null;
  startedAt: string;
  cancelledAt: string;
  minutesToCancel: number;
  outcome: RapidCancelOutcome;
  /** Total actually paid across every invoice for this subscription, in cents.
   *  0 for `abandoned_checkout` by definition. Always null for Skio — payment
   *  happened on the Shopify order, not tracked per-subscription here. */
  paidCents: number | null;
}

export interface RapidCancelSummary {
  total: number;
  abandonedCheckout: number;
  keptAccess: number;
  cancelled: number;
}

/**
 * Of the subscriptions that STARTED on `date`, whichever have already
 * requested cancellation as of right now — classified by `outcome` (see the
 * module docstring; "cancelled" is only the right word for one of the three).
 */
export async function getRapidCancellations(date: string): Promise<RapidCancellation[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH cohort AS (
      SELECT 'skio' AS source, sm.id::text AS sub_id, sm.customer_id,
             sm.selling_plan_name AS plan_name, sm.started_at, sm.cancelled_at,
             sm.status::text AS status, NULL::boolean AS cancel_at_period_end
        FROM subscription_meta sm
       WHERE sm.started_at::date = ${date}
      UNION ALL
      SELECT 'stripe' AS source, ss.stripe_subscription_id AS sub_id, ss.customer_id,
             ss.plan_nickname, ss.started_at, ss.canceled_at,
             ss.status::text AS status, ss.cancel_at_period_end
        FROM stripe_subscriptions ss
       WHERE ss.started_at::date = ${date}
    ),
    -- Earliest Shopify order linked to each SKIO subscription, for its promo code.
    promo_skio AS (
      SELECT DISTINCT ON (o.subscription_meta_id) o.subscription_meta_id::text AS sub_id,
             (SELECT dc FROM unnest(o.discount_codes) dc
               WHERE dc !~* ${OPS_DISCOUNT_SQL_REGEX} LIMIT 1) AS promo_code
        FROM orders o
       WHERE o.subscription_meta_id IS NOT NULL
       ORDER BY o.subscription_meta_id, o.processed_at ASC
    ),
    -- Earliest Stripe invoice for each Stripe subscription, for its redeemed promo
    -- code — added 22 Sep 2026. Lives on the invoice, not the subscription; see
    -- connectors/stripe/ingest.ts for why.
    promo_stripe AS (
      SELECT DISTINCT ON (si.stripe_subscription_id) si.stripe_subscription_id AS sub_id,
             si.discount_codes[1] AS promo_code
        FROM stripe_invoices si
       WHERE si.stripe_subscription_id IS NOT NULL AND si.discount_codes IS NOT NULL
       ORDER BY si.stripe_subscription_id, si.invoiced_at ASC
    ),
    promo AS (
      SELECT sub_id, promo_code FROM promo_skio
      UNION ALL
      SELECT sub_id, promo_code FROM promo_stripe
    ),
    -- What was actually PAID across every invoice for each Stripe subscription —
    -- the fact that separates "never charged, checkout abandoned" from "charged,
    -- then cancelled". Added 22 Sep 2026 after the first version of this reported
    -- unpaid abandoned checkouts as if they were regretted purchases.
    paid_stripe AS (
      SELECT si.stripe_subscription_id AS sub_id,
             COALESCE(sum(si.amount_paid_amount) FILTER (WHERE si.paid), 0)::bigint AS paid_cents
        FROM stripe_invoices si
       WHERE si.stripe_subscription_id IS NOT NULL
       GROUP BY si.stripe_subscription_id
    )
    SELECT c.source, c.plan_name, c.started_at::text AS started_at, c.cancelled_at::text AS cancelled_at,
           cu.name, cu.email, p.promo_code, c.status, c.cancel_at_period_end,
           ps.paid_cents,
           EXTRACT(EPOCH FROM (c.cancelled_at - c.started_at))::float / 60 AS minutes_to_cancel
      FROM cohort c
      JOIN customers cu ON cu.id = c.customer_id
      LEFT JOIN promo p ON p.sub_id = c.sub_id
      LEFT JOIN paid_stripe ps ON ps.sub_id = c.sub_id AND c.source = 'stripe'
     WHERE c.cancelled_at IS NOT NULL
       AND cu.email NOT ILIKE '%@essesmag.com'
     ORDER BY c.cancelled_at
  `);

  return data.map((r) => {
    const source = r.source as "skio" | "stripe";
    const status = String(r.status ?? "");
    const stillActive = status === "active" || status === "trialing";
    const paidCents = source === "stripe" ? num(r.paid_cents) : null;

    let outcome: RapidCancelOutcome;
    if (source === "stripe" && paidCents === 0) {
      outcome = "abandoned_checkout";
    } else if (stillActive) {
      outcome = "kept_access";
    } else {
      outcome = "cancelled";
    }

    return {
      source,
      customerName: (r.name as string) ?? null,
      customerEmail: String(r.email),
      planName: (r.plan_name as string) ?? null,
      promoCode: (r.promo_code as string) ?? null,
      startedAt: String(r.started_at),
      cancelledAt: String(r.cancelled_at),
      minutesToCancel: Math.max(0, num(r.minutes_to_cancel)),
      outcome,
      paidCents,
    };
  });
}

export function summariseRapidCancellations(rows: RapidCancellation[]): RapidCancelSummary {
  return {
    total: rows.length,
    abandonedCheckout: rows.filter((r) => r.outcome === "abandoned_checkout").length,
    keptAccess: rows.filter((r) => r.outcome === "kept_access").length,
    cancelled: rows.filter((r) => r.outcome === "cancelled").length,
  };
}

export interface ExpiringForecastDay {
  date: string;
  /** Stripe subscriptions whose current_period_end falls this day AND will
   *  actually renew (cancel_at_period_end = false) — business as usual. */
  stripeWillRenew: number;
  /** Stripe subscriptions whose current_period_end falls this day AND will
   *  NOT renew (cancel_at_period_end = true) — this is the forecastable part:
   *  these are already-known losses, not a prediction. */
  stripeWillEnd: number;
  /** MRR represented by stripeWillEnd, in cents — what actually leaves. */
  stripeMrrAtRiskCents: number;
  /** Skio subscriptions with a renewal due this day. Skio carries no
   *  equivalent of cancel_at_period_end in this schema (see the module
   *  docstring), so these can only be reported as "due", not split into
   *  will-renew/will-end — an honest gap, not a guess. */
  skioRenewalsDue: number;
}

export interface ExpiringForecast {
  windowDays: number;
  totalStripeWillEnd: number;
  totalStripeMrrAtRiskCents: number;
  totalSkioRenewalsDue: number;
  byDay: ExpiringForecastDay[];
}

/**
 * Forward-looking companion to the backward-looking sections above — added
 * 30 Sep 2026, Sam's request, prompted by Craft reporting 64 cancellations
 * in a single day that this digest's own (backward-looking) churn count
 * didn't fully explain. The idea: don't just report churn after it happens,
 * show what's ALREADY DUE to happen over the next `windowDays`.
 *
 * `stripeWillEnd` is not a forecast in the statistical sense — Stripe already
 * knows `cancel_at_period_end = true` today, so every subscription counted
 * here has already decided not to renew. It's a known, upcoming loss, stated
 * before it lands rather than reported after.
 */
export async function getExpiringForecast(
  anchorDate: string,
  windowDays = 7,
): Promise<ExpiringForecast> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH days AS (
      SELECT generate_series(${anchorDate}::date, ${anchorDate}::date + (${windowDays} - 1), interval '1 day') AS d
    ),
    stripe_due AS (
      SELECT ss.current_period_end::date AS d, ss.cancel_at_period_end, ss.mrr_amount
        FROM stripe_subscriptions ss
       WHERE ss.status IN ('active','trialing')
         AND ss.current_period_end::date BETWEEN ${anchorDate}::date
                                              AND ${anchorDate}::date + (${windowDays} - 1)
    ),
    skio_due AS (
      SELECT sm.next_billing_at::date AS d
        FROM subscription_meta sm
       WHERE sm.status = 'active'
         AND sm.next_billing_at::date BETWEEN ${anchorDate}::date
                                           AND ${anchorDate}::date + (${windowDays} - 1)
    )
    SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
           COALESCE((SELECT count(*) FROM stripe_due sd WHERE sd.d = days.d AND NOT sd.cancel_at_period_end), 0)::int AS stripe_will_renew,
           COALESCE((SELECT count(*) FROM stripe_due sd WHERE sd.d = days.d AND sd.cancel_at_period_end), 0)::int AS stripe_will_end,
           COALESCE((SELECT sum(sd.mrr_amount) FROM stripe_due sd WHERE sd.d = days.d AND sd.cancel_at_period_end), 0)::bigint AS stripe_mrr_at_risk,
           COALESCE((SELECT count(*) FROM skio_due kd WHERE kd.d = days.d), 0)::int AS skio_renewals_due
      FROM days
     ORDER BY days.d
  `);

  const byDay: ExpiringForecastDay[] = data.map((r) => ({
    date: String(r.date),
    stripeWillRenew: num(r.stripe_will_renew),
    stripeWillEnd: num(r.stripe_will_end),
    stripeMrrAtRiskCents: num(r.stripe_mrr_at_risk),
    skioRenewalsDue: num(r.skio_renewals_due),
  }));

  return {
    windowDays,
    totalStripeWillEnd: byDay.reduce((s, d) => s + d.stripeWillEnd, 0),
    totalStripeMrrAtRiskCents: byDay.reduce((s, d) => s + d.stripeMrrAtRiskCents, 0),
    totalSkioRenewalsDue: byDay.reduce((s, d) => s + d.skioRenewalsDue, 0),
    byDay,
  };
}

/** Everything for one calendar day (UTC, matching the rest of the app's date arithmetic). */
export async function getDailyDigest(date: string): Promise<DailyDigest> {
  const [campaigns, newSubs, churn, active, rapidCancellations, expiringForecast] = await Promise.all([
    rows<Record<string, unknown>>(sql`
      SELECT platform::text AS platform, campaign_name,
             sum(spend_amount)::bigint AS spend,
             sum(platform_conversions)::float AS results
        FROM ad_spend
       WHERE date = ${date} AND campaign_id IS NOT NULL
       GROUP BY platform, campaign_name
       ORDER BY spend DESC
    `),
    // status != 'expired' excludes Stripe's incomplete_expired subscriptions — the
    // first invoice was never paid, so these never became real subscribers. See
    // the module docstring and the identical fix in metrics/churn.ts's SUBS_CTE.
    rows<Record<string, unknown>>(sql`
      SELECT
        (SELECT count(*)::int FROM subscription_meta WHERE started_at::date = ${date}) AS skio,
        (SELECT count(*)::int FROM stripe_subscriptions
          WHERE started_at::date = ${date} AND status != 'expired') AS stripe
    `),
    rows<Record<string, unknown>>(sql`
      SELECT
        (SELECT count(*)::int FROM subscription_meta WHERE cancelled_at::date = ${date}) AS skio,
        (SELECT count(*)::int FROM stripe_subscriptions
          WHERE canceled_at::date = ${date} AND status != 'expired') AS stripe
    `),
    rows<Record<string, unknown>>(sql`
      SELECT
        (SELECT count(*)::int FROM subscription_meta WHERE status = 'active') AS skio,
        (SELECT count(*)::int FROM stripe_subscriptions WHERE status IN ('active','trialing')) AS stripe,
        (SELECT count(*)::int FROM stripe_subscriptions
          WHERE status IN ('active','trialing') AND cancel_at_period_end = true) AS pending_cancellation
    `),
    getRapidCancellations(date),
    // Forecast starts the day AFTER the reported date — `date` is yesterday
    // (already past by the time this sends), so "upcoming" means from today.
    getExpiringForecast(tomorrow(date)),
  ]);

  const byCampaign: DigestCampaignRow[] = campaigns.map((r) => {
    const spendCents = num(r.spend);
    const results = num(r.results);
    return {
      platform: String(r.platform),
      campaignName: String(r.campaign_name ?? "(unnamed)"),
      spendCents,
      results,
      cprCents: ratio(spendCents, results),
    };
  });

  const byPlatformMap = new Map<string, DigestPlatformRow>();
  for (const c of byCampaign) {
    const p = byPlatformMap.get(c.platform) ?? { platform: c.platform, spendCents: 0, results: 0 };
    p.spendCents += c.spendCents;
    p.results += c.results;
    byPlatformMap.set(c.platform, p);
  }

  const totalCents = byCampaign.reduce((s, c) => s + c.spendCents, 0);
  const totalResults = byCampaign.reduce((s, c) => s + c.results, 0);

  const newSkio = num(newSubs[0]?.skio);
  const newStripe = num(newSubs[0]?.stripe);
  const churnSkio = num(churn[0]?.skio);
  const churnStripe = num(churn[0]?.stripe);

  return {
    date,
    adSpend: {
      totalCents,
      totalResults,
      blendedCprCents: ratio(totalCents, totalResults),
      byPlatform: [...byPlatformMap.values()].sort((a, b) => b.spendCents - a.spendCents),
      byCampaign,
    },
    newSubscribers: { skio: newSkio, stripe: newStripe, total: newSkio + newStripe },
    churn: { skio: churnSkio, stripe: churnStripe, total: churnSkio + churnStripe },
    activeSubscribers: num(active[0]?.skio) + num(active[0]?.stripe),
    pendingCancellation: num(active[0]?.pending_cancellation),
    rapidCancellations,
    rapidCancelSummary: summariseRapidCancellations(rapidCancellations),
    expiringForecast,
  };
}

/** Yesterday's date (UTC), the digest's default subject — "today" isn't finished
 *  syncing yet when this runs each morning. */
export function yesterday(anchor: Date = new Date()): string {
  const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The day after a `YYYY-MM-DD` date string, same UTC arithmetic as `yesterday`. */
function tomorrow(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
