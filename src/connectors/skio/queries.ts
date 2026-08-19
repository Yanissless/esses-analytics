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

/**
 * Subscriptions changed since a timestamp — the incremental form.
 *
 * `incrementalSync` used to call the unfiltered query above and walk all 3,935
 * subscriptions on every run, taking **479 seconds**. It was named incremental and was a
 * full load. On a deployed instance the nightly cron would have been killed by the
 * platform's 300s ceiling every single night, mid-write, with nothing to show why.
 *
 * `updatedAt` is filterable (verified by introspection against the live schema, 18 Aug
 * 2026) and a one-day window is ~794 subscriptions against 3,935 — about a fifth of the
 * work.
 *
 * `updatedAt` and NOT `createdAt`: a subscription that cancels or changes plan keeps its
 * creation date, so a createdAt filter would miss exactly the changes that matter. Only
 * 293 subscriptions were created in the last week against 2,710 updated.
 */
export const SUBSCRIPTIONS_SINCE_QUERY = /* GraphQL */ `
  query SubscriptionsSince($limit: Int!, $offset: Int!, $since: timestamptz!) {
    Subscriptions(
      limit: $limit
      offset: $offset
      where: { updatedAt: { _gt: $since } }
      order_by: { updatedAt: asc }
    ) {
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
