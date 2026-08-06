"use client";

import { useActionState } from "react";
import { saveGoal, type GoalActionState } from "./actions";
import { GOAL_METRICS, GOAL_METRIC_IDS } from "@/metrics/forecast";

const initial: GoalActionState = {};

const input =
  "w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";
const label = "mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400";
const button =
  "rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900";

export interface ExistingGoal {
  metric: string;
  /** Already converted for display: dollars for money metrics, count otherwise. */
  displayValue: string;
}

/**
 * Set monthly targets.
 *
 * Money targets are typed in dollars, not cents — the action converts. Leaving a field
 * blank clears that target, which is distinct from setting it to zero.
 */
export function GoalForm({
  periodStart,
  existing,
}: {
  periodStart: string;
  existing: ExistingGoal[];
}) {
  const [state, action, pending] = useActionState(saveGoal, initial);
  const byMetric = new Map(existing.map((e) => [e.metric, e.displayValue]));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {GOAL_METRIC_IDS.map((id) => {
          const meta = GOAL_METRICS[id];
          return (
            <form key={id} action={action} className="space-y-2">
              <input type="hidden" name="metric" value={id} />
              <input type="hidden" name="periodStart" value={periodStart} />
              <div>
                <label className={label} htmlFor={`goal-${id}`}>
                  {meta.label} {meta.unit === "money" ? "($)" : "(count)"}
                </label>
                <input
                  id={`goal-${id}`}
                  name="target"
                  className={input}
                  defaultValue={byMetric.get(id) ?? ""}
                  placeholder="blank clears the target"
                  inputMode="decimal"
                />
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {meta.hint}
                </p>
              </div>
              <button type="submit" className={button} disabled={pending}>
                {pending ? "Saving…" : `Set ${meta.label.toLowerCase()}`}
              </button>
            </form>
          );
        })}
      </div>
      {state.ok || state.error ? (
        <div className="space-y-1 text-sm">
          {state.ok ? <p className="text-emerald-600 dark:text-emerald-400">{state.ok}</p> : null}
          {state.error ? <p className="text-red-600 dark:text-red-400">{state.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
