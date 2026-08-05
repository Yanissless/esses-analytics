/**
 * Money helpers. Values are stored and passed around as integer MINOR UNITS
 * (cents) with an explicit currency (Section 14). Formatting assumes the
 * currency's standard minor-unit exponent via Intl.
 */

/** Format cents for display, e.g. formatMoney(12345, "USD") -> "$123.45". */
export function formatMoney(
  minorUnits: number,
  currency = "USD",
  locale = "en-US",
): string {
  const fractionDigits = minorUnitExponent(currency);
  const divisor = 10 ** fractionDigits;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(minorUnits / divisor);
}

/** Convert a major-unit amount (e.g. dollars) to integer cents. */
export function toMinorUnits(major: number, currency = "USD"): number {
  return Math.round(major * 10 ** minorUnitExponent(currency));
}

/** Convert integer cents back to a major-unit number. */
export function toMajorUnits(minor: number, currency = "USD"): number {
  return minor / 10 ** minorUnitExponent(currency);
}

/** Sum a list of cent amounts (integer-safe). */
export function sumMinor(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Minor-unit exponent per ISO-4217 (2 for most; 0 for JPY/KRW; 3 for BHD…). */
function minorUnitExponent(currency: string): number {
  const c = currency.toUpperCase();
  if (["JPY", "KRW", "CLP", "VND", "ISK"].includes(c)) return 0;
  if (["BHD", "KWD", "OMR", "TND", "IQD", "JOD"].includes(c)) return 3;
  return 2;
}
