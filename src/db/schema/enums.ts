import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Application roles (Section 10).
 *
 * `marketing` is a restricted read role: acquisition and cohort performance, but no
 * cost/margin data and no individual customer records. What each role can actually
 * reach is defined once in `lib/auth/capabilities.ts` — don't compare roles directly
 * in a page, ask for a capability.
 */
export const userRole = pgEnum("user_role", ["admin", "viewer", "marketing"]);

/**
 * Order origin.
 *  - `one_time`: normal purchase — real Shopify revenue.
 *  - `subscription_shopify`: Skio-driven recurring order via Shopify checkout —
 *    real Shopify revenue (see the dedup gotcha in Section 3).
 *  - `subscription_stripe_fulfillment`: a Shopify order created only to ship an
 *    issue to a Stripe/Craft print subscriber. It shows a nominal price (e.g.
 *    $35) but $0 was actually received in Shopify — the real money is the Stripe
 *    invoice. These are flagged counts_as_revenue = false so they are NOT
 *    counted as Shopify revenue (would double-count against Stripe).
 */
export const orderType = pgEnum("order_type", [
  "one_time",
  "subscription_shopify",
  "subscription_stripe_fulfillment",
]);

/** Which Stripe revenue line an object belongs to (Section 3). */
export const subscriptionLine = pgEnum("subscription_line", [
  "print",
  "digital",
]);

/** Normalised subscription status across Skio + Stripe. Raw provider status is
 *  also stored as free text alongside this. */
export const subStatus = pgEnum("sub_status", [
  "active",
  "trialing",
  "past_due",
  "paused",
  "canceled",
  "expired",
  "unpaid",
]);

/** Ad platforms. Extensible via `ALTER TYPE ... ADD VALUE` (a trivial migration)
 *  when Google/TikTok come online. */
export const adPlatform = pgEnum("ad_platform", [
  "meta",
  "google_ads",
  "tiktok",
  "other",
]);

/** Lifecycle of a single sync run (Section 6 / 14). */
export const syncStatus = pgEnum("sync_status", [
  "running",
  "success",
  "partial",
  "failed",
]);

/** How a run was triggered. */
export const syncMode = pgEnum("sync_mode", ["backfill", "incremental"]);

/** Where a product cost came from (Section 5). In-app table is source of truth. */
export const costSource = pgEnum("cost_source", [
  "manual",
  "csv_import",
  "shopify_metafield",
]);
