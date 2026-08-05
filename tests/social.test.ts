import { describe, expect, it } from "vitest";
import { normalizeSocialPlatform } from "../src/metrics/social";

describe("normalizeSocialPlatform", () => {
  /**
   * These are the exact referrer hosts present in live data. `l.instagram.com` is
   * Instagram's link shim and carries 222 touchpoints — reading it as anything other
   * than Instagram would misplace a sixth of our organic social traffic.
   */
  it("maps the real Instagram hosts, shims included", () => {
    expect(normalizeSocialPlatform("https://instagram.com/", null)).toBe("instagram");
    expect(normalizeSocialPlatform("https://l.instagram.com/", null)).toBe("instagram");
    expect(normalizeSocialPlatform("https://www.instagram.com/", null)).toBe("instagram");
  });

  it("maps the real Facebook hosts, mobile and shim included", () => {
    expect(normalizeSocialPlatform("https://m.facebook.com/", null)).toBe("facebook");
    expect(normalizeSocialPlatform("https://l.facebook.com/", null)).toBe("facebook");
    expect(normalizeSocialPlatform("https://facebook.com/", null)).toBe("facebook");
    expect(normalizeSocialPlatform("https://fb.com/x", null)).toBe("facebook");
  });

  it("keeps Threads separate from Instagram despite shared ownership", () => {
    expect(normalizeSocialPlatform("https://www.threads.com/", null)).toBe("threads");
    expect(normalizeSocialPlatform("https://l.threads.com/", null)).toBe("threads");
  });

  it("maps the other platforms", () => {
    expect(normalizeSocialPlatform("https://www.tiktok.com/", null)).toBe("tiktok");
    expect(normalizeSocialPlatform("https://pinterest.com/pin/1", null)).toBe("pinterest");
    expect(normalizeSocialPlatform("https://reddit.com/r/formula1", null)).toBe("reddit");
    expect(normalizeSocialPlatform("https://x.com/esses", null)).toBe("x");
    expect(normalizeSocialPlatform("https://youtube.com/watch", null)).toBe("youtube");
    expect(normalizeSocialPlatform("https://www.linkedin.com/feed", null)).toBe("linkedin");
  });

  /**
   * 178 paid touchpoints have NO referrer — Meta's in-app browser often sends none —
   * so Shopify's own `source` is the fallback that keeps them identifiable.
   */
  it("falls back to Shopify's source when the referrer is missing", () => {
    expect(normalizeSocialPlatform(null, "Instagram")).toBe("instagram");
    expect(normalizeSocialPlatform(null, "Facebook")).toBe("facebook");
    expect(normalizeSocialPlatform("", "Instagram")).toBe("instagram");
  });

  it("returns null rather than guessing when there is no social signal", () => {
    expect(normalizeSocialPlatform(null, null)).toBeNull();
    expect(normalizeSocialPlatform("", "")).toBeNull();
    expect(normalizeSocialPlatform("   ", "  ")).toBeNull();
    // Live values that must NOT be forced into a platform.
    expect(normalizeSocialPlatform(null, "an unknown source")).toBeNull();
    expect(normalizeSocialPlatform(null, "direct")).toBeNull();
    expect(normalizeSocialPlatform("https://shop.app/", "Shop")).toBeNull();
    expect(normalizeSocialPlatform("https://www.google.com/", "google")).toBeNull();
    expect(normalizeSocialPlatform("https://essesmag.com/", null)).toBeNull();
  });

  it("is case-insensitive, since Shopify's source is title-cased", () => {
    expect(normalizeSocialPlatform("HTTPS://INSTAGRAM.COM/", null)).toBe("instagram");
    expect(normalizeSocialPlatform(null, "INSTAGRAM")).toBe("instagram");
  });
});
