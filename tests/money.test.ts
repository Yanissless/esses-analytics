import { describe, expect, it } from "vitest";
import {
  formatMoney,
  sumMinor,
  toMajorUnits,
  toMinorUnits,
} from "../src/lib/money";

describe("money helpers", () => {
  it("formats USD cents", () => {
    expect(formatMoney(12345, "USD")).toBe("$123.45");
    expect(formatMoney(0, "USD")).toBe("$0.00");
  });

  it("respects zero-decimal currencies (JPY)", () => {
    // 1234 minor units of JPY = ¥1,234 (no fractional yen).
    expect(formatMoney(1234, "JPY")).toBe("¥1,234");
    expect(toMinorUnits(1234, "JPY")).toBe(1234);
  });

  it("round-trips major/minor units", () => {
    expect(toMinorUnits(123.45)).toBe(12345);
    expect(toMajorUnits(12345)).toBe(123.45);
  });

  it("rounds fractional cents on conversion", () => {
    expect(toMinorUnits(0.1 + 0.2)).toBe(30); // avoids 0.30000000000000004
  });

  it("sums integer cents exactly", () => {
    expect(sumMinor([1000, 250, 4999])).toBe(6249);
  });
});
