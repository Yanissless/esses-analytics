/**
 * Channel performance under a chosen attribution model (Section 8.3 — "let the
 * user toggle between them on the dashboard").
 *
 * Revenue is apportioned across each order's touchpoint path, so the same orders
 * produce different channel splits depending on the model. That difference is the
 * point: if last-click and time-decay disagree sharply about a channel, the channel's
 * real contribution is uncertain and shouldn't be scaled on last-click alone.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { attribute, creditByChannel, type AttributionModel, type Touchpoint } from "./models";

/**
 * `internal` touchpoints (our own site/checkout handing off) carry no acquisition
 * signal, so they are stripped before credit is distributed. An order whose ONLY
 * touchpoints are internal is genuinely UNATTRIBUTED — crediting it to "internal"
 * would put a $33K pseudo-channel at the top of the table and imply we know where
 * that revenue came from when we don't.
 */
function acquisitionPath(path: Touchpoint[]): Touchpoint[] {
  return path.filter((t) => t.channel !== "internal");
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

export interface ChannelPerformance {
  channel: string;
  attributedRevenueCents: number;
  attributedConversions: number;
  /** Ad spend recorded for this channel in the window (paid channels only). */
  spendCents: number;
  /** Attributed revenue ÷ spend. Null when there's no spend. */
  roas: number | null;
  /** Spend ÷ attributed conversions. Null when either is zero. */
  cac: number | null;
  /** Of the above, revenue credited via the customer's acquisition channel
   *  rather than the order's own session (see `inheritFromCustomer`). */
  inheritedRevenueCents: number;
}

/**
 * Whether to credit revenue that has no session of its own to the CUSTOMER'S
 * acquisition channel (Section 8.5).
 *
 * This is the legitimate way to attribute historical revenue that native Shopify
 * leaves blank. Subscription renewals, Stripe invoices and many repeat orders are
 * created by API — no human browsed, so there is no journey and never will be.
 * Ignoring them makes acquisition channels look far weaker than they are, because
 * a channel that brings in a subscriber gets credit for one $30 first order and
 * none of the renewals it caused.
 *
 * It is inference, not measurement — so it's a toggle, it's reported separately in
 * `inheritedRevenueCents`, and it only ever uses a signal we actually observed
 * (that customer's own acquisition touchpoints). It does NOT invent a channel for
 * a customer we never had a journey for.
 */
export type AttributionBasis = "session-only" | "inherit-from-customer";

/**
 * Compute channel performance for a window under one model.
 *
 * Only orders that HAVE touchpoints participate — orders with no journey data are
 * excluded rather than dumped into "direct", which would silently inflate direct
 * and make attribution coverage look complete when it isn't. Use
 * `getAttributionCoverage` to see how much of revenue is actually attributable.
 */
export async function getChannelPerformance(
  since: string,
  until: string,
  model: AttributionModel = "last-non-direct",
  halfLifeDays = 7,
  basis: AttributionBasis = "session-only",
): Promise<ChannelPerformance[]> {
  // LEFT JOIN so orders with no journey are still returned — they're the ones the
  // inherited basis can rescue via the customer's acquisition channel.
  const orderRows = await rows<{
    order_id: string;
    revenue: number;
    converted_at: string;
    acquisition_channel: string | null;
    acquisition_campaign: string | null;
    touchpoints: Array<{ id: string; channel: string; occurred_at: string; campaign: string | null }> | null;
  }>(sql`
    SELECT o.id AS order_id,
           (o.total_amount - o.total_refunded_amount) AS revenue,
           o.processed_at AS converted_at,
           c.acquisition_channel,
           c.acquisition_campaign,
           CASE WHEN count(t.id) = 0 THEN NULL ELSE
             json_agg(json_build_object(
               'id', t.id, 'channel', t.channel,
               'occurred_at', t.occurred_at, 'campaign', t.campaign
             ) ORDER BY t.occurred_at)
           END AS touchpoints
      FROM orders o
      LEFT JOIN attribution_touchpoints t ON t.order_id = o.id
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
       AND o.processed_at::date >= ${since} AND o.processed_at::date <= ${until}
     GROUP BY o.id, c.acquisition_channel, c.acquisition_campaign
  `);

  const totals = new Map<string, { revenue: number; conversions: number; inherited: number }>();

  for (const o of orderRows) {
    const raw: Touchpoint[] = (o.touchpoints ?? []).map((t) => ({
      id: t.id,
      channel: t.channel,
      occurredAt: new Date(t.occurred_at).getTime(),
      campaign: t.campaign,
    }));
    const path = acquisitionPath(raw);
    const revenue = Number(o.revenue ?? 0);

    if (!path.length) {
      // No session of its own (or internal-only). Under the inherited basis, credit
      // the customer's known acquisition channel; otherwise leave unattributed.
      // Never inherit 'internal' — a self-referral is not an acquisition channel.
      if (
        basis === "inherit-from-customer" &&
        o.acquisition_channel &&
        o.acquisition_channel !== "internal"
      ) {
        const ch = o.acquisition_channel;
        const cur = totals.get(ch) ?? { revenue: 0, conversions: 0, inherited: 0 };
        cur.revenue += revenue;
        cur.conversions += 1;
        cur.inherited += revenue;
        totals.set(ch, cur);
      }
      continue;
    }

    const credited = attribute(path, model, {
      conversionAt: new Date(o.converted_at).getTime(),
      halfLifeDays,
    });
    for (const c of creditByChannel(credited, revenue)) {
      const cur = totals.get(c.channel) ?? { revenue: 0, conversions: 0, inherited: 0 };
      cur.revenue += c.revenueCents;
      cur.conversions += c.conversions;
      totals.set(c.channel, cur);
    }
  }

  // Ad spend per channel. ad_spend is keyed by platform, which maps onto our
  // paid-* channel names.
  const spendRows = await rows<{ channel: string; spend: number }>(sql`
    SELECT 'paid-' || platform::text AS channel, sum(spend_amount) AS spend
      FROM ad_spend
     WHERE date >= ${since} AND date <= ${until}
     GROUP BY 1
  `);
  const spendByChannel = new Map(spendRows.map((r) => [r.channel, Number(r.spend ?? 0)]));

  const channels = new Set([...totals.keys(), ...spendByChannel.keys()]);
  const out: ChannelPerformance[] = [];

  for (const channel of channels) {
    const t = totals.get(channel) ?? { revenue: 0, conversions: 0, inherited: 0 };
    const spend = spendByChannel.get(channel) ?? 0;
    out.push({
      channel,
      attributedRevenueCents: t.revenue,
      attributedConversions: Math.round(t.conversions * 100) / 100,
      spendCents: spend,
      roas: spend > 0 ? t.revenue / spend : null,
      cac: spend > 0 && t.conversions > 0 ? spend / t.conversions : null,
      inheritedRevenueCents: t.inherited,
    });
  }

  return out.sort((a, b) => b.attributedRevenueCents - a.attributedRevenueCents);
}

export interface AttributionCoverage {
  ordersTotal: number;
  ordersWithTouchpoints: number;
  revenueTotalCents: number;
  revenueAttributableCents: number;
  coveragePct: number;
  avgPathLength: number;
  /**
   * Orders that could NEVER have a journey because no human browsed — API-created
   * subscription renewals and comps. Counting them as "missing attribution" makes
   * coverage look broken when the data was never capturable.
   */
  ordersNoSessionPossible: number;
  revenueNoSessionPossibleCents: number;
  /** Coverage over orders that COULD have had a session — the fair denominator. */
  coverageOfAddressablePct: number;
  /** Revenue recoverable by inheriting the customer's acquisition channel. */
  revenueInheritableCents: number;
}

/**
 * How much of revenue attribution can actually speak to. Reported alongside every
 * channel table so a confident-looking split is never mistaken for full coverage.
 */
export async function getAttributionCoverage(
  since: string,
  until: string,
): Promise<AttributionCoverage> {
  const [r] = await rows<Record<string, unknown>>(sql`
    WITH ord AS (
      SELECT o.id,
             (o.total_amount - o.total_refunded_amount) AS revenue,
             -- A renewal or comp created via API never had a browsing session.
             (o.order_type = 'subscription_shopify' AND o.acquisition_order = false)
               OR o.total_amount = 0 AS no_session_possible,
             c.acquisition_channel
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
         AND o.processed_at::date >= ${since} AND o.processed_at::date <= ${until}
    ),
    -- Only non-internal touchpoints count as an acquisition signal, so an order
    -- whose journey is purely self-referral shows as NOT attributable.
    tp AS (
      SELECT order_id, count(*) AS n FROM attribution_touchpoints
       WHERE order_id IS NOT NULL AND channel <> 'internal'
       GROUP BY order_id
    )
    SELECT count(*) AS orders_total,
           count(tp.order_id) AS orders_with_tp,
           COALESCE(sum(ord.revenue), 0) AS revenue_total,
           COALESCE(sum(ord.revenue) FILTER (WHERE tp.order_id IS NOT NULL), 0) AS revenue_attributable,
           COALESCE(avg(tp.n), 0) AS avg_path,
           count(*) FILTER (WHERE ord.no_session_possible) AS orders_no_session,
           COALESCE(sum(ord.revenue) FILTER (WHERE ord.no_session_possible), 0) AS revenue_no_session,
           COALESCE(sum(ord.revenue) FILTER (
             WHERE tp.order_id IS NULL AND ord.acquisition_channel IS NOT NULL
           ), 0) AS revenue_inheritable,
           COALESCE(sum(ord.revenue) FILTER (WHERE NOT ord.no_session_possible), 0) AS revenue_addressable,
           COALESCE(sum(ord.revenue) FILTER (
             WHERE NOT ord.no_session_possible AND tp.order_id IS NOT NULL
           ), 0) AS revenue_addressable_covered
      FROM ord LEFT JOIN tp ON tp.order_id = ord.id
  `);

  const total = Number(r.revenue_total ?? 0);
  const attributable = Number(r.revenue_attributable ?? 0);
  const addressable = Number(r.revenue_addressable ?? 0);
  const addressableCovered = Number(r.revenue_addressable_covered ?? 0);

  return {
    ordersTotal: Number(r.orders_total ?? 0),
    ordersWithTouchpoints: Number(r.orders_with_tp ?? 0),
    revenueTotalCents: total,
    revenueAttributableCents: attributable,
    coveragePct: total > 0 ? attributable / total : 0,
    avgPathLength: Math.round(Number(r.avg_path ?? 0) * 100) / 100,
    ordersNoSessionPossible: Number(r.orders_no_session ?? 0),
    revenueNoSessionPossibleCents: Number(r.revenue_no_session ?? 0),
    coverageOfAddressablePct: addressable > 0 ? addressableCovered / addressable : 0,
    revenueInheritableCents: Number(r.revenue_inheritable ?? 0),
  };
}
