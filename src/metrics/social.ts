/**
 * Social performance, tied to commerce outcomes.
 *
 * This is deliberately NOT a replica of Later/Sprout/Hootsuite. Those report
 * platform-side engagement — followers, reach, saves, engagement rate per post —
 * which lives in the Instagram Graph / TikTok APIs and needs its own connector and
 * credentials (see `SOCIAL_PLATFORM_METRICS_GAP` below). None of it is in this
 * database, and a dashboard showing zeroes for it would be worse than not showing it.
 *
 * What this module does instead is the half those tools can't do: follow a social
 * visit through to revenue, LTV and retention, and put paid and organic social side
 * by side on the same commerce outcome. Every number here is derived from data we
 * actually hold.
 *
 * ⚠️ Read `docs` on coverage before quoting anything: attribution reaches ~41% of
 * revenue, so social-driven revenue here is a FLOOR, not a total.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "./formulas";

async function rows<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

const num = (v: unknown): number => Number(v ?? 0);

/**
 * What a social dashboard CANNOT show from this database, and why — surfaced in the
 * UI so the gap is explicit rather than looking like a bug or an empty chart.
 *
 * ## Closed on 13 Aug 2026 for Instagram, at the ACCOUNT level
 *
 * The four scopes were granted and `connectors/instagram` now stores follower counts
 * (`social_audience`) and daily reach / views / profile views / engagement
 * (`social_insights_daily`). Those two lines came off this list.
 *
 * What is still missing is **per-post and per-story** granularity, and the distinction is
 * not pedantic: account-level reach tells you the audience is there, but not which post
 * earned it. "Reach per post" needs a media-by-media crawl (`/{ig-id}/media` then insights
 * per item), which is a different shape of connector — paginated over content rather than
 * over dates — and a different cost, since it grows with how much you publish.
 *
 * Other platforms remain entirely absent; TikTok and YouTube each need their own connector.
 */
export const SOCIAL_PLATFORM_METRICS_GAP = [
  "Per-post and per-story performance",
  "Engagement and reach for platforms other than Instagram",
] as const;

/**
 * What the Instagram connector now covers, so the page can state it rather than only
 * listing absences. Kept next to the gap list because the two must stay consistent —
 * a metric appearing in both is the bug this pairing makes obvious.
 */
export const SOCIAL_PLATFORM_METRICS_HAVE = [
  "Follower count and growth (Instagram)",
  "Daily reach, views and profile views (Instagram)",
  "Accounts engaged and total interactions (Instagram)",
] as const;

// ---------------------------------------------------------------------------
// Platform identification (pure, unit-tested)
// ---------------------------------------------------------------------------

export type SocialPlatform =
  | "instagram"
  | "facebook"
  | "threads"
  | "tiktok"
  | "pinterest"
  | "reddit"
  | "x"
  | "youtube"
  | "linkedin"
  | "other-social";

/**
 * Which platform a social touchpoint came from.
 *
 * Uses the referrer host first and Shopify's own `source` second. This works TODAY
 * without any UTM tagging, which matters because 178 of our paid touchpoints have no
 * referrer at all — Meta's in-app browser often sends none.
 *
 * Host matching is on suffix boundaries so `l.instagram.com` (222 touchpoints, the
 * link-shim Instagram uses) and `m.facebook.com` land on the right platform rather
 * than falling through to "other".
 */
export function normalizeSocialPlatform(
  referrer: string | null | undefined,
  source: string | null | undefined,
): SocialPlatform | null {
  const hay = `${referrer ?? ""} ${source ?? ""}`.toLowerCase();
  if (!hay.trim()) return null;

  // Order matters: threads.com must beat a bare "thread" substring, and
  // l.instagram.com must not be read as a generic link shim.
  if (/(^|[./\s])threads\.(com|net)|threads/.test(hay)) return "threads";
  if (/instagram/.test(hay)) return "instagram";
  if (/(^|[./\s])(fb|facebook)\.(com|me)|facebook/.test(hay)) return "facebook";
  if (/tiktok/.test(hay)) return "tiktok";
  if (/pinterest|(^|[./\s])pin\.it/.test(hay)) return "pinterest";
  if (/reddit/.test(hay)) return "reddit";
  if (/(^|[./\s])(x\.com|t\.co)|twitter/.test(hay)) return "x";
  if (/youtube|(^|[./\s])youtu\.be/.test(hay)) return "youtube";
  if (/linkedin|(^|[./\s])lnkd\.in/.test(hay)) return "linkedin";
  return null;
}

/** Channels that represent social traffic, paid or organic. */
export const SOCIAL_CHANNELS = [
  "paid-meta",
  "paid-tiktok",
  "organic-social",
  "social-unknown",
] as const;

/** SQL-side platform derivation, mirroring normalizeSocialPlatform's precedence. */
const PLATFORM_EXPR = sql`
  CASE
    WHEN lower(coalesce(t.referrer,'') || ' ' || coalesce(t.source,'')) ~ 'threads'    THEN 'threads'
    WHEN lower(coalesce(t.referrer,'') || ' ' || coalesce(t.source,'')) ~ 'instagram'  THEN 'instagram'
    WHEN lower(coalesce(t.referrer,'') || ' ' || coalesce(t.source,'')) ~ 'facebook|fb\\.com' THEN 'facebook'
    WHEN lower(coalesce(t.referrer,'') || ' ' || coalesce(t.source,'')) ~ 'tiktok'     THEN 'tiktok'
    WHEN lower(coalesce(t.referrer,'') || ' ' || coalesce(t.source,'')) ~ 'pinterest'  THEN 'pinterest'
    WHEN lower(coalesce(t.referrer,'') || ' ' || coalesce(t.source,'')) ~ 'reddit'     THEN 'reddit'
    WHEN lower(coalesce(t.referrer,'') || ' ' || coalesce(t.source,'')) ~ 'x\\.com|twitter|t\\.co' THEN 'x'
    WHEN lower(coalesce(t.referrer,'') || ' ' || coalesce(t.source,'')) ~ 'youtube|youtu\\.be' THEN 'youtube'
    WHEN lower(coalesce(t.referrer,'') || ' ' || coalesce(t.source,'')) ~ 'linkedin'   THEN 'linkedin'
    ELSE 'unattributed platform'
  END
`;

const SOCIAL_TOUCHPOINTS = sql`
  soc AS (
    SELECT t.id, t.order_id, t.customer_id, t.channel, t.campaign, t.content,
           t.referrer, t.source, t.landing_url, t.occurred_at,
           ${PLATFORM_EXPR} AS platform,
           (t.channel LIKE 'paid-%') AS is_paid
      FROM attribution_touchpoints t
     WHERE t.channel = ANY(ARRAY['paid-meta','paid-tiktok','organic-social','social-unknown'])
  )
`;

/** Countable orders joined to their revenue, reused by several queries below. */
const ORD = sql`
  ord AS (
    SELECT o.id, o.customer_id, o.processed_at::date AS d,
           (o.total_amount - o.total_refunded_amount) AS revenue,
           o.total_amount > 0 AS is_paid_order
      FROM orders o
     WHERE o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
       AND o.processed_at IS NOT NULL
  )
`;

// ---------------------------------------------------------------------------
// Platform performance
// ---------------------------------------------------------------------------

export interface SocialPlatformRow {
  platform: string;
  touchpoints: number;
  orders: number;
  /**
   * Orders that actually collected money. 65% of this store's orders are $0
   * (prepaid subscription deliveries and comps), so this is the only valid AOV
   * denominator — dividing by all orders reported Instagram AOV as $13.59 against a
   * true $53. Same trap `tests/aov.test.ts` already pins for the blended figure.
   */
  paidOrders: number;
  customers: number;
  revenueCents: number;
  paidTouchpoints: number;
  organicTouchpoints: number;
  /** Revenue per PAID order this platform touched. */
  aovCents: number | null;
  /** Share of this platform's touchpoints that reached an order. */
  conversionRate: number | null;
}

/**
 * Per-platform social performance.
 *
 * Revenue is counted per ORDER the platform touched, not apportioned by an
 * attribution model — so a single order touched by both Instagram and a newsletter
 * appears under Instagram at full value. That makes this a "platforms involved in
 * this revenue" view, not an additive split; summing the column will exceed total
 * revenue. Use `/marketing` for the model-apportioned, non-double-counted version.
 */
export async function getSocialPlatformPerformance(
  since: string,
  until: string,
): Promise<SocialPlatformRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH ${SOCIAL_TOUCHPOINTS}, ${ORD}
    SELECT s.platform,
           count(*)::int AS touchpoints,
           count(*) FILTER (WHERE s.is_paid)::int AS paid_tp,
           count(*) FILTER (WHERE NOT s.is_paid)::int AS organic_tp,
           count(DISTINCT o.id)::int AS orders,
           count(DISTINCT o.id) FILTER (WHERE o.is_paid_order)::int AS paid_orders,
           count(DISTINCT s.customer_id)::int AS customers,
           COALESCE(sum(DISTINCT_REV.revenue), 0)::bigint AS revenue
      FROM soc s
      LEFT JOIN ord o ON o.id = s.order_id
        AND o.d >= ${since} AND o.d <= ${until}
      LEFT JOIN LATERAL (
        -- One revenue figure per order even when several touchpoints hit it.
        SELECT CASE WHEN s.id = (
                 SELECT s2.id FROM soc s2
                  WHERE s2.order_id = s.order_id AND s2.platform = s.platform
                  ORDER BY s2.occurred_at, s2.id LIMIT 1
               ) THEN o.revenue ELSE 0 END AS revenue
      ) AS DISTINCT_REV ON true
     GROUP BY s.platform
     ORDER BY revenue DESC, touchpoints DESC
  `);

  return data.map((r) => {
    const orders = num(r.orders);
    const paidOrders = num(r.paid_orders);
    const touchpoints = num(r.touchpoints);
    const revenue = num(r.revenue);
    return {
      platform: String(r.platform),
      touchpoints,
      orders,
      paidOrders,
      customers: num(r.customers),
      revenueCents: revenue,
      paidTouchpoints: num(r.paid_tp),
      organicTouchpoints: num(r.organic_tp),
      // Paid orders only — see the field comment.
      aovCents: paidOrders > 0 ? Math.round(revenue / paidOrders) : null,
      conversionRate: ratio(orders, touchpoints),
    };
  });
}

// ---------------------------------------------------------------------------
// Paid campaign performance — the ads ↔ commerce join
// ---------------------------------------------------------------------------

export interface PaidCampaignRow {
  campaignName: string;
  campaignId: string | null;
  spendCents: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpcCents: number | null;
  cpmCents: number | null;
  firstDay: string;
  lastDay: string;
  /** Orders whose touchpoints name this campaign (by id OR name). */
  attributedOrders: number;
  /**
   * Of those, the ones that collected money. The gap matters: "Free Quarterly
   * Campaign" drove 25 orders and $0, and "Sales - Issue 05" drove 76 orders at
   * roughly $9 each — both were buying free/discounted signups, not revenue.
   * Reading only `attributedOrders` makes those look like the same thing as a
   * campaign that sold 25 magazines.
   */
  attributedPaidOrders: number;
  attributedRevenueCents: number;
  roas: number | null;
  /** Spend per attributed order, counting free signups. */
  cacCents: number | null;
  /** Spend per attributed PAYING order. */
  paidCacCents: number | null;
  /** True when no touchpoint could be matched to this campaign at all. */
  unmatched: boolean;
}

/**
 * Meta campaign spend joined to the orders its touchpoints reached.
 *
 * The join is the interesting part. Meta's automatic tagging currently writes the
 * campaign **ID** into `utm_campaign` (e.g. `120231993199500507`), while some
 * older/hand-tagged links carry the campaign **name** instead — so matching on
 * either is required, and matching on only one silently loses most of the data.
 *
 * ⚠️ Attributed revenue here is a floor. It needs a touchpoint that names the
 * campaign, and Meta only tags some traffic; campaigns showing `unmatched` had spend
 * but no identifiable visit, which is a tagging gap rather than zero performance.
 * That is exactly what the UTM rollout fixes.
 */
export async function getPaidCampaignPerformance(
  since: string,
  until: string,
  platform = "meta",
): Promise<PaidCampaignRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH ${ORD},
    spend AS (
      SELECT COALESCE(NULLIF(btrim(a.campaign_name), ''), '(unnamed)') AS campaign_name,
             max(a.campaign_id) AS campaign_id,
             sum(a.spend_amount)::bigint AS spend,
             sum(a.impressions)::bigint AS impressions,
             sum(a.clicks)::bigint AS clicks,
             min(a.date)::text AS first_day,
             max(a.date)::text AS last_day
        FROM ad_spend a
       WHERE a.platform::text = ${platform}
         AND a.date >= ${since} AND a.date <= ${until}
       GROUP BY 1
    ),
    matched AS (
      SELECT sp.campaign_name,
             count(DISTINCT o.id)::int AS orders,
             count(DISTINCT o.id) FILTER (WHERE o.is_paid_order)::int AS paid_orders,
             COALESCE(sum(DISTINCT_REV.revenue), 0)::bigint AS revenue
        FROM spend sp
        JOIN attribution_touchpoints t
          -- Meta writes the campaign ID; hand-tagged links carry the name.
          ON t.campaign = sp.campaign_id OR t.campaign = sp.campaign_name
        JOIN ord o ON o.id = t.order_id
        LEFT JOIN LATERAL (
          SELECT CASE WHEN t.id = (
                   SELECT t2.id FROM attribution_touchpoints t2
                    WHERE t2.order_id = t.order_id
                      AND (t2.campaign = sp.campaign_id OR t2.campaign = sp.campaign_name)
                    ORDER BY t2.occurred_at, t2.id LIMIT 1
                 ) THEN o.revenue ELSE 0 END AS revenue
        ) AS DISTINCT_REV ON true
       GROUP BY sp.campaign_name
    )
    SELECT sp.*, COALESCE(m.orders, 0) AS attributed_orders,
           COALESCE(m.paid_orders, 0) AS attributed_paid_orders,
           COALESCE(m.revenue, 0) AS attributed_revenue
      FROM spend sp LEFT JOIN matched m ON m.campaign_name = sp.campaign_name
     ORDER BY sp.spend DESC
  `);

  return data.map((r) => {
    const spend = num(r.spend);
    const impressions = num(r.impressions);
    const clicks = num(r.clicks);
    const orders = num(r.attributed_orders);
    const paidOrders = num(r.attributed_paid_orders);
    const revenue = num(r.attributed_revenue);
    return {
      campaignName: String(r.campaign_name),
      campaignId: r.campaign_id == null ? null : String(r.campaign_id),
      spendCents: spend,
      impressions,
      clicks,
      ctr: ratio(clicks, impressions),
      cpcCents: clicks > 0 ? Math.round(spend / clicks) : null,
      // CPM is per thousand impressions.
      cpmCents: impressions > 0 ? Math.round((spend / impressions) * 1000) : null,
      firstDay: String(r.first_day),
      lastDay: String(r.last_day),
      attributedOrders: orders,
      attributedPaidOrders: paidOrders,
      attributedRevenueCents: revenue,
      roas: ratio(revenue, spend),
      cacCents: orders > 0 ? Math.round(spend / orders) : null,
      paidCacCents: paidOrders > 0 ? Math.round(spend / paidOrders) : null,
      unmatched: orders === 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Where social traffic lands
// ---------------------------------------------------------------------------

export interface SocialLandingRow {
  path: string;
  touchpoints: number;
  orders: number;
  revenueCents: number;
  conversionRate: number | null;
}

/**
 * Top landing pages for social traffic — the closest proxy for "which post worked"
 * until `utm_content` is in use.
 *
 * Checkout, cart and account paths are excluded: they're mid-funnel steps a visitor
 * reaches after arriving, and each checkout URL is unique per session, so they
 * flooded the list with single-order rows that say nothing about which content drove
 * the visit.
 */
export async function getSocialLandingPages(
  since: string,
  until: string,
  limit = 15,
): Promise<SocialLandingRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH ${SOCIAL_TOUCHPOINTS}, ${ORD},
    paths AS (
      SELECT COALESCE(
               NULLIF(regexp_replace(s.landing_url, '^https?://[^/]+([^?#]*).*$', '\\1'), ''),
               '/'
             ) AS path,
             s.id, s.order_id
        FROM soc s
       WHERE s.landing_url IS NOT NULL
    )
    SELECT p.path,
           count(*)::int AS touchpoints,
           count(DISTINCT o.id)::int AS orders,
           COALESCE(sum(DISTINCT_REV.revenue), 0)::bigint AS revenue
      FROM paths p
      LEFT JOIN ord o ON o.id = p.order_id AND o.d >= ${since} AND o.d <= ${until}
      LEFT JOIN LATERAL (
        SELECT CASE WHEN p.id = (
                 SELECT p2.id FROM paths p2
                  WHERE p2.order_id = p.order_id AND p2.path = p.path
                  ORDER BY p2.id LIMIT 1
               ) THEN o.revenue ELSE 0 END AS revenue
      ) AS DISTINCT_REV ON true
     WHERE p.path !~ '^/(checkouts?|cart|a/account|account|apps)(/|$)'
     GROUP BY p.path
     ORDER BY touchpoints DESC
     LIMIT ${limit}
  `);

  return data.map((r) => {
    const tp = num(r.touchpoints);
    return {
      path: String(r.path),
      touchpoints: tp,
      orders: num(r.orders),
      revenueCents: num(r.revenue),
      conversionRate: ratio(num(r.orders), tp),
    };
  });
}

// ---------------------------------------------------------------------------
// Headline summary
// ---------------------------------------------------------------------------

export interface SocialSummary {
  socialTouchpoints: number;
  socialOrders: number;
  socialRevenueCents: number;
  /** Social-touched revenue as a share of ALL revenue in the window. */
  shareOfRevenue: number | null;
  paidSpendCents: number;
  paidOrders: number;
  organicOrders: number;
  /** Orders social touched that we can see, per dollar of social ad spend. */
  paidRoas: number | null;
  /** How much of all revenue attribution can speak to at all — the honesty check. */
  attributionCoverage: number | null;
  /** Distinct platforms identified. */
  platformsIdentified: number;
  /** Touchpoints whose platform could not be identified. */
  unidentifiedTouchpoints: number;
}

export async function getSocialSummary(
  since: string,
  until: string,
): Promise<SocialSummary> {
  const [r] = await rows<Record<string, unknown>>(sql`
    WITH ${SOCIAL_TOUCHPOINTS}, ${ORD},
    per_order AS (
      SELECT DISTINCT s.order_id,
             bool_or(s.is_paid) AS any_paid,
             bool_or(NOT s.is_paid) AS any_organic
        FROM soc s WHERE s.order_id IS NOT NULL GROUP BY s.order_id
    ),
    social_rev AS (
      SELECT count(DISTINCT o.id)::int AS orders,
             COALESCE(sum(o.revenue), 0)::bigint AS revenue,
             count(DISTINCT o.id) FILTER (WHERE po.any_paid)::int AS paid_orders,
             count(DISTINCT o.id) FILTER (WHERE po.any_organic
                                            AND NOT po.any_paid)::int AS organic_orders
        FROM per_order po JOIN ord o ON o.id = po.order_id
       WHERE o.d >= ${since} AND o.d <= ${until}
    ),
    all_rev AS (
      SELECT COALESCE(sum(revenue), 0)::bigint AS revenue,
             count(*)::int AS orders
        FROM ord WHERE d >= ${since} AND d <= ${until}
    ),
    covered AS (
      SELECT COALESCE(sum(o.revenue), 0)::bigint AS revenue
        FROM ord o
       WHERE o.d >= ${since} AND o.d <= ${until}
         AND EXISTS (SELECT 1 FROM attribution_touchpoints t
                      WHERE t.order_id = o.id AND t.channel <> 'internal')
    ),
    spend AS (
      SELECT COALESCE(sum(a.spend_amount), 0)::bigint AS spend
        FROM ad_spend a
       WHERE a.date >= ${since} AND a.date <= ${until}
         AND a.platform::text IN ('meta','tiktok')
    ),
    plat AS (
      SELECT count(DISTINCT s.platform) FILTER (
               WHERE s.platform <> 'unattributed platform'
             )::int AS identified,
             count(*) FILTER (WHERE s.platform = 'unattributed platform')::int AS unidentified,
             count(*)::int AS total_tp
        FROM soc s
    )
    SELECT sr.orders, sr.revenue, sr.paid_orders, sr.organic_orders,
           ar.revenue AS all_revenue, cv.revenue AS covered_revenue,
           sp.spend, p.identified, p.unidentified, p.total_tp
      FROM social_rev sr, all_rev ar, covered cv, spend sp, plat p
  `);

  const socialRevenue = num(r?.revenue);
  const allRevenue = num(r?.all_revenue);
  const spend = num(r?.spend);

  return {
    socialTouchpoints: num(r?.total_tp),
    socialOrders: num(r?.orders),
    socialRevenueCents: socialRevenue,
    shareOfRevenue: ratio(socialRevenue, allRevenue),
    paidSpendCents: spend,
    paidOrders: num(r?.paid_orders),
    organicOrders: num(r?.organic_orders),
    paidRoas: ratio(socialRevenue, spend),
    attributionCoverage: ratio(num(r?.covered_revenue), allRevenue),
    platformsIdentified: num(r?.identified),
    unidentifiedTouchpoints: num(r?.unidentified),
  };
}

/**
 * Campaign-level attributed performance, independent of ad spend.
 *
 * Separate from `getPaidCampaignPerformance` because it also surfaces ORGANIC
 * campaigns — the ones the UTM rollout will create (`issue07_launch` and friends).
 * Until tagging lands this returns mostly Meta's opaque numeric campaign IDs, which
 * is itself the argument for the `{{campaign.name}}` setting in the tagging guide.
 */
export interface TaggedCampaignRow {
  campaign: string;
  looksLikeMetaId: boolean;
  touchpoints: number;
  orders: number;
  revenueCents: number;
  channels: string[];
}

export async function getTaggedCampaigns(
  since: string,
  until: string,
  limit = 20,
): Promise<TaggedCampaignRow[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH ${ORD}
    SELECT t.campaign,
           count(*)::int AS touchpoints,
           count(DISTINCT o.id)::int AS orders,
           COALESCE(sum(DISTINCT_REV.revenue), 0)::bigint AS revenue,
           array_agg(DISTINCT t.channel) AS channels
      FROM attribution_touchpoints t
      LEFT JOIN ord o ON o.id = t.order_id AND o.d >= ${since} AND o.d <= ${until}
      LEFT JOIN LATERAL (
        SELECT CASE WHEN t.id = (
                 SELECT t2.id FROM attribution_touchpoints t2
                  WHERE t2.order_id = t.order_id AND t2.campaign = t.campaign
                  ORDER BY t2.occurred_at, t2.id LIMIT 1
               ) THEN o.revenue ELSE 0 END AS revenue
      ) AS DISTINCT_REV ON true
     WHERE t.campaign IS NOT NULL AND btrim(t.campaign) <> ''
     GROUP BY t.campaign
     ORDER BY revenue DESC, touchpoints DESC
     LIMIT ${limit}
  `);

  return data.map((r) => {
    const campaign = String(r.campaign);
    return {
      campaign,
      // Meta's auto-tagging writes a long numeric id rather than a readable name.
      looksLikeMetaId: /^\d{10,}$/.test(campaign),
      touchpoints: num(r.touchpoints),
      orders: num(r.orders),
      revenueCents: num(r.revenue),
      channels: Array.isArray(r.channels) ? (r.channels as string[]).filter(Boolean) : [],
    };
  });
}
