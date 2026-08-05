import { describe, expect, it } from "vitest";
import {
  classifyProductTitle,
  META_CUSTOM_AUDIENCE_MIN,
  META_LOOKALIKE_SOURCE_MIN,
} from "../src/metrics/personas";

describe("classifyProductTitle", () => {
  /** Every string here is a real product title from the live catalogue. */
  it("identifies merch, not the magazine", () => {
    expect(classifyProductTitle("Esses Navy Corduroy Cap").merch).toBe(true);
    expect(classifyProductTitle("Esses Trucker Hat").merch).toBe(true);
    expect(classifyProductTitle("Esses Design Dept Tote Bag").merch).toBe(true);
    expect(classifyProductTitle("Esses Design Tee Blue").merch).toBe(true);
    expect(classifyProductTitle("Esses White Tee").merch).toBe(true);
    expect(classifyProductTitle("Daniel Ricciardo Limited Edition Sweatshirt").merch).toBe(true);
    expect(classifyProductTitle("Esses Austin Event Patches").merch).toBe(true);
  });

  it("does not treat an issue or subscription as merch", () => {
    expect(classifyProductTitle("Esses Issue 04").merch).toBe(false);
    expect(classifyProductTitle("Esses Subscription").merch).toBe(false);
    expect(classifyProductTitle("Esses Issue 03 (pre sale)").merch).toBe(false);
    expect(classifyProductTitle("Esses Four Issue Subscription").merch).toBe(false);
  });

  it("identifies event-linked products", () => {
    expect(classifyProductTitle('Miami 2025 "Big Jit" T-Shirt (Event Exclusive)').event).toBe(true);
    expect(classifyProductTitle("Esses Issue 04 IMAX Package").event).toBe(true);
    expect(classifyProductTitle("Square Guide to Austin").event).toBe(true);
    expect(classifyProductTitle("Esses Austin Event Patches").event).toBe(true);
  });

  it("identifies collectible/special editions", () => {
    expect(classifyProductTitle("Isack Hadjar Signed Esses Issue 04").special).toBe(true);
    expect(classifyProductTitle("Issue 03 Special Edition").special).toBe(true);
    expect(classifyProductTitle("Issue 03 VIP").special).toBe(true);
    expect(classifyProductTitle("Daniel Ricciardo Limited Edition Sweatshirt").special).toBe(true);
  });

  it("lets one title match several categories", () => {
    // A signed limited-edition event tee is legitimately all three.
    const c = classifyProductTitle('Miami 2025 "Big Jit" T-Shirt (Event Exclusive)');
    expect(c.merch).toBe(true);
    expect(c.event).toBe(true);
  });

  it("handles missing titles without throwing", () => {
    expect(classifyProductTitle(null)).toEqual({ merch: false, event: false, special: false });
    expect(classifyProductTitle(undefined).merch).toBe(false);
    expect(classifyProductTitle("").merch).toBe(false);
  });

  /**
   * Regression guard: "print" once matched "printer", which would have swept
   * printer-park line items into the merch cohort. The pattern no longer includes it
   * at all — this test exists so re-adding it without a negative lookahead fails.
   */
  it("does not sweep printer/print-run items into merch", () => {
    expect(classifyProductTitle("UK printer park run").merch).toBe(false);
    expect(classifyProductTitle("Print run reconciliation").merch).toBe(false);
  });
});

describe("Meta audience thresholds", () => {
  it("keeps the Lookalike floor an order of magnitude above Custom Audience", () => {
    // A segment can be big enough to retarget but far too small to seed prospecting;
    // conflating the two is how tiny cohorts end up driving acquisition spend.
    expect(META_CUSTOM_AUDIENCE_MIN).toBe(100);
    expect(META_LOOKALIKE_SOURCE_MIN).toBe(1000);
    expect(META_LOOKALIKE_SOURCE_MIN).toBeGreaterThan(META_CUSTOM_AUDIENCE_MIN);
  });
});
