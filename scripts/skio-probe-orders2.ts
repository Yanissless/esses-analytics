/** One-off: query Skio Orders directly (platformId + subscriptionId). */
import "dotenv/config";
import { skioGraphQL } from "../src/connectors/skio/client";

const Q = /* GraphQL */ `
  query ProbeOrders2 {
    Orders(limit: 5, order_by: { processedAt: desc }) {
      platformId
      platformNumber
      subscriptionId
      processedAt
      totalPrice
    }
  }
`;

skioGraphQL<{ Orders: Array<Record<string, unknown>> }>(Q)
  .then((d) => {
    console.log(`rows: ${d.Orders.length}`);
    console.log(JSON.stringify(d.Orders, null, 2));
  })
  .catch((e) => {
    console.error("probe failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
