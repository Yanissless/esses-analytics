import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { costAssumptions, productCosts } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/current-user";
import { getSkuCostRows } from "@/metrics/cogs";
import {
  getCogsCoverage,
  getCogsCoverageSummary,
  getCogsSensitivity,
} from "@/metrics/cogs-scenario";
import { getRevenueSummary } from "@/metrics/overview";
import { BOUNDARY_META } from "@/metrics/margin-boundary";
import { getMarginBoundary } from "@/metrics/margin-boundary.server";
import { Badge, Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";
import { CostForms, MarginBoundaryForm } from "./forms";

export const dynamic = "force-dynamic";

export default async function CostsPage() {
  const user = await requireAdmin();
  // Boundary and window first: the sensitivity table depends on both.
  const [marginBoundary, revenue] = await Promise.all([
    getMarginBoundary(),
    getRevenueSummary(),
  ]);
  const since = revenue.firstOrderDate ?? "2025-10-01";
  const until = revenue.lastOrderDate ?? new Date().toISOString().slice(0, 10);

  const [skus, costs, zones, coverage, coverageRows, sensitivity] = await Promise.all([
    getSkuCostRows(),
    db.select().from(productCosts).orderBy(desc(productCosts.effectiveDate)).limit(100),
    db.select().from(costAssumptions).orderBy(desc(costAssumptions.effectiveDate)),
    getCogsCoverageSummary(),
    getCogsCoverage(20),
    getCogsSensitivity(since, until, marginBoundary),
  ]);

  const csvExport = [
    "sku,origin,cost,effective_date,note",
    ...costs.map((c) =>
      [
        c.sku,
        c.origin,
        (c.costAmount / 100).toFixed(2),
        c.effectiveDate,
        (c.note ?? "").replace(/,/g, ";"),
      ].join(","),
    ),
  ].join("\n");

  const uncostedSkus = skus.filter(
    (s) => s.costUsCents == null && s.costUkCents == null && s.costDefaultCents == null,
  );
  const uncostedUnits = uncostedSkus.reduce((sum, s) => sum + s.units, 0);
  const totalUnits = skus.reduce((sum, s) => sum + s.units, 0);

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Product costs</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Per-unit costs by fulfilment origin, versioned by effective date — margin history uses
            the cost that was accurate at the time of each order.
          </p>
        </div>

        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <strong>Seeded values are placeholders.</strong> $11.48/issue comes from the May 2026
          international margins sheet; the older profit calculators said ~$5.50. The UK printer
          park&rsquo;s real cost hasn&rsquo;t been supplied yet, so UK is seeded at the same figure.
          Update anything below and every margin number recalculates.
        </div>

        {uncostedSkus.length > 0 ? (
          <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            <strong>{uncostedSkus.length} item(s) have no cost</strong> covering{" "}
            {formatNum(uncostedUnits)} of {formatNum(totalUnits)} units (
            {totalUnits ? Math.round((uncostedUnits / totalUnits) * 100) : 0}%). Margin excludes
            their cost until set, so it currently reads high for those lines.
          </div>
        ) : null}

        <Card
          title="Items sold"
          subtitle="Ordered by units — set costs top-down for the biggest margin impact"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">SKU / item</th>
                  <th className="pb-2 text-right font-medium">Units</th>
                  <th className="pb-2 text-right font-medium">Gross</th>
                  <th className="pb-2 text-right font-medium">US cost</th>
                  <th className="pb-2 text-right font-medium">UK cost</th>
                  <th className="pb-2 text-right font-medium">Default</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {skus.map((s) => {
                  const none =
                    s.costUsCents == null && s.costUkCents == null && s.costDefaultCents == null;
                  return (
                    <tr key={`${s.sku ?? "nosku"}-${s.title ?? ""}`}>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs">{s.sku ?? "—"}</span>
                          {none ? <Badge tone="amber">no cost</Badge> : null}
                        </div>
                        <div className="text-xs text-neutral-500">{s.title ?? "—"}</div>
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatNum(s.units)}</td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(s.grossCents)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {s.costUsCents == null ? "—" : formatUsd(s.costUsCents)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {s.costUkCents == null ? "—" : formatUsd(s.costUkCents)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {s.costDefaultCents == null ? "—" : formatUsd(s.costDefaultCents)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        {/* ---- how much a copy can cost, and what it costs today ---- */}
        <Card
          title="What can a copy afford to cost?"
          subtitle={`Margin recomputed at each per-unit print cost, holding shipping, packaging, processing and ad spend exactly as recorded · ${BOUNDARY_META[marginBoundary].label}`}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Breakeven per copy"
              value={
                sensitivity.breakevenPerUnitCents == null
                  ? "—"
                  : formatUsd(sensitivity.breakevenPerUnitCents)
              }
              hint="print cost where CM3 reaches zero"
              emphasis
            />
            <Stat
              label="Effective cost today"
              value={
                sensitivity.actualPerUnitCents == null
                  ? "—"
                  : formatUsd(sensitivity.actualPerUnitCents)
              }
              hint={`${formatUsd(sensitivity.actualCogsCents)} over ${formatNum(sensitivity.units)} units`}
            />
            <Stat
              label="Cost coverage"
              value={
                coverage.coveragePct == null
                  ? "—"
                  : `${(coverage.coveragePct * 100).toFixed(1)}%`
              }
              hint={`${formatNum(coverage.exposedUnits)} of ${formatNum(coverage.totalUnits)} units have no cost`}
            />
            <Stat
              label="Distinct costs in force"
              value={formatNum(coverage.distinctCostValues)}
              hint={
                coverage.distinctCostValues <= 1
                  ? "one flat rate — COGS does not vary yet"
                  : "COGS varies by product"
              }
            />
          </div>

          {/* The single most important caveat on this page. */}
          {sensitivity.actualPerUnitCents != null && coverage.exposedUnits > 0 ? (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <strong>
                The effective cost ({formatUsd(sensitivity.actualPerUnitCents)}) is lower than the
                $11.48 placeholder, and that is not good news.
              </strong>{" "}
              {formatNum(coverage.exposedUnits)} units carry no cost record at all, so they are
              costed at <strong>$0</strong> and drag the average down. Margin everywhere in this app
              is therefore <em>optimistic</em> by roughly the value of those units. Setting the costs
              in the table below will make the reported numbers worse and more correct.
            </div>
          ) : null}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Cost per copy</th>
                  <th className="pb-2 text-right font-medium">COGS total</th>
                  <th className="pb-2 text-right font-medium">CM1</th>
                  <th className="pb-2 text-right font-medium">CM2</th>
                  <th className="pb-2 text-right font-medium">CM3</th>
                  <th className="pb-2 text-right font-medium">CM3 %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {sensitivity.scenarios.map((s) => {
                  const viable = s.cm3Cents >= 0;
                  return (
                    <tr
                      key={s.perUnitCents}
                      className={s.isCurrent ? "bg-neutral-100/70 dark:bg-neutral-800/50" : ""}
                    >
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium tabular-nums">{s.label}</span>
                          {s.isCurrent ? <Badge tone="blue">current</Badge> : null}
                          {s.perUnitCents === 550 ? (
                            <Badge tone="neutral">older calculators</Badge>
                          ) : null}
                          {s.perUnitCents === 1148 ? (
                            <Badge tone="amber">May 2026 sheet</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(s.cogsCents)}</td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(s.cm1Cents)}</td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(s.cm2Cents)}</td>
                      <td
                        className={`py-2 text-right font-medium tabular-nums ${
                          viable
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {formatUsd(s.cm3Cents)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {s.cm3Pct == null ? "—" : `${(s.cm3Pct * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            <strong>Nothing here is saved</strong> — it&rsquo;s a what-if. Committing a real cost is
            the effective-dated edit further down, so a scenario can never quietly become the
            recorded truth. The breakeven moves sharply with the margin boundary above: counting only
            paid orders leaves far more headroom per copy than also counting the deliveries those
            subscriptions fund, and the second is the harder question.
          </p>
        </Card>

        <MarginBoundaryForm current={marginBoundary} />

        {/* ---- the work queue for costing products ---- */}
        <Card
          title="Products with no cost"
          subtitle="Ordered by units exposed, so the top row removes more uncertainty than the rest combined"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Product</th>
                  <th className="pb-2 font-medium">Cost key</th>
                  <th className="pb-2 text-right font-medium">Units sold</th>
                  <th className="pb-2 text-right font-medium">Units uncosted</th>
                  <th className="pb-2 text-right font-medium">Cost set</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {coverageRows
                  .filter((c) => c.exposedUnits > 0)
                  .map((c) => (
                    <tr key={c.sku}>
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{c.title ?? "(untitled)"}</span>
                          {c.issueNumber ? (
                            <Badge tone="neutral">issue {c.issueNumber}</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-2 font-mono text-[11px] text-neutral-500">{c.sku}</td>
                      <td className="py-2 text-right tabular-nums">{formatNum(c.units)}</td>
                      <td className="py-2 text-right font-medium tabular-nums text-amber-600 dark:text-amber-400">
                        {formatNum(c.exposedUnits)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {c.costCents == null ? "—" : formatUsd(c.costCents)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            Copy the <strong>cost key</strong> into the form below to set a cost. Keys beginning{" "}
            <code className="font-mono">variant:</code> are products with no SKU in Shopify — the
            resolver honours that synthetic key exactly like a real SKU, so they cost the same way.
            Because costs are effective-dated, a print run that gets cheaper only changes margin from
            that date forward; history keeps the cost that was true at the time.
          </p>
        </Card>

        <CostForms
          zones={zones.map((z) => ({
            zone: z.zone,
            effectiveDate: z.effectiveDate,
            shipCost: z.shipCostAmount,
            freightPerUnit: z.freightPerUnitAmount,
            packaging: z.packagingAmount,
            pickPack: z.pickPackAmount,
            processingPct: z.processingPct,
            returnRatePct: z.returnRatePct,
            returnCost: z.returnCostAmount,
            note: z.note,
          }))}
          csvExport={csvExport}
          skuSuggestions={skus.map((s) => s.sku).filter((s): s is string => Boolean(s))}
        />

        <Card title="Cost history" subtitle="Most recent 100 entries — versioned, never overwritten">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">SKU</th>
                  <th className="pb-2 font-medium">Origin</th>
                  <th className="pb-2 text-right font-medium">Cost</th>
                  <th className="pb-2 font-medium">Effective</th>
                  <th className="pb-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {costs.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2 font-mono text-xs">{c.sku}</td>
                    <td className="py-2">
                      <Badge tone={c.origin === "UK" ? "blue" : "neutral"}>{c.origin}</Badge>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(c.costAmount)}</td>
                    <td className="py-2 tabular-nums">{c.effectiveDate}</td>
                    <td className="py-2 text-xs text-neutral-500">{c.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </main>
    </div>
  );
}
