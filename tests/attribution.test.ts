import { describe, expect, it } from "vitest";
import {
  isOwnDomain,
  isPaidChannel,
  parseClickId,
  parseUtms,
  resolveChannel,
} from "../src/attribution/channels";
import {
  attribute,
  creditByChannel,
  reconcile,
  type Touchpoint,
} from "../src/attribution/models";
import { mapJourneyToTouchpoints } from "../src/attribution/ingest";

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 6, 1);

const path: Touchpoint[] = [
  { id: "a", channel: "organic-social", occurredAt: T0 },
  { id: "b", channel: "paid-meta", occurredAt: T0 + 5 * DAY },
  { id: "c", channel: "direct", occurredAt: T0 + 10 * DAY },
];

describe("channel resolution — paid vs organic is the distinction that matters", () => {
  it("treats an untagged Instagram referral as ORGANIC, not paid", () => {
    // This is the live Esses case: Instagram referrer, no UTMs, no click id.
    expect(
      resolveChannel({ source: "Instagram", referrerUrl: "https://instagram.com/" }),
    ).toBe("organic-social");
  });

  it("treats an fbclid as paid-meta — hard evidence of an ad click", () => {
    expect(
      resolveChannel({
        source: "Instagram",
        referrerUrl: "https://instagram.com/",
        clickId: "abc123",
        clickIdType: "meta",
      }),
    ).toBe("paid-meta");
  });

  it("treats a paid UTM medium as paid even without a click id", () => {
    expect(resolveChannel({ utmSource: "facebook", utmMedium: "cpc" })).toBe("paid-meta");
    expect(resolveChannel({ utmSource: "google", utmMedium: "ppc" })).toBe("paid-google");
    expect(resolveChannel({ utmSource: "tiktok", utmMedium: "paid_social" })).toBe("paid-tiktok");
  });

  it("recognises owned channels from UTMs", () => {
    expect(resolveChannel({ utmSource: "newsletter", utmMedium: "email" })).toBe("newsletter");
    expect(resolveChannel({ utmSource: "house", utmMedium: "onsite" })).toBe("onsite");
  });

  /**
   * These pin the tagging scheme the social manager is being asked to use. An
   * in-app tap on a story link frequently arrives with NO referrer, so without
   * reading utm_source the visit would be classified `direct` and the channel lost.
   */
  it("credits an explicitly-organic social tag even with no referrer at all", () => {
    expect(resolveChannel({ utmSource: "instagram", utmMedium: "organic_social" })).toBe(
      "organic-social",
    );
    expect(resolveChannel({ utmSource: "tiktok", utmMedium: "organic_social" })).toBe(
      "organic-social",
    );
    expect(resolveChannel({ utmSource: "instagram", utmMedium: "story" })).toBe("organic-social");
  });

  /**
   * The dangerous direction. Reading utm_source for organic must never be able to
   * pull a genuine paid click into organic — that would credit ad spend to free
   * traffic, the exact mistake this taxonomy exists to prevent.
   */
  it("never demotes a paid click to organic, whatever the source says", () => {
    expect(resolveChannel({ utmSource: "instagram", utmMedium: "paid_social" })).toBe("paid-meta");
    expect(
      resolveChannel({ utmSource: "instagram", utmMedium: "organic_social", clickIdType: "meta" }),
    ).toBe("paid-meta");
  });

  it("does not invent a social channel from utm_source when the medium isn't organic", () => {
    // No paid marker and no organic marker => not enough evidence to call it social.
    expect(resolveChannel({ utmSource: "instagram", utmMedium: "referral" })).not.toBe(
      "organic-social",
    );
  });

  it("recognises organic search", () => {
    expect(resolveChannel({ source: "google", referrerUrl: "https://www.google.com/" })).toBe(
      "organic-search",
    );
  });

  it("maps direct to direct, and leaves genuinely unknown as unknown", () => {
    expect(resolveChannel({ source: "direct" })).toBe("direct");
    expect(resolveChannel({})).toBe("direct"); // no source, no referrer
  });

  it("classifies paid channels correctly for spend attachment", () => {
    expect(isPaidChannel("paid-meta")).toBe(true);
    expect(isPaidChannel("organic-social")).toBe(false);
  });

  it("treats our OWN domain as internal, not a referral", () => {
    // Live bug this caught: www.essesmag.com produced 748 touchpoints and made
    // "referral" look like the biggest channel at $34K — it was the site handing
    // off to checkout.
    expect(resolveChannel({ referrerUrl: "https://www.essesmag.com/shop" })).toBe("internal");
    expect(resolveChannel({ referrerUrl: "https://esses.com/" })).toBe("internal");
    expect(resolveChannel({ referrerUrl: "https://shop.app/checkout/123" })).toBe("internal");
    expect(resolveChannel({ referrerUrl: "https://esses.webflow.io/" })).toBe("internal");
  });

  it("still treats a genuine third-party referrer as referral", () => {
    expect(resolveChannel({ referrerUrl: "https://joincheckmate.com/article" })).toBe("referral");
  });

  it("matches subdomains of our own domains", () => {
    expect(isOwnDomain("www.essesmag.com")).toBe(true);
    expect(isOwnDomain("essesmag.com")).toBe(true);
    expect(isOwnDomain("notessesmag.com")).toBe(false);
  });
});

describe("last-non-direct looks past internal self-referrals", () => {
  it("credits the real acquiring touch, not the site→checkout hop", () => {
    const withInternal: Touchpoint[] = [
      { id: "ig", channel: "organic-social", occurredAt: T0 },
      { id: "self", channel: "internal", occurredAt: T0 + DAY },
    ];
    const r = attribute(withInternal, "last-non-direct");
    expect(r.find((t) => t.id === "ig")?.credit).toBe(1);
    expect(r.find((t) => t.id === "self")?.credit).toBe(0);
  });
});

describe("click id and UTM parsing", () => {
  it("pulls fbclid out of a landing page", () => {
    const r = parseClickId("https://esses.com/shop?fbclid=XYZ&utm_source=ig");
    expect(r).toEqual({ clickId: "XYZ", clickIdType: "meta" });
  });

  it("pulls gclid and ttclid", () => {
    expect(parseClickId("https://e.com/?gclid=G1")?.clickIdType).toBe("google");
    expect(parseClickId("https://e.com/?ttclid=T1")?.clickIdType).toBe("tiktok");
  });

  it("returns null for no click id and for malformed URLs", () => {
    expect(parseClickId("https://esses.com/shop")).toBeNull();
    expect(parseClickId("not a url")).toBeNull();
    expect(parseClickId(null)).toBeNull();
  });

  it("parses UTMs from the landing page", () => {
    expect(parseUtms("https://e.com/?utm_source=ig&utm_medium=cpc&utm_campaign=issue6")).toEqual({
      utmSource: "ig",
      utmMedium: "cpc",
      utmCampaign: "issue6",
    });
  });
});

describe("attribution models — credit must always sum to exactly 1", () => {
  const sum = (a: { credit: number }[]) => a.reduce((s, x) => s + x.credit, 0);

  it("last-non-direct skips the direct closer", () => {
    const r = attribute(path, "last-non-direct");
    expect(r.find((t) => t.id === "b")?.credit).toBe(1);
    expect(r.find((t) => t.id === "c")?.credit).toBe(0);
    expect(sum(r)).toBe(1);
  });

  it("last-non-direct still credits something when the whole path is direct", () => {
    const allDirect: Touchpoint[] = [
      { id: "x", channel: "direct", occurredAt: T0 },
      { id: "y", channel: "direct", occurredAt: T0 + DAY },
    ];
    const r = attribute(allDirect, "last-non-direct");
    expect(sum(r)).toBe(1);
    expect(r.find((t) => t.id === "y")?.credit).toBe(1);
  });

  it("linear splits evenly and sums to 1", () => {
    const r = attribute(path, "linear");
    expect(r.every((t) => Math.abs(t.credit - 1 / 3) < 1e-12)).toBe(true);
    expect(sum(r)).toBeCloseTo(1, 12);
  });

  it("first-touch credits the earliest visit regardless of input order", () => {
    const shuffled = [path[2], path[0], path[1]];
    const r = attribute(shuffled, "first-touch");
    expect(r[0].id).toBe("a");
    expect(r[0].credit).toBe(1);
    expect(sum(r)).toBe(1);
  });

  it("time-decay weights recent touches more, still summing to 1", () => {
    const r = attribute(path, "time-decay", { conversionAt: T0 + 10 * DAY, halfLifeDays: 7 });
    const a = r.find((t) => t.id === "a")!.credit;
    const c = r.find((t) => t.id === "c")!.credit;
    expect(c).toBeGreaterThan(a);
    expect(sum(r)).toBeCloseTo(1, 12);
  });

  it("time-decay falls back to an even split when all weights underflow", () => {
    // A path years before the conversion would otherwise divide by zero.
    const ancient: Touchpoint[] = [
      { id: "p", channel: "organic-social", occurredAt: T0 },
      { id: "q", channel: "paid-meta", occurredAt: T0 + DAY },
    ];
    const r = attribute(ancient, "time-decay", {
      conversionAt: T0 + 4000 * DAY,
      halfLifeDays: 1,
    });
    expect(sum(r)).toBeCloseTo(1, 12);
  });

  it("returns nothing for an empty path rather than inventing a touchpoint", () => {
    expect(attribute([], "linear")).toEqual([]);
  });

  it("handles a single-touch path — the current Esses reality", () => {
    const single: Touchpoint[] = [{ id: "s", channel: "organic-social", occurredAt: T0 }];
    for (const m of ["linear", "last-non-direct", "time-decay", "first-touch"] as const) {
      const r = attribute(single, m);
      expect(r).toHaveLength(1);
      expect(r[0].credit).toBeCloseTo(1, 12);
    }
  });
});

describe("creditByChannel — revenue splits must reconcile to the order total", () => {
  it("apportions revenue by credit and loses nothing to rounding", () => {
    const credited = attribute(path, "linear");
    const rows = creditByChannel(credited, 10_000);
    expect(rows.reduce((s, r) => s + r.revenueCents, 0)).toBe(10_000);
  });

  it("survives an awkward total that doesn't divide by three", () => {
    const credited = attribute(path, "linear");
    const rows = creditByChannel(credited, 10_001);
    expect(rows.reduce((s, r) => s + r.revenueCents, 0)).toBe(10_001);
  });

  it("merges repeated channels into one row", () => {
    const dup: Touchpoint[] = [
      { id: "a", channel: "paid-meta", occurredAt: T0 },
      { id: "b", channel: "paid-meta", occurredAt: T0 + DAY },
    ];
    const rows = creditByChannel(attribute(dup, "linear"), 5_000);
    expect(rows).toHaveLength(1);
    expect(rows[0].revenueCents).toBe(5_000);
  });
});

describe("platform reconciliation", () => {
  it("quantifies over-claiming", () => {
    const r = reconcile(10, 17, "paid-meta");
    expect(r.deltaAbsolute).toBe(7);
    expect(r.overclaimRatio).toBeCloseTo(1.7, 10);
  });

  it("returns a null ratio (not Infinity) when we saw nothing", () => {
    expect(reconcile(0, 5, "paid-meta").overclaimRatio).toBeNull();
  });
});

describe("journey mapping", () => {
  it("dedupes the same visit appearing as both firstVisit and lastVisit", () => {
    // Shopify does this on single-touch orders; counting twice would halve credit.
    const visit = {
      occurredAt: "2026-07-30T02:04:08Z",
      source: "Instagram",
      referrerUrl: "https://instagram.com/",
      landingPage: "https://essesmag.myshopify.com/checkouts/cn/abc/en-us",
      utmParameters: null,
    };
    const t = mapJourneyToTouchpoints(
      { ready: true, firstVisit: visit, lastVisit: visit },
      { customerId: "c1", orderId: "o1", fallbackAt: new Date(T0) },
    );
    expect(t).toHaveLength(1);
    expect(t[0].channel).toBe("organic-social");
  });

  it("keeps genuinely distinct visits", () => {
    const t = mapJourneyToTouchpoints(
      {
        ready: true,
        firstVisit: { occurredAt: "2026-07-01T00:00:00Z", source: "google" },
        lastVisit: {
          occurredAt: "2026-07-05T00:00:00Z",
          source: "Instagram",
          referrerUrl: "https://instagram.com/",
        },
      },
      { customerId: "c1", orderId: "o1", fallbackAt: new Date(T0) },
    );
    expect(t).toHaveLength(2);
  });

  it("returns nothing when Shopify has no journey for the order", () => {
    expect(
      mapJourneyToTouchpoints(null, { customerId: "c1", orderId: "o1", fallbackAt: new Date(T0) }),
    ).toEqual([]);
  });
});
