import { describe, expect, it } from "vitest";
import {
  billingCycleMonths,
  cyclesReached,
  isMarketingPromo,
  isPreOrderTitle,
  parseIssueNumber,
} from "../src/metrics/churn";

describe("isMarketingPromo", () => {
  it("treats a real acquisition code as a promo", () => {
    expect(isMarketingPromo("FREEFIRSTISSUE")).toBe(true);
    expect(isMarketingPromo("WELCOME10")).toBe(true);
  });

  /**
   * The regression that matters: goodwill credits issued AFTER a delivery problem
   * would otherwise be analysed as a campaign. Customers who had a problem churn
   * more, so counting these as promos inverts the finding.
   */
  it("excludes operational adjustments seen in live Shopify data", () => {
    expect(isMarketingPromo("Delivery Issue")).toBe(false);
    expect(isMarketingPromo("Custom discount")).toBe(false);
    expect(isMarketingPromo("delivery issue")).toBe(false);
    expect(isMarketingPromo("RESHIP-004")).toBe(false);
    expect(isMarketingPromo("goodwill credit")).toBe(false);
    expect(isMarketingPromo("test100")).toBe(false);
  });

  it("treats blank or missing codes as not a promo", () => {
    expect(isMarketingPromo(null)).toBe(false);
    expect(isMarketingPromo(undefined)).toBe(false);
    expect(isMarketingPromo("   ")).toBe(false);
  });
});

describe("parseIssueNumber", () => {
  it("reads the issue number through inconsistent live titles", () => {
    expect(parseIssueNumber("Esses Issue 04")).toBe(4);
    expect(parseIssueNumber("Esses Issue 03 (pre sale)")).toBe(3);
    expect(parseIssueNumber("Esses Issue 04 Pre-Order")).toBe(4);
    expect(parseIssueNumber("Issue 03 VIP")).toBe(3);
    expect(parseIssueNumber("Esses Issue 05 Contributor Copy")).toBe(5);
    expect(parseIssueNumber("Esses Issue 01 (Imperfect Copy)")).toBe(1);
    expect(parseIssueNumber("Isack Hadjar Signed Esses Issue 04")).toBe(4);
    expect(parseIssueNumber("issue #6")).toBe(6);
  });

  it("returns null when there is no issue in the title", () => {
    // The common case for subscription signups — hence issue_at_signup exists.
    expect(parseIssueNumber("Esses Subscription")).toBeNull();
    expect(parseIssueNumber("Esses Navy Corduroy Cap")).toBeNull();
    expect(parseIssueNumber("Esses Four Issue Subscription")).toBeNull();
    expect(parseIssueNumber(null)).toBeNull();
    expect(parseIssueNumber("")).toBeNull();
  });

  it("does not read a number that isn't an issue number", () => {
    expect(parseIssueNumber("Miami 2025 Big Jit T-Shirt")).toBeNull();
  });
});

describe("isPreOrderTitle", () => {
  it("recognises the pre-order and pre-sale spellings in use", () => {
    expect(isPreOrderTitle("Esses Issue 04 Pre-Order")).toBe(true);
    expect(isPreOrderTitle("Esses Issue 03 (pre sale)")).toBe(true);
    expect(isPreOrderTitle("Esses Issue 05 (Pre Order)")).toBe(true);
    expect(isPreOrderTitle("Esses Issue 03 (Pre-order)")).toBe(true);
  });

  it("does not flag a normal release", () => {
    expect(isPreOrderTitle("Esses Issue 04")).toBe(false);
    expect(isPreOrderTitle(null)).toBe(false);
  });
});

describe("billingCycleMonths", () => {
  /**
   * The distinction the whole module rests on. Both live Skio plans bill in MONTH
   * units but with very different counts, so a renewal is 3 months for one and 12
   * for the other. Note "Annual Payment, Quarterly Delivery" delivers quarterly —
   * MRR uses that cadence, churn must NOT.
   */
  it("resolves the two live Skio plans correctly", () => {
    expect(billingCycleMonths("month", 3)).toBe(3); // Quarterly Subscription
    expect(billingCycleMonths("month", 12)).toBe(12); // Annual Payment
  });

  it("converts other intervals to months", () => {
    expect(billingCycleMonths("year", 1)).toBe(12);
    expect(billingCycleMonths("year", 2)).toBe(24);
    expect(billingCycleMonths("week", 4)).toBe(1);
    expect(billingCycleMonths("day", 30)).toBe(1);
  });

  it("never returns a zero-length cycle for sub-monthly intervals", () => {
    expect(billingCycleMonths("day", 1)).toBe(1);
    expect(billingCycleMonths("week", 1)).toBe(1);
  });

  it("returns null on unknown or missing cadence rather than assuming monthly", () => {
    expect(billingCycleMonths(null, 3)).toBeNull();
    expect(billingCycleMonths("month", null)).toBeNull();
    expect(billingCycleMonths("month", 0)).toBeNull();
    expect(billingCycleMonths("fortnight", 1)).toBeNull();
  });
});

describe("cyclesReached", () => {
  it("counts a renewal only once the subscription has lived that long", () => {
    expect(cyclesReached(0, 3)).toBe(0);
    expect(cyclesReached(2.9, 3)).toBe(0);
    expect(cyclesReached(3, 3)).toBe(1); // exactly at the first rebill
    expect(cyclesReached(5.9, 3)).toBe(1);
    expect(cyclesReached(6, 3)).toBe(2);
  });

  it("separates the annual plan's schedule from the quarterly one", () => {
    // 6 months in: the quarterly plan has faced 2 renewals, the annual none.
    expect(cyclesReached(6, 3)).toBe(2);
    expect(cyclesReached(6, 12)).toBe(0);
  });

  it("returns 0 when cadence is unknown instead of guessing", () => {
    expect(cyclesReached(12, null)).toBe(0);
    expect(cyclesReached(12, 0)).toBe(0);
  });

  it("tolerates float drift at an exact boundary", () => {
    // 2629800s months mean 3 cycles can land at 8.999999…
    expect(cyclesReached(8.999999999, 3)).toBe(3);
  });
});
