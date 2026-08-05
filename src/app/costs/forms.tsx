"use client";

import { useActionState } from "react";
import {
  importCostsCsv,
  saveMarginBoundary,
  saveProductCost,
  saveZoneAssumptions,
  type CostActionState,
} from "./actions";
import {
  BOUNDARY_META,
  MARGIN_BOUNDARIES,
  type MarginBoundary,
} from "@/metrics/margin-boundary";

const initial: CostActionState = {};

const input =
  "w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";
const label = "mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400";
const button =
  "rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900";
const card =
  "rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900";

function Msg({ state }: { state: CostActionState }) {
  if (!state.error && !state.ok) return null;
  return (
    <div className="mt-3 space-y-1 text-sm">
      {state.ok ? <p className="text-emerald-600 dark:text-emerald-400">{state.ok}</p> : null}
      {state.error ? <p className="text-red-600 dark:text-red-400">{state.error}</p> : null}
    </div>
  );
}

/**
 * The margin-boundary selector.
 *
 * Rendered as radios with each option's full trade-off visible rather than a bare
 * dropdown: the three options produce wildly different CM2 for the same period
 * (+$85K / −$15K / −$30K here), so someone changing it needs to see *why* before
 * they do, not after.
 */
export function MarginBoundaryForm({ current }: { current: MarginBoundary }) {
  const [state, action, pending] = useActionState(saveMarginBoundary, initial);

  return (
    <section className={card}>
      <header className="mb-3">
        <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          Margin boundary
        </h2>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          Which revenue classes bear cost. Changes apply immediately across Profit,
          International and Personas — revenue is identical under all three, so this only
          re-filters which costs are charged. Nothing is rebuilt.
        </p>
      </header>

      <form action={action} className="space-y-3">
        {MARGIN_BOUNDARIES.map((b) => {
          const meta = BOUNDARY_META[b];
          const active = b === current;
          return (
            <label
              key={b}
              className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
                active
                  ? "border-neutral-900 bg-neutral-50 dark:border-neutral-100 dark:bg-neutral-800/60"
                  : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/40"
              }`}
            >
              <input
                type="radio"
                name="marginBoundary"
                value={b}
                defaultChecked={active}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {meta.label}
                  {active ? (
                    <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-[11px] font-normal text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
                      active
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-neutral-600 dark:text-neutral-300">
                  {meta.short}
                </span>
                <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
                  {meta.explanation}
                </span>
              </span>
            </label>
          );
        })}
        <button type="submit" className={button} disabled={pending}>
          {pending ? "Saving…" : "Save boundary"}
        </button>
      </form>
      <Msg state={state} />
    </section>
  );
}

export interface ZoneRow {
  zone: string;
  effectiveDate: string;
  shipCost: number;
  freightPerUnit: number;
  packaging: number;
  pickPack: number;
  processingPct: number;
  returnRatePct: number;
  returnCost: number;
  note: string | null;
}

export function CostForms({
  zones,
  csvExport,
  skuSuggestions,
}: {
  zones: ZoneRow[];
  csvExport: string;
  skuSuggestions: string[];
}) {
  const [costState, costAction, costPending] = useActionState(saveProductCost, initial);
  const [csvState, csvAction, csvPending] = useActionState(importCostsCsv, initial);
  const [zoneState, zoneAction, zonePending] = useActionState(saveZoneAssumptions, initial);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <section className={card}>
          <h2 className="mb-1 text-sm font-medium">Set a unit cost</h2>
          <p className="mb-4 text-xs text-neutral-500">
            A new effective date adds a version; the same date updates it. Use origin to price
            UK-printed copies separately from US.
          </p>
          <form action={costAction} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="sku">SKU</label>
                <input id="sku" name="sku" list="skus" required className={input} placeholder="ME5" />
                <datalist id="skus">
                  {[...new Set(skuSuggestions)].map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className={label} htmlFor="origin">Fulfilment origin</label>
                <select id="origin" name="origin" defaultValue="default" className={input}>
                  <option value="default">default (any)</option>
                  <option value="US">US</option>
                  <option value="UK">UK printer park</option>
                </select>
              </div>
              <div>
                <label className={label} htmlFor="cost">Cost per unit (USD)</label>
                <input id="cost" name="cost" required className={input} placeholder="11.48" inputMode="decimal" />
              </div>
              <div>
                <label className={label} htmlFor="effectiveDate">Effective date</label>
                <input id="effectiveDate" name="effectiveDate" defaultValue={today} className={input} placeholder="YYYY-MM-DD" />
              </div>
            </div>
            <div>
              <label className={label} htmlFor="note">Note (optional)</label>
              <input id="note" name="note" className={input} placeholder="printer quote May 2026" />
            </div>
            <button type="submit" disabled={costPending} className={button}>
              {costPending ? "Saving…" : "Save cost"}
            </button>
            <Msg state={costState} />
          </form>
        </section>

        <section className={card}>
          <h2 className="mb-1 text-sm font-medium">Bulk import / export</h2>
          <p className="mb-4 text-xs text-neutral-500">
            Header: <code className="font-mono">sku,cost,effective_date</code> plus optional{" "}
            <code className="font-mono">origin,note</code>. Bad rows are reported, not skipped
            silently.
          </p>
          <form action={csvAction} className="space-y-3">
            <textarea
              name="csv"
              rows={6}
              className={`${input} font-mono text-xs`}
              placeholder={"sku,cost,effective_date,origin\nME5,11.48,2026-01-01,UK\nME4,10.90,2026-01-01,US"}
            />
            <button type="submit" disabled={csvPending} className={button}>
              {csvPending ? "Importing…" : "Import CSV"}
            </button>
            <Msg state={csvState} />
          </form>
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-neutral-500">
              Export current costs as CSV
            </summary>
            <textarea
              readOnly
              rows={6}
              value={csvExport}
              className={`${input} mt-2 font-mono text-xs`}
            />
          </details>
        </section>
      </div>

      <section className={card}>
        <h2 className="mb-1 text-sm font-medium">Zone cost assumptions</h2>
        <p className="mb-4 text-xs text-neutral-500">
          Everything between revenue and contribution margin that isn&rsquo;t the printed unit.
          Shipping cost is what <em>we</em> pay per shipment — the international view compares it
          against what customers were charged.
        </p>

        <div className="mb-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                <th className="pb-2 font-medium">Zone</th>
                <th className="pb-2 text-right font-medium">Ship</th>
                <th className="pb-2 text-right font-medium">Freight/unit</th>
                <th className="pb-2 text-right font-medium">Packaging</th>
                <th className="pb-2 text-right font-medium">Pick/pack</th>
                <th className="pb-2 text-right font-medium">Processing</th>
                <th className="pb-2 font-medium">Effective</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {zones.map((z) => (
                <tr key={`${z.zone}-${z.effectiveDate}`}>
                  <td className="py-2 font-medium uppercase">{z.zone}</td>
                  <td className="py-2 text-right tabular-nums">${(z.shipCost / 100).toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">${(z.freightPerUnit / 100).toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">${(z.packaging / 100).toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">${(z.pickPack / 100).toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">{(z.processingPct * 100).toFixed(2)}%</td>
                  <td className="py-2 tabular-nums text-xs">{z.effectiveDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form action={zoneAction} className="space-y-3 border-t border-neutral-100 pt-4 dark:border-neutral-800">
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label className={label} htmlFor="zone">Zone</label>
              <select id="zone" name="zone" className={input} defaultValue="us">
                <option value="us">us</option>
                <option value="uk">uk</option>
                <option value="eu">eu</option>
                <option value="row">row</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="zEff">Effective date</label>
              <input id="zEff" name="effectiveDate" defaultValue={today} className={input} />
            </div>
            <div>
              <label className={label} htmlFor="shipCost">Shipping cost / shipment</label>
              <input id="shipCost" name="shipCost" className={input} placeholder="12.00" inputMode="decimal" />
            </div>
            <div>
              <label className={label} htmlFor="freightPerUnit">Freight &amp; duties / unit</label>
              <input id="freightPerUnit" name="freightPerUnit" className={input} placeholder="0.00" inputMode="decimal" />
            </div>
            <div>
              <label className={label} htmlFor="packaging">Packaging / order</label>
              <input id="packaging" name="packaging" className={input} placeholder="0.60" inputMode="decimal" />
            </div>
            <div>
              <label className={label} htmlFor="pickPack">Pick &amp; pack / order</label>
              <input id="pickPack" name="pickPack" className={input} placeholder="0.00" inputMode="decimal" />
            </div>
            <div>
              <label className={label} htmlFor="processingPct">Payment processing %</label>
              <input id="processingPct" name="processingPct" className={input} placeholder="2.9" inputMode="decimal" />
            </div>
            <div>
              <label className={label} htmlFor="returnCost">Return cost / order</label>
              <input id="returnCost" name="returnCost" className={input} placeholder="1.00" inputMode="decimal" />
            </div>
          </div>
          <input type="hidden" name="returnRatePct" value="0" />
          <div>
            <label className={label} htmlFor="zNote">Note</label>
            <input id="zNote" name="note" className={input} placeholder="carrier invoice avg, Jul 2026" />
          </div>
          <button type="submit" disabled={zonePending} className={button}>
            {zonePending ? "Saving…" : "Save zone assumptions"}
          </button>
          <Msg state={zoneState} />
        </form>
      </section>
    </div>
  );
}
