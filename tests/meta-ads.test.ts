import { describe, expect, it } from "vitest";
import {
  mapInsightRow,
  normalizeAccountId,
  pickPurchaseAction,
} from "../src/connectors/ads/meta";

describe("normalizeAccountId", () => {
  it("adds the act_ prefix when missing", () => {
    expect(normalizeAccountId("123456789")).toBe("act_123456789");
  });
  it("leaves an already-prefixed id alone", () => {
    expect(normalizeAccountId("act_123456789")).toBe("act_123456789");
  });
  it("trims surrounding whitespace", () => {
    expect(normalizeAccountId("  act_42 ")).toBe("act_42");
  });
});

describe("pickPurchaseAction", () => {
  it("ignores clicks and views", () => {
    const actions = [
      { action_type: "link_click", value: "125" },
      { action_type: "landing_page_view", value: "80" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "7" },
    ];
    expect(pickPurchaseAction(actions)).toBe(7);
  });

  /**
   * The regression that mattered: these types overlap, so adding them inflated
   * Meta's claimed conversions ~3× and made the platform-vs-attributed
   * reconciliation meaningless.
   */
  it("never adds overlapping purchase types together", () => {
    const actions = [
      { action_type: "link_click", value: "125" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "7" },
      { action_type: "omni_purchase", value: "9" },
      { action_type: "purchase", value: "9" },
      { action_type: "web_in_store_purchase", value: "1" },
    ];
    // omni_purchase wins outright — not 7+9+9+1.
    expect(pickPurchaseAction(actions)).toBe(9);
  });

  it("falls back down the priority list when richer types are absent", () => {
    expect(pickPurchaseAction([{ action_type: "purchase", value: "4" }])).toBe(4);
    expect(
      pickPurchaseAction([{ action_type: "web_in_store_purchase", value: "3" }]),
    ).toBe(3);
  });

  it("sums repeated entries of the SAME type (breakdown rows)", () => {
    const actions = [
      { action_type: "omni_purchase", value: "2" },
      { action_type: "omni_purchase", value: "3" },
    ];
    expect(pickPurchaseAction(actions)).toBe(5);
  });

  it("returns 0 for an empty or missing array rather than NaN", () => {
    expect(pickPurchaseAction([])).toBe(0);
    expect(pickPurchaseAction(undefined)).toBe(0);
  });

  it("ignores non-numeric values instead of producing NaN", () => {
    expect(pickPurchaseAction([{ action_type: "purchase", value: "n/a" }])).toBe(0);
  });
});

describe("mapInsightRow", () => {
  const row = {
    date_start: "2026-07-15",
    account_id: "123456789",
    account_currency: "usd",
    campaign_id: "c1",
    campaign_name: "Issue 06 launch",
    adset_id: "as1",
    adset_name: "US 25-44",
    ad_id: "ad1",
    ad_name: "Carousel A",
    spend: "134.57",
    impressions: "20431",
    clicks: "312",
    actions: [
      { action_type: "link_click", value: "312" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "6" },
    ],
    action_values: [
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "210.50" },
    ],
  };

  it("converts spend from a decimal string to integer cents", () => {
    expect(mapInsightRow(row, "act_fallback").spendAmount).toBe(13457);
  });

  it("parses impressions and clicks as integers", () => {
    const m = mapInsightRow(row, "act_fallback");
    expect(m.impressions).toBe(20431);
    expect(m.clicks).toBe(312);
  });

  it("extracts platform conversions and value from the nested arrays", () => {
    const m = mapInsightRow(row, "act_fallback");
    expect(m.platformConversions).toBe(6);
    expect(m.platformConversionValueAmount).toBe(21050);
  });

  it("uppercases the account currency and never assumes USD", () => {
    expect(mapInsightRow(row, "act_x").currency).toBe("USD");
    expect(mapInsightRow({ ...row, account_currency: "gbp" }, "act_x").currency).toBe("GBP");
  });

  it("prefixes the account id and falls back when absent", () => {
    expect(mapInsightRow(row, "act_fallback").accountId).toBe("act_123456789");
    expect(mapInsightRow({ ...row, account_id: undefined }, "act_fallback").accountId).toBe(
      "act_fallback",
    );
  });

  it("keeps the campaign hierarchy for later CAC/ROAS breakdowns", () => {
    const m = mapInsightRow(row, "act_x");
    expect(m.campaignName).toBe("Issue 06 launch");
    expect(m.adsetName).toBe("US 25-44");
    expect(m.adName).toBe("Carousel A");
  });

  it("yields zeros (not NaN) for a row with no delivery", () => {
    const m = mapInsightRow({ date_start: "2026-07-16", ad_id: "ad2" }, "act_x");
    expect(m.spendAmount).toBe(0);
    expect(m.impressions).toBe(0);
    expect(m.clicks).toBe(0);
    expect(m.platformConversions).toBe(0);
    expect(m.platformConversionValueAmount).toBe(0);
  });
});
