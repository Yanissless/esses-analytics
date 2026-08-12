/**
 * Journey structure: how many touches an order actually has, and how long it took.
 *
 * ## Why this is a coverage page rather than a path explorer
 *
 * The obvious "customer journey attribution" feature is a path explorer — top converting
 * sequences, channel transitions, assist-versus-close. This data will not support one, and
 * the numbers say so plainly: of countable orders, **71% have no non-internal touchpoint at
 * all**, 23% have exactly one, and only about 5.6% have a multi-touch journey. A path
 * explorer built on that would render a few hundred orders in an interface implying it
 * described the business.
 *
 * The 71% is not a tracking bug and no amount of tagging fixes it: subscription renewals
 * and comps are created through the API, so no human ever browsed. `getAttributionCoverage`
 * already separates those out and calls the remainder the addressable denominator — the
 * fair number. What was missing, and what this module adds, is the shape *within* the
 * orders that do have a journey:
 *
 *  - the distribution of touch counts, so "average path length 1.37" stops hiding the fact
 *    that the mode is 1;
 *  - time from first touch to order, which is the one journey question the single-touch
 *    majority can still answer.
 *
 * The decision this supports is whether attribution deserves further investment. If
 * essentially every addressable order is a single session, all four attribution models
 * agree by construction and arguing about which to use is wasted effort — the lever is
 * capturing more journeys (UTM tagging, cross-session identity), not modelling the ones
 * you have more cleverly.
 *
 * SQL filters here mirror `report.ts` exactly — `test = false`, not cancelled,
 * `counts_as_revenue`, and `channel <> 'internal'`. Two surfaces disagreeing about how
 * many orders exist is a bug in itself.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

// ---------------------------------------------------------------------------
// Pure bucketing (unit-tested)
// ---------------------------------------------------------------------------

export type TouchBucket = "0" | "1" | "2-3" | "4+";

/** Ordered for display; `0` first because it is the largest and the point of the page. */
export const TOUCH_BUCKETS: TouchBucket[] = ["0", "1", "2-3", "4+"];

export function bucketTouches(n: number): TouchBucket {
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 3) return "2-3";
  return "4+";
}

export type LatencyBucket = "same day" | "1-3 days" | "4-7 days" | "8-30 days" | "30+ days";

export const LATENCY_BUCKETS: LatencyBucket[] = [
  "same day",
  "1-3 days",
  "4-7 days",
  "8-30 days",
  "30+ days",
];

/**
 * Buckets first-touch-to-order latency.
 *
 * Negative input is clamped to "same day" rather than thrown: a touchpoint timestamped
 * marginally after its order is a clock-skew artefact between our session capture and
 * Shopify's `processed_at`, not a journey that ran backwards, and dropping those rows
 * would quietly bias the distribution toward longer journeys.
 */
export function bucketLatencyHours(hours: number): LatencyBucket {
  if (hours < 24) return "same day";
  const days = hours / 24;
  if (days <= 3) return "1-3 days";
  if (days <= 7) return "4-7 days";
  if (days <= 30) return "8-30 days";
  return "30+ days";
}

// ---------------------------------------------------------------------------
// Distribution of touch counts
// ---------------------------------------------------------------------------

export interface TouchDistributionRow {
  bucket: TouchBucket;
  orders: number;
  revenueCents: number;
  /** Share of all countable orders in the window. */
  shareOfOrders: number;
  /**
   * Of the orders in this bucket, how many could never have had a session anyway
   * (API renewal or comp). Populated for the `0` bucket, where it is the explanation.
   */
  noSessionPossible: number;
}

export async function getTouchDistribution(
  since: string,
  until: string,
): Promise<TouchDistributionRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH ord AS (
      SELECT o.id,
             (o.total_amount - o.total_refunded_amount) AS revenue,
             (o.order_type = 'subscription_shopify' AND o.acquisition_order = false)
               OR o.total_amount = 0 AS no_session_possible
        FROM orders o
       WHERE o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
         AND o.processed_at::date >= ${since} AND o.processed_at::date <= ${until}
    ),
    tp AS (
      SELECT order_id, count(*)::int AS n
        FROM attribution_touchpoints
       WHERE order_id IS NOT NULL AND channel <> 'internal'
       GROUP BY order_id
    ),
    j AS (
      SELECT ord.id,
             ord.revenue,
             ord.no_session_possible,
             COALESCE(tp.n, 0) AS touches
        FROM ord LEFT JOIN tp ON tp.order_id = ord.id
    )
    SELECT CASE
             WHEN touches = 0 THEN '0'
             WHEN touches = 1 THEN '1'
             WHEN touches <= 3 THEN '2-3'
             ELSE '4+'
           END                                                      AS bucket,
           count(*)::int                                            AS orders,
           COALESCE(sum(revenue), 0)                                AS revenue,
           count(*) FILTER (WHERE no_session_possible)::int          AS no_session
      FROM j
     GROUP BY 1
  `);

  const total = data.reduce((a, r) => a + Number(r.orders ?? 0), 0);
  const byBucket = new Map(data.map((r) => [String(r.bucket), r]));

  // Emit every bucket in display order, including empty ones — a missing row reads as
  // "no data" where zero orders is the actual, meaningful answer.
  return TOUCH_BUCKETS.map((bucket) => {
    const r = byBucket.get(bucket);
    const orders = Number(r?.orders ?? 0);
    return {
      bucket,
      orders,
      revenueCents: Number(r?.revenue ?? 0),
      shareOfOrders: total > 0 ? orders / total : 0,
      noSessionPossible: Number(r?.no_session ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Time from first touch to order
// ---------------------------------------------------------------------------

export interface LatencyRow {
  bucket: LatencyBucket;
  orders: number;
  shareOfJourneys: number;
}

export interface TimeToConversion {
  buckets: LatencyRow[];
  /** Orders with at least one non-internal touchpoint — the denominator here. */
  journeys: number;
  /** Median hours first touch → order. Null when there are no journeys. */
  medianHours: number | null;
  /** 90th percentile, so a long tail is visible without a chart. */
  p90Hours: number | null;
}

export async function getTimeToConversion(
  since: string,
  until: string,
): Promise<TimeToConversion> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH ord AS (
      SELECT o.id, o.processed_at
        FROM orders o
       WHERE o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
         AND o.processed_at::date >= ${since} AND o.processed_at::date <= ${until}
    ),
    first_touch AS (
      SELECT t.order_id, min(t.occurred_at) AS first_at
        FROM attribution_touchpoints t
       WHERE t.order_id IS NOT NULL AND t.channel <> 'internal'
       GROUP BY t.order_id
    )
    SELECT
      -- Clamp negatives: a touch stamped just after its order is clock skew between our
      -- session capture and Shopify's processed_at, not a backwards journey.
      GREATEST(EXTRACT(EPOCH FROM (ord.processed_at - ft.first_at)) / 3600.0, 0) AS hours
      FROM ord JOIN first_touch ft ON ft.order_id = ord.id
  `);

  const hours = data
    .map((r) => Number(r.hours ?? 0))
    .filter((h) => Number.isFinite(h))
    .sort((a, b) => a - b);

  const counts = new Map<LatencyBucket, number>(LATENCY_BUCKETS.map((b) => [b, 0]));
  for (const h of hours) counts.set(bucketLatencyHours(h), (counts.get(bucketLatencyHours(h)) ?? 0) + 1);

  const pick = (q: number) => (hours.length === 0 ? null : hours[Math.min(hours.length - 1, Math.floor(q * hours.length))]);

  return {
    journeys: hours.length,
    medianHours: pick(0.5),
    p90Hours: pick(0.9),
    buckets: LATENCY_BUCKETS.map((bucket) => ({
      bucket,
      orders: counts.get(bucket) ?? 0,
      shareOfJourneys: hours.length > 0 ? (counts.get(bucket) ?? 0) / hours.length : 0,
    })),
  };
}
