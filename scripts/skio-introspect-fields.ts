/** One-off: verify field names on Subscription / SubscriptionLine types. */
import "dotenv/config";
import { skioGraphQL } from "../src/connectors/skio/client";

async function fieldsOf(type: string): Promise<string[]> {
  const r = await skioGraphQL<{ __type: { fields: Array<{ name: string }> } | null }>(
    `query { __type(name: "${type}") { fields { name } } }`,
  );
  return (r.__type?.fields.map((f) => f.name) ?? []).sort();
}

async function main() {
  for (const t of ["Order", "OrderLineItem"]) {
    const f = await fieldsOf(t);
    console.log(`--- ${t} (${f.length} fields) ---`);
    console.log(f.join(", "));
    console.log();
  }
}
main().catch((e) => {
  console.error("failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
