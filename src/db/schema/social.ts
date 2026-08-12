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
 *    `pages_show_list`, `pages_read_engagement`) are, as of 11 Aug 2026, all missing from
 *    the token, and the app can see 0 Pages. See `SOCIAL_PLATFORM_METRICS_GAP` in
 *    `metrics/social.ts`, which has listed "Follower count and growth" as the first
 *    missing metric since the social dashboard was built.
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
