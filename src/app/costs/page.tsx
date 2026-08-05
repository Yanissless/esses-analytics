import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { costAssumptions, productCosts } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/current-user";
import { getSkuCostRows } from "@/metrics/cogs";
import { getMarginBoundary } from "@/metrics/margin-boundary.server";
import { Badge, Card, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";
import { CostForms, MarginBoundaryForm } from "./forms";

export const dynamic = "force-dynamic";

export default async function CostsPage() {
  const user = await requireAdmin();
  const [skus, costs, zones, marginBoundary] = await Promise.all([
    getSkuCostRows(),
    db.select().from(productCosts).orderBy(desc(productCosts.effectiveDate)).limit(100),
    db.select().from(costAssumptions).orderBy(desc(costAssumptions.effectiveDate)),
    getMarginBoundary(),
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

        <MarginBoundaryForm current={marginBoundary} />

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
