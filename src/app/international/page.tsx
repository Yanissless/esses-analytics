import { db } from "@/db/client";
import { marginSettings } from "@/db/schema";
import { desc } from "drizzle-orm";
import { requireCapability } from "@/lib/auth/current-user";
import { getMarginSummary, getMarketMargins } from "@/metrics/cogs";
import { BOUNDARY_META } from "@/metrics/margin-boundary";
import { getMarginBoundary } from "@/metrics/margin-boundary.server";
import { Badge, Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";

export const dynamic = "force-dynamic";

const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

export default async function InternationalPage() {
  const user = await requireCapability("margin");
  const boundary = await getMarginBoundary();
  const [summary, markets, settingsRows] = await Promise.all([
    getMarginSummary(boundary),
    getMarketMargins(boundary),
    db.select().from(marginSettings).orderBy(desc(marginSettings.effectiveDate)).limit(1),
  ]);
  const boundaryMeta = BOUNDARY_META[boundary];
  const target = settingsRows[0]?.targetMarginPct ?? 0.2;

  const international = markets.filter((m) => m.country && m.country !== "US");
  const unmapped = markets.filter((m) => m.country && !m.marketName);
  const belowTarget = international.filter((m) => m.cm2Pct < target && m.netExVatCents > 0);

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">International margin — actuals</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Real orders costed with per-origin COGS, zone shipping, and market VAT. Target
            contribution margin {pct(target)}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <Badge tone="blue">margin boundary</Badge>
          <span className="font-medium">{boundaryMeta.label}</span>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {boundaryMeta.short} Every market&rsquo;s CM2 below responds to this.
          </span>
          <a
            href="/costs"
            className="ml-auto text-xs text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            Change
          </a>
        </div>

        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <strong>Costs are placeholders.</strong> COGS $11.48/issue and the shipping figures come
          from your sheets, which flag shipping as an estimate. Update them under{" "}
          <strong>Costs</strong> and these numbers move immediately — treat the shape as real and the
          absolute margin as provisional.
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Net revenue (ex-VAT)"
            value={formatUsd(summary.netExVatCents)}
            hint={`${formatNum(summary.orders)} orders · ${formatNum(summary.units)} units`}
            emphasis
          />
          <Stat
            label="CM1 (after COGS)"
            value={formatUsd(summary.cm1Cents)}
            hint={`${pct(summary.cm1Pct)} · COGS ${formatUsd(summary.cogsCents)}`}
          />
          <Stat
            label="CM2 (after variable costs)"
            value={formatUsd(summary.cm2Cents)}
            hint={`${pct(summary.cm2Pct)} · variable ${formatUsd(summary.variableCostsCents)}`}
          />
          <Stat
            label="Shipping recovery"
            value={formatUsd(summary.shippingGapCents)}
            hint={`charged ${formatUsd(summary.shipChargedCents)} vs cost ${formatUsd(summary.shipCostCents)}`}
          />
        </div>

        <Card
          title="Free copies are accounted for separately"
          subtitle="Contributor, VIP and seeding copies carry real cost but never earn revenue — that's marketing spend, not a pricing problem"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label="Comp units shipped"
              value={formatNum(summary.compUnits)}
              hint={`${formatNum(summary.compOrders)} orders`}
            />
            <Stat
              label="Comp programme cost"
              value={formatUsd(summary.compCostCents)}
              hint="COGS + shipping + packaging"
            />
            <Stat
              label="CM2 after comps"
              value={formatUsd(summary.cm2AfterCompsCents)}
              hint={
                summary.netExVatCents
                  ? `${pct(summary.cm2AfterCompsCents / summary.netExVatCents)} of net revenue`
                  : "—"
              }
            />
          </div>
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
            Trading margin above excludes comps so each market is judged on what it was actually
            paid for. This card shows what the giveaway programme costs, and the bottom line once
            it&rsquo;s deducted.
          </p>
        </Card>

        {summary.shippingGapCents < 0 ? (
          <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            <strong>Shipping is underwater by {formatUsd(Math.abs(summary.shippingGapCents))}.</strong>{" "}
            Customers were charged {formatUsd(summary.shipChargedCents)} while estimated shipping cost
            was {formatUsd(summary.shipCostCents)} — that gap comes straight out of margin.
          </div>
        ) : null}

        {belowTarget.length > 0 ? (
          <Card
            title={`${belowTarget.length} market(s) below the ${pct(target)} target`}
            subtitle="Ranked by how far under — these are the pricing decisions that matter"
          >
            <ul className="space-y-2 text-sm">
              {belowTarget
                .slice()
                .sort((a, b) => a.cm2Pct - b.cm2Pct)
                .map((m) => (
                  <li key={m.country} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span>
                      <span className="font-medium">{m.marketName ?? m.country}</span>{" "}
                      <span className="text-xs text-neutral-500">
                        {formatNum(m.orders)} orders · VAT {pct(m.vatPct)} · via {m.origin}
                      </span>
                    </span>
                    <span className="tabular-nums">
                      <span className={m.cm2Pct < 0 ? "text-red-600 dark:text-red-400" : ""}>
                        {pct(m.cm2Pct)}
                      </span>{" "}
                      <span className="text-xs text-neutral-500">
                        ({formatUsd(m.cm2Cents)} on {formatUsd(m.netExVatCents)})
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
          </Card>
        ) : null}

        <Card
          title="By market"
          subtitle="Net revenue is ex-VAT; CM2 is after COGS, shipping, packaging, processing and returns"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Market</th>
                  <th className="pb-2 text-right font-medium">Orders</th>
                  <th className="pb-2 text-right font-medium">Units</th>
                  <th className="pb-2 text-right font-medium">Net ex-VAT</th>
                  <th className="pb-2 text-right font-medium">COGS</th>
                  <th className="pb-2 text-right font-medium">Ship cost</th>
                  <th className="pb-2 text-right font-medium">Ship charged</th>
                  <th className="pb-2 text-right font-medium">CM2</th>
                  <th className="pb-2 text-right font-medium">CM2 %</th>
                  <th className="pb-2 text-right font-medium">Comps</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {markets.map((m) => {
                  const under = m.cm2Pct < target;
                  return (
                    <tr key={`${m.country}-${m.origin}`}>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{m.marketName ?? m.country ?? "—"}</span>
                          {!m.marketName && m.country ? <Badge tone="amber">unmapped</Badge> : null}
                          <Badge tone={m.origin === "UK" ? "blue" : "neutral"}>{m.origin}</Badge>
                        </div>
                        <div className="text-xs text-neutral-500">
                          {m.country} · zone {m.zone} · VAT {pct(m.vatPct)}
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatNum(m.orders)}</td>
                      <td className="py-2 text-right tabular-nums">{formatNum(m.units)}</td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(m.netExVatCents)}</td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(m.cogsCents)}</td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(m.shipCostCents)}</td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(m.shipChargedCents)}</td>
                      <td className="py-2 text-right tabular-nums">{formatUsd(m.cm2Cents)}</td>
                      <td
                        className={`py-2 text-right font-medium tabular-nums ${
                          m.cm2Pct < 0
                            ? "text-red-600 dark:text-red-400"
                            : under
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {pct(m.cm2Pct)}
                      </td>
                      <td className="py-2 text-right text-xs tabular-nums text-neutral-500">
                        {m.compUnits ? `${formatNum(m.compUnits)}u · ${formatUsd(m.compCostCents)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {unmapped.length > 0 ? (
            <p className="mt-4 text-xs text-neutral-500">
              {unmapped.length} destination(s) aren&rsquo;t in your market model (
              {unmapped.map((u) => u.country).join(", ")}) — they fall back to the{" "}
              <code className="font-mono">row</code> zone and 0% VAT, so their margin is optimistic.
              Add them to see true numbers.
            </p>
          ) : null}
        </Card>

        {summary.uncostedUnits > 0 ? (
          <p className="pb-4 text-xs text-neutral-500">
            {formatNum(summary.uncostedUnits)} unit(s) have no cost record, so their COGS counts as
            $0 and margin above is overstated for those lines. Set costs under{" "}
            <strong>Costs</strong> to close the gap.
          </p>
        ) : null}
      </main>
    </div>
  );
}
