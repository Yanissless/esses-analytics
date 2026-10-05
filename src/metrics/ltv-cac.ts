/**
 * LTV, LTV:CAC and CAC payback — the formula from Ojus Jain's methodology note
 * ("How LTV and LTV:CAC Are Calculated", 10 August 2026), implemented exactly.
 *
 * Every pure function here is unit-tested against the doc's own worked example
 * (print+digital $100, 2030) so a coding error can't silently drift from the
 * number the team has already agreed to: 3-year LTV = $61.13.
 *
 * ## The formula
 *
 *   LTV = Σ [ C(t) × S(t) ] ÷ (1 + d)^(t−1)      for t = 1 to T
 *
 * Read left to right: for each year t, take that year's contribution C(t),
 * multiply by the probability the subscriber is still there S(t), divide by the
 * discount factor, and sum. C(t) is year-1 contribution when t=1 (the
 * introductory discount applies only there) and renewal contribution for every
 * year after — renewals pay full list price. S(t) is survival: S(1)=1, S(2)=r1,
 * and S(t)=r1×r2^(t-2) for t>2 (r2 is stated as applying "year-2-onward", so it
 * compounds for every year past the second, not just once).
 *
 * ## What this deliberately does NOT do
 *
 * It does not compute a naive perpetuity (contribution ÷ churn, no discounting,
 * no horizon) — the doc's Section 3 shows that overstates LTV by ~78% here, and
 * `predictiveSubscriptionLtv` in `formulas.ts` already implements that shortcut
 * for a different purpose (subscription-system-wide MRV×lifespan). The two are
 * not interchangeable; this module exists because that one is the wrong tool for
 * a CAC comparison on a print business (see the doc's Section 7 on why revenue-
 * or naive-perpetuity LTV against a contribution-based CAC bar overstates
 * viability by 3x or more).
 *
 * ## Every "year" is actually a PERIOD, and periods aren't all 12 months
 *
 * The doc was worked entirely against an annual-billing tier, so its formula's
 * t=1..T reads as literal years. Esses' real quarterly plan bills every 3
 * months, and plugging its price/COGS/r1/r2 straight into a formula that treats
 * t as a calendar year is wrong in three separate ways at once: COGS meant for a
 * full year gets charged against one quarter's revenue (silently makes LTV
 * negative), a 15%-per-YEAR discount rate gets applied per QUARTER (massively
 * overdiscounts anything past cycle 1), and payback's "× 12" assumes each
 * period is a year. `cycleMonths` (default 12, matching the doc exactly) fixes
 * all three: `discountFactor` and `cacPaybackMonths` both use it to convert
 * period count into real elapsed time. Callers still express `horizonYears` in
 * actual years — 3 years is 3 periods for an annual tier and 12 for a quarterly
 * one — so different-cadence tiers stay comparable on the same horizon.
 */
import { desc, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db/client";
import { ltvCacAssumptions, type LtvCacAssumption } from "../db/schema";

export interface ContributionInputs {
  listPriceCents: number;
  /** Year-1-only, as a fraction (0.10 = 10%). Renewals pay full list price. */
  introDiscountPct: number;
  /** As a fraction of realised (post-discount) price. */
  processingPct: number;
  /** Charged in every year, year 1 and every renewal alike. */
  annualCogsCents: number;
}

export interface YearContribution {
  /** Year-1 contribution: list price less intro discount, processing, COGS. */
  year1Cents: number;
  /** Renewal-year contribution: full list price less processing, COGS. */
  renewalCents: number;
}

/** Section 2 — the two contribution figures. Rounded to the cent, matching money
 *  convention elsewhere (minor units, no fractional cents stored or compared). */
export function contributionForYears(input: ContributionInputs): YearContribution {
  const { listPriceCents, introDiscountPct, processingPct, annualCogsCents } = input;

  const year1Net = listPriceCents * (1 - introDiscountPct);
  const year1 = year1Net - year1Net * processingPct - annualCogsCents;

  const renewalNet = listPriceCents;
  const renewal = renewalNet - renewalNet * processingPct - annualCogsCents;

  return {
    year1Cents: Math.round(year1),
    renewalCents: Math.round(renewal),
  };
}

/**
 * Section 3 — survival probability of still paying in year t, given a subscriber
 * acquired at t=0. S(1)=1 always (they just signed up). S(2)=r1. Every year past
 * the second multiplies by r2 again, because r2 is the STEADY-STATE retention
 * rate the doc says applies "year-2-onward", not a one-time step.
 */
export function survivalProbability(t: number, r1: number, r2: number): number {
  if (t <= 1) return 1;
  if (t === 2) return r1;
  return r1 * r2 ** (t - 2);
}

/**
 * Section 4 — discount factor. Exponent is YEARS elapsed, not periods elapsed:
 * `(t-1) * cycleMonths / 12`. For an annual tier (the default) that's just t−1,
 * reproducing the doc exactly. For a quarterly tier (`cycleMonths=3`) period 5
 * is 1 year out, not 4 — discounting it as if 4 years had passed would compound
 * an annual rate four times too often. Period 1 is always received now (0 years
 * elapsed) and is never discounted, regardless of cycle length.
 */
export function discountFactor(t: number, discountRatePct: number, cycleMonths = 12): number {
  const yearsElapsed = ((t - 1) * cycleMonths) / 12;
  return (1 + discountRatePct) ** yearsElapsed;
}

export interface LtvYearBreakdown {
  /** Period index (1, 2, 3...) — a YEAR only when cycleMonths=12. */
  year: number;
  contributionCents: number;
  survivalPct: number;
  discountFactor: number;
  discountedCents: number;
}

export interface LtvResult {
  ltvCents: number;
  years: LtvYearBreakdown[];
  /** Carried through so a caller can label the breakdown correctly — "Year N"
   *  is wrong to print beside a quarterly tier's rows. */
  cycleMonths: number;
}

export interface LtvInputs extends ContributionInputs {
  r1: number;
  r2: number;
  discountRatePct: number;
  horizonYears: number;
  /** Months per billing period — 12 (annual, the doc's default) or 3
   *  (quarterly). See the module docstring: this is not cosmetic, it changes
   *  the discount exponent and the payback multiplier. */
  cycleMonths?: number;
}

/** Section 4 — the full formula, plus a period-by-period breakdown so the
 *  number can be audited the same way the doc's worked example shows it.
 *  `horizonYears` is always real years: at cycleMonths=3 that's 4x as many
 *  periods as at cycleMonths=12, so a "3-year LTV" means the same span of
 *  real time regardless of how often the tier bills. */
export function computeLtv(input: LtvInputs): LtvResult {
  const { r1, r2, discountRatePct, horizonYears, cycleMonths = 12 } = input;
  const { year1Cents, renewalCents } = contributionForYears(input);
  const periods = Math.round((horizonYears * 12) / cycleMonths);

  const years: LtvYearBreakdown[] = [];
  let total = 0;

  for (let t = 1; t <= periods; t++) {
    const contributionCents = t === 1 ? year1Cents : renewalCents;
    const survivalPct = survivalProbability(t, r1, r2);
    const df = discountFactor(t, discountRatePct, cycleMonths);
    const discountedCents = (contributionCents * survivalPct) / df;
    total += discountedCents;
    years.push({
      year: t,
      contributionCents,
      survivalPct,
      discountFactor: df,
      discountedCents: Math.round(discountedCents),
    });
  }

  return { ltvCents: Math.round(total), years, cycleMonths };
}

/**
 * Section 8 — LTV:CAC. Null when CAC is 0 or unset, matching the ratio()
 * convention elsewhere: an unmeasurable ratio is null, not 0 or Infinity.
 */
export function ltvToCac(ltvCents: number, cacCents: number): number | null {
  if (!Number.isFinite(cacCents) || cacCents <= 0) return null;
  return ltvCents / cacCents;
}

/** Section 8 — the CAC a tier could afford and still hit its target ratio
 *  (default 3:1). Useful alongside the actual CAC to see the gap. */
export function allowableCac(ltvCents: number, targetRatio: number): number | null {
  if (!Number.isFinite(targetRatio) || targetRatio <= 0) return null;
  return ltvCents / targetRatio;
}

/**
 * Section 9 — CAC payback in months. Uses the FIRST-PERIOD contribution only,
 * per the doc: "Payback (months) = CAC ÷ Year-1 contribution × 12". The ×12
 * assumes that first period IS a year; generalised to `× cycleMonths` so a
 * quarterly tier's payback isn't reported 4x too fast. Null when CAC or
 * first-period contribution can't support a payback figure — an unrecoverable
 * CAC is not "0 months".
 */
export function cacPaybackMonths(
  cacCents: number,
  firstPeriodContributionCents: number,
  cycleMonths = 12,
): number | null {
  if (!Number.isFinite(cacCents) || cacCents <= 0) return null;
  if (!Number.isFinite(firstPeriodContributionCents) || firstPeriodContributionCents <= 0) {
    return null;
  }
  return (cacCents / firstPeriodContributionCents) * cycleMonths;
}

// ---------------------------------------------------------------------------
// Reading the assumptions table
// ---------------------------------------------------------------------------

export interface TierRow {
  id: string;
  tier: string;
  tierLabel: string;
  route: string;
  effectiveDate: string;
  inputs: LtvInputs;
  ltv: LtvResult;
  cacCents: number;
  ltvCac: number | null;
  allowableCacCents: number | null;
  targetRatio: number;
  paybackMonths: number | null;
  baseSharePct: number | null;
  source: string | null;
  note: string | null;
}

function toInputs(a: LtvCacAssumption): LtvInputs {
  return {
    listPriceCents: a.listPriceCents,
    introDiscountPct: a.introDiscountPct,
    processingPct: a.processingPct,
    annualCogsCents: a.annualCogsCents,
    r1: a.r1,
    r2: a.r2,
    discountRatePct: a.discountRatePct,
    horizonYears: a.horizonYears,
    cycleMonths: a.cycleMonths,
  };
}

function toRow(a: LtvCacAssumption): TierRow {
  const inputs = toInputs(a);
  const ltv = computeLtv(inputs);
  return {
    id: a.id,
    tier: a.tier,
    tierLabel: a.tierLabel,
    route: a.route,
    effectiveDate: a.effectiveDate,
    inputs,
    ltv,
    cacCents: a.cacCents,
    ltvCac: ltvToCac(ltv.ltvCents, a.cacCents),
    allowableCacCents: allowableCac(ltv.ltvCents, a.targetRatio),
    targetRatio: a.targetRatio,
    paybackMonths: cacPaybackMonths(a.cacCents, ltv.years[0]?.discountedCents ?? 0, a.cycleMonths),
    baseSharePct: a.baseSharePct,
    source: a.source,
    note: a.note,
  };
}

/**
 * The current (most recent effective-dated) row for every distinct (tier, route),
 * each with LTV, LTV:CAC, payback and allowable-CAC computed live from its
 * stored inputs — so editing a number at /ltv-cac recomputes everything that
 * depends on it, the same guarantee /costs makes for COGS.
 */
export async function getLtvCacTable(): Promise<TierRow[]> {
  const rows = await db
    .select()
    .from(ltvCacAssumptions)
    .orderBy(desc(ltvCacAssumptions.effectiveDate));

  // Keep only the newest row per (tier, route) — same "latest effective-dated
  // wins" rule as product_costs, just applied in JS since there's no per-group
  // LIMIT in a plain select.
  const latest = new Map<string, LtvCacAssumption>();
  for (const r of rows) {
    const key = `${r.tier}|${r.route}`;
    if (!latest.has(key)) latest.set(key, r);
  }

  // Best ratio first — the number the page leads with — nulls (no measurable CAC) last.
  return [...latest.values()].map(toRow).sort((a, b) => (b.ltvCac ?? -Infinity) - (a.ltvCac ?? -Infinity));
}

/** Full history for one (tier, route) — versioned, never overwritten. */
export async function getLtvCacHistory(tier: string, route: string): Promise<LtvCacAssumption[]> {
  return db
    .select()
    .from(ltvCacAssumptions)
    .where(drizzleSql`${ltvCacAssumptions.tier} = ${tier} AND ${ltvCacAssumptions.route} = ${route}`)
    .orderBy(desc(ltvCacAssumptions.effectiveDate));
}

export interface BlendedLtv {
  /** Weighted by each row's baseSharePct — null when a row is missing a share,
   *  since averaging in a 0 would understate the blend rather than skip it. */
  blendedLtvCents: number | null;
  /** Rows actually included, so a caller can say which ones were excluded. */
  includedTiers: string[];
  excludedTiers: string[];
  /** Shares that were supplied, summed — should read close to 100% or the
   *  blend is describing an incomplete portfolio. */
  totalShareCovered: number;
}

/**
 * Portfolio LTV weighted by base mix (Section 10) — a summary figure, NOT the
 * decision metric. Only defined over rows that carry a `baseSharePct`; one
 * missing share excludes that tier rather than silently treating it as 0.
 *
 * ⚠️ The doc is explicit that this number should never be compared against a
 * blended CAC to produce a portfolio LTV:CAC — premium subscribers arrive by
 * upgrade, not acquisition, so they inflate this LTV with no matching
 * acquisition cost. Use the per-tier table for any real decision; this exists
 * so "what is the subscriber book worth" can be answered without also implying
 * "and CAC of X is therefore fine".
 */
export function blendLtv(rows: TierRow[]): BlendedLtv {
  const withShare = rows.filter((r) => r.baseSharePct != null && r.baseSharePct > 0);
  const included = withShare.map((r) => r.tierLabel);
  const excluded = rows.filter((r) => !included.includes(r.tierLabel)).map((r) => r.tierLabel);
  const totalShare = withShare.reduce((s, r) => s + (r.baseSharePct ?? 0), 0);

  if (withShare.length === 0) {
    return { blendedLtvCents: null, includedTiers: [], excludedTiers: excluded, totalShareCovered: 0 };
  }

  const blended = withShare.reduce((s, r) => s + (r.baseSharePct ?? 0) * r.ltv.ltvCents, 0);
  return {
    blendedLtvCents: Math.round(blended),
    includedTiers: included,
    excludedTiers: excluded,
    totalShareCovered: totalShare,
  };
}
