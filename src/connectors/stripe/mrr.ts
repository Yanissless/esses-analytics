/** Normalise a recurring charge to monthly minor units (MRR contribution). Pure. */
export function toMonthlyCents(
  unitAmount: number,
  quantity: number,
  interval: string | null | undefined,
  intervalCount: number | null | undefined,
): number {
  const perPeriod = unitAmount * (quantity || 1);
  const n = intervalCount && intervalCount > 0 ? intervalCount : 1;
  switch (interval) {
    case "day":
      return Math.round((perPeriod * 30) / n);
    case "week":
      return Math.round((perPeriod * (52 / 12)) / n);
    case "month":
      return Math.round(perPeriod / n);
    case "year":
      return Math.round(perPeriod / (12 * n));
    default:
      return perPeriod;
  }
}
