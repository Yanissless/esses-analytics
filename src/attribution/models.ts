/**
 * Attribution models (Section 8.3). Pure functions over a customer's touchpoint
 * path, returning fractional credit per touchpoint that always sums to 1.
 *
 * Implemented:
 *  - `last-non-direct` — all credit to the last touch that isn't direct. Matches
 *    what ad platforms mostly do, so it's the sanity-check model.
 *  - `linear` — credit split evenly. Blunt but unbiased.
 *  - `time-decay` — exponential weighting toward touches nearer the conversion,
 *    with a configurable half-life. This is the "better attribution" the business
 *    actually wants: it neither ignores earlier discovery nor pretends a
 *    three-week-old impression closed the sale.
 *  - `first-touch` — for acquisition analysis (which channel *found* them).
 *
 * Invariant enforced by tests: credit sums to exactly 1 (within float epsilon) for
 * every model and path, including all-direct paths. If a model can't attribute
 * (empty path), it returns an empty array rather than inventing a touchpoint.
 */

export type AttributionModel = "last-non-direct" | "linear" | "time-decay" | "first-touch";

export interface Touchpoint {
  id: string;
  channel: string;
  /** Milliseconds since epoch. */
  occurredAt: number;
  campaign?: string | null;
}

export interface CreditedTouchpoint extends Touchpoint {
  /** Fraction of the conversion credited to this touchpoint (0..1). */
  credit: number;
}

/**
 * Channels that carry no acquisition signal, so `last-non-direct` looks past them
 * for the touch that actually did the work. `internal` is here because a
 * self-referral (our own site → checkout) is navigation, not a channel.
 */
const DIRECT_CHANNELS = new Set(["direct", "unknown", "internal"]);

/** Default half-life for time decay: 7 days, the common industry setting. */
export const DEFAULT_HALF_LIFE_DAYS = 7;

function normalise(path: Touchpoint[]): Touchpoint[] {
  return [...path].sort((a, b) => a.occurredAt - b.occurredAt);
}

/**
 * Distribute credit across a path.
 *
 * `conversionAt` matters for time-decay: weights are measured back from the
 * conversion, not from the last touch, so a long gap between the final touch and
 * the purchase correctly reduces everything's weight relative to each other.
 */
export function attribute(
  path: Touchpoint[],
  model: AttributionModel,
  opts: { conversionAt?: number; halfLifeDays?: number } = {},
): CreditedTouchpoint[] {
  if (path.length === 0) return [];
  const sorted = normalise(path);

  switch (model) {
    case "first-touch": {
      return sorted.map((t, i) => ({ ...t, credit: i === 0 ? 1 : 0 }));
    }

    case "last-non-direct": {
      // Walk back for the last non-direct touch; if the whole path is direct,
      // credit the last touch rather than dropping the conversion entirely.
      let idx = -1;
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (!DIRECT_CHANNELS.has(sorted[i].channel)) {
          idx = i;
          break;
        }
      }
      if (idx === -1) idx = sorted.length - 1;
      return sorted.map((t, i) => ({ ...t, credit: i === idx ? 1 : 0 }));
    }

    case "linear": {
      const share = 1 / sorted.length;
      return sorted.map((t) => ({ ...t, credit: share }));
    }

    case "time-decay": {
      const halfLife = (opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS) * 24 * 3600 * 1000;
      const conversionAt = opts.conversionAt ?? sorted[sorted.length - 1].occurredAt;
      const weights = sorted.map((t) => {
        const age = Math.max(0, conversionAt - t.occurredAt);
        return Math.pow(2, -age / halfLife);
      });
      const total = weights.reduce((s, w) => s + w, 0);
      // All weights underflowing to 0 (an ancient path) would divide by zero;
      // fall back to an even split so the conversion is never lost.
      if (total <= 0) {
        const share = 1 / sorted.length;
        return sorted.map((t) => ({ ...t, credit: share }));
      }
      return sorted.map((t, i) => ({ ...t, credit: weights[i] / total }));
    }
  }
}

export interface ChannelCredit {
  channel: string;
  credit: number;
  revenueCents: number;
  conversions: number;
}

/**
 * Roll credited touchpoints up by channel, splitting an order's revenue in the
 * same proportions. Revenue is apportioned in cents and the remainder is given to
 * the largest share, so the parts always sum back to the order total.
 */
export function creditByChannel(
  credited: CreditedTouchpoint[],
  revenueCents: number,
): ChannelCredit[] {
  if (credited.length === 0) return [];

  const byChannel = new Map<string, { credit: number; revenue: number }>();
  for (const t of credited) {
    const cur = byChannel.get(t.channel) ?? { credit: 0, revenue: 0 };
    cur.credit += t.credit;
    byChannel.set(t.channel, cur);
  }

  const entries = [...byChannel.entries()];
  let allocated = 0;
  const out: ChannelCredit[] = entries.map(([channel, v]) => {
    const revenue = Math.round(revenueCents * v.credit);
    allocated += revenue;
    return { channel, credit: v.credit, revenueCents: revenue, conversions: v.credit };
  });

  // Push any rounding remainder onto the biggest share.
  const remainder = revenueCents - allocated;
  if (remainder !== 0 && out.length > 0) {
    const biggest = out.reduce((a, b) => (b.credit > a.credit ? b : a));
    biggest.revenueCents += remainder;
  }

  return out.sort((a, b) => b.credit - a.credit);
}

/**
 * Reconcile our attribution against a platform's self-reported conversions
 * (Section 8.4). The delta is the finding: ad platforms systematically over-claim
 * because they count view-through and cross-device conversions we can't see.
 */
export interface Reconciliation {
  channel: string;
  ourConversions: number;
  platformConversions: number;
  deltaAbsolute: number;
  /** Platform ÷ ours. >1 means the platform claims more than we can see. */
  overclaimRatio: number | null;
}

export function reconcile(
  ours: number,
  platform: number,
  channel: string,
): Reconciliation {
  return {
    channel,
    ourConversions: ours,
    platformConversions: platform,
    deltaAbsolute: platform - ours,
    overclaimRatio: ours === 0 ? null : platform / ours,
  };
}
