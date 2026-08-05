/** One-off: live-probe the corrected Subscriptions query shape. */
import "dotenv/config";
import { skioGraphQL } from "../src/connectors/skio/client";

const Q = /* GraphQL */ `
  query Probe {
    Subscriptions(limit: 2, order_by: { createdAt: asc }) {
      id
      platformId
      status
      createdAt
      cancelledAt
      nextBillingDate
      currencyCode
      cyclesCompleted
      BillingPolicy { interval intervalCount }
      StorefrontUser { id email firstName lastName }
      SubscriptionLines {
        id
        sellingPlanId
        priceWithoutDiscount
        quantity
        OriginalSellingPlan { name }
        ProductVariant { platformId }
      }
    }
  }
`;

skioGraphQL(Q)
  .then((d) => console.log(JSON.stringify(d, null, 2).slice(0, 3000)))
  .catch((e) => {
    console.error("probe failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
