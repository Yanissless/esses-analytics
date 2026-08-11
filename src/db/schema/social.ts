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
import { date, integer, text, uniqueIndex, index, pgTable } from "drizzle-orm/pg-core";
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
