/**
 * Audience composition against actual customers.
 *
 * The question: the following is 54% US and 10% UK, but where do orders actually come
 * from? If a country is a tenth of the audience and a fortieth of the orders, either there
 * is demand being left unconverted or the economics of serving it don't work — and
 * `/international` already knows which, because it carries per-market margin.
 *
 * ## Two things that make this easy to get wrong
 *
 * **1. Meta's shares don't sum to 100.** It reports only the top ten, to one decimal, so
 * the countries here total about 81%. Treating that as 100 inflates every share by ~23%.
 * Every ratio below therefore normalises against the sum of what is *present*, and the page
 * states the covered share so nobody reads a partial distribution as a whole one.
 *
 * **2. The two sides name countries differently.** Meta says "United States"; Shopify
 * stores "US". The mapping is unavoidable and it fails silently if you let it — an
 * unmapped country simply vanishes from the comparison, which quietly removes exactly the
 * markets you'd most want flagged. So `mapCountryName` returns null rather than guessing,
 * and unmapped names are surfaced as their own list instead of being dropped.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "./formulas";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/**
 * Meta's country label → ISO 3166-1 alpha-2, as Shopify stores it.
 *
 * Deliberately a fixed table rather than a fuzzy match: a near-miss that maps "Georgia"
 * (the country) onto "GA" (the US state) or silently merges "Congo" variants would corrupt
 * the comparison in a way nobody would notice. Covers the markets that appear in Esses'
 * audience and order data plus the obvious neighbours; anything else is reported unmapped.
 */
const COUNTRY_TO_ISO: Record<string, string> = {
  "united states": "US",
  "united kingdom": "GB",
  canada: "CA",
  australia: "AU",
  "new zealand": "NZ",
  ireland: "IE",
  france: "FR",
  germany: "DE",
  italy: "IT",
  spain: "ES",
  portugal: "PT",
  netherlands: "NL",
  belgium: "BE",
  switzerland: "CH",
  austria: "AT",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  poland: "PL",
  "czech republic": "CZ",
  czechia: "CZ",
  greece: "GR",
  turkey: "TR",
  india: "IN",
  japan: "JP",
  china: "CN",
  "hong kong": "HK",
  singapore: "SG",
  "south korea": "KR",
  malaysia: "MY",
  indonesia: "ID",
  philippines: "PH",
  thailand: "TH",
  vietnam: "VN",
  mexico: "MX",
  brazil: "BR",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  "south africa": "ZA",
  "united arab emirates": "AE",
  "saudi arabia": "SA",
  israel: "IL",
  qatar: "QA",
};

/** Null when unrecognised — never a guess. Case- and whitespace-insensitive. */
export function mapCountryName(name: string): string | null {
  return COUNTRY_TO_ISO[name.trim().toLowerCase()] ?? null;
}

/**
 * Over/under-index: audience share divided by order share.
 *
 * 1.0 means a country converts exactly in line with its share of the following. Above 1
 * means the audience is there and the orders are not. Null when the country has no orders
 * at all — that is "cannot be measured as a ratio", not infinite over-indexing, and the
 * caller should show the raw counts instead (rule 3).
 */
export function overIndex(audienceShare: number, orderShare: number): number | null {
  return ratio(audienceShare, orderShare);
}

/**
 * Below this many orders, the index is arithmetic rather than evidence.
 *
 * On this data India shows 1 order against 2.8% of the audience, which divides out to an
 * index of 237x. That is a true division and a useless number: one more order halves it.
 * A figure like that is precisely what gets lifted into a deck, so the row is marked
 * unreliable and the page shows the order count instead of the multiple. Same reasoning as
 * `minSubscriptions` on the churn cohorts — thin cohorts mislead.
 */
export const MIN_ORDERS_FOR_INDEX = 20;

export interface GeoComparisonRow {
  iso: string;
  label: string;
  /** Share of followers, renormalised over the countries Meta actually reported. */
  audienceShare: number;
  /** Share of countable orders, over orders that have a country. */
  orderShare: number;
  orders: number;
  revenueCents: number;
  /** audienceShare / orderShare. Null when there are no orders. */
  index: number | null;
  /**
   * False when the order count is too small for the index to mean anything. The index is
   * still returned — suppressing the number entirely hides that the market is tiny — but
   * the UI must present the counts rather than the multiple.
   */
  indexReliable: boolean;
}

export interface AudienceGeography {
  capturedOn: string | null;
  rows: GeoComparisonRow[];
  /**
   * Sum of the raw reported shares — about 0.81 here, NOT 1. Meta lists only its top ten,
   * so this is how much of the following the comparison can speak to at all.
   */
  audienceCoverage: number;
  /** Meta country labels with no ISO mapping. Reported, never silently dropped. */
  unmapped: string[];
  ordersWithCountry: number;
  ordersTotal: number;
}

export async function getAudienceGeography(
  platform = "instagram",
): Promise<AudienceGeography> {
  const [segments, orders, totals] = await Promise.all([
    rows<{ captured_on: string; key: string; share_pct: number }>(sql`
      SELECT to_char(captured_on, 'YYYY-MM-DD') AS captured_on, key, share_pct
        FROM social_audience_segment
       WHERE platform = ${platform} AND dimension = 'country'
         -- Latest export only; composition is a snapshot, so mixing dates would blend
         -- two different pictures of the same audience.
         AND captured_on = (
           SELECT max(captured_on) FROM social_audience_segment
            WHERE platform = ${platform} AND dimension = 'country'
         )
       ORDER BY share_pct DESC
    `),
    rows<{ iso: string; orders: number; revenue: number }>(sql`
      SELECT shipping_country AS iso,
             count(*)::int    AS orders,
             COALESCE(sum(total_amount - total_refunded_amount), 0) AS revenue
        FROM orders
       WHERE test = false AND cancelled_at IS NULL AND counts_as_revenue = true
         AND shipping_country IS NOT NULL
       GROUP BY shipping_country
    `),
    rows<{ total: number; with_country: number }>(sql`
      SELECT count(*)::int AS total,
             count(shipping_country)::int AS with_country
        FROM orders
       WHERE test = false AND cancelled_at IS NULL AND counts_as_revenue = true
    `),
  ]);

  const ordersTotal = Number(totals[0]?.total ?? 0);
  const ordersWithCountry = Number(totals[0]?.with_country ?? 0);
  const orderByIso = new Map(
    orders.map((o) => [o.iso, { orders: Number(o.orders), revenue: Number(o.revenue) }]),
  );

  // Renormalise over what Meta actually reported — see the note at the top of the file.
  const rawTotal = segments.reduce((a, s) => a + Number(s.share_pct), 0);
  const unmapped: string[] = [];

  const comparison: GeoComparisonRow[] = [];
  for (const s of segments) {
    const iso = mapCountryName(s.key);
    if (!iso) {
      unmapped.push(s.key);
      continue;
    }
    const o = orderByIso.get(iso);
    const audienceShare = rawTotal > 0 ? Number(s.share_pct) / rawTotal : 0;
    const orderShare = ordersWithCountry > 0 ? (o?.orders ?? 0) / ordersWithCountry : 0;
    comparison.push({
      iso,
      label: s.key,
      audienceShare,
      orderShare,
      orders: o?.orders ?? 0,
      revenueCents: o?.revenue ?? 0,
      index: overIndex(audienceShare, orderShare),
      indexReliable: (o?.orders ?? 0) >= MIN_ORDERS_FOR_INDEX,
    });
  }

  return {
    capturedOn: segments[0]?.captured_on ?? null,
    rows: comparison.sort((a, b) => b.audienceShare - a.audienceShare),
    audienceCoverage: rawTotal / 100,
    unmapped,
    ordersWithCountry,
    ordersTotal,
  };
}
