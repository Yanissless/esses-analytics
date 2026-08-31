import { describe, expect, it } from "vitest";
import {
  nextReleaseAfter,
  RELEASE_DAY,
  RELEASE_MONTHS,
  releasesBetween,
  releasesFaced,
} from "../src/metrics/release-schedule";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("release calendar", () => {
  it("ships in February, May, August and November on the 15th", () => {
    // Confirmed by Sam, and corroborated by the billing data: 1,605 of the active
    // subscriptions have next_billing_at on 11-15.
    expect([...RELEASE_MONTHS]).toEqual([2, 5, 8, 11]);
    expect(RELEASE_DAY).toBe(15);
  });

  it("lists the releases in a year", () => {
    expect(releasesBetween(d("2026-01-01"), d("2026-12-31")).map((x) => x.toISOString().slice(0, 10)))
      .toEqual(["2026-02-15", "2026-05-15", "2026-08-15", "2026-11-15"]);
  });

  it("spans a year boundary", () => {
    expect(releasesBetween(d("2026-10-01"), d("2027-03-01")).map((x) => x.toISOString().slice(0, 10)))
      .toEqual(["2026-11-15", "2027-02-15"]);
  });

  it("returns nothing for a reversed or empty range", () => {
    expect(releasesBetween(d("2026-12-31"), d("2026-01-01"))).toEqual([]);
    expect(releasesBetween(d("2026-03-01"), d("2026-04-01"))).toEqual([]);
  });

  it("finds the next release after a date", () => {
    expect(nextReleaseAfter(d("2026-03-03"))?.toISOString().slice(0, 10)).toBe("2026-05-15");
    // On release day itself the next one is the following release: buying on the day is buying
    // that issue, not renewing into it.
    expect(nextReleaseAfter(d("2026-05-15"))?.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("counts releases lived through, exclusive of the signup date", () => {
    expect(releasesFaced(d("2026-03-01"), d("2026-05-14"))).toBe(0);
    expect(releasesFaced(d("2026-03-01"), d("2026-05-15"))).toBe(1);
    expect(releasesFaced(d("2026-03-01"), d("2026-08-15"))).toBe(2);
  });

  it("counts nothing when as-of precedes the start", () => {
    expect(releasesFaced(d("2026-08-01"), d("2026-01-01"))).toBe(0);
  });

  it("survives an invalid date rather than throwing", () => {
    expect(releasesBetween(new Date("nope"), d("2026-12-31"))).toEqual([]);
  });
});
