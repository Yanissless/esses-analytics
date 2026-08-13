/**
 * Set an annual target and split it into monthly goals.
 *
 *   pnpm set:goals --metric=revenue --annual=250000 --year=2026 --releases=3,6,9,12
 *   pnpm set:goals --metric=orders  --annual=14000  --year=2026 --flat
 *   pnpm set:goals --list
 *   pnpm set:goals --metric=revenue --year=2026 --clear
 *
 * Nothing is written without `--write`. A dry run prints the twelve months so the shape can be
 * eyeballed before it becomes the thing every dashboard badge is measured against.
 *
 * `--annual` is in the metric's natural unit: DOLLARS for money metrics (converted to cents
 * on write), whole counts for orders and customers. Passing cents by mistake would set a
 * target a hundred times too big, so the script echoes back what it understood before writing.
 *
 * Three ways to shape the year:
 *
 *   --releases=3,6,9,12   split by issue release months. The right default here: this
 *                         business swings 4x on whether an issue shipped, which dwarfs
 *                         anything calendar-seasonal.
 *   --flat                even twelfths.
 *   --seasonal            weight by history. REFUSED below 24 months, because with one
 *                         observation per calendar month a "seasonal index" is really last
 *                         year's trend — see metrics/goal-planner.ts.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import {
  monthlyWeights,
  releaseWeights,
  splitAnnualTarget,
  type MonthlyWeights,
} from "../src/metrics/goal-planner";
import { logger } from "../src/lib/logger";

/** Metrics stored in cents. Everything else is a whole count. */
const MONEY_METRICS = new Set(["revenue", "cm3"]);
const VALID_METRICS = ["revenue", "orders", "new_customers", "cm3"];

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const flag = (n: string) => process.argv.includes(`--${n}`);

async function list() {
  const rows = await db.execute<{ period_start: string; metric: string; target_amount: number }>(sql`
    SELECT period_start::text, metric, target_amount FROM goals ORDER BY period_start, metric
  `);
  const all = [...rows];
  if (all.length === 0) {
    console.log("\nNo goals set. Nothing on the dashboard will show a target badge.\n");
    return;
  }
  console.log(`\n${all.length} goal(s):\n`);
  for (const r of all) {
    const amount = MONEY_METRICS.has(r.metric)
      ? `$${(Number(r.target_amount) / 100).toLocaleString("en-US")}`
      : Number(r.target_amount).toLocaleString("en-US");
    console.log(`  ${r.period_start}  ${r.metric.padEnd(14)} ${amount}`);
  }
  console.log("");
}

/** Removes a metric's goals for a year. Exists so a placeholder target can be un-set. */
async function clear(metric: string, year: number) {
  const r = await db.execute(sql`
    DELETE FROM goals
     WHERE metric = ${metric}
       AND period_start >= ${`${year}-01-01`}
       AND period_start <= ${`${year}-12-01`}
  `);
  const n = (r as unknown as { count?: number }).count ?? 0;
  console.log(`\n✓ removed ${n} goal(s) for ${metric} ${year}.\n`);
}

async function main() {
  if (flag("list")) return list();

  const metric = arg("metric");
  const annualRaw = arg("annual");
  const year = Number(arg("year") ?? new Date().getUTCFullYear());

  if (!metric || !VALID_METRICS.includes(metric)) {
    console.error(`\n--metric must be one of: ${VALID_METRICS.join(", ")}\n`);
    process.exit(1);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    console.error(`\n--year must be a sensible year, got "${arg("year")}"\n`);
    process.exit(1);
  }
  if (flag("clear")) return clear(metric, year);

  const annualNatural = Number(annualRaw);
  if (!annualRaw || !Number.isFinite(annualNatural) || annualNatural <= 0) {
    console.error("\n--annual must be a positive number (dollars for money metrics)\n");
    process.exit(1);
  }

  const isMoney = MONEY_METRICS.has(metric);
  const annualStored = isMoney ? Math.round(annualNatural * 100) : Math.round(annualNatural);

  let weights: MonthlyWeights;
  const releases = arg("releases");
  if (releases) {
    weights = releaseWeights(
      releases.split(",").map((s) => Number(s.trim())).filter(Number.isFinite),
      Number(arg("baseline") ?? 0.35),
    );
  } else if (flag("seasonal")) {
    // One row per observed calendar month. The planner decides whether that is enough.
    const hist = await db.execute<{ month: number; value: number }>(sql`
      SELECT EXTRACT(MONTH FROM date_trunc('month', date))::int AS month,
             SUM(${sql.raw(isMoney ? "revenue_amount" : "orders")})::float AS value
        FROM daily_metrics
       WHERE channel IS NULL
       GROUP BY date_trunc('month', date)
    `);
    weights = monthlyWeights([...hist].map((h) => ({ month: Number(h.month), value: Number(h.value) })));
  } else {
    weights = { weights: new Array(12).fill(1 / 12), method: "flat", reason: "Even twelfths." };
  }

  const months = splitAnnualTarget(annualStored, year, weights.weights);

  const fmt = (v: number) =>
    isMoney ? `$${(v / 100).toLocaleString("en-US")}` : v.toLocaleString("en-US");

  console.log(`\n${metric} · ${year} · annual target ${fmt(annualStored)}`);
  console.log(`Shape: ${weights.method} — ${weights.reason}\n`);
  for (const m of months) {
    console.log(`  ${m.periodStart}   ${fmt(m.target).padStart(14)}`);
  }
  console.log(`  ${"".padEnd(12)}   ${fmt(months.reduce((a, m) => a + m.target, 0)).padStart(14)}  total`);

  if (!flag("write")) {
    console.log("\nDry run. Add --write to save these.\n");
    return;
  }

  for (const m of months) {
    await db.execute(sql`
      INSERT INTO goals (period_start, metric, target_amount, currency)
      VALUES (${m.periodStart}, ${metric}, ${m.target}, 'USD')
      ON CONFLICT (period_start, metric) DO UPDATE SET target_amount = EXCLUDED.target_amount
    `);
  }
  console.log(`\n✓ ${months.length} monthly goals written for ${metric} ${year}.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("set-goals failed", { error: err instanceof Error ? err.message : String(err) });
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
