import { describe, expect, it } from "vitest";
import { normalizeTracking } from "../src/lib/shipping/match";
import { parseEasyshipCsv } from "../src/connectors/easyship";

/**
 * Pure re-implementation of the allocation arithmetic used by
 * allocateBatchInvoice, so the invariant that matters — the allocation always
 * reconciles EXACTLY to the invoice total — is pinned by a test rather than
 * trusted. A silent rounding drift here would misstate shipping cost on every
 * order in the batch.
 */
function allocate(
  totalCents: number,
  shipments: Array<{ units: number; rate: number | null }>,
  method: "even" | "by_units" | "by_rate",
): number[] {
  const totalUnits = shipments.reduce((s, r) => s + r.units, 0);
  const rated = shipments.filter((r) => r.rate != null);
  const avgRate = rated.length
    ? rated.reduce((s, r) => s + (r.rate as number), 0) / rated.length
    : 0;
  const weightOf = (r: (typeof shipments)[number]) => (r.rate ?? avgRate) || 1;
  const totalWeight = shipments.reduce((s, r) => s + weightOf(r), 0);

  const out: number[] = [];
  let running = 0;
  for (let i = 0; i < shipments.length; i++) {
    const r = shipments[i];
    const isLast = i === shipments.length - 1;
    const share =
      method === "by_rate" && totalWeight > 0
        ? Math.round((totalCents * weightOf(r)) / totalWeight)
        : method === "by_units" && totalUnits > 0
          ? Math.round((totalCents * r.units) / totalUnits)
          : Math.round(totalCents / shipments.length);
    const amount = isLast ? totalCents - running : share;
    running += amount;
    out.push(amount);
  }
  return out;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe("batch allocation reconciles to the invoice total", () => {
  it("even split of an amount that doesn't divide cleanly still sums exactly", () => {
    // $10.00 across 3 shipments — 333 + 333 + 334.
    const parts = allocate(1000, [
      { units: 1, rate: null },
      { units: 1, rate: null },
      { units: 1, rate: null },
    ], "even");
    expect(sum(parts)).toBe(1000);
    expect(parts).toEqual([333, 333, 334]);
  });

  it("by_units weights larger shipments and still sums exactly", () => {
    const parts = allocate(1200, [
      { units: 1, rate: null },
      { units: 3, rate: null },
    ], "by_units");
    expect(sum(parts)).toBe(1200);
    expect(parts[0]).toBe(300);
    expect(parts[1]).toBe(900);
  });

  it("by_rate follows expected label cost — Media Mail vs international", () => {
    // Two domestic Media Mail labels (~$4.95) and one international (~$18).
    const parts = allocate(2790, [
      { units: 1, rate: 495 },
      { units: 1, rate: 495 },
      { units: 1, rate: 1800 },
    ], "by_rate");
    expect(sum(parts)).toBe(2790);
    expect(parts[0]).toBe(495);
    expect(parts[2]).toBeGreaterThan(parts[0] * 3);
  });

  it("scales rate weights up when the real bill exceeds the estimates", () => {
    // Estimates total $27.90 but the bill was $55.80 → each doubles.
    const parts = allocate(5580, [
      { units: 1, rate: 495 },
      { units: 1, rate: 495 },
      { units: 1, rate: 1800 },
    ], "by_rate");
    expect(sum(parts)).toBe(5580);
    expect(parts[0]).toBe(990);
  });

  it("gives unrated shipments the batch average weight rather than zero", () => {
    const parts = allocate(2000, [
      { units: 1, rate: 500 },
      { units: 1, rate: null },
    ], "by_rate");
    expect(sum(parts)).toBe(2000);
    expect(parts[0]).toBe(1000);
    expect(parts[1]).toBe(1000);
  });

  it("handles a single shipment taking the whole invoice", () => {
    expect(allocate(4321, [{ units: 2, rate: 495 }], "by_rate")).toEqual([4321]);
  });
});

describe("tracking-number normalisation", () => {
  it("ignores case, spaces and punctuation so portal/spreadsheet formats match", () => {
    expect(normalizeTracking("1Z K414-4668 910168")).toBe("1zk4144668910168");
    expect(normalizeTracking("1zk4144668910168")).toBe("1zk4144668910168");
  });

  it("returns null for empty or punctuation-only values", () => {
    expect(normalizeTracking("")).toBeNull();
    expect(normalizeTracking(null)).toBeNull();
    expect(normalizeTracking(" - - ")).toBeNull();
  });
});

describe("EasyShip CSV parsing keeps duties separate", () => {
  it("splits carriage from prepaid duties and surcharges", () => {
    const csv = [
      "Tracking Number,Platform Order Number,Created At,Shipment Charge,Import Tax Charge,Import Duty Charge,Insurance Fee",
      "ES123456789,#13965,2026-07-15,12.40,3.10,1.50,0.75",
    ].join("\n");
    const [line] = parseEasyshipCsv(csv);
    expect(line.trackingNumber).toBe("ES123456789");
    expect(line.orderNumber).toBe("#13965");
    expect(line.shippedOn).toBe("2026-07-15");
    expect(line.shipCents).toBe(1240);
    expect(line.dutiesCents).toBe(460); // tax 310 + duty 150
    expect(line.surchargeCents).toBe(75);
  });

  it("skips rows with no tracking or order reference", () => {
    const csv = ["Tracking Number,Shipment Charge", ",5.00"].join("\n");
    expect(parseEasyshipCsv(csv)).toHaveLength(0);
  });

  it("returns nothing for a header-only export rather than throwing", () => {
    expect(parseEasyshipCsv("Tracking Number,Shipment Charge")).toEqual([]);
  });
});
