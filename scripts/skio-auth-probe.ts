/** One-off: find the Authorization header format Skio accepts. */
import "dotenv/config";

const KEY = process.env.SKIO_API_KEY ?? "";
const URL = process.env.SKIO_API_URL ?? "https://graphql.skio.com/v1/graphql";
const QUERY = `query { Subscriptions(limit: 1) { id } }`;

const variants: Array<[string, Record<string, string>]> = [
  ["authorization: API <key>", { Authorization: `API ${KEY}` }],
  ["authorization: <key> (raw)", { Authorization: KEY }],
  ["authorization: Bearer <key>", { Authorization: `Bearer ${KEY}` }],
  ["x-api-key: <key>", { "x-api-key": KEY }],
];

async function tryVariant(label: string, headers: Record<string, string>) {
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query: QUERY }),
    });
    const body = await res.text();
    const short = body.length > 220 ? body.slice(0, 220) + "…" : body;
    console.log(`${label} -> HTTP ${res.status}: ${short}\n`);
  } catch (e) {
    console.log(`${label} -> network error: ${e instanceof Error ? e.message : e}\n`);
  }
}

async function main() {
  for (const [label, headers] of variants) await tryVariant(label, headers);
}
main();
