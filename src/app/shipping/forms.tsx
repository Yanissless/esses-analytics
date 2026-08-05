"use client";

import { useActionState } from "react";
import {
  createBatchInvoice,
  importItemisedCsv,
  type ShippingActionState,
} from "./actions";

const initial: ShippingActionState = {};

const input =
  "w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";
const label = "mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400";
const button =
  "rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900";
const card =
  "rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900";

function Msg({ state }: { state: ShippingActionState }) {
  if (!state.error && !state.ok) return null;
  return (
    <div className="mt-3 space-y-1 text-sm">
      {state.ok ? <p className="text-emerald-600 dark:text-emerald-400">{state.ok}</p> : null}
      {state.error ? <p className="text-amber-700 dark:text-amber-400">{state.error}</p> : null}
    </div>
  );
}

export function ShippingForms({
  carriers,
  locations,
}: {
  carriers: string[];
  locations: string[];
}) {
  const [batchState, batchAction, batchPending] = useActionState(createBatchInvoice, initial);
  const [itemState, itemAction, itemPending] = useActionState(importItemisedCsv, initial);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className={card}>
        <h2 className="mb-1 text-sm font-medium">Batch bill / period total</h2>
        <p className="mb-4 text-xs text-neutral-500">
          For the UK park&rsquo;s per-batch invoices, or a Shopify shipping-cost report total.
          Filters pick which shipments it covers; the total is then spread across them and always
          reconciles to what you entered.
        </p>
        <form action={batchAction} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="vendor">Vendor</label>
              <select id="vendor" name="vendor" className={input} defaultValue="uk_park">
                <option value="uk_park">uk_park (printer park)</option>
                <option value="shopify_shipping">shopify_shipping (report)</option>
                <option value="usps">usps</option>
                <option value="ups">ups</option>
                <option value="other">other</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="invoiceRef">Invoice ref</label>
              <input id="invoiceRef" name="invoiceRef" className={input} placeholder="PARK-2026-07" />
            </div>
            <div>
              <label className={label} htmlFor="periodStart">Period start</label>
              <input id="periodStart" name="periodStart" className={input} placeholder="2026-07-01" />
            </div>
            <div>
              <label className={label} htmlFor="periodEnd">Period end</label>
              <input id="periodEnd" name="periodEnd" className={input} placeholder="2026-07-31" />
            </div>
            <div>
              <label className={label} htmlFor="total">Invoice total (USD)</label>
              <input id="total" name="total" className={input} placeholder="1450.00" inputMode="decimal" />
            </div>
            <div>
              <label className={label} htmlFor="method">Allocate by</label>
              <select id="method" name="method" className={input} defaultValue="by_rate">
                <option value="by_rate">expected label rate (recommended)</option>
                <option value="even">evenly per shipment</option>
                <option value="by_units">by units shipped</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="trackingCompany">Carrier filter</label>
              <input
                id="trackingCompany"
                name="trackingCompany"
                list="carrier-list"
                className={input}
                placeholder="Royal Mail"
              />
              <datalist id="carrier-list">
                {carriers.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div>
              <label className={label} htmlFor="locationName">Location filter</label>
              <input
                id="locationName"
                name="locationName"
                list="location-list"
                className={input}
                placeholder="(any)"
              />
              <datalist id="location-list">
                {locations.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </div>
          </div>
          <div>
            <label className={label} htmlFor="countries">Destination countries (optional, comma separated)</label>
            <input id="countries" name="countries" className={input} placeholder="GB,DE,FR,IT,ES,NL" />
          </div>
          <div>
            <label className={label} htmlFor="note">Note</label>
            <input id="note" name="note" className={input} placeholder="July park batch, 2 pallets" />
          </div>
          <button type="submit" disabled={batchPending} className={button}>
            {batchPending ? "Allocating…" : "Save & allocate"}
          </button>
          <Msg state={batchState} />
        </form>
      </section>

      <section className={card}>
        <h2 className="mb-1 text-sm font-medium">Itemised import (EasyShip / carrier)</h2>
        <p className="mb-4 text-xs text-neutral-500">
          Per-shipment lines matched by tracking number, then order number. EasyShip duties are kept
          separate — that&rsquo;s the real cost on DDP subscription and comp shipments.
        </p>
        <form action={itemAction} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="ivendor">Vendor</label>
              <select id="ivendor" name="vendor" className={input} defaultValue="easyship">
                <option value="easyship">easyship</option>
                <option value="usps">usps</option>
                <option value="ups">ups</option>
                <option value="uk_park">uk_park</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="format">CSV format</label>
              <select id="format" name="format" className={input} defaultValue="easyship">
                <option value="easyship">EasyShip export</option>
                <option value="generic">generic columns</option>
              </select>
            </div>
          </div>
          <div>
            <label className={label} htmlFor="iref">Invoice ref</label>
            <input id="iref" name="invoiceRef" className={input} placeholder="EASYSHIP-2026-07" />
          </div>
          <div>
            <label className={label} htmlFor="csv">CSV</label>
            <textarea
              id="csv"
              name="csv"
              rows={7}
              className={`${input} font-mono text-xs`}
              placeholder={"tracking_number,ship_cost,duties,order_number\n9249090267338800000360,4.95,0,#13965"}
            />
          </div>
          <button type="submit" disabled={itemPending} className={button}>
            {itemPending ? "Importing…" : "Import & match"}
          </button>
          <Msg state={itemState} />
        </form>
      </section>
    </div>
  );
}
