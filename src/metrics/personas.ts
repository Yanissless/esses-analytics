/**
 * Behavioural customer personas, for grounding ad targeting in what people
 * actually did rather than who we guess they are.
 *
 * ## Why behavioural and not demographic
 *
 * Esses' own targeting research concluded that Meta age/gender targeting costs
 * 2–3× per placement and acts as an exclusion filter rather than a targeting tool,
 * and that the thing which actually works is hyper-specific creative — because
 * Meta's Advantage+ reads the creative text and targets on signals it will never
 * let you select manually (interests, estimated income, identity, card usage).
 *
 * That conclusion is why this module exists in this shape. We hold **no** gender,
 * age, income or interest data — Shopify doesn't collect it and Meta won't expose
 * it. What we do hold is purchase behaviour, and behaviour is both the better input
 * to creative ("you own three issues and the fourth just dropped") and the only
 * thing that can seed a Custom Audience → Lookalike, which is the Meta mechanism
 * that works without demographic limiting.
 *
 * So every segment here is defined by an observable action, each definition is
 * stated in plain English on the page, and each carries the commercial outcome
 * (LTV, retention, discount dependence) that says whether it's worth targeting.
 *
 * ⚠️ Segments deliberately OVERLAP — one customer can be a collector, a full-price
 * buyer and international at once. Sizes therefore do not sum to the customer base.
 * Use `getSegmentOverlap()` before running several campaigns at once.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { ratio } from "./formulas";
import { SUBS_CTE } from "./churn";

async function rows<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Minimum matched customers Meta needs for each audience tool. Sizes below the
 * Lookalike floor still work as a Custom Audience for retargeting, but can't seed
 * prospecting — and that distinction decides whether a segment is a growth lever or
 * only a retention one.
 */
export const META_CUSTOM_AUDIENCE_MIN = 100;
export const META_LOOKALIKE_SOURCE_MIN = 1000;

export type PersonaSegment =
  | "collector"
  | "annual_committed"
  | "quarterly_trial"
  | "full_price"
  | "discount_dependent"
  | "merch_buyer"
  | "gift_giver"
  | "event_attendee"
  | "single_issue_tryer"
  | "high_value"
  | "international"
  | "us_core"
  | "lapsed_subscriber";

/**
 * Product-title patterns, exported so the SQL below and `classifyProductTitle()`
 * share one definition — the same single-source discipline as
 * `OPS_DISCOUNT_SQL_REGEX` in churn.ts, and for the same reason.
 *
 * Titles are inconsistent in live data ("Esses Navy Corduroy Cap", "Esses Design Tee
 * Blue", "Miami 2025 \"Big Jit\" T-Shirt (Event Exclusive)", "Isack Hadjar Signed
 * Esses Issue 04"), so these are deliberately loose and pinned by unit tests against
 * the real strings.
 */
export const MERCH_PATTERN =
  "cap|hat|tee|t-shirt|shirt|tote|sweatshirt|hoodie|patch|sticker|poster";
export const EVENT_PATTERN = "event|watch party|imax|eventbrite|austin|miami|guide to";
export const SPECIAL_PATTERN = "signed|special edition|vip|limited edition|collector";

/**
 * TS-side equivalent of the SQL classification, for testing and for any caller that
 * already holds titles in memory. A title can match several categories — a signed
 * event tee is all three — so this returns a set of flags rather than one label.
 */
export function classifyProductTitle(title: string | null | undefined): {
  merch: boolean;
  event: boolean;
  special: boolean;
} {
  const t = (title ?? "").toLowerCase();
  return {
    merch: new RegExp(MERCH_PATTERN).test(t),
    event: new RegExp(EVENT_PATTERN).test(t),
    special: new RegExp(SPECIAL_PATTERN).test(t),
  };
}

export interface PersonaProfile {
  segment: PersonaSegment;
  label: string;
  /** Plain-English definition, shown in the UI so the segment is auditable. */
  definition: string;
  customers: number;
  /** Share of all paying customers. */
  shareOfPaying: number | null;
  ltvCents: number | null;
  aovCents: number | null;
  ordersPerCustomer: number | null;
  /** Share of the segment holding a subscription in either system. */
  subscriberShare: number | null;
  /** Churn by first renewal for this segment's subscriptions (maturity-corrected). */
  churnByFirstRenewalPct: number | null;
  matureSubscriptions: number;
  /** Share whose orders always carried a marketing promo code. */
  promoUseRate: number | null;
  topCountry: string | null;
  topCountryShare: number | null;
  /** Customers with a usable email — the ceiling on a Custom Audience upload. */
  contactableCustomers: number;
  meetsCustomAudienceMin: boolean;
  meetsLookalikeMin: boolean;
}

const DEFINITIONS: Record<PersonaSegment, { label: string; definition: string }> = {
  collector: {
    label: "Collectors",
    definition:
      "Bought two or more different issues, or any signed / special-edition / VIP item. Owning a run is the behaviour, not a demographic.",
  },
  annual_committed: {
    label: "Annual committers",
    definition:
      "Chose an annual-payment plan. The strongest willingness-to-prepay signal we hold.",
  },
  quarterly_trial: {
    label: "Quarterly triallers",
    definition: "Chose the 3-month plan — lower commitment, and the plan that churns hardest.",
  },
  full_price: {
    label: "Full-price buyers",
    definition: "Every paid order was at full price, never a marketing promo code.",
  },
  discount_dependent: {
    label: "Discount-dependent",
    definition: "Every paid order carried a marketing promo code — never bought without one.",
  },
  merch_buyer: {
    label: "Merch buyers",
    definition: "Bought apparel or accessories (cap, tee, tote, patches), not just the magazine.",
  },
  gift_giver: {
    label: "Gift givers",
    definition: "Used a gift-flagged promo code, so likely buying for someone else.",
  },
  event_attendee: {
    label: "Event / community",
    definition:
      "Bought an event-linked product (watch party, IMAX package, city guide, event patches) — the in-person-community cohort.",
  },
  single_issue_tryer: {
    label: "Single-issue tryers",
    definition:
      "Exactly one paid order, one issue, never subscribed and never returned. The biggest untapped pool.",
  },
  high_value: {
    label: "Top-decile value",
    definition: "In the highest 10% of lifetime value across all paying customers.",
  },
  international: {
    label: "International",
    definition: "Shipping outside the US — the UK/EU/CA/AU audience.",
  },
  us_core: {
    label: "US core",
    definition: "Shipping inside the US, where ~91% of orders land.",
  },
  lapsed_subscriber: {
    label: "Lapsed subscribers",
    definition:
      "Held a subscription that is now cancelled. Already proved they'll pay — the cheapest audience to win back.",
  },
};

/**
 * One row per customer with every behavioural flag resolved, plus value metrics.
 *
 * Built as a single CTE chain so each segment is a filter over the same base rather
 * than its own query — that keeps definitions comparable and means adding a segment
 * costs one predicate, not one more full query.
 */
const CUSTOMER_FACTS = sql`
  paid_orders AS (
    SELECT o.id, o.customer_id, o.processed_at,
           (o.total_amount - o.total_refunded_amount) AS revenue,
           o.discount_codes
      FROM orders o
     WHERE o.test = false AND o.cancelled_at IS NULL AND o.counts_as_revenue = true
       AND o.customer_id IS NOT NULL AND o.total_amount > 0
  ),
  line_flags AS (
    SELECT po.customer_id,
           count(DISTINCT (regexp_match(lower(li.title), 'issue\\s*#?\\s*0*([0-9]{1,2})'))[1])
             AS distinct_issues,
           bool_or(lower(li.title) ~ ${MERCH_PATTERN})   AS bought_merch,
           bool_or(lower(li.title) ~ ${EVENT_PATTERN})   AS bought_event,
           bool_or(lower(li.title) ~ ${SPECIAL_PATTERN}) AS bought_special,
           sum(li.quantity) AS units
      FROM paid_orders po
      JOIN order_line_items li ON li.order_id = po.id
     GROUP BY po.customer_id
  ),
  order_agg AS (
    SELECT po.customer_id,
           count(*) AS paid_order_count,
           sum(po.revenue) AS shopify_revenue,
           -- "Every order had a marketing code" vs "never did" — the two ends that
           -- actually describe a person. Mixed behaviour is neither.
           bool_and(EXISTS (
             SELECT 1 FROM unnest(COALESCE(po.discount_codes, ARRAY[]::text[])) dc
              WHERE btrim(dc) <> '' AND dc !~* ${"delivery\\s*issue|custom\\s*discount|cancel\\s*flow|prepaid\\s*credit|^discount$|^subscriber$|replace|reship|refund|adjust"}
           )) AS always_promo,
           bool_or(EXISTS (
             SELECT 1 FROM unnest(COALESCE(po.discount_codes, ARRAY[]::text[])) dc
              WHERE dc ~* 'gift'
           )) AS used_gift_code,
           bool_and(NOT EXISTS (
             SELECT 1 FROM unnest(COALESCE(po.discount_codes, ARRAY[]::text[])) dc
              WHERE btrim(dc) <> '' AND dc !~* ${"delivery\\s*issue|custom\\s*discount|cancel\\s*flow|prepaid\\s*credit|^discount$|^subscriber$|replace|reship|refund|adjust"}
           )) AS never_promo
      FROM paid_orders po GROUP BY po.customer_id
  ),
  geo AS (
    SELECT DISTINCT ON (o.customer_id) o.customer_id,
           COALESCE(o.shipping_country, o.billing_country) AS country
      FROM orders o
     WHERE o.customer_id IS NOT NULL
       AND COALESCE(o.shipping_country, o.billing_country) IS NOT NULL
     ORDER BY o.customer_id, o.processed_at DESC
  ),
  stripe_val AS (
    SELECT si.customer_id, sum(si.amount_paid_amount) AS stripe_revenue
      FROM stripe_invoices si WHERE si.paid = true AND si.customer_id IS NOT NULL
     GROUP BY si.customer_id
  ),
  sub_state AS (
    SELECT e.customer_id,
           bool_or(NOT e.is_churned) AS has_active_sub,
           bool_or(e.is_churned)     AS has_churned_sub,
           bool_or(e.cycle_months >= 12) AS has_annual,
           bool_or(e.cycle_months < 12 AND e.cycle_months IS NOT NULL) AS has_short_cycle,
           count(*) FILTER (WHERE e.cycle_months IS NOT NULL
                              AND e.age_months >= e.cycle_months) AS mature_subs,
           count(*) FILTER (WHERE e.cycle_months IS NOT NULL
                              AND e.age_months >= e.cycle_months
                              AND e.is_churned
                              AND e.lived_months < e.cycle_months) AS churned_by_first
      FROM enriched e WHERE e.customer_id IS NOT NULL
     GROUP BY e.customer_id
  ),
  cust AS (
    SELECT c.id, c.email,
           COALESCE(oa.paid_order_count, 0) AS paid_order_count,
           COALESCE(oa.shopify_revenue, 0) + COALESCE(sv.stripe_revenue, 0) AS value,
           COALESCE(oa.shopify_revenue, 0) AS shopify_revenue,
           COALESCE(lf.distinct_issues, 0) AS distinct_issues,
           COALESCE(lf.bought_merch, false) AS bought_merch,
           COALESCE(lf.bought_event, false) AS bought_event,
           COALESCE(lf.bought_special, false) AS bought_special,
           COALESCE(oa.always_promo, false) AS always_promo,
           COALESCE(oa.never_promo, false) AS never_promo,
           COALESCE(oa.used_gift_code, false) AS used_gift_code,
           g.country,
           COALESCE(ss.has_active_sub, false) AS has_active_sub,
           COALESCE(ss.has_churned_sub, false) AS has_churned_sub,
           COALESCE(ss.has_annual, false) AS has_annual,
           COALESCE(ss.has_short_cycle, false) AS has_short_cycle,
           COALESCE(ss.mature_subs, 0) AS mature_subs,
           COALESCE(ss.churned_by_first, 0) AS churned_by_first,
           (ss.customer_id IS NOT NULL) AS is_subscriber
      FROM customers c
      LEFT JOIN order_agg oa ON oa.customer_id = c.id
      LEFT JOIN line_flags lf ON lf.customer_id = c.id
      LEFT JOIN geo g ON g.customer_id = c.id
      LEFT JOIN stripe_val sv ON sv.customer_id = c.id
      LEFT JOIN sub_state ss ON ss.customer_id = c.id
  ),
  paying AS (SELECT * FROM cust WHERE value > 0),
  decile AS (
    SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY value) AS p90 FROM paying
  )
`;

/** The predicate that defines each segment, over the `paying` CTE aliased `p`. */
function segmentPredicate(segment: PersonaSegment): SQL {
  switch (segment) {
    case "collector":
      return sql`(p.distinct_issues >= 2 OR p.bought_special)`;
    case "annual_committed":
      return sql`p.has_annual`;
    case "quarterly_trial":
      return sql`p.has_short_cycle`;
    case "full_price":
      return sql`p.never_promo`;
    case "discount_dependent":
      return sql`p.always_promo`;
    case "merch_buyer":
      return sql`p.bought_merch`;
    case "gift_giver":
      return sql`p.used_gift_code`;
    case "event_attendee":
      return sql`p.bought_event`;
    case "single_issue_tryer":
      return sql`(p.paid_order_count = 1 AND p.distinct_issues <= 1 AND NOT p.is_subscriber)`;
    case "high_value":
      return sql`p.value >= (SELECT p90 FROM decile)`;
    case "international":
      return sql`(p.country IS NOT NULL AND p.country <> 'US')`;
    case "us_core":
      return sql`p.country = 'US'`;
    case "lapsed_subscriber":
      return sql`(p.has_churned_sub AND NOT p.has_active_sub)`;
  }
}

const ALL_SEGMENTS = Object.keys(DEFINITIONS) as PersonaSegment[];

/**
 * Profile every segment, in one statement.
 *
 * ## Why this was rewritten
 *
 * It used to loop the segments and run two queries each. The old comment here said the base was
 * "a CTE the planner materialises once per query, and segment count is small and fixed" — both
 * statements true, and together they hid the cost. Once per QUERY, with 1 + 13 × 2 = 27
 * queries, meant the whole customer-facts join ran 27 times. `/personas` took **30.7 seconds**
 * to render, against under 2.9s for every other page in the app.
 *
 * A CTE genuinely is materialised once per statement, so the fix is to make it one statement.
 * Each segment becomes a `UNION ALL` branch tagging its own key, the top country is resolved by
 * `DISTINCT ON` over a second set of branches, and the paying total is a scalar subquery over
 * the same CTE.
 *
 * The lesson worth keeping: "the expensive part is shared" only holds inside one statement.
 * Sharing it across a loop shares nothing.
 */
export async function getPersonaProfiles(): Promise<PersonaProfile[]> {
  const profileBranches = ALL_SEGMENTS.map(
    (segment) => sql`
      SELECT ${segment}::text AS segment,
             count(*)::int AS customers,
             count(p.email)::int AS contactable,
             avg(p.value) AS ltv,
             sum(p.shopify_revenue) AS shopify_revenue,
             sum(p.paid_order_count) AS paid_orders,
             avg(p.paid_order_count) AS orders_per_customer,
             count(*) FILTER (WHERE p.is_subscriber)::int AS subscribers,
             count(*) FILTER (WHERE p.always_promo)::int AS promo_users,
             sum(p.mature_subs)::int AS mature_subs,
             sum(p.churned_by_first)::int AS churned_by_first
        FROM paying p
       WHERE ${segmentPredicate(segment)}
    `,
  );

  const geoBranches = ALL_SEGMENTS.map(
    (segment) => sql`
      SELECT ${segment}::text AS segment, p.country, count(*)::int AS n
        FROM paying p
       WHERE ${segmentPredicate(segment)} AND p.country IS NOT NULL
       GROUP BY p.country
    `,
  );

  const all = await rows<Record<string, unknown>>(sql`
    WITH ${SUBS_CTE}, ${CUSTOMER_FACTS},
    profiles AS (
      ${sql.join(profileBranches, sql` UNION ALL `)}
    ),
    geo_all AS (
      ${sql.join(geoBranches, sql` UNION ALL `)}
    ),
    -- Highest-count country per segment. DISTINCT ON is Postgres's cheapest top-N-per-group.
    geo_top AS (
      SELECT DISTINCT ON (segment) segment, country, n
        FROM geo_all ORDER BY segment, n DESC
    )
    SELECT pr.*,
           gt.country                         AS top_country,
           gt.n                               AS top_country_n,
           (SELECT count(*) FROM paying)::int AS paying_total
      FROM profiles pr
      LEFT JOIN geo_top gt ON gt.segment = pr.segment
  `);

  const payingTotal = num(all[0]?.paying_total);
  const out: PersonaProfile[] = [];

  for (const r of all) {
    const segment = String(r.segment) as PersonaSegment;
    const geo =
      r.top_country == null
        ? undefined
        : { country: r.top_country, n: r.top_country_n };

    const customers = num(r?.customers);
    const paidOrders = num(r?.paid_orders);
    const shopifyRevenue = num(r?.shopify_revenue);
    const mature = num(r?.mature_subs);
    const contactable = num(r?.contactable);

    out.push({
      segment,
      label: DEFINITIONS[segment].label,
      definition: DEFINITIONS[segment].definition,
      customers,
      shareOfPaying: ratio(customers, payingTotal),
      ltvCents: r?.ltv == null ? null : Math.round(Number(r.ltv)),
      aovCents: paidOrders > 0 ? Math.round(shopifyRevenue / paidOrders) : null,
      ordersPerCustomer: numOrNull(r?.orders_per_customer),
      subscriberShare: ratio(num(r?.subscribers), customers),
      churnByFirstRenewalPct: mature > 0 ? ratio(num(r?.churned_by_first), mature) : null,
      matureSubscriptions: mature,
      promoUseRate: ratio(num(r?.promo_users), customers),
      topCountry: geo?.country == null ? null : String(geo.country),
      topCountryShare: geo == null ? null : ratio(num(geo.n), customers),
      contactableCustomers: contactable,
      meetsCustomAudienceMin: contactable >= META_CUSTOM_AUDIENCE_MIN,
      meetsLookalikeMin: contactable >= META_LOOKALIKE_SOURCE_MIN,
    });
  }

  return out.sort((a, b) => (b.ltvCents ?? 0) - (a.ltvCents ?? 0));
}

export interface SegmentOverlapRow {
  a: PersonaSegment;
  b: PersonaSegment;
  bothCustomers: number;
  /** Share of the SMALLER segment that also sits in the larger one. */
  overlapOfSmaller: number | null;
}

/**
 * Pairwise overlap between segments.
 *
 * Worth checking before launching several campaigns: two segments that overlap
 * heavily will show the same people the same ads, which inflates frequency, wastes
 * budget and makes per-campaign attribution mutually contaminated.
 */
export async function getSegmentOverlap(
  segments: PersonaSegment[] = ALL_SEGMENTS,
  minOverlap = 0.25,
): Promise<SegmentOverlapRow[]> {
  if (segments.length < 2) return [];

  /*
   * Was a nested loop: 13 segments means 78 pairs, each its own query rebuilding the whole
   * customer-facts CTE. Together with the segment loop above it made /personas take 30 seconds
   * — and fixing only that loop left it at 19, because this was the larger half.
   *
   * Membership is unpivoted once into (customer, segment) pairs, and the pairwise counting
   * becomes a single self-join on customer with `a < b` to get each pair once. 13 branches
   * instead of 78, one statement, and the expensive CTE evaluated once.
   */
  const memberBranches = segments.map(
    (segment) => sql`
      SELECT p.id AS customer_id, ${segment}::text AS segment
        FROM paying p
       WHERE ${segmentPredicate(segment)}
    `,
  );

  const data = await rows<Record<string, unknown>>(sql`
    WITH ${SUBS_CTE}, ${CUSTOMER_FACTS},
    memberships AS (
      ${sql.join(memberBranches, sql` UNION ALL `)}
    ),
    sizes AS (
      SELECT segment, count(*)::int AS n FROM memberships GROUP BY 1
    ),
    pairs AS (
      SELECT m1.segment AS a, m2.segment AS b, count(*)::int AS both
        FROM memberships m1
        JOIN memberships m2
          ON m2.customer_id = m1.customer_id
         -- Lexical ordering yields each unordered pair exactly once and drops self-pairs.
         AND m1.segment < m2.segment
       GROUP BY 1, 2
    )
    SELECT pr.a, pr.b, pr.both, sa.n AS a_n, sb.n AS b_n
      FROM pairs pr
      JOIN sizes sa ON sa.segment = pr.a
      JOIN sizes sb ON sb.segment = pr.b
  `);

  const out: SegmentOverlapRow[] = [];
  for (const r of data) {
    const both = num(r.both);
    const smaller = Math.min(num(r.a_n), num(r.b_n));
    const share = ratio(both, smaller);
    if (both > 0 && share != null && share >= minOverlap) {
      out.push({
        a: String(r.a) as PersonaSegment,
        b: String(r.b) as PersonaSegment,
        bothCustomers: both,
        overlapOfSmaller: share,
      });
    }
  }

  return out.sort((a, b) => (b.overlapOfSmaller ?? 0) - (a.overlapOfSmaller ?? 0));
}

export interface GeoConcentration {
  country: string | null;
  customers: number;
  share: number | null;
  ltvCents: number | null;
  aovCents: number | null;
}

/**
 * Where paying customers actually are, with value per market.
 *
 * Directly relevant to the targeting doc's "Locations — UK, Canada, US": this says
 * whether those three are where the money is, and whether any of them is being
 * under-served relative to its value.
 */
export async function getGeoConcentration(limit = 12): Promise<GeoConcentration[]> {
  const data = await rows<Record<string, unknown>>(sql`
    WITH ${SUBS_CTE}, ${CUSTOMER_FACTS},
    tot AS (SELECT count(*)::int AS n FROM paying)
    SELECT p.country, count(*)::int AS customers,
           avg(p.value) AS ltv,
           CASE WHEN sum(p.paid_order_count) > 0
                THEN sum(p.shopify_revenue) / sum(p.paid_order_count) END AS aov,
           (SELECT n FROM tot) AS total
      FROM paying p
     GROUP BY p.country
     ORDER BY customers DESC
     LIMIT ${limit}
  `);

  return data.map((r) => ({
    country: r.country == null ? null : String(r.country),
    customers: num(r.customers),
    share: ratio(num(r.customers), num(r.total)),
    ltvCents: r.ltv == null ? null : Math.round(Number(r.ltv)),
    aovCents: r.aov == null ? null : Math.round(Number(r.aov)),
  }));
}
