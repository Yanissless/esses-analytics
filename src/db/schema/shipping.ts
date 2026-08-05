import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { currency, money, pk, timestamps } from "./_shared";
import { orders } from "./orders";

/**
 * Shipments, synced from Shopify.
 *
 * ⚠️ Shopify's Admin API does NOT expose what a label cost — `Fulfillment` has
 * tracking, location and service but no price. So this table supplies the MATCHING
 * KEYS (tracking number, carrier, fulfilment location, date) and actual cost
 * arrives separately via `shipping_charges` from the fulfiller's invoice.
 */
export const fulfillments = pgTable(
  "fulfillments",
  {
    id: pk(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shopifyFulfillmentId: text("shopify_fulfillment_id").notNull(),
    name: text("name"), // e.g. "#13966-F1"

    trackingCompany: text("tracking_company"), // "USPS", "UPS®", "Royal Mail"
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),

    locationName: text("location_name"), // fulfilment location (park vs US)
    serviceName: text("service_name"),
    serviceType: text("service_type"),

    status: text("status"),
    totalQuantity: integer("total_quantity"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("fulfillments_shopify_id_unique").on(t.shopifyFulfillmentId),
    index("fulfillments_order_idx").on(t.orderId),
    // Tracking number is how park/EasyShip invoice lines match back to a shipment.
    index("fulfillments_tracking_number_idx").on(t.trackingNumber),
    index("fulfillments_company_idx").on(t.trackingCompany),
    index("fulfillments_location_idx").on(t.locationName),
  ],
);

/**
 * A shipping bill from a fulfiller/carrier.
 *
 * The UK printer park bills per BATCH of orders it fulfils, so an invoice can
 * carry a lump-sum total that gets allocated across the shipments it covers.
 * EasyShip bills per shipment (duties/taxes prepaid), which arrives as itemised
 * lines instead.
 */
export const shippingInvoices = pgTable(
  "shipping_invoices",
  {
    id: pk(),
    /** 'uk_park' | 'easyship' | 'usps' | 'ups' | other. */
    vendor: text("vendor").notNull(),
    invoiceRef: text("invoice_ref"),
    invoiceDate: date("invoice_date"),
    /** Period the batch covers — used to match shipments when lines aren't itemised. */
    periodStart: date("period_start"),
    periodEnd: date("period_end"),

    currency: currency().notNull().default("USD"),
    /** Invoice total as billed. Allocation must reconcile to this. */
    totalAmount: money("total_amount").notNull().default(0),
    /** Shipment count stated on the invoice, when given — a reconciliation check. */
    statedShipmentCount: integer("stated_shipment_count"),

    /** How the total was spread: 'itemised' | 'even' | 'by_units'. */
    allocationMethod: text("allocation_method").notNull().default("itemised"),
    /** Sum actually allocated to shipments — compare against totalAmount. */
    allocatedAmount: money("allocated_amount").notNull().default(0),

    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("shipping_invoices_vendor_ref_unique").on(t.vendor, t.invoiceRef),
    index("shipping_invoices_vendor_idx").on(t.vendor),
    index("shipping_invoices_period_idx").on(t.periodStart, t.periodEnd),
  ],
);

/**
 * Actual shipping cost attributed to one shipment (or one order when the shipment
 * can't be identified). This is what margin uses when present — the zone
 * assumption in `cost_assumptions` is only the fallback.
 *
 * `duties_amount` matters for the EasyShip flow: international subscription and
 * comp shipments go out DDP with duties/taxes prepaid, which is real cost on
 * orders that collected $0 from the customer.
 */
export const shippingCharges = pgTable(
  "shipping_charges",
  {
    id: pk(),
    invoiceId: uuid("invoice_id").references(() => shippingInvoices.id, {
      onDelete: "cascade",
    }),
    fulfillmentId: uuid("fulfillment_id").references(() => fulfillments.id),
    orderId: uuid("order_id").references(() => orders.id),

    vendor: text("vendor").notNull(),
    /** Tracking number as it appeared on the invoice — the match key. */
    trackingNumber: text("tracking_number"),
    shippedOn: date("shipped_on"),

    currency: currency().notNull().default("USD"),
    /** Carriage only. */
    shipAmount: money("ship_amount").notNull().default(0),
    /** Duties/taxes prepaid (DDP) — EasyShip's main cost driver for us. */
    dutiesAmount: money("duties_amount").notNull().default(0),
    /** Insurance, fuel, remote-area and other surcharges. */
    surchargeAmount: money("surcharge_amount").notNull().default(0),
    /** Convenience total = ship + duties + surcharge. */
    totalAmount: money("total_amount").notNull().default(0),

    /** 'itemised' when the invoice named this shipment, 'allocated' when spread. */
    attribution: text("attribution").notNull().default("itemised"),
    /** 'tracking' | 'order_number' | 'period' | 'manual' — how it was matched. */
    matchedBy: text("matched_by"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("shipping_charges_invoice_idx").on(t.invoiceId),
    index("shipping_charges_fulfillment_idx").on(t.fulfillmentId),
    index("shipping_charges_order_idx").on(t.orderId),
    index("shipping_charges_tracking_idx").on(t.trackingNumber),
  ],
);

/**
 * Expected cost per label by carrier/service — the middle tier between an
 * invoice-accurate cost and a flat zone average.
 *
 * Most subscription fulfilment goes USPS Media Mail at just under $5/label, so a
 * service-level rate estimates each shipment far better than a zone average. When
 * a Shopify shipping-cost report for a period is imported, these rates weight the
 * allocation and are then scaled to reconcile exactly to the reported total — so
 * per-shipment cost is realistic AND the period sums to what was actually billed.
 *
 * Matching is by case-insensitive substring on carrier and service, most specific
 * (highest priority) first.
 */
export const shippingRateRules = pgTable(
  "shipping_rate_rules",
  {
    id: pk(),
    label: text("label").notNull(), // e.g. "USPS Media Mail"
    /** Substring matched against fulfillments.tracking_company (null = any). */
    carrierPattern: text("carrier_pattern"),
    /** Substring matched against fulfillments.service_name (null = any). */
    servicePattern: text("service_pattern"),
    /** Restrict to a destination country (null = any). */
    countryCode: text("country_code"),
    /**
     * Destination country this rule must NOT match (null = no exclusion).
     *
     * Rates derived from the shipping report split domestic (destination = US)
     * from international, and an international rule has no single zone to pin to
     * — it covers uk, eu and row. Left unscoped it also matched US orders, so a
     * domestic shipment on a carrier with no domestic rule of its own inherited
     * the international rate (e.g. DHL eCommerce at $20.75 instead of ~$4.40
     * Media Mail). Setting this to 'US' expresses "anywhere but domestic".
     */
    excludeCountryCode: text("exclude_country_code"),
    /** Restrict to a shipping zone (null = any). */
    zone: text("zone"),
    currency: currency().notNull().default("USD"),
    expectedCostAmount: money("expected_cost_amount").notNull(),
    /** Higher wins when several rules match. */
    priority: integer("priority").notNull().default(0),
    effectiveDate: date("effective_date").notNull(),
    source: text("source"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("shipping_rate_rules_label_date_unique").on(t.label, t.effectiveDate),
    index("shipping_rate_rules_priority_idx").on(t.priority),
  ],
);

export type ShippingRateRule = typeof shippingRateRules.$inferSelect;
export type Fulfillment = typeof fulfillments.$inferSelect;
export type ShippingInvoice = typeof shippingInvoices.$inferSelect;
export type ShippingCharge = typeof shippingCharges.$inferSelect;
