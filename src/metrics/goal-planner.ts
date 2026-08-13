/**
 * Turning an annual target into monthly ones.
 *
 * StoreHero's pitch is "set an annual target once and we auto-build seasonally adjusted
 * monthly benchmarks". The adjustment is the interesting part and the part that is easy to
 * fake, so this module is mostly about refusing to.
 *
 * ## Why seasonal weighting is refused below two years of history
 *
 * A seasonal index for August needs several Augusts. With 11 months of data there is exactly
 * ONE observation per calendar month, so "August is a weak month" and "August was weak that
 * year" and "the business was smaller by August" are the same number. Weighting on that
 * doesn't encode seasonality, it encodes last year's trend and one-offs, then hands it back
 * as a target with a confident-looking shape.
 *
 * The failure is not neutral either. It sets the lowest targets for the months that happened
 * to be quiet, so a genuinely bad month clears its target comfortably and nothing flags.
 *
 * So: `monthlyWeights` returns flat weights and a stated reason until there are two full
 * cycles. `method` is on the return value, not buried in a comment, because the page has to
 * be able to say which one it used.
 *
 * ## Releases, not calendar months
 *
 * For this business the real driver is when an issue ships — months with a release run
 * 1,100-1,600 orders and months without run 200-400, a 4x swing that dwarfs anything
 * seasonal. `releaseWeights` splits an annual target by where releases actually land, which
 * needs no history at all: it needs the publishing schedule, which is known in advance.
 *
 * That is the mode to use here. Calendar seasonality is the wrong model for a business whose
 * revenue is driven by a calendar you control.
 */

/** Two full cycles. Below this, one observation per month is all a "seasonal index" has. */
export const MIN_MONTHS_FOR_SEASONALITY = 24;

export type WeightMethod = "flat" | "seasonal" | "release";

export interface MonthlyWeights {
  /** Twelve weights, one per calendar month, summing to 1. */
  weights: number[];
  method: WeightMethod;
  /** Why this method was chosen. Always populated — the page states it. */
  reason: string;
}

const FLAT = (): number[] => new Array(12).fill(1 / 12);

/**
 * Weights from historical monthly totals.
 *
 * `history` is one entry per calendar month per year observed, e.g. two entries for month 7
 * if two Julys are present. Anything under `MIN_MONTHS_FOR_SEASONALITY` distinct months of
 * data returns flat weights with the reason attached rather than a shape it cannot support.
 */
export function monthlyWeights(
  history: Array<{ month: number; value: number }>,
  minMonths = MIN_MONTHS_FOR_SEASONALITY,
): MonthlyWeights {
  if (history.length < minMonths) {
    return {
      weights: FLAT(),
      method: "flat",
      reason:
        `${history.length} months of history — a seasonal index needs at least ${minMonths} ` +
        "so each calendar month has more than one observation. Below that, weighting encodes " +
        "last year's trend rather than seasonality, and sets the easiest targets for the " +
        "months that happened to be quiet.",
    };
  }

  const totals = new Array(12).fill(0);
  const counts = new Array(12).fill(0);
  for (const h of history) {
    const i = h.month - 1;
    if (i < 0 || i > 11) continue;
    totals[i] += h.value;
    counts[i] += 1;
  }

  // Average per calendar month, so an extra observed January doesn't outweigh the rest.
  const avgs = totals.map((t, i) => (counts[i] === 0 ? 0 : t / counts[i]));
  const sum = avgs.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    return {
      weights: FLAT(),
      method: "flat",
      reason: "History sums to zero, so there is no shape to weight by.",
    };
  }
  if (counts.some((c) => c === 0)) {
    return {
      weights: FLAT(),
      method: "flat",
      reason:
        "At least one calendar month has no history at all, so a full-year shape cannot be " +
        "built without inventing the missing months.",
    };
  }

  return {
    weights: avgs.map((a) => a / sum),
    method: "seasonal",
    reason: `Weighted by the average of ${history.length} observed months.`,
  };
}

/**
 * Weights from a publishing schedule.
 *
 * `releaseMonths` is the 1-12 month number of each issue release in the year; a month with
 * two releases counts twice. `baselineShare` is the fraction of the year's total that arrives
 * regardless of releases — ongoing subscription renewals and back-issue sales — spread evenly,
 * with the remainder split across release months.
 *
 * Needs no history: the schedule is known in advance, which is exactly why it beats inferring
 * seasonality from a single incomplete year.
 */
export function releaseWeights(
  releaseMonths: number[],
  baselineShare = 0.35,
  /**
   * Day of the month releases land on. A mid-month release does NOT put its revenue in one
   * month: Esses ships on the 15th, so roughly half the surge falls in the release month and
   * half in the next. Assigning it all to the release month sets a target that month cannot
   * hit and hands the following month a target it beats for free — the pattern looks like
   * alternating over- and under-performance that isn't real.
   *
   * The split is proportional to the days remaining in the release month, which assumes the
   * surge decays evenly over about a month. That is an assumption, not a measurement; with
   * more history it should be replaced by the observed decay curve.
   */
  releaseDay = 1,
): MonthlyWeights {
  const valid = releaseMonths.filter((m) => m >= 1 && m <= 12);
  if (valid.length === 0) {
    return {
      weights: FLAT(),
      method: "flat",
      reason: "No release months given, so the target is spread evenly.",
    };
  }
  const base = Math.min(Math.max(baselineShare, 0), 1);
  const day = Math.min(Math.max(Math.round(releaseDay), 1), 28);

  // Share of the surge landing in the release month itself. Day 1 → all of it; day 15 → ~half.
  const inMonth = Math.min(Math.max((30 - day + 1) / 30, 0), 1);

  const surge = new Array(12).fill(0);
  for (const m of valid) {
    surge[m - 1] += inMonth;
    // December's spillover lands in January, which is the same calendar-month bucket next
    // year — for an annual shape that wraps rather than being discarded.
    surge[m % 12] += 1 - inMonth;
  }
  const surgeTotal = surge.reduce((a, b) => a + b, 0);

  const weights = surge.map((s) => base / 12 + (1 - base) * (s / surgeTotal));
  return {
    weights,
    method: "release",
    reason:
      `${valid.length} release(s) on day ${day} of months ${valid.join(", ")}. ` +
      `${Math.round(inMonth * 100)}% of each release's surge is placed in its own month and ` +
      `${Math.round((1 - inMonth) * 100)}% in the following one, because a mid-month release ` +
      `straddles two. ${Math.round(base * 100)}% of the year is treated as baseline renewals ` +
      "and spread evenly.",
  };
}

export interface MonthlyTarget {
  /** YYYY-MM-01, matching `goals.period_start`. */
  periodStart: string;
  /** Same unit as the annual figure — cents for money metrics. */
  target: number;
}

/**
 * Splits an annual target across twelve months.
 *
 * Rounds to integers and puts the rounding remainder on the LARGEST month, so the twelve
 * monthly targets sum exactly to the annual one. Letting them sum to annual ± a few units is
 * the kind of thing nobody notices until someone reconciles the year and finds the targets
 * don't add up to the target.
 */
export function splitAnnualTarget(
  annual: number,
  year: number,
  weights: number[],
): MonthlyTarget[] {
  if (weights.length !== 12) throw new Error("weights must have 12 entries");
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("weights must sum to more than zero");

  const raw = weights.map((w) => (annual * w) / sum);
  const rounded = raw.map((v) => Math.round(v));

  const drift = Math.round(annual) - rounded.reduce((a, b) => a + b, 0);
  if (drift !== 0) {
    let biggest = 0;
    for (let i = 1; i < 12; i++) if (rounded[i] > rounded[biggest]) biggest = i;
    rounded[biggest] += drift;
  }

  return rounded.map((target, i) => ({
    periodStart: `${year}-${String(i + 1).padStart(2, "0")}-01`,
    target,
  }));
}

/**
 * Where a metric stands against its target, as a share.
 *
 * Returns null rather than 0 when there is no target or the target is zero — "no target set"
 * and "0% of target" are different statements and the badge must not render the second when
 * it means the first.
 */
export function targetProgress(actual: number, target: number | null): number | null {
  if (target === null || target === 0 || !Number.isFinite(target)) return null;
  return actual / target;
}

/**
 * Pace-adjusted variance: how far ahead or behind the run rate is, as a fraction.
 *
 * +0.05 is "5% ahead of target", the phrasing on the badge. Comparing raw progress against a
 * whole month's target on the 3rd would report every month as catastrophically behind, so the
 * target is pro-rated by how much of the period has elapsed.
 *
 * Null when there is no target, or before any of the period has elapsed — on day zero
 * everything is infinitely behind, which is noise rather than news.
 *
 * ⚠️ This is the same quantity as `GoalProgress.pace - 1` from `metrics/forecast.server.ts`.
 * Two expressions of one rule is how `revenue_class` and the shipping predicate went wrong, so
 * when a caller already holds a `GoalProgress`, use `paceFromProgress` below rather than
 * recomputing here from parts. This function is for callers that only have the raw numbers.
 */
export function paceVariance(
  actual: number,
  target: number | null,
  daysElapsed: number,
  daysInPeriod: number,
): number | null {
  if (target === null || target <= 0) return null;
  if (daysElapsed <= 0 || daysInPeriod <= 0) return null;
  const expected = target * (Math.min(daysElapsed, daysInPeriod) / daysInPeriod);
  if (expected <= 0) return null;
  return actual / expected - 1;
}

/**
 * Variance from an already-computed `pace`, which is the only form a page should use when it
 * has a `GoalProgress` in hand.
 *
 * Trivial arithmetic, deliberately given a name: it makes "convert pace to variance" a single
 * place rather than a `- 1` scattered across every tile, and it keeps the null handling
 * identical to `paceVariance` instead of relying on each caller to remember it.
 */
export function paceFromProgress(pace: number | null | undefined): number | null {
  if (pace === null || pace === undefined || !Number.isFinite(pace)) return null;
  return pace - 1;
}
