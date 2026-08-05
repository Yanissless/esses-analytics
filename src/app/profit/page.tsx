import { requireUser } from "@/lib/auth/current-user";
import { getRevenueSummary } from "@/metrics/overview";
import {
  getProductProfit,
  getProfitQuality,
  getProfitWaterfall,
  getWorstOrders,
} from "@/metrics/profit";
import { BOUNDARY_META } from "@/metrics/margin-boundary";
import { getMarginBoundary } from "@/metrics/margin-boundary.server";
import { Badge, Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";

export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

export default async function ProfitPage() {
  const user = await requireUser();
  const summary = await getRevenueSummary();
  const since = summary.firstOrderDate ?? "2025-10-01";
  const until = summary.lastOrderDate ?? new Date().toISOString().slice(0, 10);

  const boundary = await getMarginBoundary();
  const [waterfall, products, worst, quality] = await Promise.all([
    getProfitWaterfall(since, until, boundary),
    getProductProfit(since, until, boundary),
    getWorstOrders(since, until, 15),
    getProfitQuality(since, until),
  ]);
  const boundaryMeta = BOUNDARY_META[boundary];

  const maxStep = Math.max(...waterfall.steps.map((s) => Math.abs(s.runningCents)), 1);
  const estimatedShipPct =
    quality.paidOrders > 0
      ? (quality.shipBasisRate + quality.shipBasisZone) /
        (quality.shipBasisActual + quality.shipBasisRate + quality.shipBasisZone)
      : 0;

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Profit</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Contribution margin from net revenue down to CM3 · {since} → {until}
          </p>
        </div>

        {/* Never show a margin figure without saying which boundary produced it. */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <Badge tone="blue">margin boundary</Badge>
          <span className="font-medium">{boundaryMeta.label}</span>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {boundaryMeta.short}
          </span>
          <a
            href="/costs"
            className="ml-auto text-xs text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            Change
          </a>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Net revenue (ex-VAT)"
            value={formatUsd(waterfall.netRevenueCents)}
            // Revenue is the same under every boundary — comps and prepaid deliveries
            // collect $0 — so saying "comps excluded" here would wrongly imply the
            // setting moves this number. Only the cost lines below respond.
            hint="same under every boundary"
            emphasis
          />
          <Stat label="CM1 (after COGS)" value={formatUsd(waterfall.cm1Cents)} hint={pct(waterfall.steps.find((s) => s.label === "CM1")?.pctOfRevenue ?? null)} />
          <Stat label="CM2 (after fulfilment)" value={formatUsd(waterfall.cm2Cents)} hint={pct(waterfall.steps.find((s) => s.label === "CM2")?.pctOfRevenue ?? null)} />
          <Stat
            label="CM3 (after ad spend)"
            value={formatUsd(waterfall.cm3Cents)}
            hint={pct(waterfall.cm3PctOfRevenue)}
          />
        </div>

        <Card title="Contribution margin waterfall" subtitle="Each cost as a share of net revenue">
          <ul className="space-y-2">
            {waterfall.steps.map((s) => {
              const width = (Math.abs(s.runningCents) / maxStep) * 100;
              const isMargin = s.kind === "margin";
              return (
                <li key={s.label}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span
                      className={
                        isMargin
                          ? "font-medium text-neutral-900 dark:text-neutral-100"
                          : "text-neutral-600 dark:text-neutral-400"
                      }
                    >
                      {s.label}
                      {s.note ? (
                        <span className="ml-2 text-xs text-neutral-400">{s.note}</span>
                      ) : null}
                    </span>
                    <span className="flex items-baseline gap-3 tabular-nums">
                      {s.kind === "cost" ? (
                        <span className="text-xs text-neutral-500">
                          {formatUsd(s.deltaCents)} ({pct(s.pctOfRevenue)})
                        </span>
                      ) : null}
                      <span className={isMargin ? "font-medium" : "text-neutral-500"}>
                        {formatUsd(s.runningCents)}
                      </span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                    <div
                      className={`h-full rounded-full ${
                        isMargin
                          ? "bg-emerald-600 dark:bg-emerald-500"
                          : s.kind === "revenue"
                            ? "bg-neutral-900 dark:bg-neutral-100"
                            : "bg-neutral-400 dark:bg-neutral-600"
                      }`}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-5 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat
                label="Comp programme cost"
                value={formatUsd(waterfall.compCostCents)}
                hint="free copies — real cost, no revenue"
              />
              <Stat
                label="CM3 after comps"
                value={formatUsd(waterfall.cm3AfterCompsCents)}
                hint="the all-in bottom line"
              />
            </div>
          </div>
        </Card>

        <Card
          title="Data quality behind these numbers"
          subtitle="Margin is only as good as the costs underneath it"
        >
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-neutral-500">Loss-making paid orders</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums">
                {formatNum(quality.lossMakingOrders)}
                <span className="ml-1 text-sm text-neutral-500">
                  of {formatNum(quality.paidOrders)}
                </span>
              </dd>
              <dd className="text-xs text-neutral-500">
                {formatUsd(quality.lossMakingCm2Cents)} combined CM2
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Units with no cost record</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums">
                {quality.totalUnits > 0
                  ? `${Math.round((quality.uncostedUnits / quality.totalUnits) * 100)}%`
                  : "—"}
              </dd>
              <dd className="text-xs text-neutral-500">
                {formatNum(quality.uncostedUnits)} of {formatNum(quality.totalUnits)} — margin
                overstated for these
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Shipping from real invoices</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums">
                {formatNum(quality.shipBasisActual)}
              </dd>
              <dd className="text-xs text-neutral-500">orders costed from actual labels</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Shipping estimated</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums">{pct(estimatedShipPct)}</dd>
              <dd className="text-xs text-neutral-500">
                {formatNum(quality.shipBasisRate)} rate-rule · {formatNum(quality.shipBasisZone)} zone
              </dd>
            </div>
          </dl>
        </Card>

        <Card
          title="Profitability by product"
          subtitle="CM1 only — shipping and processing are order-level, so splitting them across a mixed order's line items would be an arbitrary allocation"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Product</th>
                  <th className="pb-2 text-right font-medium">Units</th>
                  <th className="pb-2 text-right font-medium">Rev/unit</th>
                  <th className="pb-2 text-right font-medium">Cost/unit</th>
                  <th className="pb-2 text-right font-medium">Revenue</th>
                  <th className="pb-2 text-right font-medium">COGS</th>
                  <th className="pb-2 text-right font-medium">CM1</th>
                  <th className="pb-2 text-right font-medium">CM1 %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {products.slice(0, 25).map((p) => (
                  <tr key={`${p.sku}-${p.title}`}>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{p.sku ?? "—"}</span>
                        {p.uncostedUnits > 0 ? <Badge tone="amber">no cost</Badge> : null}
                      </div>
                      <div className="text-xs text-neutral-500">{p.title ?? "—"}</div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatNum(p.units)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {p.unitRevenueCents == null ? "—" : formatUsd(p.unitRevenueCents)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {p.unitCostCents == null ? "—" : formatUsd(p.unitCostCents)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(p.revenueCents)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(p.cogsCents)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(p.cm1Cents)}</td>
                    <td
                      className={`py-2 text-right font-medium tabular-nums ${
                        (p.cm1Pct ?? 0) < 0
                          ? "text-red-600 dark:text-red-400"
                          : (p.cm1Pct ?? 0) < 0.3
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {pct(p.cm1Pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Least profitable paid orders"
          subtitle="Only orders that collected money — a $0 prepaid delivery is structurally negative because its revenue landed on an earlier order"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Order</th>
                  <th className="pb-2 font-medium">Country</th>
                  <th className="pb-2 text-right font-medium">Units</th>
                  <th className="pb-2 text-right font-medium">Net rev</th>
                  <th className="pb-2 text-right font-medium">COGS</th>
                  <th className="pb-2 text-right font-medium">Ship cost</th>
                  <th className="pb-2 text-right font-medium">Ship charged</th>
                  <th className="pb-2 text-right font-medium">CM2</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {worst.map((o) => (
                  <tr key={o.orderNumber ?? Math.random().toString()}>
                    <td className="py-2">
                      <div className="font-medium">{o.orderNumber ?? "—"}</div>
                      <div className="text-xs text-neutral-500">{o.processedAt}</div>
                    </td>
                    <td className="py-2">
                      <div className="flex items-center gap-1.5">
                        <span>{o.country ?? "—"}</span>
                        <Badge tone={o.shipBasis === "actual" ? "emerald" : "neutral"}>
                          {o.shipBasis === "actual" ? "invoiced" : "est"}
                        </Badge>
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatNum(o.units)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(o.netRevenueCents)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(o.cogsCents)}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(o.shipCostCents)}</td>
                    <td className="py-2 text-right tabular-nums text-neutral-500">
                      {formatUsd(o.shipChargedCents)}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums text-red-600 dark:text-red-400">
                      {formatUsd(o.cm2Cents)}
                    </td>
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
