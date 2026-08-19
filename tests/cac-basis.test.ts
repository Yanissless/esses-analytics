import { describe, expect, it } from "vitest";
import { buildCac, isCacBasis } from "../src/metrics/cac-basis";

/**
 * Two CAC figures exist so that neither has to be silently restated. The subtle part is the
 * DENOMINATOR: Sam's hope is that "that number goes down as the free first quarter customers
 * renew", and that only happens for the per-PAYING-customer figure. CAC over new customers
 * cannot fall on renewal, because a renewal adds nothing to its denominator.
 */
describe("buildCac", () => {
  const base = {
    marketingCents: 10_000_00,
    freeIssueCents: 34_679_06,
    newCustomers: 4_000,
  };

  it("charges only marketing on the marketing-only basis", () => {
    const r = buildCac({ ...base, basis: "marketing-only" });
    expect(r.freeIssueCents).toBe(0);
    expect(r.totalCents).toBe(base.marketingCents);
    expect(r.cac).toBe(r.cacMarketingOnly);
  });

  it("adds free-issue cost on the inclusive basis", () => {
    const r = buildCac({ ...base, basis: "with-free-issues" });
    expect(r.freeIssueCents).toBe(base.freeIssueCents);
    expect(r.totalCents).toBe(base.marketingCents + base.freeIssueCents);
    expect(r.cac).toBe(r.cacWithFreeIssues);
  });

  it("computes BOTH figures whichever basis is selected", () => {
    // The page shows them side by side so a reader can see the size of the choice they are
    // making, rather than having to toggle back and forth to find out.
    for (const basis of ["marketing-only", "with-free-issues"] as const) {
      const r = buildCac({ ...base, basis });
      expect(r.cacMarketingOnly).not.toBeNull();
      expect(r.cacWithFreeIssues).not.toBeNull();
      expect(r.cacWithFreeIssues!).toBeGreaterThan(r.cacMarketingOnly!);
    }
  });

  it("reports how much larger the inclusive figure is", () => {
    const r = buildCac({ ...base, basis: "marketing-only" });
    // (10,000 + 34,679.06) / 10,000 ≈ 4.47x
    expect(r.inclusiveMultiple).toBeCloseTo(4.4679, 3);
  });

  it("does NOT let CAC-over-new-customers fall when a cohort renews", () => {
    // The trap this guards. Renewals do not add new customers, so this figure is fixed once
    // the cost is spent. If it were presented as the one that improves, Sam would watch a
    // number that cannot move and conclude the promo had failed.
    const before = buildCac({ ...base, basis: "with-free-issues", payingCustomers: 500 });
    const after = buildCac({ ...base, basis: "with-free-issues", payingCustomers: 2_000 });
    expect(after.cac).toBe(before.cac);
    // But cost per PAYING customer does improve, which is the figure to watch.
    expect(after.costPerPayingCustomer!).toBeLessThan(before.costPerPayingCustomer!);
  });

  it("returns null for cost-per-paying rather than substituting new customers", () => {
    // Paying and acquired are different populations. Falling back to newCustomers would make
    // the figure look measurable before any cohort had matured.
    const r = buildCac({ ...base, basis: "with-free-issues" });
    expect(r.costPerPayingCustomer).toBeNull();
    expect(buildCac({ ...base, basis: "with-free-issues", payingCustomers: 0 }).costPerPayingCustomer).toBeNull();
  });

  it("returns null rather than dividing by zero customers", () => {
    const r = buildCac({ ...base, newCustomers: 0, basis: "with-free-issues" });
    expect(r.cac).toBeNull();
    expect(r.cacMarketingOnly).toBeNull();
    expect(r.inclusiveMultiple).toBeNull();
  });
});

describe("isCacBasis", () => {
  it("accepts only the two known bases", () => {
    expect(isCacBasis("marketing-only")).toBe(true);
    expect(isCacBasis("with-free-issues")).toBe(true);
    expect(isCacBasis("everything")).toBe(false);
    expect(isCacBasis(undefined)).toBe(false);
  });
});
