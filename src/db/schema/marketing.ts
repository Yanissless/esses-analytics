import {
  bigint,
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

export type AdSpend = typeof adSpend.$inferSelect;
export type AttributionTouchpoint = typeof attributionTouchpoints.$inferSelect;
export type AdInventoryDelivery = typeof adInventoryDelivery.$inferSelect;
