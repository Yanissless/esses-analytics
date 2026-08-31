import { describe, expect, it } from "vitest";
import {
  adDestinations,
  hostOf,
  isObservableHost,
  taggedForTracking,
  verdictFor,
} from "../src/connectors/ads/destinations";

describe("adDestinations", () => {
  it("reads a plain link ad", () => {
    expect(
      adDestinations({ object_story_spec: { link_data: { link: "https://esses.com/checkout" } } }),
    ).toEqual(["https://esses.com/checkout"]);
  });

  it("reads every card of a carousel", () => {
    // Reading only link_data.link would report "no destination" for a carousel, and this
    // account runs them.
    expect(
      adDestinations({
        object_story_spec: {
          link_data: { child_attachments: [{ link: "https://a.test/1" }, { link: "https://a.test/2" }] },
        },
      }),
    ).toEqual(["https://a.test/1", "https://a.test/2"]);
  });

  it("reads a video ad's call-to-action link", () => {
    expect(
      adDestinations({
        object_story_spec: { video_data: { call_to_action: { value: { link: "https://v.test/x" } } } },
      }),
    ).toEqual(["https://v.test/x"]);
  });

  it("reads an Advantage+ asset feed", () => {
    expect(
      adDestinations({ asset_feed_spec: { link_urls: [{ website_url: "https://af.test/y" }] } }),
    ).toEqual(["https://af.test/y"]);
  });

  it("returns nothing rather than throwing on an empty creative", () => {
    expect(adDestinations(undefined)).toEqual([]);
    expect(adDestinations({})).toEqual([]);
  });
});

describe("hostOf", () => {
  it("lowercases the host", () => {
    expect(hostOf("https://ESSES.com/checkout")).toBe("esses.com");
  });

  it("returns null for junk rather than throwing", () => {
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe("taggedForTracking", () => {
  it("accepts tags on the destination URL", () => {
    // The mechanism actually in use: url_tags was set on 1 of 200 ads while the real tagging
    // was appended to the URLs, so checking only url_tags would report the account untagged.
    expect(
      taggedForTracking({
        object_story_spec: { link_data: { link: "https://x.test/p?utm_source=instagram" } },
      }),
    ).toBe(true);
  });

  it("accepts Meta's url_tags field", () => {
    expect(taggedForTracking({ url_tags: "utm_source=fb&utm_medium=paid_social" })).toBe(true);
  });

  it("is false when neither carries tags", () => {
    expect(
      taggedForTracking({
        object_story_spec: { link_data: { link: "https://esses.com/checkout?checkoutLink=abc" } },
      }),
    ).toBe(false);
  });
});

describe("isObservableHost", () => {
  it("accepts the Shopify hosts whose visits we actually record", () => {
    expect(isObservableHost("essesmag.myshopify.com")).toBe(true);
    expect(isObservableHost("shop.app")).toBe(true);
  });

  it("rejects Craft, which records nothing on our side", () => {
    // THE case. A click here is real, the spend is real, and no touchpoint is ever created.
    expect(isObservableHost("esses.com")).toBe(false);
    expect(isObservableHost("www.esses.com")).toBe(false);
  });

  it("rejects a missing host rather than defaulting to observable", () => {
    // Defaulting the other way is what silence looks like.
    expect(isObservableHost(null)).toBe(false);
  });
});

describe("verdictFor", () => {
  it("reports an unobservable destination first, before the tagging question", () => {
    // Order matters: tagging an ad that bypasses Shopify changes nothing, so leading with
    // "untagged" would send somebody to do the wrong fix.
    const v = verdictFor({
      object_story_spec: { link_data: { link: "https://esses.com/checkout?checkoutLink=abc" } },
    });
    expect(v.observable).toBe(false);
    expect(v.host).toBe("esses.com");
    expect(v.note).toContain("no touchpoint is ever recorded");
  });

  it("still reports unobservable even when the ad IS tagged", () => {
    // Tags on a Craft-destined ad are discarded at the handoff to checkout, so this is not a
    // solved case.
    const v = verdictFor({
      object_story_spec: { link_data: { link: "https://esses.com/x?utm_source=instagram" } },
    });
    expect(v.tagged).toBe(true);
    expect(v.observable).toBe(false);
  });

  it("flags an observable but untagged destination", () => {
    const v = verdictFor({
      object_story_spec: { link_data: { link: "https://essesmag.myshopify.com/products/x" } },
    });
    expect(v.observable).toBe(true);
    expect(v.tagged).toBe(false);
    expect(v.note).toContain("carries no UTMs");
  });

  it("passes an ad that is traceable end to end", () => {
    const v = verdictFor({
      object_story_spec: {
        link_data: { link: "https://essesmag.myshopify.com/products/x?utm_source=instagram" },
      },
    });
    expect(v.observable).toBe(true);
    expect(v.tagged).toBe(true);
    expect(v.note).toBe("Traceable end to end.");
  });

  it("says so when there is no destination at all", () => {
    expect(verdictFor({}).note).toContain("No destination found");
  });
});
