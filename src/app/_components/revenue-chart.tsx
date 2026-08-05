import type { MonthlyPoint } from "@/metrics/overview";
import { formatUsd } from "./ui";

const SHOPIFY = "#2a78d6";
const STRIPE = "#eb6834";

/**
 * Stacked monthly revenue: Shopify orders + Stripe subscriptions. Plain SVG so it
 * renders on the server with no client JS and no charting dependency.
 */
export function RevenueChart({ data }: { data: MonthlyPoint[] }) {
  if (!data.length) {
    return <p className="text-sm text-neutral-500">No revenue data yet.</p>;
  }

  const W = 720;
  const H = 240;
  const padL = 56;
  const padR = 8;
  const padT = 8;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const totals = data.map((d) => d.shopifyNetCents + d.stripePaidCents);
  const rawMax = Math.max(...totals, 1);
  // Round the axis up to a clean step so gridline labels read nicely.
  const step = 10 ** Math.floor(Math.log10(rawMax)) / 2;
  const max = Math.ceil(rawMax / step) * step;

  const slot = plotW / data.length;
  const barW = Math.min(28, slot * 0.6);
  const y = (cents: number) => padT + plotH - (cents / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full min-w-[560px]"
        role="img"
        aria-label={`Monthly revenue from ${data[0].month} to ${data[data.length - 1].month}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(t)}
              y2={y(t)}
              className="stroke-neutral-200 dark:stroke-neutral-800"
              strokeWidth="1"
            />
            <text
              x={padL - 8}
              y={y(t) + 4}
              textAnchor="end"
              className="fill-neutral-400 text-[11px] tabular-nums"
            >
              {formatUsd(t, { compact: true })}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const cx = padL + slot * i + slot / 2;
          const x = cx - barW / 2;
          const shopH = (d.shopifyNetCents / max) * plotH;
          const stripeH = (d.stripePaidCents / max) * plotH;
          const shopY = padT + plotH - shopH;
          const stripeY = shopY - stripeH;
          const label = d.month.slice(5); // MM
          const showLabel = data.length <= 14 || i % 2 === 0;
          return (
            <g key={d.month}>
              <title>{`${d.month}: ${formatUsd(d.shopifyNetCents + d.stripePaidCents)}`}</title>
              {shopH > 0 ? <rect x={x} y={shopY} width={barW} height={shopH} fill={SHOPIFY} /> : null}
              {stripeH > 0 ? (
                <rect x={x} y={stripeY} width={barW} height={stripeH} fill={STRIPE} rx="2" />
              ) : null}
              {showLabel ? (
                <text
                  x={cx}
                  y={H - 10}
                  textAnchor="middle"
                  className="fill-neutral-400 text-[11px] tabular-nums"
                >
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}

        <line
          x1={padL}
          x2={W - padR}
          y1={padT + plotH}
          y2={padT + plotH}
          className="stroke-neutral-300 dark:stroke-neutral-700"
          strokeWidth="1"
        />
      </svg>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SHOPIFY }} />
          Shopify orders (net)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: STRIPE }} />
          Stripe subscriptions (paid)
        </span>
      </div>
    </div>
  );
}
