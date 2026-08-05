import { describe, expect, it } from "vitest";
import { toMonthlyCents } from "../src/connectors/stripe/mrr";
import { resolveSubscriptionLine } from "../src/connectors/stripe/line-mapping";

describe("toMonthlyCents (MRR normalisation)", () => {
  it("monthly is unchanged", () => {
    expect(toMonthlyCents(3000, 1, "month", 1)).toBe(3000);
  });
  it("yearly divides by 12", () => {
    expect(toMonthlyCents(12000, 1, "year", 1)).toBe(1000);
  });
  it("every-3-months divides by 3", () => {
    expect(toMonthlyCents(9000, 1, "month", 3)).toBe(3000);
  });
  it("multiplies by quantity", () => {
    expect(toMonthlyCents(1000, 5, "month", 1)).toBe(5000);
  });
});

describe("resolveSubscriptionLine (print vs digital)", () => {
  it("matches configured print price id", () => {
    expect(resolveSubscriptionLine({ priceId: "price_print_1" })).toBe("print");
  });
  it("matches configured digital price id", () => {
    expect(resolveSubscriptionLine({ priceId: "price_digital_1" })).toBe("digital");
  });
  it("matches configured product id", () => {
    expect(resolveSubscriptionLine({ productId: "prod_digital" })).toBe("digital");
  });
  it("falls back to name heuristic (digital)", () => {
    expect(resolveSubscriptionLine({ text: "Esses Web Edition" })).toBe("digital");
  });
  it("falls back to name heuristic (print)", () => {
    expect(resolveSubscriptionLine({ text: "Print Magazine Subscription" })).toBe("print");
  });
  it("defaults to print when unknown", () => {
    expect(resolveSubscriptionLine({ text: "Mystery Plan" })).toBe("print");
  });
});
