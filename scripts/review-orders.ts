/**
 * Review the flagged-order queue from the terminal (until the Phase 8 dashboard
 * view lands). Shows customer context so comps are easy to spot.
 *
 *   pnpm review                          # list pending orders
 *   pnpm review --include=#7218          # count this order as revenue
 *   pnpm review --exclude=#8648          # confirm it as a comp
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { orders } from "../src/db/schema";
import {
  listOrdersForReview,
  setReviewDecision,
  type ReviewDecision,
} from "../src/lib/review/order-review";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function decide(orderNumber: string, decision: ReviewDecision) {
  const key = orderNumber.startsWith("#") ? orderNumber : `#${orderNumber}`;
  const [row] = await db
    .select({ id: orders.id, num: orders.orderNumber })
    .from(orders)
    .where(eq(orders.orderNumber, key))
    .limit(1);
  if (!row) {
    console.error(`Order ${key} not found.`);
    process.exit(1);
  }
  await setReviewDecision(row.id, decision);
  console.log(
    decision === "include"
      ? `✓ ${key} will now COUNT as revenue.`
      : `✓ ${key} confirmed as a comp (excluded from revenue).`,
  );
}

async function list() {
  const rows = await listOrdersForReview();
  if (!rows.length) {
    console.log("Nothing awaiting review. 🎉");
    return;
  }
  console.log(`${rows.length} order(s) awaiting review — excluded from revenue until confirmed:\n`);
  for (const r of rows) {
    const when = r.processedAt ? r.processedAt.toISOString().slice(0, 10) : "unknown date";
    console.log(`${r.orderNumber ?? r.orderId}  ${usd(r.totalAmount)}  (${when})`);
    console.log(`   reason      : ${r.reviewReason ?? "-"}  [${r.financialStatus ?? "-"}, via ${r.sourceName ?? "-"}]`);
    console.log(`   customer    : ${r.customerName ?? "(no name)"} <${r.customerEmail ?? "no email"}>`);
    console.log(
      `   history     : ${r.customerOrderCount} order(s), ${usd(r.customerPaidTotal)} actually paid` +
        `${r.isSubscriber ? ", is a subscriber" : ""}`,
    );
    console.log(`   items       : ${r.items ?? "-"}`);
    console.log(
      `   decide      : pnpm review --include=${r.orderNumber ?? r.orderId}   |   ` +
        `pnpm review --exclude=${r.orderNumber ?? r.orderId}\n`,
    );
  }
}

async function main() {
  const inc = arg("include");
  const exc = arg("exclude");
  if (inc) return decide(inc, "include");
  if (exc) return decide(exc, "exclude");
  return list();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Review failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
