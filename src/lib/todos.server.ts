/**
 * Everything currently waiting on a human, computed from live data.
 *
 * ## Why this is derived and not a list
 *
 * There was already a list, in three places: the "Waiting on Sam" table in START-HERE.md, the
 * blocked-on section of HANDOFF.md, and whatever the last session happened to say. All three
 * drifted. `read_reports` sat on the blocked list for weeks after the scope had been granted,
 * and the only reason anyone noticed was a deploy check printing the token's actual scopes.
 *
 * A hand-maintained list of outstanding work rots at exactly the rate the work gets done, which
 * is the worst possible rate. So every item here asks the database or the environment whether it
 * is still true, and an item that has been dealt with stops appearing without anyone editing
 * anything.
 *
 * ## What earns a place
 *
 * Only things a person can act on. "COGS is a placeholder" belongs here because a real number
 * exists somewhere and someone can supply it. "Meta's view-through conversions are unobservable"
 * does not, however much it affects the figures — nobody can do anything about it, and a to-do
 * list containing items nobody can clear teaches people to ignore the list.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { connectorConfigured, env } from "./env";
import { getRenewalForecast } from "../metrics/renewal-forecast";

export type TodoOwner =
  /** Whoever is reading this can finish it, now, in the app or by pasting a value. */
  | "you"
  /** Needs someone who can change the website or the ad account. */
  | "someone-else"
  /** Waiting on an outside party — an approval, an API grant. Chasing is the only action. */
  | "external"
  /** Only time fixes it. Listed so nobody re-investigates it every month. */
  | "time";

export interface TodoItem {
  id: string;
  title: string;
  /** The measured current state. Always a number where a number exists. */
  detail: string;
  /** What leaving it undone actually costs. The reason to care. */
  blocks: string;
  owner: TodoOwner;
  /** Where to go to do it, when the app can do it. */
  href?: string;
  actionLabel?: string;
}

/** Order: what you can finish now, then what you must supply, then what you can only chase. */
const OWNER_RANK: Record<TodoOwner, number> = {
  you: 0,
  "someone-else": 1,
  external: 2,
  time: 3,
};

/**
 * Sort so the top of the list is always something the reader can act on.
 *
 * Pure and exported for testing. A list that opens with three items blocked on a third party
 * reads as "nothing I can do", and the two things that could have been cleared in a minute sit
 * below the fold.
 */
export function sortTodos(items: TodoItem[]): TodoItem[] {
  return [...items].sort(
    (a, b) => OWNER_RANK[a.owner] - OWNER_RANK[b.owner] || a.title.localeCompare(b.title),
  );
}

const usd = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const n = (v: unknown): number => Number(v ?? 0);

export interface TodoReport {
  items: TodoItem[];
  /** How many the reader can finish themselves — the number worth putting on a badge. */
  actionable: number;
}

export async function getTodos(): Promise<TodoReport> {
  const one = async <T,>(q: ReturnType<typeof sql>): Promise<T | undefined> =>
    [...(await db.execute(q))][0] as T | undefined;

  const [review, cogs, plans, social, newsletter, content] = await Promise.all([
    one<{ n: number; cents: number }>(sql`
      SELECT count(*)::int AS n, COALESCE(sum(total_amount), 0)::bigint AS cents
        FROM orders WHERE needs_review = true AND review_override IS NULL`),
    // Paid orders only. The all-classes figure is 2,660 units, but comps and gifts carry no
    // revenue for their cost to distort, so the paid boundary is the one that means something —
    // the same reason per-order averages divide by paid orders.
    one<{ units: number; total: number }>(sql`
      SELECT COALESCE(sum(uncosted_units), 0)::int AS units,
             COALESCE(sum(units), 0)::int          AS total
        FROM order_profit WHERE revenue_class = 'paid'`),
    // Asks the forecast, because it owns the pricing rules. Re-deriving them here in SQL
    // would be a second copy of a predicate that has already been wrong once.
    getRenewalForecast(12).then((f) => ({ unknown: f.unknownCount })),
    one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM attribution_touchpoints
       WHERE channel = 'organic-social' AND campaign IS NULL`),
    one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM attribution_touchpoints
       WHERE channel = 'newsletter' AND campaign IS NULL`),
    one<{ n: number }>(sql`SELECT count(*)::int AS n FROM content_metrics`),
  ]);

  const items: TodoItem[] = [];

  // ---- things the app itself can finish -----------------------------------------------
  if (n(review?.n) > 0) {
    items.push({
      id: "review-queue",
      title: `${n(review?.n)} order(s) waiting to be classified`,
      detail: `${usd(n(review?.cents))} held out of revenue until someone says what they were.`,
      blocks: "Revenue is understated by that amount on every page that reads it.",
      owner: "you",
      href: "/review",
      actionLabel: "Clear the queue",
    });
  }

  /*
   * Keyed on whether a price is actually unresolvable, not on whether a name is missing.
   *
   * The first version counted subscriptions with no `selling_plan_name` and told the reader to
   * go and fix 46 of them. They did not need fixing: grouped by billing cadence they fall
   * cleanly onto the two plans that exist, so `renewalChargeCents` now matches them by
   * interval and every one is priced. Counting the name would have kept an item on this list
   * forever that nobody could clear and nobody needed to.
   *
   * `unknownCount` is the signal that means something — a subscription whose renewal charge
   * genuinely cannot be established, which contributes nothing to the forecast.
   */
  if (n(plans?.unknown) > 0) {
    items.push({
      id: "unpriced-subscriptions",
      title: `${n(plans?.unknown)} subscriptions have no establishable renewal price`,
      detail:
        "No plan name, and a billing cadence that matches none of the known plans, so there " +
        "is nothing to price them from.",
      blocks:
        "They contribute nothing to the renewal forecast, so it is understated by whatever " +
        "they would have renewed at.",
      owner: "you",
      href: "/forecast",
      actionLabel: "See the forecast",
    });
  }

  // ---- values only a person outside the app has ---------------------------------------
  if (n(cogs?.units) > 0) {
    items.push({
      id: "cogs-placeholder",
      title: "Real per-copy print cost",
      detail:
        `Print COGS is still an $11.48 placeholder, and ${n(cogs?.units).toLocaleString()} of ` +
        `${n(cogs?.total).toLocaleString()} paid units have no cost record at all.`,
      blocks:
        "Every margin figure in the app — CM1, CM2, CM3 and breakeven MER. Margin is " +
        "overstated for the units with no cost.",
      owner: "you",
      href: "/costs",
      actionLabel: "Enter costs",
    });
  }

  if (!connectorConfigured.ga4()) {
    const missing = [
      env.GA4_PROPERTY_ID ? null : "GA4_PROPERTY_ID",
      env.GA4_CREDENTIALS_PATH ? null : "GA4_CREDENTIALS_PATH",
    ].filter(Boolean);
    items.push({
      id: "ga4-credentials",
      title: "Connect Google Analytics",
      detail: `Missing ${missing.join(" and ")}. The page and connector are built and waiting.`,
      blocks:
        "Readership. Every other number starts from an order, so an article read by 8,000 " +
        "people who bought nothing is invisible — which is the branded-article question.",
      owner: "you",
      href: "/content",
      actionLabel: "See what it needs",
    });
  } else if (n(content?.n) === 0) {
    items.push({
      id: "ga4-no-data",
      title: "Google Analytics is connected but has no data yet",
      detail: "Credentials are set and nothing has been loaded.",
      blocks: "The readership page is empty until the first sync runs.",
      owner: "you",
      href: "/content",
      actionLabel: "Load it",
    });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    items.push({
      id: "anthropic-key",
      title: "Turn on the AI analyst",
      detail: "ANTHROPIC_API_KEY is not set. Needs an org admin to approve the request.",
      blocks: "The Ask page. Nothing else is affected.",
      owner: "external",
      href: "/ask",
      actionLabel: "See the page",
    });
  }

  if (!process.env.CRON_SECRET) {
    items.push({
      id: "cron-secret",
      title: "Set CRON_SECRET before going live",
      detail:
        "Not set, so the scheduled nightly refresh is disabled and /api/sync refuses everything.",
      blocks:
        "Nothing locally — the app refreshes itself while it is open. On a deployed instance it " +
        "is what keeps Instagram follower history from being lost, since Meta serves it over a " +
        "rolling 30 days and never republishes.",
      owner: "you",
    });
  }

  // ---- needs somebody else ------------------------------------------------------------
  if (n(social?.n) > 0) {
    items.push({
      id: "utm-organic",
      title: "Tag organic social links",
      detail: `${n(social?.n).toLocaleString()} visits from organic social carry no campaign tag.`,
      blocks:
        "The largest single source of traffic to the shop is anonymous — we can see it came " +
        "from Instagram but not which post, story or bio link.",
      owner: "someone-else",
      href: "/journeys",
      actionLabel: "See the coverage",
    });
  }

  if (n(newsletter?.n) > 0) {
    items.push({
      id: "utm-newsletter",
      title: "Add campaign names to newsletter links",
      detail: `${n(newsletter?.n)} newsletter visits carry no campaign name.`,
      blocks: "We know a visit came from the newsletter and nothing else about it.",
      owner: "someone-else",
    });
  }

  items.push({
    id: "esses-com-capture",
    title: "esses.com needs to pass UTM tags to checkout",
    detail:
      "Tags arriving on esses.com are discarded at the handoff to Shopify, so tagging those " +
      "ads changes nothing. Brief with working code is in docs/esses-com-attribution.md.",
    blocks:
      "All editorial-site attribution. Ads pointing at esses.com cannot be measured at all.",
    owner: "someone-else",
  });

  // ---- only time fixes it -------------------------------------------------------------
  items.push({
    id: "yoy-columns",
    title: "Year-on-year comparisons",
    detail:
      "Data starts 2025-10-01, so a year-ago column is empty for every range anyone looks at " +
      "until around October 2026.",
    blocks:
      "Nothing today. Listed so it does not get re-investigated monthly — and deliberately not " +
      "built, because a column that silently starts meaning something is worse than no column.",
    owner: "time",
  });

  const sorted = sortTodos(items);
  return { items: sorted, actionable: sorted.filter((i) => i.owner === "you").length };
}
