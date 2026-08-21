import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";

/**
 * Web traffic per page per day, from the GA4 Data API.
 *
 * ## Why this table exists at all, given everything else comes from orders
 *
 * Every other number in the app starts from an order, which means the app is blind to
 * traffic that never converts. An article read by 8,000 people who bought nothing is
 * invisible — and that is precisely the "branded article performance" question, because a
 * sponsored feature is often bought on readership rather than on sales it drove.
 *
 * ## What is deliberately NOT here
 *
 * No source, medium, campaign or session-attribution columns. GA4 runs its own attribution
 * model, it will disagree with ours, and there is no way to adjudicate between them from the
 * outside — so having both would mean two answers to "where did this revenue come from" and
 * no way to choose. Attribution stays in one place. This table is content metrics only.
 *
 * ## Grain and the provisional window
 *
 * One row per (date, page_path). GA4 keeps reprocessing recent days for up to ~48 hours, so
 * the newest rows change after they are first written — the same shape as ad platforms
 * restating spend. `is_provisional` records that per row rather than leaving the reader to
 * infer it from the sync clock, because a row written today for three days ago is settled
 * while a row written today for yesterday is not.
 */
export const contentMetrics = pgTable(
  "content_metrics",
  {
    id: pk(),
    date: date("date").notNull(),

    /** Path only, no host and no query string — see normalisePath in the connector. */
    pagePath: text("page_path").notNull(),
    /** GA4's page title at the time of the visit. Changes when a page is retitled. */
    pageTitle: text("page_title"),

    sessions: bigint("sessions", { mode: "number" }).notNull().default(0),
    /** GA4's `screenPageViews`. Named views here because "screen" means nothing for a website. */
    views: bigint("views", { mode: "number" }).notNull().default(0),
    /** GA4's `totalUsers` for the day — NOT summable across days without double counting. */
    users: bigint("users", { mode: "number" }).notNull().default(0),
    /** Sessions GA4 considers engaged: >10s, a conversion, or 2+ pageviews. */
    engagedSessions: bigint("engaged_sessions", { mode: "number" }).notNull().default(0),
    /** Total engagement time in seconds. Divide by sessions for an average; don't average averages. */
    engagementSeconds: bigint("engagement_seconds", { mode: "number" }).notNull().default(0),
    /** Sessions that STARTED on this page. The denominator for a landing-page read. */
    entrances: bigint("entrances", { mode: "number" }).notNull().default(0),

    /**
     * True when GA4 may still revise this row. Set for dates inside the processing window at
     * fetch time, and cleared when a later sync re-reads the same date outside that window.
     */
    isProvisional: boolean("is_provisional").notNull().default(false),

    ...timestamps,
  },
  (t) => [
    // The upsert target, and also the date index: Postgres can use a composite index for a
    // range on its leading column, so a separate index on date alone would be dead weight that
    // still has to be maintained on every write.
    uniqueIndex("content_metrics_date_path_key").on(t.date, t.pagePath),
    // Earns its place — "how has this one article performed over time" leads with the path,
    // which the composite index cannot serve.
    index("content_metrics_path_idx").on(t.pagePath),
  ],
);

/**
 * A day GA4 answered for, and what it said about that answer's completeness.
 *
 * ## Why a separate table rather than a column
 *
 * Two facts about a day are not facts about any single page in it. First, whether GA4
 * collapsed low-traffic paths into an `(other)` row: past a cardinality limit it stops
 * itemising and returns one bucket, so the per-page rows no longer add up to the day and any
 * "top pages account for X% of traffic" claim is wrong by an unknown amount. Second, whether
 * the response was sampled.
 *
 * Both are properties of the query, and both silently invalidate totals if unrecorded. Storing
 * them per day means a later reader can tell which days are safe to sum — a warning on the
 * sync run would be gone by the time anyone asked.
 */
export const contentDayQuality = pgTable(
  "content_day_quality",
  {
    id: pk(),
    date: date("date").notNull(),

    /** Rows GA4 itemised for this day, before the `(other)` bucket. */
    rowsReturned: integer("rows_returned").notNull().default(0),
    /**
     * GA4 collapsed the tail into `(other)`. When true, per-page rows do NOT sum to the day.
     */
    hasOtherRow: boolean("has_other_row").notNull().default(false),
    /** Sessions inside the `(other)` bucket, when there is one. The size of the blind spot. */
    otherSessions: bigint("other_sessions", { mode: "number" }).notNull().default(0),
    /** GA4 reported the response as sampled rather than complete. */
    sampled: boolean("sampled").notNull().default(false),

    /** Day totals as GA4 reports them WITHOUT the page dimension — the honest denominator. */
    totalSessions: bigint("total_sessions", { mode: "number" }).notNull().default(0),
    totalViews: bigint("total_views", { mode: "number" }).notNull().default(0),

    ...timestamps,
  },
  (t) => [uniqueIndex("content_day_quality_date_key").on(t.date)],
);

export type ContentMetric = typeof contentMetrics.$inferSelect;
export type NewContentMetric = typeof contentMetrics.$inferInsert;
export type ContentDayQuality = typeof contentDayQuality.$inferSelect;
