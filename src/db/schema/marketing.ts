import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { currency, money, pk, timestamps } from "./_shared";
import { adPlatform } from "./enums";
import { customers } from "./customers";
import { orders } from "./orders";

/** Daily ad spend at ad level, per platform (Section 6). Meta first; the same
 *  shape serves Google/TikTok when their connectors come online. */
export const adSpend = pgTable(
  "ad_spend",
  {
    id: pk(),
    platform: adPlatform("platform").notNull(),
    date: date("date").notNull(),
    accountId: text("account_id"),

    campaignId: text("campaign_id"),
    campaignName: text("campaign_name"),
    adsetId: text("adset_id"),
    adsetName: text("adset_name"),
    adId: text("ad_id"),
    adName: text("ad_name"),

    currency: currency().notNull().default("USD"),
    spendAmount: money("spend_amount").notNull().default(0),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    // Platform-reported (used to reconcile against our own attribution).
    platformConversions: doublePrecision("platform_conversions")
      .notNull()
      .default(0),
    platformConversionValueAmount: money("platform_conversion_value_amount")
      .notNull()
      .default(0),

    ...timestamps,
  },
  (t) => [
    // One row per platform/account/day/ad — re-syncing a day upserts it.
    uniqueIndex("ad_spend_natural_key").on(
      t.platform,
      t.accountId,
      t.date,
      t.adId,
    ),
    index("ad_spend_date_idx").on(t.date),
    index("ad_spend_campaign_idx").on(t.campaignId),
  ],
);

/**
 * Multi-touch attribution touchpoints (Section 8). `channel` is deliberately an
 * OPEN text set (paid-meta, paid-google, newsletter, onsite, organic, direct,
 * referral, …) so newsletter and on-site self-promo slot in without a migration.
 */
export const attributionTouchpoints = pgTable(
  "attribution_touchpoints",
  {
    id: pk(),
    customerId: uuid("customer_id").references(() => customers.id),
    sessionId: text("session_id"), // first-party session/click cookie
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),

    channel: text("channel").notNull(), // open set — see note above
    source: text("source"),
    medium: text("medium"),
    campaign: text("campaign"),
    content: text("content"),
    term: text("term"),

    clickId: text("click_id"), // fbclid / gclid / etc.
    clickIdType: text("click_id_type"),
    landingUrl: text("landing_url"),
    referrer: text("referrer"),

    // Set when this touchpoint is the converting checkout.
    orderId: uuid("order_id").references(() => orders.id),

    ...timestamps,
  },
  (t) => [
    index("touchpoints_customer_idx").on(t.customerId),
    index("touchpoints_session_idx").on(t.sessionId),
    index("touchpoints_occurred_at_idx").on(t.occurredAt),
    index("touchpoints_channel_idx").on(t.channel),
    index("touchpoints_order_idx").on(t.orderId),
  ],
);

/**
 * Advertiser-sold inventory delivery (Section 8a) — a distinct, simpler module.
 * `advertiser` NULL means an Esses self-promo house ad (which also feeds the
 * main attribution model as an "onsite" touchpoint). Advertisers care about
 * impressions delivered + CTR, not our internal MER/LTV.
 */
export const adInventoryDelivery = pgTable(
  "ad_inventory_delivery",
  {
    id: pk(),
    date: date("date").notNull(),
    placement: text("placement").notNull(), // unit/slot identifier
    advertiser: text("advertiser"), // NULL = self-promo house ad
    campaign: text("campaign"),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("inventory_date_idx").on(t.date),
    index("inventory_placement_idx").on(t.placement),
    index("inventory_advertiser_idx").on(t.advertiser),
  ],
);

/**
 * Ad creative previews — the picture, cached as bytes, plus where it came from.
 *
 * ## Why the image is stored rather than the URL
 *
 * Every image URL Meta returns is signed and expiring. A real one from this account carried
 * `oe=6A839ADE`, which decodes to 2026-08-17 — four days out. Storing URLs gives you a page
 * that works today, passes review, and quietly fills with broken images next week. So the
 * bytes are cached and served from our own route.
 *
 * Base64 in a text column rather than `bytea`: drizzle's postgres.js driver round-trips
 * Buffers awkwardly through raw SQL, and these are small. Correctness over elegance.
 *
 * ## Why `imageSource` exists
 *
 * No single field returns a usable picture. Ads resolve down a cascade, different ads stop at
 * different rungs, and the same page ends up showing previews of very different quality — so
 * the UI has to be able to say which is which rather than implying they are equivalent:
 *
 *  - `creative_image`  — an image ad's own asset. Full size.
 *  - `video_thumbnail` — a video ad's poster frame from `object_story_spec`. Full size.
 *  - `post_picture`    — a boosted post's picture, read from the post. Full size, and requires
 *                        a PAGE-scoped token: the user token returns error #10 even with
 *                        `pages_read_engagement` granted.
 *  - `thumbnail`       — the 64x64 `thumbnail_url`, present on everything. A floor, not a
 *                        choice: Meta silently ignores `.width(400).height(400)` on that
 *                        field, so 64px is genuinely all it will give.
 *
 * Only ads appearing in `ad_spend` get bytes downloaded. The account has ~679 creatives and
 * ~76 that actually spent money; fetching them all would be tens of MB of pictures for ads
 * nobody will look at.
 */
export const adCreative = pgTable(
  "ad_creative",
  {
    id: pk(),
    platform: adPlatform("platform").notNull(),
    /** Meta's ad ID. Joins to `ad_spend.ad_id`. */
    adId: text("ad_id").notNull(),
    adName: text("ad_name"),
    campaignId: text("campaign_id"),
    creativeId: text("creative_id"),
    /** Meta's own classification: SHARE, VIDEO, PHOTO, LINK … */
    objectType: text("object_type"),
    /** ACTIVE, PAUSED, ARCHIVED — so a dead creative is labelled rather than dropped. */
    status: text("status"),

    /** The cached picture, base64. Null when every rung of the cascade failed. */
    imageData: text("image_data"),
    /** `image/jpeg`, `image/png`. Needed to serve the bytes back correctly. */
    imageMime: text("image_mime"),
    /** Which rung produced it — drives the honesty label in the UI. */
    imageSource: text("image_source"),
    /** Byte size, so a 2KB 64px thumbnail can be told apart from a real asset. */
    imageBytes: doublePrecision("image_bytes"),

    /** Link to the live post when there is one, so someone can go look at the real thing. */
    permalink: text("permalink"),

    /**
     * Where the ad actually sends people, and whether it carries tracking.
     *
     * ## Why these are stored rather than fetched when needed
     *
     * On 31 Aug 2026 every one of the 57 active ads was pointing at
     * `esses.com/checkout?checkoutLink=…` — Craft, not Shopify — with 56 of the 57 carrying no
     * UTMs. A click landing on Craft produces no Shopify touchpoint at all, so that traffic is
     * invisible rather than merely untagged: traceable paid-meta touchpoints fell from 42 in
     * week 33 to 7 and 10 in the weeks after, while spend held around $1,800 a week.
     *
     * Nothing in the app could have noticed. Spend kept arriving, creatives kept syncing, and
     * the tagging figures read 100% because they measure the touchpoints that DO arrive — a
     * shrinking legacy population. The destination was the missing fact, and it was already
     * being fetched and then discarded.
     *
     * Stored so the check for it is a database query rather than a Graph call, and so the day a
     * destination changes is recorded rather than inferred afterwards from a collapse in
     * coverage.
     */
    destinationUrl: text("destination_url"),
    /** Host only, for grouping and for the observability check. */
    destinationHost: text("destination_host"),
    /**
     * True when the ad carries UTMs, from either Meta's `url_tags` field or the destination URL
     * itself. Both are used in practice — see docs/utm-tagging-status.md.
     */
    hasUrlTags: boolean("has_url_tags"),

    /** When the bytes were last fetched, so a stale cache is visible rather than assumed. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("ad_creative_platform_ad_idx").on(t.platform, t.adId),
    index("ad_creative_campaign_idx").on(t.campaignId),
  ],
);

export type AdSpend = typeof adSpend.$inferSelect;
export type AttributionTouchpoint = typeof attributionTouchpoints.$inferSelect;
export type AdInventoryDelivery = typeof adInventoryDelivery.$inferSelect;
export type AdCreative = typeof adCreative.$inferSelect;
