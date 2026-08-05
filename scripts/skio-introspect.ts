/** One-off: introspect the Skio GraphQL schema to verify entity/field names. */
import "dotenv/config";
import { skioGraphQL } from "../src/connectors/skio/client";

async function main() {
  // Query-root fields that look subscription-related.
  const root = await skioGraphQL<{
    __type: { fields: Array<{ name: string }> } | null;
  }>(`query { __type(name: "query_root") { fields { name } } }`);

  const fields = root.__type?.fields.map((f) => f.name) ?? [];
  const interesting = fields.filter((n) =>
    /subscri|storefront|selling|order|churn|cancel/i.test(n),
  );
  console.log("query_root fields (filtered):");
  for (const f of interesting.sort()) console.log("  " + f);
  console.log(`\n(total root fields: ${fields.length})`);
}

main().catch((e) => {
  console.error("Introspection failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
