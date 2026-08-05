/**
 * Skio GraphQL queries — VERIFIED against the live schema (introspection +
 * probe, 2026-07-28). Hasura-style: capitalised entities, limit/offset.
 *
 * Notes from verification:
 *  - Billing/Delivery policies live on the Subscription (not the line).
 *  - `priceWithoutDiscount` is per DELIVERY in major units (e.g. 25 = $25.00);
 *    the annual plan bills MONTH×12 but delivers quarterly, so MRR must be
 *    price × deliveries-per-year ÷ 12 (see ingest.ts).
 *  - Line `sellingPlanId` is a Skio UUID; the Shopify GID for order-line
 *    matching is `OriginalSellingPlan.platformId`.
 *  - `Orders { platformId }` gives the exact Shopify orders per subscription —
 *    used for direct order → subscription_meta linking.
 */

export const SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query Subscriptions($limit: Int!, $offset: Int!) {
    Subscriptions(limit: $limit, offset: $offset, order_by: { createdAt: asc }) {
      id
      platformId
      status
      createdAt
      cancelledAt
      nextBillingDate
      currencyCode
      cyclesCompleted
      BillingPolicy { interval intervalCount }
      DeliveryPolicy { interval intervalCount }
      StorefrontUser { id email firstName lastName }
      Orders { platformId }
      SubscriptionLines {
        id
        sellingPlanId
        priceWithoutDiscount
        quantity
        OriginalSellingPlan { name platformId }
        ProductVariant { platformId }
      }
    }
  }
`;
