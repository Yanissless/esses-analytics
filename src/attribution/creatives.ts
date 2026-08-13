/**
 * Campaign and creative performance: what we spent, and what we can prove it earned.
 *
 * ## Why this is possible at all
 *
 * The rest of the app treats paid-meta attribution as nearly blind, because most Meta clicks
 * arrive untagged and land in organic-social. But the clicks that ARE tagged carry something
 * better than a campaign name: Meta's own numeric IDs. `utm_campaign` holds the campaign ID
 * and `utm_content` holds the ad ID, which join straight onto `ad_spend.campaign_id` and
 * `ad_spend.ad_id`. So for the tagged subset we can put spend and provable revenue against
 * the same creative — the question "which creative is working" — without any name matching.
 *
 * As of 12 Aug 2026 that subset is 8 of 22 campaigns and 44 of 679 creatives. Small, and
 * every figure here therefore describes tagged traffic only. `getCreativeCoverage` exists so
 * the page can lead with that rather than implying it ranks the whole account.
 *
 * ## The double-count this avoids
 *
 * An order can carry several paid-meta touchpoints on different creatives. Summing its
 * revenue under each one inflates the total and makes the column sum exceed real revenue —
 * the same family of error as the `sum(DISTINCT revenue)` bug in `HANDOFF.md`. So revenue is
 * assigned to exactly one creative per order: the LAST tagged paid-meta touch before the
 * order. That is last-touch at creative level, chosen because it is the model an ad buyer
 * reads a creative table with, and because splitting fractional revenue across creatives
 * makes a per-creative ROAS that cannot be checked against anything.
 *
 * Meta's own claimed conversions sit in their own columns, never blended with ours. The
 * gap between the two is the interesting part of the table, so merging them would destroy
 * the only honest reading of it.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "../metrics/formulas";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

export interface DiscountUse {
  code: string;
  orders: number;
  discountCents: number;
}

export interface CreativeRow {
  adId: string | null;
  adName: string | null;
  adsetName: string | null;
  spendCents: number;
  impressions: number;
  clicks: number;
  /** Meta's own claim. Never blended with ours. */
  metaConversions: number;
  metaValueCents: number;
  /** What we can actually prove, from tagged converting touchpoints. */
  ourOrders: number;
  ourRevenueCents: number;
  /** Attributed orders that collected $0 — a free offer redeemed, not a failed sale. */
  ourFreeOrders: number;
  /**
   * Share of attributed orders that collected nothing. Null when there are no orders.
   *
   * This is the field that stops the table lying. "Free Quarterly Campaign" spent $5,076,
   * drove 46 orders, and collected $0, because the offer attached to it gives the issue away
   * — so its ROAS is 0.00 and it looks like the worst creative in the account. It isn't; it
   * is an acquisition campaign whose payoff is subscription LTV in later periods. Above a
   * high threshold here, ROAS is the wrong measure and the UI says so instead of ranking on it.
   */
  ourFreeOrderShare: number | null;
  ourRoas: number | null;
  metaRoas: number | null;
  ctr: number | null;
  /** True when at least one tagged touchpoint pointed at this ad. */
  tagged: boolean;
  discounts: DiscountUse[];
}

export interface CampaignRow extends Omit<CreativeRow, "adId" | "adName" | "adsetName"> {
  campaignId: string | null;
  campaignName: string | null;
  creatives: CreativeRow[];
}

/**
 * Above this share of $0 attributed orders, ROAS is the wrong lens and the UI says so.
 *
 * 0.8 rather than 1.0 because a free-offer campaign picks up the occasional full-price order
 * and that shouldn't flip it back to being judged on revenue.
 */
export const FREE_OFFER_THRESHOLD = 0.8;

/** Is this line an acquisition play rather than a revenue play? */
export function isAcquisitionPlay(row: { ourOrders: number; ourFreeOrderShare: number | null }): boolean {
  return row.ourOrders > 0 && (row.ourFreeOrderShare ?? 0) >= FREE_OFFER_THRESHOLD;
}

export interface CreativeCoverage {
  campaignsTotal: number;
  campaignsTagged: number;
  creativesTotal: number;
  creativesTagged: number;
  spendTotalCents: number;
  /** Spend on campaigns that have at least one tagged touchpoint. */
  spendTaggedCents: number;
  /** UTM ad IDs with no matching row in ad_spend for this window. Reported, not dropped. */
  unmatchedAdIds: string[];
}

/**
 * Spend and provable revenue per campaign, with creatives nested underneath.
 *
 * Ordered by spend: the question is where the money went, so the biggest line comes first
 * whether or not it worked.
 */
export async function getCampaignPerformance(
  since: string,
  until: string,
): Promise<CampaignRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH spend AS (
      SELECT campaign_id, campaign_name, adset_name, ad_id, ad_name,
             COALESCE(sum(spend_amount), 0)                    AS spend,
             COALESCE(sum(impressions), 0)                     AS impressions,
             COALESCE(sum(clicks), 0)                          AS clicks,
             COALESCE(sum(platform_conversions), 0)            AS meta_conv,
             COALESCE(sum(platform_conversion_value_amount), 0) AS meta_value
        FROM ad_spend
       WHERE platform = 'meta' AND date >= ${since} AND date <= ${until}
       GROUP BY campaign_id, campaign_name, adset_name, ad_id, ad_name
    ),
    -- One row per ORDER: its last tagged paid-meta touch. Without this an order with two
    -- touchpoints would have its revenue counted under both creatives.
    last_touch AS (
      SELECT DISTINCT ON (o.id)
             o.id                                            AS order_id,
             t.campaign                                      AS campaign_id,
             t.content                                       AS ad_id,
             (o.total_amount - o.total_refunded_amount)       AS revenue,
             o.total_discounts_amount                        AS discount,
             o.discount_codes                                AS codes
        FROM attribution_touchpoints t
        JOIN orders o ON o.id = t.order_id
       WHERE t.channel = 'paid-meta'
         AND t.content IS NOT NULL
         AND o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
         AND o.processed_at::date >= ${since} AND o.processed_at::date <= ${until}
       ORDER BY o.id, t.occurred_at DESC
    ),
    attributed AS (
      SELECT campaign_id, ad_id,
             count(*)::int                                  AS our_orders,
             count(*) FILTER (WHERE revenue = 0)::int        AS our_free_orders,
             COALESCE(sum(revenue), 0)                       AS our_revenue
        FROM last_touch
       GROUP BY campaign_id, ad_id
    ),
    -- Discount codes on those same orders, unnested from the array column.
    codes AS (
      SELECT lt.campaign_id, lt.ad_id, code,
             count(*)::int                       AS orders,
             COALESCE(sum(lt.discount), 0)       AS discount
        FROM last_touch lt, unnest(
               CASE WHEN cardinality(lt.codes) = 0 THEN ARRAY[NULL]::text[] ELSE lt.codes END
             ) AS code
       GROUP BY lt.campaign_id, lt.ad_id, code
    )
    SELECT s.campaign_id, s.campaign_name, s.adset_name, s.ad_id, s.ad_name,
           s.spend, s.impressions, s.clicks, s.meta_conv, s.meta_value,
           COALESCE(a.our_orders, 0)      AS our_orders,
           COALESCE(a.our_free_orders, 0) AS our_free_orders,
           COALESCE(a.our_revenue, 0)     AS our_revenue,
           (
             SELECT json_agg(json_build_object('code', c.code, 'orders', c.orders, 'discount', c.discount)
                             ORDER BY c.orders DESC)
               FROM codes c
              WHERE c.campaign_id = s.campaign_id AND c.ad_id = s.ad_id AND c.code IS NOT NULL
           ) AS discounts
      FROM spend s
      LEFT JOIN attributed a ON a.campaign_id = s.campaign_id AND a.ad_id = s.ad_id
     ORDER BY s.spend DESC
  `);

  // Group creatives under their campaign in JS: the aggregate has to be the SUM of the
  // creative rows shown, or a reader who adds the column up gets a different number.
  const byCampaign = new Map<string, CampaignRow>();

  for (const r of data) {
    const campaignId = (r.campaign_id as string) ?? null;
    const key = campaignId ?? "(none)";
    const creative: CreativeRow = {
      adId: (r.ad_id as string) ?? null,
      adName: (r.ad_name as string) ?? null,
      adsetName: (r.adset_name as string) ?? null,
      spendCents: Number(r.spend ?? 0),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      metaConversions: Number(r.meta_conv ?? 0),
      metaValueCents: Number(r.meta_value ?? 0),
      ourOrders: Number(r.our_orders ?? 0),
      ourRevenueCents: Number(r.our_revenue ?? 0),
      ourFreeOrders: Number(r.our_free_orders ?? 0),
      ourFreeOrderShare: ratio(Number(r.our_free_orders ?? 0), Number(r.our_orders ?? 0)),
      ourRoas: ratio(Number(r.our_revenue ?? 0), Number(r.spend ?? 0)),
      metaRoas: ratio(Number(r.meta_value ?? 0), Number(r.spend ?? 0)),
      ctr: ratio(Number(r.clicks ?? 0), Number(r.impressions ?? 0)),
      tagged: Number(r.our_orders ?? 0) > 0,
      discounts: ((r.discounts as Array<{ code: string; orders: number; discount: number }> | null) ?? []).map(
        (d) => ({ code: d.code, orders: Number(d.orders), discountCents: Number(d.discount) }),
      ),
    };

    const existing = byCampaign.get(key);
    if (existing) {
      existing.creatives.push(creative);
    } else {
      byCampaign.set(key, {
        campaignId,
        campaignName: (r.campaign_name as string) ?? null,
        creatives: [creative],
        spendCents: 0,
        impressions: 0,
        clicks: 0,
        metaConversions: 0,
        metaValueCents: 0,
        ourOrders: 0,
        ourRevenueCents: 0,
        ourFreeOrders: 0,
        ourFreeOrderShare: null,
        ourRoas: null,
        metaRoas: null,
        ctr: null,
        tagged: false,
        discounts: [],
      });
    }
  }

  const out = [...byCampaign.values()].map((c) => {
    const sum = (pick: (x: CreativeRow) => number) => c.creatives.reduce((a, x) => a + pick(x), 0);
    c.spendCents = sum((x) => x.spendCents);
    c.impressions = sum((x) => x.impressions);
    c.clicks = sum((x) => x.clicks);
    c.metaConversions = sum((x) => x.metaConversions);
    c.metaValueCents = sum((x) => x.metaValueCents);
    c.ourOrders = sum((x) => x.ourOrders);
    c.ourRevenueCents = sum((x) => x.ourRevenueCents);
    c.ourFreeOrders = sum((x) => x.ourFreeOrders);
    c.ourFreeOrderShare = ratio(c.ourFreeOrders, c.ourOrders);
    c.ourRoas = ratio(c.ourRevenueCents, c.spendCents);
    c.metaRoas = ratio(c.metaValueCents, c.spendCents);
    c.ctr = ratio(c.clicks, c.impressions);
    c.tagged = c.creatives.some((x) => x.tagged);
    // Roll the codes up so a campaign shows every offer that appeared beneath it.
    const merged = new Map<string, DiscountUse>();
    for (const x of c.creatives) {
      for (const d of x.discounts) {
        const cur = merged.get(d.code);
        if (cur) {
          cur.orders += d.orders;
          cur.discountCents += d.discountCents;
        } else merged.set(d.code, { ...d });
      }
    }
    c.discounts = [...merged.values()].sort((a, b) => b.orders - a.orders);
    c.creatives.sort((a, b) => b.spendCents - a.spendCents);
    return c;
  });

  return out.sort((a, b) => b.spendCents - a.spendCents);
}

/**
 * How much of the account this view can actually speak to.
 *
 * Leads the page. A creative table that silently covers 6% of creatives, presented as a
 * ranking, is exactly the confident-and-wrong artefact this codebase is built against.
 */
export async function getCreativeCoverage(
  since: string,
  until: string,
): Promise<CreativeCoverage> {
  const [totals] = await rows<Record<string, unknown>>(sql`
    SELECT count(DISTINCT campaign_id)::int AS campaigns,
           count(DISTINCT ad_id)::int       AS creatives,
           COALESCE(sum(spend_amount), 0)   AS spend
      FROM ad_spend
     WHERE platform = 'meta' AND date >= ${since} AND date <= ${until}
  `);

  const [tagged] = await rows<Record<string, unknown>>(sql`
    WITH tags AS (
      SELECT DISTINCT t.campaign AS campaign_id, t.content AS ad_id
        FROM attribution_touchpoints t
        JOIN orders o ON o.id = t.order_id
       WHERE t.channel = 'paid-meta' AND t.content IS NOT NULL
         AND o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
         AND o.processed_at::date >= ${since} AND o.processed_at::date <= ${until}
    )
    SELECT count(DISTINCT tags.campaign_id)::int AS campaigns,
           count(DISTINCT tags.ad_id)::int       AS creatives,
           COALESCE((
             SELECT sum(s.spend_amount) FROM ad_spend s
              WHERE s.platform = 'meta' AND s.date >= ${since} AND s.date <= ${until}
                AND s.campaign_id IN (SELECT campaign_id FROM tags)
           ), 0) AS spend_tagged,
           COALESCE((
             SELECT array_agg(DISTINCT tags.ad_id)
               FROM tags
              WHERE NOT EXISTS (
                SELECT 1 FROM ad_spend s
                 WHERE s.platform = 'meta' AND s.ad_id = tags.ad_id
                   AND s.date >= ${since} AND s.date <= ${until}
              )
           ), ARRAY[]::text[]) AS unmatched
      FROM tags
  `);

  return {
    campaignsTotal: Number(totals?.campaigns ?? 0),
    campaignsTagged: Number(tagged?.campaigns ?? 0),
    creativesTotal: Number(totals?.creatives ?? 0),
    creativesTagged: Number(tagged?.creatives ?? 0),
    spendTotalCents: Number(totals?.spend ?? 0),
    spendTaggedCents: Number(tagged?.spend_tagged ?? 0),
    unmatchedAdIds: ((tagged?.unmatched as string[] | null) ?? []).filter(Boolean),
  };
}
