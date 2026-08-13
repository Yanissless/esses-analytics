import { describe, expect, it } from "vitest";
import { mapOrderAttributesToTouchpoint } from "../src/attribution/ingest";

const ctx = {
  customerId: "cust-1",
  orderId: "order-1",
  occurredAt: new Date("2026-08-13T12:00:00Z"),
};

/**
 * Attribution carried on the order itself, set by esses.com at checkout.
 *
 * This is the only route that can work for this business: ads point at esses.com (Craft),
 * checkout happens in Shopify, and Shopify's analytics only see pages Shopify serves. Over
 * 30 recent orders, every `landingPageUrl` was a checkout URL and not one carried a UTM.
 *
 * These tests are the contract with `docs/esses-com-attribution.md`. If the attribute names
 * there change, these fail — which is the point, because the two halves are shipped by
 * different people at different times and nothing else connects them.
 */
describe("mapOrderAttributesToTouchpoint", () => {
  it("reads the attribute names the esses.com brief specifies", () => {
    const t = mapOrderAttributesToTouchpoint(
      [
        { key: "utm_source", value: "facebook" },
        { key: "utm_medium", value: "paid_social" },
        { key: "utm_campaign", value: "120248671551720507" },
        { key: "utm_content", value: "120249330189320507" },
        { key: "utm_term", value: "120249330171610507" },
      ],
      ctx,
    );
    expect(t).not.toBeNull();
    expect(t?.channel).toBe("paid-meta");
    // utm_content carries the AD id — this is what joins to ad_spend.ad_id and makes
    // per-creative attribution possible at all.
    expect(t?.content).toBe("120249330189320507");
    expect(t?.campaign).toBe("120248671551720507");
  });

  it("treats fbclid alone as a paid Meta click", () => {
    // The whole point of capturing fbclid on esses.com: it needs no ad tagging, and a
    // click id is unambiguous proof the click was paid rather than organic reach.
    const t = mapOrderAttributesToTouchpoint([{ key: "fbclid", value: "IwAR123abc" }], ctx);
    expect(t?.channel).toBe("paid-meta");
    expect(t?.clickIdType).toBe("meta");
  });

  it("returns null when there is nothing but a referrer", () => {
    // Shopify's journey already reports the referrer. Emitting a duplicate touchpoint for
    // it would inflate path length under linear attribution while adding no information.
    expect(
      mapOrderAttributesToTouchpoint([{ key: "referrer", value: "https://instagram.com/" }], ctx),
    ).toBeNull();
  });

  it("returns null for orders with no attributes — i.e. every order today", () => {
    expect(mapOrderAttributesToTouchpoint([], ctx)).toBeNull();
    expect(mapOrderAttributesToTouchpoint(null, ctx)).toBeNull();
    expect(mapOrderAttributesToTouchpoint(undefined, ctx)).toBeNull();
  });

  it("ignores unrelated cart attributes rather than treating them as attribution", () => {
    // Carts pick up gift messages and delivery notes. Reading those as attribution would
    // manufacture a touchpoint on an order that has none.
    expect(
      mapOrderAttributesToTouchpoint(
        [
          { key: "gift_message", value: "Happy birthday" },
          { key: "delivery_date", value: "2026-09-01" },
        ],
        ctx,
      ),
    ).toBeNull();
  });

  it("is case-insensitive and tolerates blank values", () => {
    // The brief says lowercase, but a hand-built Craft template will eventually send
    // "UTM_Source" and an empty string for a parameter that wasn't present.
    const t = mapOrderAttributesToTouchpoint(
      [
        { key: "UTM_Source", value: "facebook" },
        { key: "utm_medium", value: "paid_social" },
        { key: "utm_content", value: "" },
        { key: "utm_campaign", value: "  camp-1  " },
      ],
      ctx,
    );
    expect(t?.source).toBe("facebook");
    expect(t?.campaign).toBe("camp-1");
    expect(t?.content).toBeNull();
  });
});
