import { describe, expect, it } from "vitest";
import { parseOrdersCsv } from "../src/connectors/shopify/csv-import";

// Mimics a Shopify orders export: order-level fields on the first row, extra
// line items on following rows with the Name repeated and totals blank.
const CSV = `Name,Email,Financial Status,Currency,Subtotal,Shipping,Total,Tags,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku
#1001,buyer@example.com,paid,USD,50.00,5.00,55.00,,1,Esses Issue 04,35.00,ME4
#1001,buyer@example.com,,USD,,,,,2,Sticker Pack,7.50,STK
#1002,two@example.com,paid,USD,35.00,0.00,35.00,VIP,1,Esses Issue 05,35.00,ME5`;

describe("parseOrdersCsv", () => {
  it("groups line items under their order", () => {
    const orders = parseOrdersCsv(CSV);
    expect(orders).toHaveLength(2);

    const o1 = orders.find((o) => o.name === "#1001")!;
    expect(o1.email).toBe("buyer@example.com");
    expect(o1.totalCents).toBe(5500);
    expect(o1.shippingCents).toBe(500);
    expect(o1.lines).toHaveLength(2);
    expect(o1.lines[0]).toMatchObject({ title: "Esses Issue 04", quantity: 1, priceCents: 3500, sku: "ME4" });
    expect(o1.lines[1]).toMatchObject({ title: "Sticker Pack", quantity: 2, priceCents: 750, sku: "STK" });
  });

  it("parses tags and totals for a second order", () => {
    const orders = parseOrdersCsv(CSV);
    const o2 = orders.find((o) => o.name === "#1002")!;
    expect(o2.totalCents).toBe(3500);
    expect(o2.tags).toEqual(["VIP"]);
    expect(o2.lines).toHaveLength(1);
  });
});
