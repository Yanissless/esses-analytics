/** One-off: does Subscription.Orders return platformIds, and do they match ours? */
import "dotenv/config";
import { skioGraphQL } from "../src/connectors/skio/client";

const Q = /* GraphQL */ `
  query ProbeOrders {
    Subscriptions(limit: 5, order_by: { createdAt: desc }) {
      id
      status
      Orders { platformId }
    }
  }
`;

skioGraphQL<{ Subscriptions: Array<{ id: string; status: string; Orders?: Array<{ platformId?: string | null }> }> }>(Q)
  .then((d) => {
    for (const s of d.Subscriptions) {
      const ids = (s.Orders ?? []).map((o) => o.platformId).join(", ") || "(none)";
      console.log(`${s.id} [${s.status}] orders: ${ids}`);
    }
  })
  .catch((e) => {
    console.error("probe failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
