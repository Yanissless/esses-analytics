/** Find where Meta's insights API starts failing: window size, or a specific month. */
import "dotenv/config";
import { metaConnector } from "../src/connectors/ads/meta";

const day = 24 * 3600 * 1000;

async function tryWindow(label: string, since: Date, until: Date) {
  try {
    const rows = await metaConnector.fetchSpend({ since, until });
    const spend = rows.reduce((s, r) => s + r.spendAmount, 0);
    console.log(`  ✓ ${label}: ${rows.length} rows, $${(spend / 100).toFixed(2)}`);
    return true;
  } catch (e) {
    console.log(`  ✗ ${label}: ${e instanceof Error ? e.message.slice(0, 90) : e}`);
    return false;
  }
}

async function main() {
  const now = new Date();
  console.log("Window-size probe (ending today):");
  for (const days of [7, 14, 30]) {
    await tryWindow(`${days}d`, new Date(now.getTime() - days * day), now);
  }

  console.log("\nPer-month probe:");
  for (const [y, m] of [
    [2025, 9], [2025, 10], [2025, 11],
    [2026, 0], [2026, 1], [2026, 2], [2026, 3], [2026, 4], [2026, 5], [2026, 6],
  ] as Array<[number, number]>) {
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    await tryWindow(`${y}-${String(m + 1).padStart(2, "0")}`, start, end);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
