"use client";

/**
 * Charts for follower growth against subscriber growth.
 *
 * ## One axis, indexed — not two axes
 *
 * Followers run ~18,000 and subscribers ~2,000, so the tempting chart is a dual y-axis
 * with one line on each. That chart is unfalsifiable: where the lines cross and how far
 * apart they sit are consequences of where you put the two scales, not of the data. Slide
 * one axis and the story changes. So both series are indexed to 100 at the first week
 * with a real follower reading and share a single axis — which is also the question
 * actually being asked ("is follower growth outpacing subscriber growth?") rather than
 * the one a dual axis answers ("do these two unrelated numbers happen to touch?").
 *
 * Colours are the validated categorical slots 1 and 2, stepped separately for light and
 * dark surfaces. Identity is never carried by colour alone: both lines are directly
 * labelled at their right-hand end and a legend is always present.
 */

import { useId, useMemo, useState } from "react";
import type { IndexedPoint, LagResult } from "@/metrics/audience-growth";

// Validated categorical slots 1 (blue) and 2 (orange), light / dark steps.
const FOLLOWER = { light: "#2a78d6", dark: "#3987e5" };
const SUBSCRIBER = { light: "#eb6834", dark: "#d95926" };

const PAD = { top: 16, right: 60, bottom: 28, left: 40 };
const W = 760;
const H = 260;

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** Splits a series into runs of consecutive non-null points, so gaps stay gaps. */
function segments(values: Array<number | null>): Array<Array<{ i: number; v: number }>> {
  const out: Array<Array<{ i: number; v: number }>> = [];
  let run: Array<{ i: number; v: number }> = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) out.push(run);
      run = [];
    } else {
      run.push({ i, v });
    }
  });
  if (run.length) out.push(run);
  return out;
}

export function IndexedGrowthChart({ points }: { points: IndexedPoint[] }) {
  const clip = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    const values = points.flatMap((p) =>
      [p.followerIndex, p.subscriberIndex].filter((v): v is number => v !== null),
    );
    const lo = Math.min(100, ...values);
    const hi = Math.max(100, ...values);
    const padY = (hi - lo) * 0.08 || 5;
    const yMin = lo - padY;
    const yMax = hi + padY;
    const x = (i: number) =>
      PAD.left +
      (points.length <= 1 ? 0 : (i / (points.length - 1)) * (W - PAD.left - PAD.right));
    const y = (v: number) =>
      PAD.top + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);
    return { x, y, yMin, yMax, ticks: niceTicks(yMin, yMax) };
  }, [points]);

  if (points.length < 2) return null;

  const line = (values: Array<number | null>) =>
    segments(values)
      .map((run) => run.map((p, k) => `${k === 0 ? "M" : "L"}${geom.x(p.i)},${geom.y(p.v)}`).join(" "))
      .join(" ");

  const last = (values: Array<number | null>) => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return { i, v: values[i] as number };
    return null;
  };

  const followers = points.map((p) => p.followerIndex);
  const subscribers = points.map((p) => p.subscriberIndex);
  const fLast = last(followers);
  const sLast = last(subscribers);
  const active = hover === null ? null : points[hover];

  return (
    <figure className="m-0">
      {/* Legend — always present for two series, and each line is directly labelled too,
          so identity never rests on colour alone. */}
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-neutral-600 dark:text-neutral-400">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-0.5 w-4 rounded-full"
            style={{ background: "var(--follower)" }}
          />
          Followers
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-0.5 w-4 rounded-full"
            style={{ background: "var(--subscriber)" }}
          />
          Subscribers
        </span>
        <span className="text-neutral-400">both = 100 at {shortDate(points[0].weekStart)}</span>
      </div>

      <div
        className="relative"
        style={
          {
            "--follower": FOLLOWER.light,
            "--subscriber": SUBSCRIBER.light,
          } as React.CSSProperties
        }
      >
        <style>{`@media (prefers-color-scheme: dark) {
          .audience-chart { --follower: ${FOLLOWER.dark}; --subscriber: ${SUBSCRIBER.dark}; }
        }`}</style>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="audience-chart w-full"
          role="img"
          aria-label="Follower and subscriber growth, both indexed to 100 at the start of the window"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * W;
            const t = (px - PAD.left) / (W - PAD.left - PAD.right);
            const i = Math.round(t * (points.length - 1));
            setHover(Math.max(0, Math.min(points.length - 1, i)));
          }}
        >
          <clipPath id={clip}>
            <rect x={PAD.left} y={0} width={W - PAD.left - PAD.right} height={H} />
          </clipPath>

          {/* Recessive grid. The 100 baseline is slightly stronger — it's the reference. */}
          {geom.ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={geom.y(t)}
                y2={geom.y(t)}
                stroke="currentColor"
                strokeWidth={t === 100 ? 1 : 0.5}
                className={t === 100 ? "text-neutral-400" : "text-neutral-200 dark:text-neutral-800"}
              />
              <text
                x={PAD.left - 8}
                y={geom.y(t) + 3.5}
                textAnchor="end"
                className="fill-neutral-400 text-[10px]"
              >
                {t}
              </text>
            </g>
          ))}

          {/* x labels: first, middle, last only — a label on every week is unreadable. */}
          {[0, Math.floor((points.length - 1) / 2), points.length - 1].map((i) => (
            <text
              key={i}
              x={geom.x(i)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
              className="fill-neutral-400 text-[10px]"
            >
              {shortDate(points[i].weekStart)}
            </text>
          ))}

          <g clipPath={`url(#${clip})`}>
            <path d={line(subscribers)} fill="none" stroke="var(--subscriber)" strokeWidth={2} />
            <path d={line(followers)} fill="none" stroke="var(--follower)" strokeWidth={2} />
          </g>

          {/* Crosshair + markers on hover. */}
          {active && (
            <g>
              <line
                x1={geom.x(hover as number)}
                x2={geom.x(hover as number)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke="currentColor"
                strokeWidth={1}
                className="text-neutral-300 dark:text-neutral-700"
              />
              {active.subscriberIndex !== null && (
                <circle
                  cx={geom.x(hover as number)}
                  cy={geom.y(active.subscriberIndex)}
                  r={4.5}
                  fill="var(--subscriber)"
                  stroke="var(--surface-ring, #fff)"
                  strokeWidth={2}
                  className="[--surface-ring:#fff] dark:[--surface-ring:#171717]"
                />
              )}
              {active.followerIndex !== null && (
                <circle
                  cx={geom.x(hover as number)}
                  cy={geom.y(active.followerIndex)}
                  r={4.5}
                  fill="var(--follower)"
                  stroke="var(--surface-ring, #fff)"
                  strokeWidth={2}
                  className="[--surface-ring:#fff] dark:[--surface-ring:#171717]"
                />
              )}
            </g>
          )}

          {/* Direct end labels — the secondary encoding that keeps identity off colour.
              Both sit at the same x (the series' last point), so when the two indices
              converge the labels would overlap and become unreadable. Nudge them apart
              when they're within a line-height of each other. */}
          {(() => {
            if (!fLast && !sLast) return null;
            const fy = fLast ? geom.y(fLast.v) : null;
            const sy = sLast ? geom.y(sLast.v) : null;
            let fOff = 0;
            let sOff = 0;
            if (fy !== null && sy !== null && Math.abs(fy - sy) < 12) {
              // Keep their vertical order; separate to 12px total.
              const push = (12 - Math.abs(fy - sy)) / 2;
              const followerIsAbove = fy <= sy;
              fOff = followerIsAbove ? -push : push;
              sOff = followerIsAbove ? push : -push;
            }
            return (
              <>
                {fLast && (
                  <text
                    x={geom.x(fLast.i) + 6}
                    y={(fy as number) + 3.5 + fOff}
                    className="fill-neutral-500 text-[10px] dark:fill-neutral-400"
                  >
                    Followers
                  </text>
                )}
                {sLast && (
                  <text
                    x={geom.x(sLast.i) + 6}
                    y={(sy as number) + 3.5 + sOff}
                    className="fill-neutral-500 text-[10px] dark:fill-neutral-400"
                  >
                    Subs
                  </text>
                )}
              </>
            );
          })()}
        </svg>

        {active && (
          <div
            className="pointer-events-none absolute top-0 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
            style={{
              left: `${((geom.x(hover as number) + 10) / W) * 100}%`,
              transform: (hover as number) > points.length * 0.7 ? "translateX(-110%)" : undefined,
            }}
          >
            <div className="font-medium text-neutral-700 dark:text-neutral-200">
              week of {shortDate(active.weekStart)}
            </div>
            <div className="mt-0.5 text-neutral-600 dark:text-neutral-400">
              Followers {active.followerIndex === null ? "—" : active.followerIndex.toFixed(1)}
            </div>
            <div className="text-neutral-600 dark:text-neutral-400">
              Subscribers {active.subscriberIndex === null ? "—" : active.subscriberIndex.toFixed(1)}
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}

/**
 * One absolute total, on its own axis.
 *
 * Used as a small multiple: followers (~18,000) and subscribers (~2,000) each get their
 * own chart rather than sharing one with two y-scales. Two charts side by side let you
 * read each real number off its own axis and still compare shapes — which is what a dual
 * axis pretends to offer while actually making the gap between the lines an artefact of
 * scale placement. A single series, so no legend: the card title names it.
 */
export function AbsoluteSeriesChart({
  weeks,
  values,
  series,
  label,
  precision = 0,
}: {
  /** ISO week starts, parallel to `values`. */
  weeks: string[];
  /**
   * The series itself, already extracted server-side.
   *
   * Deliberately plain data rather than a `(point) => number` accessor: props crossing
   * into a Client Component must be serializable, and a function is not. That fails at
   * REQUEST time with "Functions cannot be passed directly to Client Components" —
   * neither `tsc` nor `build` catches it, only actually loading the page does. Same family
   * as rule 6 in CLAUDE.md, one boundary further along.
   */
  values: Array<number | null>;
  /**
   * Which categorical slot to paint, as a string rather than the colour itself.
   *
   * The palette cannot be exported from this module and read by the page: a Server
   * Component importing a plain value from a `"use client"` file receives a client
   * *reference*, not the object, so `colour.dark` is undefined at render. Another
   * request-time-only failure that `tsc` and `build` both pass. So the client side owns
   * the palette and the server just names the series.
   */
  series: "follower" | "subscriber";
  label: string;
  /** Decimal places. 0 for counts, 1 for the followers-per-subscriber ratio. */
  precision?: number;
}) {
  const clip = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const h = 150;
  const colour = series === "follower" ? FOLLOWER : SUBSCRIBER;

  const format = (n: number) =>
    precision === 0 ? Math.round(n).toLocaleString("en-US") : n.toFixed(precision);
  const real = values.filter((v): v is number => v !== null);
  if (real.length < 2) {
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">Not enough data yet.</p>;
  }

  const lo = Math.min(...real);
  const hi = Math.max(...real);
  // Absolute totals are NOT zero-based here: these are levels in the tens of thousands
  // where the interesting movement is a few percent, and forcing zero would flatten the
  // line into a straight edge. A line chart of a level carries no area-vs-baseline
  // meaning, so this is honest — it would not be for bars.
  const pad = (hi - lo) * 0.12 || Math.max(hi * 0.02, 1);
  const yMin = Math.max(0, lo - pad);
  const yMax = hi + pad;
  const x = (i: number) =>
    PAD.left + (weeks.length <= 1 ? 0 : (i / (weeks.length - 1)) * (W - PAD.left - 12));
  const y = (v: number) => 12 + (1 - (v - yMin) / (yMax - yMin)) * (h - 12 - PAD.bottom);
  const ticks = niceTicks(yMin, yMax, 3);

  const path = segments(values)
    .map((run) => run.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i)},${y(p.v)}`).join(" "))
    .join(" ");

  const active = hover === null ? null : values[hover];

  return (
    <figure className="relative m-0">
      <style>{`@media (prefers-color-scheme: dark) {
        .abs-${clip} { --c: ${colour.dark}; }
      }`}</style>
      <svg
        viewBox={`0 0 ${W} ${h}`}
        className={`abs-${clip} w-full`}
        style={{ ["--c" as string]: colour.light }}
        role="img"
        aria-label={`${label} over time`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const t = (px - PAD.left) / (W - PAD.left - 12);
          setHover(Math.max(0, Math.min(weeks.length - 1, Math.round(t * (weeks.length - 1)))));
        }}
      >
        <clipPath id={clip}>
          <rect x={PAD.left} y={0} width={W - PAD.left - 12} height={h} />
        </clipPath>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - 12}
              y1={y(t)}
              y2={y(t)}
              stroke="currentColor"
              strokeWidth={0.5}
              className="text-neutral-200 dark:text-neutral-800"
            />
            <text x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end" className="fill-neutral-400 text-[10px]">
              {format(t)}
            </text>
          </g>
        ))}
        {[0, weeks.length - 1].map((i) => (
          <text
            key={i}
            x={x(i)}
            y={h - 6}
            textAnchor={i === 0 ? "start" : "end"}
            className="fill-neutral-400 text-[10px]"
          >
            {shortDate(weeks[i])}
          </text>
        ))}
        <g clipPath={`url(#${clip})`}>
          <path d={path} fill="none" stroke="var(--c)" strokeWidth={2} />
        </g>
        {hover !== null && active !== null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={12}
              y2={h - PAD.bottom}
              stroke="currentColor"
              strokeWidth={1}
              className="text-neutral-300 dark:text-neutral-700"
            />
            <circle
              cx={x(hover)}
              cy={y(active)}
              r={4.5}
              fill="var(--c)"
              stroke="#fff"
              strokeWidth={2}
              className="[stroke:#fff] dark:[stroke:#171717]"
            />
          </>
        )}
      </svg>
      {hover !== null && active !== null && (
        <div className="pointer-events-none absolute top-0 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
          style={{
            left: `${((x(hover) + 10) / W) * 100}%`,
            transform: hover > weeks.length * 0.7 ? "translateX(-110%)" : undefined,
          }}
        >
          <div className="font-medium text-neutral-700 dark:text-neutral-200">
            {shortDate(weeks[hover])}
          </div>
          <div className="mt-0.5 text-neutral-600 dark:text-neutral-400">
            {format(active)} {label.toLowerCase()}
          </div>
        </div>
      )}
    </figure>
  );
}


/**
 * Correlation of follower change against subscriber change at each weekly lag.
 *
 * One series, so no legend — the heading names it. A tall bar at lag 0 means the two
 * move together in the same week; a tall bar at lag 3 means follower growth arrives
 * about three weeks before subscriber growth, which would make social a genuine leading
 * indicator. Bars for lags that aren't measurable are drawn as an explicit gap rather
 * than as zero height, because rule 3: null is "not measurable", not "no relationship".
 */
/**
 * Bars are sized by |r| but the value is printed above every one, so the sign is readable
 * without relying on the colour — an inverse lag and a positive lag of the same strength are
 * the same height, and only the printed number and hue separate them.
 *
 * `unit` must match the grain the correlation actually ran at. It was hard-coded to "w" while
 * the page fell back to a daily profile, which labelled 8 days as 8 weeks.
 */
export function LagProfileChart({
  profile,
  unit = "w",
}: {
  profile: LagResult[];
  unit?: string;
}) {
  const measurable = profile.filter((p) => p.r !== null);
  if (measurable.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        Not enough paired observations to measure a lag yet.
      </p>
    );
  }
  const peak = Math.max(...measurable.map((p) => Math.abs(p.r as number)), 0.2);

  return (
    <div className="flex items-end gap-2" style={{ height: 120 }}>
      {profile.map((p) => {
        const h = p.r === null ? 0 : (Math.abs(p.r) / peak) * 88;
        return (
          <div key={p.lag} className="flex flex-1 flex-col items-center gap-1">
            <span className="text-[10px] text-neutral-400">
              {p.r === null ? "—" : p.r.toFixed(2)}
            </span>
            {p.r === null ? (
              <div
                className="w-full rounded border border-dashed border-neutral-300 dark:border-neutral-700"
                style={{ height: 8 }}
                title="not measurable — too few paired observations at this lag"
              />
            ) : (
              // 4px rounded data-end, anchored to the baseline.
              <div
                className="w-full rounded-t"
                style={{
                  height: Math.max(h, 2),
                  background: (p.r as number) < 0 ? SUBSCRIBER.light : FOLLOWER.light,
                }}
                title={`lag ${p.lag}${unit}: r = ${(p.r as number).toFixed(3)}${
                  (p.r as number) < 0 ? " (inverse)" : ""
                }`}
              />
            )}
            <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
              {p.lag}
              {unit}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The table view. Always available — colour is never the only channel. */
export function AudienceTable({ points }: { points: IndexedPoint[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-neutral-500 underline decoration-dotted hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        {open ? "Hide" : "Show"} the numbers
      </button>
      {open && (
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-neutral-50 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
              <tr>
                <th className="px-3 py-2 font-medium">Week</th>
                <th className="px-3 py-2 text-right font-medium">Followers (index)</th>
                <th className="px-3 py-2 text-right font-medium">Subscribers (index)</th>
              </tr>
            </thead>
            <tbody className="text-neutral-700 dark:text-neutral-300">
              {points.map((p) => (
                <tr key={p.weekStart} className="border-t border-neutral-100 dark:border-neutral-800">
                  <td className="px-3 py-1.5">{p.weekStart}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {p.followerIndex === null ? "—" : p.followerIndex.toFixed(1)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {p.subscriberIndex === null ? "—" : p.subscriberIndex.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
