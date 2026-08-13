/**
 * Daily reach as bars, with views behind them.
 *
 * **Not** a Client Component, on purpose. There is no interaction here — no hover state, no
 * toggle — so it renders on the server and cannot hit the serialization trap that has bitten
 * this codebase three times: a function or a module-level object passed across the boundary
 * type-checks and builds cleanly, then arrives as a client reference at request time. Anything
 * static should stay on the server, where that failure mode does not exist.
 *
 * Bars rather than a line because reach is a per-day quantity, not a level that carries over
 * between days. A line implies the value existed continuously in between; a bar says "this day
 * had this much", which is what the number means.
 */

const AXIS = "#a3a3a3";

export function ReachSparkline({
  points,
}: {
  points: Array<{ date: string; reach: number | null; views: number | null }>;
}) {
  const withReach = points.filter(
    (p): p is { date: string; reach: number; views: number | null } => p.reach !== null,
  );
  if (withReach.length < 2) return null;

  const W = 720;
  const H = 130;
  const PAD_B = 18;
  const PAD_T = 6;
  // Views scale the same axis as reach so the two are comparable by height — views is always
  // the larger of the two by definition, so it sets the ceiling.
  const peak = Math.max(...withReach.map((p) => Math.max(p.reach, p.views ?? 0)), 1);
  const slot = W / withReach.length;
  const barW = Math.max(1, slot * 0.62);
  const plotH = H - PAD_B - PAD_T;

  const first = withReach[0].date;
  const last = withReach[withReach.length - 1].date;
  // Views set the ceiling whenever they exist, so the axis max must say WHICH series it
  // belongs to. Unlabelled, it sits next to a "best day" reach tile showing a smaller number
  // and reads as a contradiction.
  const peakReach = Math.max(...withReach.map((p) => p.reach));
  const ceilingLabel =
    peak > peakReach
      ? `axis max ${peak.toLocaleString("en-US")} views`
      : `peak reach ${peak.toLocaleString("en-US")}`;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-4 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-neutral-800 dark:bg-neutral-200" />
          accounts reached
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-neutral-300 dark:bg-neutral-700" />
          views
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Daily Instagram reach from ${first} to ${last}, highest day ${peakReach.toLocaleString("en-US")} accounts reached`}
      >
        {withReach.map((p, idx) => {
          const xLeft = idx * slot + (slot - barW) / 2;
          const rh = (p.reach / peak) * plotH;
          const vh = p.views == null ? 0 : (p.views / peak) * plotH;
          return (
            <g key={p.date}>
              {/* Views sit behind, full slot width, so reach reads as a share of them. */}
              {vh > 0 ? (
                <rect
                  x={idx * slot + (slot - barW * 1.35) / 2}
                  y={PAD_T + plotH - vh}
                  width={barW * 1.35}
                  height={vh}
                  className="fill-neutral-300 dark:fill-neutral-700"
                />
              ) : null}
              <rect
                x={xLeft}
                y={PAD_T + plotH - rh}
                width={barW}
                height={rh}
                className="fill-neutral-800 dark:fill-neutral-200"
              >
                <title>{`${p.date}: ${p.reach.toLocaleString("en-US")} reached${
                  p.views == null ? "" : `, ${p.views.toLocaleString("en-US")} views`
                }`}</title>
              </rect>
            </g>
          );
        })}
        <line x1={0} y1={PAD_T + plotH} x2={W} y2={PAD_T + plotH} stroke={AXIS} strokeWidth={1} />
      </svg>

      <div className="flex justify-between text-[11px] text-neutral-400 dark:text-neutral-500">
        <span>{first}</span>
        <span>{ceilingLabel}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}
