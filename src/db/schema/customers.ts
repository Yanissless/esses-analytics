import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";

/**
 * Unified customer entity (Section 6). Deduplicated primarily by email; fall
 * back to phone / name+address when email is missing (matching logic lives in
 * the connector layer). The per-source IDs below ARE the `source_ids` map —
 * modelled as indexed columns so connectors can find-or-create quickly.
 *
 * Acquisition fields support LTV-by-cohort (acquisition month / channel /
 * first-order offer). They are populated by the attribution engine (Phase 7);
 * present here so no migration is needed later.
 */
export const customers = pgTable(
  "customers",
  {
    id: pk(),

    // Dedup keys
    email: text("email"), // lower-cased at write time; nullable (fallback match)
    phone: text("phone"),
    name: text("name"),

    // Source IDs (the source_ids map, as indexed columns)
    shopifyCustomerId: text("shopify_customer_id"),
    skioStorefrontUserId: text("skio_storefront_user_id"),
    stripeCustomerId: text("stripe_customer_id"),

    // Acquisition cohort (populated later)
    acquisitionChannel: text("acquisition_channel"),
    acquisitionCampaign: text("acquisition_campaign"),
    acquisitionOffer: text("acquisition_offer"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }),
    firstOrderAt: timestamp("first_order_at", { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("customers_email_unique").on(t.email),
    uniqueIndex("customers_shopify_id_unique").on(t.shopifyCustomerId),
    uniqueIndex("customers_stripe_id_unique").on(t.stripeCustomerId),
    uniqueIndex("customers_skio_id_unique").on(t.skioStorefrontUserId),
    index("customers_acquisition_idx").on(
      t.acquiredAt,
      t.acquisitionChannel,
    ),
  ],
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
