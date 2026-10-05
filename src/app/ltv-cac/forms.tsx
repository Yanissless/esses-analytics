"use client";

import { useActionState } from "react";
import { saveLtvCacAssumption, type LtvCacActionState } from "./actions";
import type { TierRow } from "@/metrics/ltv-cac";

const initial: LtvCacActionState = {};

const input =
  "w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";
const label = "mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400";
const button =
  "rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900";
const card =
  "rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900";

function Msg({ state }: { state: LtvCacActionState }) {
  if (!state.error && !state.ok) return null;
  return (
    <div className="mt-3 space-y-1 text-sm">
      {state.ok ? <p className="text-emerald-600 dark:text-emerald-400">{state.ok}</p> : null}
      {state.error ? <p className="text-red-600 dark:text-red-400">{state.error}</p> : null}
    </div>
  );
}

/**
 * One editable tier/route row. A real per-row form, not one form for the whole
 * table — editing Digital can't accidentally resubmit Premium mid-edit.
 * Pre-filled from the current row so an edit is "change one number and save",
 * not "retype everything".
 */
function TierForm({ row, today }: { row: TierRow; today: string }) {
  const [state, action, pending] = useActionState(saveLtvCacAssumption, initial);
  const pct = (v: number) => (v * 100).toFixed(v * 100 < 1 && v > 0 ? 2 : 1);

  return (
    <details className="group rounded-lg border border-neutral-200 dark:border-neutral-800">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm font-medium">
        <span>
          {row.tierLabel} <span className="font-normal text-neutral-400">· {row.route}</span>
        </span>
        <span className="text-xs text-neutral-400 group-open:hidden">edit</span>
      </summary>
      <form action={action} className="space-y-3 border-t border-neutral-100 p-3 dark:border-neutral-800">
        <input type="hidden" name="tier" value={row.tier} />
        <input type="hidden" name="route" value={row.route} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <label className={label}>Tier label</label>
            <input name="tierLabel" defaultValue={row.tierLabel} required className={input} />
          </div>
          <div>
            <label className={label}>Effective date</label>
            <input name="effectiveDate" defaultValue={today} className={input} />
          </div>
          <div>
            <label className={label}>List price (USD/yr)</label>
            <input
              name="listPrice"
              defaultValue={(row.inputs.listPriceCents / 100).toFixed(2)}
              inputMode="decimal"
              required
              className={input}
            />
          </div>
          <div>
            <label className={label}>Year-1 intro discount (%)</label>
            <input
              name="introDiscountPct"
              defaultValue={pct(row.inputs.introDiscountPct)}
              inputMode="decimal"
              className={input}
            />
          </div>
          <div>
            <label className={label}>Processing (%)</label>
            <input
              name="processingPct"
              defaultValue={pct(row.inputs.processingPct)}
              inputMode="decimal"
              className={input}
            />
          </div>
          <div>
            <label className={label}>COGS per billing cycle (USD)</label>
            <input
              name="annualCogs"
              defaultValue={(row.inputs.annualCogsCents / 100).toFixed(2)}
              inputMode="decimal"
              className={input}
            />
          </div>
          <div>
            <label className={label}>Billing cycle (months)</label>
            <input
              name="cycleMonths"
              defaultValue={row.inputs.cycleMonths ?? 12}
              inputMode="numeric"
              required
              className={input}
            />
          </div>
          <div>
            <label className={label}>r1 — first-renewal survival (%)</label>
            <input name="r1" defaultValue={pct(row.inputs.r1)} inputMode="decimal" required className={input} />
          </div>
          <div>
            <label className={label}>r2 — steady-state retention (%)</label>
            <input name="r2" defaultValue={pct(row.inputs.r2)} inputMode="decimal" required className={input} />
          </div>
          <div>
            <label className={label}>Discount rate d (%/yr)</label>
            <input
              name="discountRatePct"
              defaultValue={pct(row.inputs.discountRatePct)}
              inputMode="decimal"
              className={input}
            />
          </div>
          <div>
            <label className={label}>Horizon (years)</label>
            <input
              name="horizonYears"
              defaultValue={row.inputs.horizonYears}
              inputMode="numeric"
              className={input}
            />
          </div>
          <div>
            <label className={label}>CAC — fully loaded (USD)</label>
            <input
              name="cac"
              defaultValue={(row.cacCents / 100).toFixed(2)}
              inputMode="decimal"
              required
              className={input}
            />
          </div>
          <div>
            <label className={label}>Target LTV:CAC ratio</label>
            <input name="targetRatio" defaultValue={row.targetRatio} inputMode="decimal" className={input} />
          </div>
          <div>
            <label className={label}>Share of current base (%, optional)</label>
            <input
              name="baseSharePct"
              defaultValue={row.baseSharePct == null ? "" : pct(row.baseSharePct)}
              inputMode="decimal"
              placeholder="only for the blended-LTV summary"
              className={input}
            />
          </div>
        </div>
        <div>
          <label className={label}>Note</label>
          <input name="note" defaultValue={row.note ?? ""} className={input} />
        </div>
        <input type="hidden" name="source" value="manual entry" />
        <button type="submit" disabled={pending} className={button}>
          {pending ? "Saving…" : "Save"}
        </button>
        <Msg state={state} />
      </form>
    </details>
  );
}

/**
 * Add a brand-new tier or route — same fields as `TierForm` but blank, for a
 * tier that doesn't exist yet (e.g. testing a new price point as its own row
 * rather than overwriting a live one).
 */
function NewTierForm({ today }: { today: string }) {
  const [state, action, pending] = useActionState(saveLtvCacAssumption, initial);

  return (
    <section className={card}>
      <h2 className="mb-1 text-sm font-medium">Add a tier or scenario</h2>
      <p className="mb-4 text-xs text-neutral-500">
        A new (tier, route) pair — e.g. testing a reprice as its own row rather than overwriting
        a live tier. <code className="font-mono">tier</code> is the stable key (lowercase,
        underscores); <code className="font-mono">route</code> is <code>bought</code> or{" "}
        <code>upgraded</code>.
      </p>
      <form action={action} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <label className={label}>Tier key</label>
          <input name="tier" required placeholder="print_digital_v2" className={input} />
        </div>
        <div>
          <label className={label}>Tier label</label>
          <input name="tierLabel" required placeholder="Print+digital $120" className={input} />
        </div>
        <div>
          <label className={label}>Route</label>
          <select name="route" defaultValue="bought" className={input}>
            <option value="bought">bought</option>
            <option value="upgraded">upgraded</option>
          </select>
        </div>
        <div>
          <label className={label}>Effective date</label>
          <input name="effectiveDate" defaultValue={today} className={input} />
        </div>
        <div>
          <label className={label}>List price (USD/yr)</label>
          <input name="listPrice" required inputMode="decimal" placeholder="120.00" className={input} />
        </div>
        <div>
          <label className={label}>Year-1 intro discount (%)</label>
          <input name="introDiscountPct" defaultValue="10" inputMode="decimal" className={input} />
        </div>
        <div>
          <label className={label}>Processing (%)</label>
          <input name="processingPct" defaultValue="3" inputMode="decimal" className={input} />
        </div>
        <div>
          <label className={label}>COGS per billing cycle (USD)</label>
          <input name="annualCogs" defaultValue="0" inputMode="decimal" className={input} />
        </div>
        <div>
          <label className={label}>Billing cycle (months)</label>
          <input
            name="cycleMonths"
            defaultValue="12"
            required
            inputMode="numeric"
            placeholder="12, or 3 for quarterly"
            className={input}
          />
        </div>
        <div>
          <label className={label}>r1 — first-renewal survival (%)</label>
          <input name="r1" required inputMode="decimal" placeholder="67" className={input} />
        </div>
        <div>
          <label className={label}>r2 — steady-state retention (%)</label>
          <input name="r2" required inputMode="decimal" placeholder="76" className={input} />
        </div>
        <div>
          <label className={label}>Discount rate d (%/yr)</label>
          <input name="discountRatePct" defaultValue="15" inputMode="decimal" className={input} />
        </div>
        <div>
          <label className={label}>Horizon (years)</label>
          <input name="horizonYears" defaultValue="3" inputMode="numeric" className={input} />
        </div>
        <div>
          <label className={label}>CAC — fully loaded (USD)</label>
          <input name="cac" required inputMode="decimal" placeholder="48.00" className={input} />
        </div>
        <div className="col-span-2 sm:col-span-3">
          <label className={label}>Note</label>
          <input name="note" placeholder="why this scenario exists" className={input} />
        </div>
        <div className="col-span-2 sm:col-span-3">
          <input type="hidden" name="source" value="manual entry" />
          <button type="submit" disabled={pending} className={button}>
            {pending ? "Saving…" : "Add tier"}
          </button>
          <Msg state={state} />
        </div>
      </form>
    </section>
  );
}

export function LtvCacForms({ rows, today }: { rows: TierRow[]; today: string }) {
  return (
    <div className="space-y-6">
      <section className={card}>
        <h2 className="mb-1 text-sm font-medium">Edit assumptions</h2>
        <p className="mb-4 text-xs text-neutral-500">
          Every figure below feeds the formula directly — change one and every number on this
          page recomputes. Saving writes a new row effective on the date given, so past LTV keeps
          whatever assumptions were true at the time; use today&rsquo;s date to update the figure
          going forward.
        </p>
        <div className="space-y-2">
          {rows.map((r) => (
            <TierForm key={`${r.tier}-${r.route}`} row={r} today={today} />
          ))}
        </div>
      </section>

      <NewTierForm today={today} />
    </div>
  );
}
