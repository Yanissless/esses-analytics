/**
 * The free-order promo registry: which codes give something away, and WHY.
 *
 * Sam's decision, 18 Aug 2026: a free first issue is an acquisition cost, not a prepaid
 * delivery. Nobody paid for it, so the product and shipping behind it is money spent to win a
 * subscriber — the same category as ad spend.
 *
 * ## Purpose is the whole point of this file
 *
 * The first version treated all four codes as one thing: "free issue promos", $39,452 of
 * acquisition cost, one conversion table. Sam corrected it, and the correction changes the
 * arithmetic rather than just the labels:
 *
 *   FREEFIRSTISSUE  free first quarter                     -> acquisition
 *   D1G90FJ1GQ28    free first issue (earlier run of it)   -> acquisition
 *   THANKYOU100     free YEAR to win back lapsed annuals   -> win-back
 *   f34hzrhds       lifetime free for clients and VIPs     -> comp
 *
 * Three consequences:
 *
 * **1. A comp is not an acquisition cost.** `f34hzrhds` recipients will never pay, by design.
 * Charging their $764 to acquisition would inflate CAC with a relationship cost, and putting
 * them in a conversion cohort would report a permanent 0% — a fabricated failure, since nobody
 * ever intended them to convert. They are excluded from both.
 *
 * **2. Win-back is not acquisition.** `THANKYOU100` went to people who had ALREADY subscribed
 * and lapsed. Its cohort is lapsed subscribers, its success is reactivation, and its benchmark
 * is other win-back attempts — not a first-issue offer aimed at strangers. Averaging the two
 * would flatter whichever is worse and bury whichever is better.
 *
 * **3. The acquisition figure drops.** $39,452 across four codes becomes $34,679 across two.
 *
 * ## Why this is a written-down list rather than a rule
 *
 * The obvious rule — "a $0 order from a customer who has never paid before" — matches 4,473
 * orders when only 1,907 are promotions. It sweeps in ordinary quarterly issue fulfilments,
 * because for those the money arrives on the SUBSCRIPTION charge rather than on the delivery
 * order, so the delivery legitimately looks unpaid in isolation.
 *
 * And no rule could have separated these four anyway. "Free year to win back a lapsed annual",
 * "lifetime free for a VIP" and "free first quarter" produce identical order rows. The
 * difference is what each code was created to do, which is knowledge rather than data — so it
 * is written down, and anything unlisted keeps its existing classification.
 */

export type PromoPurpose =
  /** Free issue or quarter offered to a NEW subscriber. A genuine acquisition cost. */
  | "acquisition"
  /** Free period offered to a LAPSED subscriber to reactivate them. */
  | "win-back"
  /** Lifetime or long-term free access for clients, VIPs and contributors. Never converts. */
  | "comp";

export interface PromoDefinition {
  code: string;
  purpose: PromoPurpose;
  /** What it is, in the words of whoever ran it. Shown in the UI. */
  label: string;
}

/**
 * Every code whose $0 orders mean something deliberate.
 *
 * Confirmed by Sam, 18 Aug 2026. Codes not listed keep whatever classification the revenue
 * rules already give them.
 */
export const PROMO_DEFINITIONS: PromoDefinition[] = [
  {
    code: "FREEFIRSTISSUE",
    purpose: "acquisition",
    label: "Free first quarter — current offer",
  },
  {
    code: "D1G90FJ1GQ28",
    purpose: "acquisition",
    label: "Free first issue — earlier run, Mar to Jun 2026",
  },
  {
    code: "THANKYOU100",
    purpose: "win-back",
    label: "Free year to win back lapsed annual subscribers",
  },
  {
    code: "f34hzrhds",
    purpose: "comp",
    label: "Lifetime free subscription — clients and VIPs",
  },
];

const BY_CODE = new Map<string, PromoDefinition>(
  PROMO_DEFINITIONS.map((d) => [d.code.toUpperCase(), d]),
);

export function promoDefinition(code: string | null | undefined): PromoDefinition | null {
  return BY_CODE.get((code ?? "").trim().toUpperCase()) ?? null;
}

export function promoPurpose(code: string | null | undefined): PromoPurpose | null {
  return promoDefinition(code)?.purpose ?? null;
}

/** True for codes representing money spent to win a NEW subscriber. */
export function isAcquisitionPromo(code: string | null | undefined): boolean {
  return promoPurpose(code) === "acquisition";
}

/**
 * True for any code in the registry — acquisition, win-back or comp.
 *
 * Used where every deliberate giveaway needs identifying regardless of purpose, e.g. separating
 * them from genuine prepaid deliveries.
 */
export function isRegisteredPromo(code: string | null | undefined): boolean {
  return promoDefinition(code) !== null;
}

/**
 * A comp recipient never converts, by design.
 *
 * Reporting a conversion rate for one is not merely uninformative — it manufactures a failure
 * out of a decision that was never about revenue.
 */
export function isComp(code: string | null | undefined): boolean {
  return promoPurpose(code) === "comp";
}

/** Anchored POSIX alternation for the whole registry, for SQL `~*`. Derived so it cannot drift. */
export const ALL_PROMO_SQL_REGEX = `^(${PROMO_DEFINITIONS.map((d) => d.code).join("|")})$`;

/** Anchored alternation for acquisition codes only — the CAC denominator. */
export const ACQUISITION_PROMO_SQL_REGEX = `^(${PROMO_DEFINITIONS.filter(
  (d) => d.purpose === "acquisition",
)
  .map((d) => d.code)
  .join("|")})$`;

/**
 * Anchored alternation for codes whose giveaway is NOT an acquisition cost — win-back and
 * comps. These classify as `comp`, per Sam's decision of 18 Aug 2026.
 *
 * Win-back sits here rather than with acquisition because the recipient had already been won
 * once; the free year is a retention expense. VIP comps sit here because nobody expected
 * revenue from them at all.
 */
export const COMP_PROMO_SQL_REGEX = `^(${PROMO_DEFINITIONS.filter(
  (d) => d.purpose === "win-back" || d.purpose === "comp",
)
  .map((d) => d.code)
  .join("|")})$`;
