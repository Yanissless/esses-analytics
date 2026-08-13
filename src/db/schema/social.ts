/**
 * Social audience snapshots — follower counts over time.
 *
 * ## Why this is a snapshot table rather than a connector cache
 *
 * The obvious design is "sync follower counts from the Instagram Graph API nightly".
 * That does not work on its own, for a reason worth writing down because it is not
 * obvious and it shapes everything here:
 *
 *  - Instagram's `follower_count` insight returns a **rolling ~30-day window**. There is
 *    no endpoint that gives you the follower count on an arbitrary past date. So the API
 *    can keep this table current from the day it is wired up, but it can never backfill
 *    the history — and correlating follower growth against subscriber growth is exactly
 *    a question about history.
 *  - The four scopes needed (`instagram_basic`, `instagram_manage_insights`,
 *    `pages_show_list`, `pages_read_engagement`) were granted 12 Aug 2026 and the connector
 *    went live on 13 Aug. Everything dated before that is reconstructed or hand-entered and
 *    says so in `source`. Because of the rolling window above, that distinction is
 *    permanent — no later backfill can upgrade those days to observations.
 *
 * So the grain is a dated observation with a recorded **source**, and a manually entered
 * number is a first-class citizen rather than a stopgap. `source` exists so every chart
 * built on this can state its own provenance in line — the same thing `/shipping` does
 * when it falls back from actual label costs to rate-rule estimates. A follower series
 * that is half hand-entered and says so is worth more than one that looks authoritative
 * and isn't.
 *
 * One row per platform per day. Re-importing the same day updates it rather than
 * duplicating, so a corrected number replaces a wrong one.
 */
import {
  date,
  doublePrecision,
  integer,
  text,
  uniqueIndex,
  index,
  pgTable,
} from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";

export const socialAudience = pgTable(
  "social_audience",
  {
    id: pk(),

    /**
     * Open set, matching `attribution_touchpoints.channel` and the `SocialPlatform`
     * union in `metrics/social.ts` — instagram, facebook, threads, tiktok, youtube,
     * newsletter. Text rather than an enum so adding a platform is an insert, not a
     * migration.
     */
    platform: text("platform").notNull(),

    /** The day this observation describes, not the day it was recorded. */
    capturedOn: date("captured_on").notNull(),

    followers: integer("followers").notNull(),
    /** Accounts the profile follows. Optional — rarely available from a manual entry. */
    following: integer("following"),
    /** Lifetime post count, useful for normalising engagement against output. */
    posts: integer("posts"),

    /**
     * Where the number came from. Drives the coverage note on every chart:
     *  - `meta_api`   — Instagram Graph API, once the scopes above are granted.
     *  - `manual`     — typed in by a human, e.g. read off the Instagram app.
     *  - `csv`        — bulk import via `run.cmd import:social`.
     *  - `estimated`  — interpolated between two known points. Never a real observation;
     *                   excluded from correlation so a straight line can't manufacture one.
     */
    source: text("source").notNull(),

    /** Free text — "from IG app screenshot", "post-migration recount", etc. */
    note: text("note"),

    ...timestamps,
  },
  (t) => [
    // One observation per platform per day; a re-import corrects rather than duplicates.
    uniqueIndex("social_audience_platform_day_idx").on(t.platform, t.capturedOn),
    index("social_audience_captured_on_idx").on(t.capturedOn),
    index("social_audience_source_idx").on(t.source),
  ],
);

/**
 * Daily organic performance per platform — reach, views, engagement.
 *
 * Separate from `socialAudience` because these answer a different question and behave
 * differently. Follower count is a **level**: it exists on every date and carries over. Reach
 * is a **flow**: it belongs to a day and summing two days double-counts anyone who saw you on
 * both. Putting a flow in the same row as a level invites averaging the one and summing the
 * other by accident.
 *
 * ## Read `reach` and `views` as different questions, not one number and a rounder version
 *
 *  - **reach** — distinct accounts. De-duplicated *within* the window Meta was asked for, so
 *    28 days of reach is not the sum of 28 daily figures and will always be lower. The daily
 *    rows here are each de-duplicated within their own day.
 *  - **views** — total times content was seen, one account counted many times. Meta retired
 *    `impressions` and this replaced it; it is not the same definition, so a figure quoted
 *    from before the changeover is not comparable to one after it.
 *
 * Which means: never divide the two across different windows, and never present a 28-day
 * reach next to a summed 28-day views as if they share a denominator.
 *
 * ## Nullable on purpose
 *
 * Every metric is nullable and null means "Meta did not give us this", never zero. Meta
 * re-gates these individually — `profile_views` needs a business rather than creator account,
 * `impressions` vanished outright — and a metric that silently became 0 would read as "nobody
 * saw anything", which is a much worse lie than a blank.
 */
export const socialInsightsDaily = pgTable(
  "social_insights_daily",
  {
    id: pk(),
    /** Open set, same as `socialAudience.platform`. */
    platform: text("platform").notNull(),
    /** The day these figures describe. */
    capturedOn: date("captured_on").notNull(),

    /** Distinct accounts that saw any content. De-duplicated within the day. */
    reach: integer("reach"),
    /** Total content views. Meta's replacement for the retired `impressions`. */
    views: integer("views"),
    /** Profile page visits. */
    profileViews: integer("profile_views"),
    /** Distinct accounts that interacted at all. */
    accountsEngaged: integer("accounts_engaged"),
    /** Likes + comments + shares + saves. */
    totalInteractions: integer("total_interactions"),

    /** `meta_api` | `manual` | `csv`, same vocabulary as `socialAudience.source`. */
    source: text("source").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("social_insights_platform_day_idx").on(t.platform, t.capturedOn),
    index("social_insights_captured_on_idx").on(t.capturedOn),
  ],
);

/**
 * Audience composition — the share breakdowns that come with a follower export.
 *
 * Meta's audience export carries three distributions alongside the follower series: top
 * countries, top cities, and an age/gender grid, each as a **percentage of followers**.
 * They are snapshots rather than a time series: the export gives you the composition as of
 * the export, with no history, so the grain is one row per dimension key per export date.
 *
 * Stored generically (`dimension` + `key` + `sharePct`) rather than as three tables because
 * the shapes are identical and the platforms disagree about which breakdowns they offer.
 * Adding TikTok's or a newsletter's equivalent is an insert, not a migration.
 *
 * ⚠️ **`sharePct` is a share of FOLLOWERS, and it is truncated.** Meta reports one decimal
 * place and lists only the top ten, so a dimension's rows sum to well under 100 — for
 * countries here, about 81%. Anything computed from these must treat the total as the sum
 * of what is present, never as 100, or every share is silently inflated. The remainder is
 * a real "everyone else", not a rounding error.
 */
export const socialAudienceSegment = pgTable(
  "social_audience_segment",
  {
    id: pk(),
    platform: text("platform").notNull(),
    /** Export date — the composition is as-of, with no history behind it. */
    capturedOn: date("captured_on").notNull(),
    /** `country` | `city` | `age_gender`. Open set for the same reason `platform` is. */
    dimension: text("dimension").notNull(),
    /** As Meta labels it: "United States", "New York, NY", "25-34 / Men". */
    key: text("key").notNull(),
    /** Percentage of followers, 0-100, one decimal as reported. */
    sharePct: doublePrecision("share_pct").notNull(),
    source: text("source").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("social_segment_natural_key").on(t.platform, t.capturedOn, t.dimension, t.key),
    index("social_segment_dimension_idx").on(t.dimension),
  ],
);
