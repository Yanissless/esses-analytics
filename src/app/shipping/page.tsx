import { desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { shippingInvoices, shippingRateRules } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/current-user";
import { getShippingCoverage } from "@/lib/shipping/match";
import { Badge, Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";
import { ShippingForms } from "./forms";

export const dynamic = "force-dynamic";

export default async function ShippingPage() {
  const user = await requireAdmin();

  const [coverage, invoices, rules, carriers, locations] = await Promise.all([
    getShippingCoverage(),
    db.select().from(shippingInvoices).orderBy(desc(shippingInvoices.createdAt)).limit(25),
    db.select().from(shippingRateRules).orderBy(desc(shippingRateRules.priority)),
    db.execute(sql`
      SELECT COALESCE(tracking_company,'(none)') AS name, count(*)::int AS shipments
        FROM fulfillments GROUP BY 1 ORDER BY 2 DESC LIMIT 12
    `) as unknown as Promise<Array<{ name: string; shipments: number }>>,
    db.execute(sql`
      SELECT COALESCE(location_name,'(none)') AS name, count(*)::int AS shipments
        FROM fulfillments GROUP BY 1 ORDER BY 2 DESC LIMIT 12
    `) as unknown as Promise<Array<{ name: string; shipments: number }>>,
  ]);

  const pctActual = coverage.shipmentsTotal
    ? Math.round((coverage.shipmentsWithActual / coverage.shipmentsTotal) * 100)
    : 0;

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Shipping costs</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Attach real shipping spend to the orders it paid for. Margin uses actual invoice cost
            where known, then a per-label rate, then the zone average.
          </p>
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <strong>Shopify doesn&rsquo;t expose label costs via its API.</strong> Fulfilments give us
          the tracking number, carrier and location; the money has to come from a bill. Two ways in:
          paste a <em>period total</em> from your Shopify shipping report (allocated by expected
          label rate), or import <em>itemised</em> lines from EasyShip / a carrier invoice.
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Shipments tracked"
            value={formatNum(coverage.shipmentsTotal)}
            hint="from Shopify fulfilments"
            emphasis
          />
          <Stat
            label="With actual cost"
            value={`${pctActual}%`}
            hint={`${formatNum(coverage.shipmentsWithActual)} shipments matched to a bill`}
          />
          <Stat
            label="Actual shipping spend"
            value={formatUsd(coverage.actualCostCents)}
            hint="attributed from invoices"
          />
          <Stat
            label="Prepaid duties (DDP)"
            value={formatUsd(coverage.dutiesCents)}
            hint="cost on $0 subscription & comp shipments"
          />
        </div>

        <ShippingForms
          carriers={carriers.map((c) => c.name)}
          locations={locations.map((l) => l.name)}
        />

        <Card title="Carriers & fulfilment locations seen" subtitle="Use these exact values as batch filters">
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <div className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Carrier</div>
              <ul className="space-y-1 text-sm">
                {carriers.map((c) => (
                  <li key={c.name} className="flex justify-between">
                    <span>{c.name}</span>
                    <span className="tabular-nums text-neutral-500">{formatNum(c.shipments)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Location</div>
              <ul className="space-y-1 text-sm">
                {locations.map((l) => (
                  <li key={l.name} className="flex justify-between">
                    <span>{l.name}</span>
                    <span className="tabular-nums text-neutral-500">{formatNum(l.shipments)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>

        <Card title="Per-label rate rules" subtitle="Used to weight batch allocations and to estimate cost before a bill arrives">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Rule</th>
                  <th className="pb-2 font-medium">Carrier</th>
                  <th className="pb-2 font-medium">Country / zone</th>
                  <th className="pb-2 text-right font-medium">Per label</th>
                  <th className="pb-2 text-right font-medium">Priority</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2">
                      <div className="font-medium">{r.label}</div>
                      {r.source ? <div className="text-xs text-neutral-500">{r.source}</div> : null}
                    </td>
                    <td className="py-2 text-xs">{r.carrierPattern ?? "any"}</td>
                    <td className="py-2 text-xs">
                      {r.countryCode ?? "any"} / {r.zone ?? "any"}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatUsd(r.expectedCostAmount)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-neutral-500">{r.priority}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Invoices" subtitle="Allocated vs invoiced — a gap means some shipments weren't matched">
          {invoices.length === 0 ? (
            <p className="text-sm text-neutral-500">No shipping invoices recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                    <th className="pb-2 font-medium">Vendor / ref</th>
                    <th className="pb-2 font-medium">Period</th>
                    <th className="pb-2 font-medium">Method</th>
                    <th className="pb-2 text-right font-medium">Invoiced</th>
                    <th className="pb-2 text-right font-medium">Allocated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {invoices.map((inv) => {
                    const gap = inv.totalAmount - inv.allocatedAmount;
                    return (
                      <tr key={inv.id}>
                        <td className="py-2">
                          <div className="font-medium">{inv.vendor}</div>
                          <div className="text-xs text-neutral-500">{inv.invoiceRef ?? "—"}</div>
                        </td>
                        <td className="py-2 text-xs tabular-nums">
                          {inv.periodStart ?? "—"} → {inv.periodEnd ?? "—"}
                        </td>
                        <td className="py-2">
                          <Badge tone={inv.allocationMethod === "itemised" ? "emerald" : "blue"}>
                            {inv.allocationMethod}
                          </Badge>
                        </td>
                        <td className="py-2 text-right tabular-nums">{formatUsd(inv.totalAmount)}</td>
                        <td className="py-2 text-right tabular-nums">
                          {formatUsd(inv.allocatedAmount)}
                          {Math.abs(gap) > 1 ? (
                            <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">
                              ({gap > 0 ? "-" : "+"}
                              {formatUsd(Math.abs(gap))})
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}
