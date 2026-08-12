import { describe, expect, it } from "vitest";
import { mapCountryName, overIndex } from "../src/metrics/audience-geography";

/**
 * Comparing audience composition against actual customers.
 *
 * The mapping is the dangerous part. Meta labels countries in prose ("United States") and
 * Shopify stores ISO codes ("US"), so every comparison depends on a lookup — and a lookup
 * that guesses is worse than one that fails. An unmapped country silently vanishing from
 * the table removes exactly the market you'd most want flagged, so `mapCountryName` returns
 * null and the caller surfaces those names separately.
 */

describe("mapCountryName", () => {
  it("maps the markets that appear in this business's data", () => {
    expect(mapCountryName("United States")).toBe("US");
    expect(mapCountryName("United Kingdom")).toBe("GB");
    expect(mapCountryName("Italy")).toBe("IT");
    expect(mapCountryName("Australia")).toBe("AU");
    expect(mapCountryName("India")).toBe("IN");
    expect(mapCountryName("France")).toBe("FR");
    expect(mapCountryName("Canada")).toBe("CA");
    expect(mapCountryName("Mexico")).toBe("MX");
    expect(mapCountryName("Spain")).toBe("ES");
    expect(mapCountryName("Germany")).toBe("DE");
  });

  it("does not map the UK to UK", () => {
    // Shopify stores GB, not UK. Getting this wrong drops the second-largest audience
    // market from the comparison entirely.
    expect(mapCountryName("United Kingdom")).toBe("GB");
    expect(mapCountryName("United Kingdom")).not.toBe("UK");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(mapCountryName("  united states  ")).toBe("US");
    expect(mapCountryName("UNITED KINGDOM")).toBe("GB");
  });

  it("accepts both spellings of Czechia", () => {
    expect(mapCountryName("Czech Republic")).toBe("CZ");
    expect(mapCountryName("Czechia")).toBe("CZ");
  });

  it("returns null rather than guessing at an unknown name", () => {
    // Guessing is the failure mode: a fuzzy match could put the country Georgia onto the
    // US state code GA, and nobody would notice the comparison had been corrupted.
    expect(mapCountryName("Georgia")).toBeNull();
    expect(mapCountryName("Wakanda")).toBeNull();
    expect(mapCountryName("")).toBeNull();
    expect(mapCountryName("US")).toBeNull(); // an ISO code is not a Meta label
  });
});

describe("overIndex", () => {
  it("is 1.0 when audience share and order share agree", () => {
    expect(overIndex(0.1, 0.1)).toBeCloseTo(1, 10);
  });

  it("is above 1 when the audience is there and the orders are not", () => {
    // The real finding on this data: the UK is ~12% of the reported audience and 2.5% of
    // orders, so it over-indexes about 5x.
    const idx = overIndex(0.125, 0.025);
    expect(idx).not.toBeNull();
    expect(idx as number).toBeCloseTo(5, 6);
  });

  it("is below 1 when orders outrun the audience", () => {
    // The US: ~67% of the reported audience but 94% of orders.
    const idx = overIndex(0.665, 0.943);
    expect(idx as number).toBeLessThan(1);
  });

  it("is not measurable rather than infinite when a country has no orders", () => {
    // Rule 3. "Infinite over-indexing" is not a number anyone should see; the caller shows
    // the raw counts instead.
    expect(overIndex(0.023, 0)).toBeNull();
  });

  it("is zero when a country has orders but no measured audience share", () => {
    // Meta lists only its top ten, so a real order market can legitimately be absent from
    // the audience list. That is 0 over-index, not null — the share genuinely is zero.
    expect(overIndex(0, 0.05)).toBe(0);
  });
});
