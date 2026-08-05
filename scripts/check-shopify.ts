/**
 * Verify the Shopify connection end to end: token exchange, shop identity, order
 * read, and — separately — the read_reports scope that shipping costs need.
 *
 *   pnpm check:shopify
 *
 * Each check reports independently so a missing scope is obvious rather than
 * looking like a broken connection.
 */
import "dotenv/config";
import { connectorConfigured, env } from "../src/lib/env";
import { getAccessToken, grantedScopes, shopHost } from "../src/connectors/shopify/auth";
import { shopifyGraphQL } from "../src/connectors/shopify/client";

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);

async function main() {
  console.log("Shopify connection check\n");

  console.log("Config:");
  console.log(`  shop            : ${env.SHOPIFY_SHOP ?? "(not set)"}`);
  console.log(`  api version     : ${env.SHOPIFY_API_VERSION}`);
  console.log(`  client id       : ${env.SHOPIFY_CLIENT_ID ? "set" : "(not set)"}`);
  console.log(`  client secret   : ${env.SHOPIFY_CLIENT_SECRET ? "set" : "(not set)"}`);
  console.log(`  static token    : ${env.SHOPIFY_ADMIN_ACCESS_TOKEN ? "set (overrides grant)" : "(not set)"}`);

  if (!connectorConfigured.shopify()) {
    bad("\nNot configured. Set SHOPIFY_SHOP plus SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.");
    process.exit(1);
  }

  console.log("\n1. Access token");
  try {
    const t = await getAccessToken();
    ok(`obtained (${t.slice(0, 6)}…, ${t.length} chars)`);
    const scopes = grantedScopes();
    if (scopes) console.log(`     granted scopes: ${scopes}`);
  } catch (e) {
    bad(e instanceof Error ? e.message : String(e));
    console.log(
      "\n  Common causes:\n" +
        `   • SHOPIFY_SHOP must be the myshopifyDomain (currently ${shopHost()}).\n` +
        "   • 'shop_not_permitted' → app and store aren't in the same Shopify organization.\n" +
        "   • App not installed on the store yet.",
    );
    process.exit(1);
  }

  console.log("\n2. Shop identity");
  try {
    const d = await shopifyGraphQL<{ shop: { name: string; myshopifyDomain: string } }>(
      `{ shop { name myshopifyDomain } }`,
    );
    ok(`${d.shop.name} (${d.shop.myshopifyDomain})`);
  } catch (e) {
    bad(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  console.log("\n3. Order read (needs read_orders / read_all_orders)");
  try {
    const d = await shopifyGraphQL<{
      orders: { edges: Array<{ node: { name: string; processedAt: string } }> };
    }>(`{ orders(first: 1, sortKey: PROCESSED_AT, reverse: true) { edges { node { name processedAt } } } }`);
    const n = d.orders.edges[0]?.node;
    ok(n ? `latest order ${n.name} (${n.processedAt?.slice(0, 10)})` : "no orders returned");
  } catch (e) {
    bad(e instanceof Error ? e.message : String(e));
  }

  console.log("\n4. Shipping label costs (needs read_reports)");
  try {
    const d = await shopifyGraphQL<{
      shopifyqlQuery: { parseErrors: string[]; tableData: { rows: Array<Record<string, unknown>> } | null };
    }>(
      `query($q:String!){ shopifyqlQuery(query:$q){ parseErrors tableData { rows } } }`,
      { q: "FROM shipping_labels SHOW shipping_label_costs GROUP BY order_name SINCE -30d UNTIL today LIMIT 1" },
    );
    const rows = d.shopifyqlQuery?.tableData?.rows ?? [];
    if (d.shopifyqlQuery?.parseErrors?.length) {
      bad(`parse errors: ${d.shopifyqlQuery.parseErrors.join("; ")}`);
    } else {
      ok(`reachable — ${rows.length} sample row(s)`);
    }
  } catch (e) {
    bad(e instanceof Error ? e.message : String(e));
    console.log("     Add the read_reports scope in the Dev Dashboard, then reinstall the app.");
  }

  console.log("\nDone. If all four passed, `pnpm sync` will keep everything current.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
