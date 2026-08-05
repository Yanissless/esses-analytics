/**
 * Platform-reported vs our-attributed performance (Section 8.4).
 *
 * Every ad platform grades its own homework: Meta counts a conversion whenever a
 * purchase can be tied to someone who saw an ad, using view-through windows and
 * cross-device identity we can't see. We count a conversion only when a touchpoint
 * survived into `attribution_touchpoints`. The two numbers will never match, and
 * the SIZE of the gap is the useful signal — it bounds how much of the platform's
 * claim we can actually corroborate.
 *
 * On this account the gap is extreme (Meta self-reports ~552 conversions in seven
 * days; our paid-meta attribution finds ~286 across ten months), and the cause is
 * known: Esses doesn't UTM-tag its links. A Meta click that arrives without an
 * `fbclid` is indistinguishable from organic Instagram reach, so it lands in
 * `organic-social`. `ambiguous*` below measures exactly that pool — social traffic
 * from the platform's own hosts that carried no paid marker. It is the band inside
 * which the truth sits: our attribution is the floor, our attribution plus the
 * ambiguous pool is the ceiling.
 *
 * Nothing here reclassifies anything. It reports the uncertainty instead of
 * resolving it, because resolving it needs tagged links, not a better guess.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "../metrics/formulas";
import { getChannelPerformance, type AttributionBasis } from "./report";
import type { AttributionModel } from "./models";
import { reconcile, type Reconciliation } from "./models";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Which touchpoint signals mean "this could have been a paid click from platform
 * X, we just can't prove it". Keyed to the same hosts `resolveChannel` uses to
 * call something organic-social, so the two stay in agreement.
 */
/*
 * Both patterns are POSIX regexes applied with `~*`, not LIKE with an array:
 * drizzle's sql`` template expands a JS array into a parenthesised tuple
 * ($3, $4, $5) rather than a Postgres array literal, so `ILIKE ANY(${arr})`
 * fails with "op ANY/ALL (array) requires array on right side".
 */
const AMBIGUOUS_SIGNALS: Record<string, { hostPattern: string; sourcePattern: string }> = {
  meta: {
    hostPattern: "instagram\\.com|facebook\\.com|fb\\.com",
    sourcePattern: "instagram|facebook|meta",
  },
  google: { hostPattern: "google\\.", sourcePattern: "google" },
  tiktok: { hostPattern: "tiktok\\.com", sourcePattern: "tiktok" },
};

export interface PlatformReconciliation extends Reconciliation {
  /** Ad platform as stored in `ad_spend.platform`. */
  platform: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  /** Revenue the platform claims it drove. */
  platformConversionValueCents: number;
  /** Revenue our model credits to this channel. */
  ourRevenueCents: number;
  platformRoas: number | null;
  ourRoas: number | null;
  /** Platform CAC using the platform's own conversion count. */
  platformCac: number | null;
  ourCac: number | null;
  /**
   * Conversions sitting in `organic-social` that came from this platform's hosts
   * with no paid marker — traffic that may well be ours but can't be proven.
   */
  ambiguousConversions: number;
  ambiguousRevenueCents: number;
  /**
   * ROAS if every ambiguous conversion turned out to be paid. The optimistic end
   * of the band; `ourRoas` is the pessimistic end.
   */
  ceilingRoas: number | null;
  /** True when the ambiguous pool alone could close the gap to the platform. */
  gapExplainableByUntagged: boolean;
  /** Orders the store took in this window from EVERY channel, paid and organic. */
  storeOrdersInWindow: number;
  /**
   * Sanity guard: a platform cannot have driven more purchases than the store
   * received in total. When this trips, the platform figures are not measuring
   * conversions and every ratio derived from them (their ROAS, their CAC, the
   * overclaim multiple) is meaningless — so the UI must say so rather than
   * rendering a confident-looking number.
   *
   * It caught a real defect: the Meta connector summed `omni_purchase`,
   * `purchase` and `offsite_conversion.fb_pixel_purchase`, which are overlapping
   * views of one conversion, inflating the count roughly 3×.
   */
  claimExceedsAllOrders: boolean;
}

/**
 * Reconcile each ad platform against our own attribution for a window.
 *
 * `model` and `basis` are passed through to `getChannelPerformance` so the panel
 * always reflects the same model the rest of the page is showing — a
 * reconciliation against a different model than the table above it would be
 * quietly misleading.
 */
export async function getPlatformReconciliation(
  since: string,
  until: string,
  model: AttributionModel = "last-non-direct",
  basis: AttributionBasis = "session-only",
  halfLifeDays = 7,
): Promise<PlatformReconciliation[]> {
  const [platformRows, ourChannels, ambiguous, storeOrders] = await Promise.all([
    rows<Record<string, unknown>>(sql`
      SELECT platform::text AS platform,
             COALESCE(sum(spend_amount), 0) AS spend,
             COALESCE(sum(impressions), 0) AS impressions,
             COALESCE(sum(clicks), 0) AS clicks,
             COALESCE(sum(platform_conversions), 0) AS conversions,
             COALESCE(sum(platform_conversion_value_amount), 0) AS conversion_value
        FROM ad_spend
       WHERE date >= ${since} AND date <= ${until}
       GROUP BY 1
    `),
    getChannelPerformance(since, until, model, halfLifeDays, basis),
    getAmbiguousSocial(since, until),
    countStoreOrders(since, until),
  ]);

  const ourByChannel = new Map(ourChannels.map((c) => [c.channel, c]));

  const out: PlatformReconciliation[] = [];
  for (const p of platformRows) {
    const platform = String(p.platform);
    const channel = `paid-${platform}`;
    const ours = ourByChannel.get(channel);
    const spend = num(p.spend);
    const platformConv = num(p.conversions);
    const platformValue = num(p.conversion_value);
    const ourConv = ours?.attributedConversions ?? 0;
    const ourRevenue = ours?.attributedRevenueCents ?? 0;
    const amb = ambiguous.get(platform) ?? { conversions: 0, revenueCents: 0 };

    out.push({
      ...reconcile(ourConv, platformConv, channel),
      platform,
      spendCents: spend,
      impressions: num(p.impressions),
      clicks: num(p.clicks),
      platformConversionValueCents: platformValue,
      ourRevenueCents: ourRevenue,
      platformRoas: ratio(platformValue, spend),
      ourRoas: ratio(ourRevenue, spend),
      platformCac: platformConv > 0 ? ratio(spend, platformConv) : null,
      ourCac: ourConv > 0 ? ratio(spend, ourConv) : null,
      ambiguousConversions: Math.round(amb.conversions * 100) / 100,
      ambiguousRevenueCents: amb.revenueCents,
      ceilingRoas: ratio(ourRevenue + amb.revenueCents, spend),
      gapExplainableByUntagged: ourConv + amb.conversions >= platformConv,
      storeOrdersInWindow: storeOrders,
      claimExceedsAllOrders: platformConv > storeOrders,
    });
  }

  return out.sort((a, b) => b.spendCents - a.spendCents);
}

/**
 * Orders whose attributed channel is `organic-social` but whose touchpoints came
 * from a given ad platform's hosts without a click id or paid UTM.
 *
 * Counted per ORDER, not per touchpoint, so it lines up with a conversion count.
 * An order is credited to the platform whose hosts appear in its path; if several
 * do, it counts once for each — this is an upper bound by construction, which is
 * the point of a ceiling.
 */
async function getAmbiguousSocial(
  since: string,
  until: string,
): Promise<Map<string, { conversions: number; revenueCents: number }>> {
  const out = new Map<string, { conversions: number; revenueCents: number }>();

  for (const [platform, sig] of Object.entries(AMBIGUOUS_SIGNALS)) {
    // Reduce to one row per ORDER first. Summing over the join would multiply an
    // order's revenue by its touchpoint count, and `sum(DISTINCT revenue)` would
    // be worse still — it silently collapses two different orders that happen to
    // be for the same amount, which on a fixed-price magazine is most of them.
    const [r] = await rows<Record<string, unknown>>(sql`
      WITH matched AS (
        SELECT DISTINCT o.id,
               (o.total_amount - o.total_refunded_amount) AS revenue
          FROM orders o
          JOIN attribution_touchpoints t ON t.order_id = o.id
         WHERE o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
           AND o.processed_at::date >= ${since} AND o.processed_at::date <= ${until}
           AND t.channel = 'organic-social'
           -- No hard paid evidence: a click id or paid medium would have made
           -- resolveChannel() classify it as paid in the first place.
           AND t.click_id IS NULL
           AND (t.referrer ~* ${sig.hostPattern} OR t.source ~* ${sig.sourcePattern})
      )
      SELECT count(*) AS conversions, COALESCE(sum(revenue), 0) AS revenue FROM matched
    `);
    out.set(platform, {
      conversions: num(r?.conversions),
      revenueCents: num(r?.revenue),
    });
  }

  return out;
}

/** Every order the store took in the window — the ceiling on any platform claim. */
async function countStoreOrders(since: string, until: string): Promise<number> {
  const [r] = await rows<Record<string, unknown>>(sql`
    SELECT count(*) AS n FROM orders
     WHERE test = false AND cancelled_at IS NULL AND counts_as_revenue = true
       AND processed_at::date >= ${since} AND processed_at::date <= ${until}
  `);
  return num(r?.n);
}

export interface ReconciliationTrendPoint {
  month: string;
  spendCents: number;
  platformConversions: number;
  platformConversionValueCents: number;
}

/**
 * Monthly platform-reported spend and conversions. Shown as a trend because a
 * single window can't tell a persistent measurement gap from a one-month blip —
 * and Meta's numbers only became checkable once ten months were loaded.
 */
export async function getPlatformTrend(
  since: string,
  until: string,
  platform = "meta",
): Promise<ReconciliationTrendPoint[]> {
  const data = await rows<Record<string, unknown>>(sql`
    SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
           COALESCE(sum(spend_amount), 0) AS spend,
           COALESCE(sum(platform_conversions), 0) AS conversions,
           COALESCE(sum(platform_conversion_value_amount), 0) AS conversion_value
      FROM ad_spend
     WHERE date >= ${since} AND date <= ${until} AND platform::text = ${platform}
     GROUP BY 1 ORDER BY 1
  `);
  return data.map((r) => ({
    month: String(r.month),
    spendCents: num(r.spend),
    platformConversions: num(r.conversions),
    platformConversionValueCents: num(r.conversion_value),
  }));
}
