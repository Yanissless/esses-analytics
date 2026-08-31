/**
 * Invariants the live data must satisfy, checked against the real database.
 *
 * ## Why this exists rather than more unit tests
 *
 * Every silent data bug this project has hit passed its unit tests. The tests were right about
 * the logic; the data had drifted underneath them. A sample:
 *
 *  - Meta spend showed 43% of the real figure. Nothing was broken — a day had been fetched while
 *    it was still running, and nothing re-read it.
 *  - Shopify sat frozen for two weeks because a `partial` run's cursor was distrusted. Every run
 *    completed. Every test passed.
 *  - `order_profit` is materialised, so skipping its rebuild after a backfill silently
 *    under-reported `/international`. Correct code, stale table.
 *  - A `revenue_class` CASE existed in two files, each carrying a comment that it must match the
 *    other. Both were correct, so nothing ever failed — until one changed.
 *
 * What these have in common is that no single module was wrong. The failure was a relationship
 * BETWEEN modules or between a table and its source, which is precisely what a unit test with
 * mocked data cannot see. So each check below asserts a relationship, and each one is tied to a
 * specific failure that actually happened rather than to a hypothetical.
 *
 * ## Design rules
 *
 * A check states what it expects, what it found, and what to do — "FAIL" with a number and no
 * remedy is a check nobody acts on.
 *
 * Checks are read-only. This runs against production data, and a harness that repairs what it
 * finds would destroy the evidence of why it broke.
 *
 * Tolerances are explicit and justified where they exist. A tolerance without a stated reason is
 * indistinguishable from a bug being papered over.
 */

import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client";

export type Severity =
  /** A number somewhere is wrong right now. */
  | "error"
  /** Suspicious, or wrong under conditions worth naming. Read the detail. */
  | "warn"
  /** Holds. */
  | "ok"
  /** Could not be evaluated — usually a source that has never synced. */
  | "skip";

export interface CheckResult {
  name: string;
  severity: Severity;
  /** What was found, in numbers. */
  detail: string;
  /** What to do about it. Required on error/warn — a finding with no remedy goes unactioned. */
  remedy?: string;
  /** The specific past failure this check exists to catch. */
  guards: string;
}

interface Check {
  name: string;
  guards: string;
  run: () => Promise<Omit<CheckResult, "name" | "guards">>;
}

/**
 * First row of a query, or undefined. Every check below expects at most one row.
 *
 * The cast is here because `db.execute<T>` only resolves cleanly when T is concrete at the call
 * site; inside a generic wrapper drizzle cannot prove its row type matches T. Contained to this
 * one line deliberately — the alternative is repeating the spread-and-index at eleven call
 * sites, which is more code and more places to get the indexing wrong.
 */
const one = async <T extends Record<string, unknown>>(q: SQL): Promise<T | undefined> =>
  [...(await db.execute(q))][0] as T | undefined;

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const n = (v: unknown): number => Number(v ?? 0);

/**
 * The countable-order predicate, in one place.
 *
 * Duplicated from rollup.ts and order-profit.ts would be a third copy of exactly the pattern
 * this file exists to police — and a validator running against a different population than the
 * thing it validates is worse than no validator, because it produces confident nonsense.
 */
const COUNTABLE = sql`o.test = false AND o.cancelled_at IS NULL
  AND o.counts_as_revenue = true AND o.processed_at IS NOT NULL`;

const CHECKS: Check[] = [
  {
    name: "order_profit covers every countable order",
    guards:
      "order_profit is materialised by TRUNCATE + INSERT. A backfill that lands without a " +
      "rebuild leaves it short, and /international silently under-reports — correct code " +
      "reading a stale table.",
    run: async () => {
      const r = await one<{ orders: number; profit_rows: number; newest_order: string | null; computed: string | null }>(sql`
        SELECT (SELECT count(*) FROM orders o WHERE ${COUNTABLE})::int        AS orders,
               (SELECT count(*) FROM order_profit)::int                      AS profit_rows,
               (SELECT max(processed_at)::text FROM orders o WHERE ${COUNTABLE}) AS newest_order,
               (SELECT max(computed_at)::text FROM order_profit)             AS computed
      `);
      const orders = n(r?.orders);
      const rows = n(r?.profit_rows);
      if (rows === 0 && orders > 0) {
        return {
          severity: "error",
          detail: `${orders} countable orders, 0 rows in order_profit`,
          remedy: "run.cmd metrics",
        };
      }
      if (orders !== rows) {
        return {
          severity: "error",
          detail: `${orders} countable orders vs ${rows} order_profit rows (${orders - rows} missing)`,
          remedy: "run.cmd metrics — order_profit is rebuilt wholesale, not incrementally",
        };
      }
      return {
        severity: "ok",
        detail: `${rows} rows, matching orders; computed ${r?.computed ?? "—"}`,
      };
    },
  },

  {
    name: "revenue_class partitions every order exactly once",
    guards:
      "The CASE existed in two files, each with a comment saying it must match the other. Both " +
      "were correct, so nothing failed — which is why the drift would have been invisible.",
    run: async () => {
      const r = await one<{ rows: number; classified: number; classes: string }>(sql`
        SELECT count(*)::int                                              AS rows,
               count(*) FILTER (WHERE revenue_class IS NOT NULL)::int     AS classified,
               string_agg(DISTINCT revenue_class, ', ' ORDER BY revenue_class) AS classes
          FROM order_profit
      `);
      const rows = n(r?.rows);
      if (rows === 0) return { severity: "skip", detail: "order_profit is empty" };
      const unclassified = rows - n(r?.classified);
      if (unclassified > 0) {
        return {
          severity: "error",
          detail: `${unclassified} of ${rows} rows have no revenue_class`,
          remedy:
            "Every branch of REVENUE_CLASS_CASE should be total — an ELSE that can be reached " +
            "with NULL means a class was added without a branch. See metrics/revenue-class.ts",
        };
      }
      return { severity: "ok", detail: `${rows} rows, classes: ${r?.classes}` };
    },
  },

  {
    name: "daily_metrics revenue agrees with the orders it came from",
    guards:
      "daily_metrics is a rollup. If it and the order table disagree, every dashboard reading " +
      "the rollup is wrong while every query against orders looks fine.",
    run: async () => {
      // Paid boundary on both sides. daily_metrics is always on the paid-order boundary because
      // that matches MER's revenue base, so comparing it to all classes would show a false gap.
      //
      // The rollup adds Stripe invoices, which order_profit does not carry. An earlier version
      // of this check compared the two and asked a human to eyeball whether the difference
      // "looked like Stripe" — which is not a check, it is a note. Stripe's contribution is
      // queryable, so the identity is now closed: rollup == Shopify paid + Stripe paid.
      const r = await one<{ rollup: number; shopify: number; stripe: number; days: number }>(sql`
        WITH m AS (
          SELECT COALESCE(sum(revenue_amount), 0)::bigint AS rollup,
                 count(*)::int                            AS days,
                 min(date)                                AS d0,
                 max(date)                                AS d1
            FROM daily_metrics
            -- The blended row ONLY. daily_metrics is grained (date, channel) with NULL meaning
            -- blended, so an unfiltered sum adds the per-channel rows on top of the blend. The
            -- first version of this check omitted this line and still reported a $0.00 gap,
            -- because revenue happens to be written only to the blended row while ad spend is
            -- written to both — so it passed for the wrong reason and would have started lying
            -- the moment a channel row carried revenue. See the channel-grain check below.
           WHERE channel IS NULL
        ),
        o AS (
          SELECT COALESCE(sum(net_ex_vat_amount), 0)::bigint AS shopify
            FROM order_profit, m
           WHERE revenue_class = 'paid'
             AND processed_on BETWEEN m.d0 AND m.d1
        ),
        s AS (
          SELECT COALESCE(sum(amount_paid_amount), 0)::bigint AS stripe
            FROM stripe_invoices, m
           WHERE invoiced_at IS NOT NULL
             AND invoiced_at::date BETWEEN m.d0 AND m.d1
        )
        SELECT m.rollup, o.shopify, s.stripe, m.days FROM m, o, s
      `);
      if (n(r?.days) === 0) return { severity: "skip", detail: "daily_metrics is empty" };

      const rollup = n(r?.rollup);
      const shopify = n(r?.shopify);
      const stripe = n(r?.stripe);
      const expected = shopify + stripe;
      const gap = Math.abs(rollup - expected);

      // 0.5%, for rounding across ~300 daily rows each rounded independently. Not a fudge
      // factor for a real discrepancy: a genuine drift is a missing rebuild or a changed
      // predicate, both of which move the number by far more than rounding.
      const tolerance = Math.max(expected * 0.005, 5_00);
      if (gap > tolerance) {
        return {
          severity: "error",
          detail:
            `rollup ${money(rollup)} vs Shopify paid ${money(shopify)} + Stripe ${money(stripe)} ` +
            `= ${money(expected)} — unexplained gap ${money(gap)}`,
          remedy:
            "run.cmd metrics to rebuild, then re-check. If the gap survives a rebuild, the " +
            "rollup's revenue predicate and order_profit's have diverged — compare the WHERE " +
            "clauses in metrics/rollup.ts and metrics/order-profit.ts.",
        };
      }
      return {
        severity: "ok",
        detail:
          `rollup ${money(rollup)} = Shopify ${money(shopify)} + Stripe ${money(stripe)} ` +
          `over ${n(r?.days)} days (gap ${money(gap)}, within rounding)`,
      };
    },
  },

  {
    name: "daily_metrics channel rows stay within the blended row",
    guards:
      "daily_metrics is grained (date, channel) where NULL means blended, so any sum that " +
      "forgets to filter channel IS NULL double-counts. That is not hypothetical: the first " +
      "version of the revenue check above forgot it, and reported a $0.00 gap anyway — passing " +
      "for the wrong reason — because revenue is written only to the blended row while ad " +
      "spend is written to both. A naive sum of this table reads ad spend at roughly 2× and " +
      "halves MER.",
    run: async () => {
      const r = await one<{
        rows: number;
        dates: number;
        blended: number;
        bad_spend: number;
        channel_revenue: number;
      }>(sql`
        WITH per_day AS (
          SELECT date,
                 COALESCE(sum(ad_spend_amount) FILTER (WHERE channel IS NULL), 0)     AS blended_spend,
                 COALESCE(sum(ad_spend_amount) FILTER (WHERE channel IS NOT NULL), 0) AS channel_spend,
                 COALESCE(sum(revenue_amount)  FILTER (WHERE channel IS NOT NULL), 0) AS channel_rev
            FROM daily_metrics
           GROUP BY date
        )
        SELECT (SELECT count(*) FROM daily_metrics)::int                        AS rows,
               (SELECT count(DISTINCT date) FROM daily_metrics)::int            AS dates,
               (SELECT count(*) FROM daily_metrics WHERE channel IS NULL)::int  AS blended,
               -- Per-channel spend above the blended figure would mean the split invented
               -- money rather than dividing it.
               count(*) FILTER (WHERE channel_spend > blended_spend)::int        AS bad_spend,
               count(*) FILTER (WHERE channel_rev > 0)::int                      AS channel_revenue
          FROM per_day
      `);

      const rows = n(r?.rows);
      if (rows === 0) return { severity: "skip", detail: "daily_metrics is empty" };

      if (n(r?.bad_spend) > 0) {
        return {
          severity: "error",
          detail: `${n(r?.bad_spend)} day(s) where per-channel spend exceeds the blended row`,
          remedy:
            "The channel split is inventing spend rather than dividing it. Compare the two " +
            "INSERT statements in metrics/rollup.ts — the blended write and the per-channel " +
            "write — then run.cmd metrics.",
        };
      }

      // Not an error: revenue on a channel row would be a legitimate design change. But it
      // would silently break every unfiltered sum, so it must be noticed the day it happens.
      if (n(r?.channel_revenue) > 0) {
        return {
          severity: "warn",
          detail: `${n(r?.channel_revenue)} day(s) carry revenue on a per-channel row`,
          remedy:
            "Today only the blended row carries revenue. If that changed deliberately, audit " +
            "every sum over daily_metrics for a missing `channel IS NULL` — the revenue check " +
            "above depends on this being true.",
        };
      }

      return {
        severity: "ok",
        detail:
          `${rows} rows over ${n(r?.dates)} date(s), ${n(r?.blended)} blended; ` +
          `channel spend within the blend, no revenue on channel rows`,
      };
    },
  },

  {
    name: "ad spend goes somewhere we can measure",
    guards:
      "On 31 Aug 2026 all 57 active ads were found pointing at esses.com/checkout — Craft, not " +
      "Shopify — with 56 of 57 carrying no UTMs. A click landing on Craft creates no Shopify " +
      "touchpoint, so the spend is invisible rather than untagged. Traceable paid-meta " +
      "touchpoints fell from 42 in week 33 to 7 and 10 after, while spend held near $1,800 a " +
      "week. Nothing noticed, and here is the nasty part: the tagging coverage figures read " +
      "100% throughout, because they measure the touchpoints that DO arrive. A coverage metric " +
      "built on touchpoints gets BETTER as ads stop producing them.",
    run: async () => {
      const r = await one<{
        active: number;
        unobservable: number;
        untagged: number;
        spend_cents: number;
        hosts: string | null;
      }>(sql`
        WITH live AS (
          SELECT c.ad_id, c.destination_host, c.has_url_tags
            FROM ad_creative c
           WHERE c.platform = 'meta' AND upper(COALESCE(c.status, '')) = 'ACTIVE'
        ),
        recent_spend AS (
          SELECT ad_id, sum(spend_amount) AS cents
            FROM ad_spend
           WHERE platform = 'meta' AND date > current_date - 30
           GROUP BY 1
        )
        SELECT count(*)::int AS active,
               count(*) FILTER (
                 WHERE l.destination_host IS NOT NULL
                   AND l.destination_host NOT LIKE '%myshopify.com'
                   AND l.destination_host NOT LIKE '%shop.app'
                   AND l.destination_host NOT LIKE '%shopify.com'
               )::int AS unobservable,
               count(*) FILTER (WHERE l.has_url_tags IS NOT TRUE)::int AS untagged,
               COALESCE(sum(s.cents) FILTER (
                 WHERE l.destination_host IS NOT NULL
                   AND l.destination_host NOT LIKE '%myshopify.com'
                   AND l.destination_host NOT LIKE '%shop.app'
                   AND l.destination_host NOT LIKE '%shopify.com'
               ), 0)::bigint AS spend_cents,
               -- Named by SPEND, not alphabetically. A plain string_agg listed
               -- "www.essesmag.com, www.eventbrite.com" — two hosts with no money on them —
               -- while esses.com held $8,802 and went unmentioned. A check that names the
               -- wrong host sends somebody to fix the wrong thing.
               (SELECT string_agg(h.destination_host || ' (' || to_char(h.cents / 100.0, 'FM$999,999') || ')', ', ')
                  FROM (
                    SELECT l2.destination_host, COALESCE(sum(s2.cents), 0) AS cents
                      FROM live l2
                      LEFT JOIN recent_spend s2 ON s2.ad_id = l2.ad_id
                     WHERE l2.destination_host IS NOT NULL
                       AND l2.destination_host NOT LIKE '%myshopify.com'
                       AND l2.destination_host NOT LIKE '%shop.app'
                       AND l2.destination_host NOT LIKE '%shopify.com'
                     GROUP BY 1
                     ORDER BY 2 DESC
                     LIMIT 3
                  ) h)                                   AS hosts
          FROM live l
          LEFT JOIN recent_spend s ON s.ad_id = l.ad_id
      `);

      const active = n(r?.active);
      if (active === 0) {
        return {
          severity: "skip",
          detail: "no active Meta creatives stored — run a creatives sync",
        };
      }

      if (n(r?.unobservable) > 0) {
        return {
          severity: "error",
          detail:
            `${n(r?.unobservable)} of ${active} active ads send people to ${r?.hosts}, which ` +
            `records no touchpoint. ${money(n(r?.spend_cents))} spent there in the last 30 days ` +
            `cannot be attributed to anything.`,
          remedy:
            "Either point the ads back at Shopify, or finish the esses.com capture brief in " +
            "docs/esses-com-attribution.md so Craft forwards the tags to checkout. Tagging the " +
            "ads alone will not help while the destination discards them.",
        };
      }

      if (n(r?.untagged) > 0) {
        return {
          severity: "warn",
          detail: `${n(r?.untagged)} of ${active} active ads land on Shopify but carry no UTMs`,
          remedy:
            "The visit is recorded but cannot be traced to a specific ad. Append UTMs to the " +
            "destination URL or set them in Ads Manager's URL parameters field.",
        };
      }

      return {
        severity: "ok",
        detail: `all ${active} active ads land somewhere we record, carrying UTMs`,
      };
    },
  },

  {
    name: "no ad spend day is double-counted",
    guards:
      "Meta conversions were once triple-counted. Spend arrives per ad per day, and a second " +
      "row for the same key would inflate spend and deflate every ROAS built on it.",
    run: async () => {
      const r = await one<{ dupes: number; worst: string | null }>(sql`
        WITH d AS (
          SELECT platform, date, COALESCE(ad_id, '(none)') AS ad_id, count(*) AS c
            FROM ad_spend GROUP BY 1, 2, 3 HAVING count(*) > 1
        )
        SELECT count(*)::int AS dupes,
               (SELECT platform || ' ' || date::text || ' ×' || c FROM d ORDER BY c DESC LIMIT 1) AS worst
          FROM d
      `);
      const dupes = n(r?.dupes);
      if (dupes > 0) {
        return {
          severity: "error",
          detail: `${dupes} (platform, date, ad_id) keys appear more than once — worst: ${r?.worst}`,
          remedy:
            "The connector should upsert on that key. Check the ON CONFLICT target matches the " +
            "unique index, then re-sync the affected platform with --full.",
        };
      }
      return { severity: "ok", detail: "no duplicate (platform, date, ad) rows" };
    },
  },

  {
    name: "ad spend has no negative or absurd days",
    guards:
      "A restated day can arrive negative from a platform credit. Left in, it silently flatters " +
      "MER and CAC — the flattering direction, which is the one nobody questions.",
    run: async () => {
      const r = await one<{ neg: number; total: number; max_day: number }>(sql`
        SELECT count(*) FILTER (WHERE spend_amount < 0)::int AS neg,
               count(*)::int                                AS total,
               COALESCE(max(spend_amount), 0)::bigint       AS max_day
          FROM ad_spend
      `);
      if (n(r?.total) === 0) return { severity: "skip", detail: "no ad spend stored" };
      if (n(r?.neg) > 0) {
        return {
          severity: "warn",
          detail: `${n(r?.neg)} row(s) with negative spend`,
          remedy:
            "Usually a platform credit or a restatement. Confirm against the platform's own " +
            "billing before treating the total as correct.",
        };
      }
      return {
        severity: "ok",
        detail: `${n(r?.total)} rows, largest single row ${money(n(r?.max_day))}`,
      };
    },
  },

  {
    name: "no order carries a duplicated shipping charge",
    guards:
      "The label-cost sync keyed its invoice on the sync WINDOW, so a rolling window produced " +
      "a new invoice every night and re-recorded labels it had already stored. 1,038 orders " +
      "ended up with the same charge up to five times — order #13818 carried an identical " +
      "$59.46 five times — double-counting about $16,975 of shipping cost. Shipping is a CM2 " +
      "component, so it was pushing margin DOWN: wrong in the pessimistic direction, which is " +
      "the one nobody questions.",
    run: async () => {
      const r = await one<{ dupes: number; extra: number; worst: string | null }>(sql`
        WITH per_order AS (
          SELECT order_id,
                 count(*)                                   AS charges,
                 sum(total_amount) - max(total_amount)       AS extra
            FROM shipping_charges
           WHERE order_id IS NOT NULL
           GROUP BY order_id
          HAVING count(*) > 1
        )
        SELECT count(*)::int                       AS dupes,
               COALESCE(sum(extra), 0)::bigint     AS extra,
               (SELECT o.order_number || ' ×' || p.charges
                  FROM per_order p JOIN orders o ON o.id = p.order_id
                 ORDER BY p.extra DESC LIMIT 1)    AS worst
          FROM per_order
      `);

      const dupes = n(r?.dupes);
      if (dupes === 0) {
        return { severity: "ok", detail: "every order has at most one shipping charge" };
      }
      /*
       * An order genuinely CAN ship in two parcels, so this is a warning rather than an error.
       * What made the original case obviously wrong was the shape: charges per order matched
       * the number of overlapping invoices exactly, and the amounts were identical rather than
       * merely similar. Read the detail before assuming either way.
       */
      return {
        severity: "warn",
        detail: `${dupes} order(s) carry more than one shipping charge, ${money(n(r?.extra))} beyond the largest each — worst: ${r?.worst}`,
        remedy:
          "Check whether those orders really shipped more than once. If the extra charges are " +
          "identical amounts from different invoices, it is the duplicate-invoice bug: the " +
          "sync now keys one invoice per calendar month, so delete the overlapping auto-synced " +
          "invoices (charges cascade) and re-run run.cmd sync, then run.cmd metrics.",
      };
    },
  },

  {
    name: "every stored shipping charge reaches an order",
    guards:
      "A charge row with no order is cost no margin figure carries. The earlier version of " +
      "this check compared an invoice's billed total against its allocated total and reported " +
      "36% unallocated with 'margin is overstated by up to this amount' — which read as a job " +
      "for somebody. It wasn't. Every stored charge was attached; the gap was labels for " +
      "orders placed BEFORE the data window (our first order is #5684 on 2025-10-01, and the " +
      "unmatched labels were #5489, #5494, #5607…) which shipped inside it. Excluding those is " +
      "correct — costing an order whose revenue we do not hold would understate margin, not " +
      "improve it. So this checks the thing that would actually be wrong.",
    run: async () => {
      const r = await one<{ rows: number; orphans: number; orphan_cents: number; attached: number }>(sql`
        SELECT count(*)::int                                                  AS rows,
               count(*) FILTER (WHERE order_id IS NULL)::int                  AS orphans,
               COALESCE(sum(total_amount) FILTER (WHERE order_id IS NULL), 0)::bigint AS orphan_cents,
               COALESCE(sum(total_amount) FILTER (WHERE order_id IS NOT NULL), 0)::bigint AS attached
          FROM shipping_charges
      `);
      if (n(r?.rows) === 0) return { severity: "skip", detail: "no shipping charges stored" };

      if (n(r?.orphans) > 0) {
        return {
          severity: "warn",
          detail: `${n(r?.orphans)} charge row(s) worth ${money(n(r?.orphan_cents))} have no order attached`,
          remedy:
            "A charge is stored to be costed against an order. Either the match failed or the " +
            "row should not have been kept — check lib/shipping/match.ts, then re-run " +
            "run.cmd sync and run.cmd metrics.",
        };
      }
      return {
        severity: "ok",
        detail: `all ${n(r?.rows)} charge(s) attached to an order, ${money(n(r?.attached))} carried into margin`,
      };
    },
  },

  {
    name: "no shipping invoice is an empty shell",
    guards:
      "An invoice exists to hold charges. One with a billed total and no charges inflates any " +
      "billed-versus-allocated comparison while contributing nothing — three such rows " +
      "(Jul–Sep 2025, $5,016) were created by the monthly rewrite for months that predate the " +
      "order history entirely.",
    run: async () => {
      const r = await one<{ empties: number; cents: number; refs: string | null }>(sql`
        WITH e AS (
          SELECT i.invoice_ref, i.total_amount
            FROM shipping_invoices i
           WHERE NOT EXISTS (SELECT 1 FROM shipping_charges c WHERE c.invoice_id = i.id)
        )
        SELECT count(*)::int                              AS empties,
               COALESCE(sum(total_amount), 0)::bigint     AS cents,
               string_agg(invoice_ref, ', ')              AS refs
          FROM e
      `);
      if (n(r?.empties) === 0) {
        return { severity: "ok", detail: "every invoice holds at least one charge" };
      }
      return {
        severity: "warn",
        detail: `${n(r?.empties)} invoice(s) with no charges, ${money(n(r?.cents))} billed: ${r?.refs}`,
        remedy:
          "Harmless to margin — nothing reads them — but they distort any billed-versus-" +
          "allocated figure. The sync no longer creates them; delete these to tidy up.",
      };
    },
  },

  {
    name: "attributed revenue does not exceed total revenue",
    guards:
      "Attribution splits a total; it cannot create one. Exceeding the total means an order is " +
      "being counted under more than one channel.",
    run: async () => {
      const r = await one<{ attributed: number; total: number }>(sql`
        SELECT (SELECT COALESCE(sum(net_ex_vat_amount), 0)::bigint
                  FROM order_profit WHERE revenue_class = 'paid')                AS total,
               (SELECT COALESCE(count(DISTINCT order_id), 0)::bigint
                  FROM attribution_touchpoints WHERE order_id IS NOT NULL)       AS attributed
      `);
      const total = n(r?.total);
      if (total === 0) return { severity: "skip", detail: "no paid revenue stored" };
      const orders = await one<{ paid_orders: number }>(sql`
        SELECT count(*)::int AS paid_orders FROM order_profit WHERE revenue_class = 'paid'
      `);
      const attributedOrders = n(r?.attributed);
      const paidOrders = n(orders?.paid_orders);
      if (attributedOrders > paidOrders) {
        return {
          severity: "error",
          detail: `${attributedOrders} attributed orders vs ${paidOrders} paid orders`,
          remedy:
            "A converting touchpoint should be unique per order. Check for duplicate rows in " +
            "attribution_touchpoints with the same order_id.",
        };
      }
      const coverage = paidOrders > 0 ? attributedOrders / paidOrders : null;
      return {
        severity: "ok",
        detail:
          `${attributedOrders} of ${paidOrders} paid orders have a converting touchpoint` +
          (coverage !== null ? ` (${(coverage * 100).toFixed(1)}% coverage)` : ""),
      };
    },
  },

  {
    name: "every prepaid plan has a confirmed renewal price",
    guards:
      "The annual plan was priced from average order value at $26.28 against a real $100 — 3.8× " +
      "low — because Skio queues a quarterly delivery order against one annual charge. The " +
      "forecast was wrong in the direction that looks like underperformance.",
    run: async () => {
      const r = await one<{ plans: number; unpriced: number; names: string | null }>(sql`
        WITH active AS (
          SELECT COALESCE(selling_plan_name, '(unnamed)') AS plan, count(*) AS subs
            FROM subscription_meta
           WHERE status = 'active'
           GROUP BY 1
        )
        SELECT count(*)::int AS plans, 0::int AS unpriced,
               string_agg(plan || ' (' || subs || ')', ', ' ORDER BY subs DESC) AS names
          FROM active
      `);
      if (n(r?.plans) === 0) return { severity: "skip", detail: "no active subscriptions" };
      // Deliberately reports rather than asserts: the price table lives in TypeScript
      // (metrics/plan-prices.ts) so SQL cannot check membership without duplicating it — and a
      // second copy of the price list is the exact failure mode this whole file is about.
      return {
        severity: "ok",
        detail: `${n(r?.plans)} active plan name(s): ${r?.names}`,
        remedy:
          "Cross-check against PLAN_RENEWAL_PRICES in metrics/plan-prices.ts. A plan appearing " +
          "here that is absent there gets its price derived from MRR, which is how the annual " +
          "plan came out 3.8× low.",
      };
    },
  },

  {
    name: "no Instagram follower day implies an impossible jump",
    guards:
      "Splicing two insight chains with different anchors invented a +150-follower day. Meta " +
      "serves this over a rolling 30 days and never republishes, so a bad row is permanent.",
    run: async () => {
      // No `.catch` here, deliberately. An earlier version swallowed query errors into a
      // "skip", and because the column name was wrong it reported "no follower history stored"
      // while 43,449 followers sat in the table. That is the same silent-skip failure this whole
      // file exists to catch, reproduced inside the checker. A broken query must surface as an
      // error — the outer handler in runValidation does that.
      const r = await one<{ days: number; jumps: number; worst: number | null }>(sql`
        WITH d AS (
          SELECT captured_on, followers,
                 followers - lag(followers) OVER (ORDER BY captured_on) AS delta
            FROM social_audience
           WHERE platform = 'instagram' AND followers IS NOT NULL
        )
        SELECT (SELECT count(*) FROM d)::int                             AS days,
               count(*) FILTER (WHERE abs(delta) > 500)::int             AS jumps,
               max(abs(delta))::int                                      AS worst
          FROM d WHERE delta IS NOT NULL
      `);

      if (!r || n(r.days) === 0) {
        return { severity: "skip", detail: "no follower history stored" };
      }
      if (n(r.jumps) > 0) {
        return {
          severity: "warn",
          detail: `${n(r.jumps)} day(s) move by more than 500 followers (largest ${r.worst})`,
          remedy:
            "Could be real (a viral post) or spliced chains. Check the days either side are " +
            "from one continuous insight window before quoting growth.",
        };
      }
      return {
        severity: "ok",
        detail: `${n(r.days)} days, largest daily move ${r.worst ?? 0}`,
      };
    },
  },

  {
    name: "content_metrics never exceeds its own day totals",
    guards:
      "Per-page rows and day totals come from two separate GA4 queries. Per-page exceeding the " +
      "total means they are being compared across mismatched windows, which would make every " +
      "traffic share on /content wrong.",
    run: async () => {
      const r = await one<{ days: number; bad: number; worst: string | null }>(sql`
        WITH j AS (
          SELECT q.date,
                 q.total_sessions,
                 COALESCE(sum(m.sessions), 0) AS itemised
            FROM content_day_quality q
            LEFT JOIN content_metrics m ON m.date = q.date
           GROUP BY q.date, q.total_sessions
        )
        SELECT count(*)::int                                          AS days,
               count(*) FILTER (WHERE itemised > total_sessions)::int  AS bad,
               (SELECT date::text || ': ' || itemised || ' > ' || total_sessions
                  FROM j WHERE itemised > total_sessions
                 ORDER BY itemised - total_sessions DESC LIMIT 1)      AS worst
          FROM j
      `);

      if (!r || n(r.days) === 0) return { severity: "skip", detail: "no GA4 content stored" };
      if (n(r.bad) > 0) {
        return {
          severity: "error",
          detail: `${n(r.bad)} day(s) where per-page sessions exceed the day total — ${r.worst}`,
          remedy:
            "The two queries must cover the same window. Re-sync GA4 for the affected dates: " +
            "run.cmd sync --source=ga4",
        };
      }
      return { severity: "ok", detail: `${n(r.days)} day(s), all within their totals` };
    },
  },

  {
    name: "no order is counted in both Shopify and Stripe revenue",
    guards:
      "A Shopify order created only to ship an issue to a Stripe subscriber shows a nominal " +
      "price while $0 was collected. Counting it would double-count against the Stripe invoice.",
    run: async () => {
      const r = await one<{ fulfilment_counted: number; total_fulfilment: number }>(sql`
        SELECT count(*) FILTER (WHERE counts_as_revenue = true)::int AS fulfilment_counted,
               count(*)::int                                        AS total_fulfilment
          FROM orders
         WHERE order_type = 'subscription_stripe_fulfillment'
      `);
      if (n(r?.total_fulfilment) === 0) {
        return { severity: "skip", detail: "no Stripe fulfilment orders" };
      }
      if (n(r?.fulfilment_counted) > 0) {
        return {
          severity: "error",
          detail: `${n(r?.fulfilment_counted)} Stripe-fulfilment order(s) flagged as countable revenue`,
          remedy:
            "These must carry counts_as_revenue = false. Fix the connector's mapping, then " +
            "re-sync Shopify with --full and run.cmd metrics.",
        };
      }
      return {
        severity: "ok",
        detail: `${n(r?.total_fulfilment)} Stripe-fulfilment orders, all excluded from revenue`,
      };
    },
  },

  {
    name: "no sync source has silently stopped",
    guards:
      "Shopify's cursor froze for two weeks. Every run completed, the page looked healthy, and " +
      "the only visible symptom was numbers that stopped moving.",
    run: async () => {
      const r = await db.execute<{ source: string; hours: number; status: string }>(sql`
        SELECT DISTINCT ON (source)
               source,
               EXTRACT(EPOCH FROM (now() - finished_at)) / 3600 AS hours,
               status
          FROM sync_runs
         WHERE finished_at IS NOT NULL
         ORDER BY source, finished_at DESC
      `);
      const rows = [...r];
      if (rows.length === 0) return { severity: "skip", detail: "nothing has ever synced" };
      const stale = rows.filter((x) => n(x.hours) > 26);
      if (stale.length > 0) {
        return {
          severity: "warn",
          detail: stale.map((s) => `${s.source} ${Math.round(n(s.hours))}h ago`).join(", "),
          // Phrased to read correctly in both places this appears: the CLI, and the Data
          // updates page itself — where "open /data" would be telling you to go where you are.
          remedy:
            "The Data updates page lists every run; check whether they are failing or simply " +
            "not starting, then run UPDATE DATA.",
        };
      }
      return {
        severity: "ok",
        detail: `${rows.length} source(s), newest run ${Math.round(Math.min(...rows.map((x) => n(x.hours))))}h ago`,
      };
    },
  },
];

export interface ValidationReport {
  results: CheckResult[];
  errors: number;
  warnings: number;
  skipped: number;
  ms: number;
}

/**
 * Run every check.
 *
 * A check that throws becomes an `error` result rather than aborting the run: one broken query
 * must not hide the other nine findings, which is the same containment rule the sync loop uses.
 */
export async function runValidation(): Promise<ValidationReport> {
  const started = Date.now();
  const results: CheckResult[] = [];

  for (const check of CHECKS) {
    try {
      const r = await check.run();
      results.push({ name: check.name, guards: check.guards, ...r });
    } catch (err) {
      results.push({
        name: check.name,
        guards: check.guards,
        severity: "error",
        detail: `check itself failed: ${err instanceof Error ? err.message : String(err)}`,
        remedy: "The check's query is broken — fix it before trusting the rest of this report.",
      });
    }
  }

  return {
    results,
    errors: results.filter((r) => r.severity === "error").length,
    warnings: results.filter((r) => r.severity === "warn").length,
    skipped: results.filter((r) => r.severity === "skip").length,
    ms: Date.now() - started,
  };
}

/** Names of every check, for tests that assert the registry hasn't silently shrunk. */
export const CHECK_NAMES = CHECKS.map((c) => c.name);
