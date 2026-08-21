import { describe, expect, it } from "vitest";
import {
  classifyPath,
  isContentKind,
  normalisePath,
  OTHER_ROW,
  parseGa4Date,
  PAGE_SIZE,
  provisionalFrom,
  shapeRows,
  type Ga4Row,
} from "../src/connectors/ga4/shape";

const row = (over: Partial<Ga4Row> = {}): Ga4Row => ({
  date: "20260815",
  pagePath: "/blogs/news/monaco-preview",
  pageTitle: "Monaco Preview",
  sessions: 10,
  views: 12,
  users: 9,
  engagedSessions: 7,
  engagementSeconds: 300,
  entrances: 8,
  ...over,
});

describe("parseGa4Date", () => {
  it("converts GA4's compact date", () => {
    expect(parseGa4Date("20260815")).toBe("2026-08-15");
  });

  it("rejects a Measurement-ID-shaped or otherwise wrong value", () => {
    expect(parseGa4Date("G-ABC123")).toBeNull();
    expect(parseGa4Date("2026-08-15")).toBeNull();
    expect(parseGa4Date("")).toBeNull();
  });

  it("rejects a date that is well-formed but impossible", () => {
    // A string like this would otherwise be stored and then never match any range query,
    // making the traffic simply vanish rather than fail.
    expect(parseGa4Date("20261345")).toBeNull();
    expect(parseGa4Date("20260230")).toBeNull();
  });
});

describe("normalisePath", () => {
  it("strips the query string", () => {
    // THE reason this function exists. Left alone, the best-promoted article fragments across
    // the most UTM variants and therefore ranks lowest — the ranking inverts.
    expect(normalisePath("/blogs/news/x?utm_source=instagram&utm_medium=social")).toBe(
      "/blogs/news/x",
    );
    expect(normalisePath("/products/esses-issue-03?variant=42")).toBe("/products/esses-issue-03");
  });

  it("strips a fragment", () => {
    expect(normalisePath("/blogs/news/x#comments")).toBe("/blogs/news/x");
  });

  it("collapses a trailing slash, but never the root", () => {
    expect(normalisePath("/blogs/news/x/")).toBe("/blogs/news/x");
    expect(normalisePath("/")).toBe("/");
  });

  it("treats an empty path as the root", () => {
    expect(normalisePath("")).toBe("/");
    expect(normalisePath("   ")).toBe("/");
  });

  it("reduces a full URL to its path", () => {
    expect(normalisePath("https://essesmag.myshopify.com/products/esses-tee")).toBe(
      "/products/esses-tee",
    );
    expect(normalisePath("https://esses.com/features/senna?ref=x")).toBe("/features/senna");
  });

  it("keeps a relative path usable rather than dropping it", () => {
    expect(normalisePath("blogs/news/x")).toBe("/blogs/news/x");
  });

  it("does not merge two genuinely different articles", () => {
    expect(normalisePath("/blogs/news/a")).not.toBe(normalisePath("/blogs/news/b"));
  });
});

describe("classifyPath", () => {
  it("recognises the store's real path shapes", () => {
    // Taken from the actual converting landing URLs in attribution_touchpoints.
    expect(classifyPath("/products/esses-yearly-subscription")).toBe("product");
    expect(classifyPath("/collections/magazine")).toBe("collection");
    expect(classifyPath("/")).toBe("home");
    expect(classifyPath("/pages/about")).toBe("page");
  });

  it("keeps funnel and account traffic out of content", () => {
    // These are mechanism, not readership. Checkout paths in particular carry a per-session
    // token, so each one would otherwise look like a unique article with one reader.
    for (const p of [
      "/cart",
      "/checkouts/cn/hWN47zCfQ5rquhQ7dkhWgvWD/en-us",
      "/a/account/login",
      "/a/account/subscriptions",
    ]) {
      expect(classifyPath(p)).toBe("funnel");
    }
  });

  it("distinguishes a blog article from the blog index", () => {
    expect(classifyPath("/blogs/news/monaco-preview")).toBe("article");
    // Two segments is the listing page, which is not an article.
    expect(classifyPath("/blogs/news")).toBe("collection");
  });

  it("recognises editorial paths a magazine site uses", () => {
    expect(classifyPath("/features/senna-at-monaco")).toBe("article");
    expect(classifyPath("/news/2026-calendar")).toBe("article");
  });

  it("is case-insensitive", () => {
    expect(classifyPath("/Products/Esses-Tee")).toBe("product");
  });

  it("reports an unknown shape as unclassified rather than guessing", () => {
    // The honest outcome. esses.com is a separate editorial site whose paths never appear in
    // order data, so some of the pattern list is inference — and inference should fail
    // countably. Folding these into "other" would hide that the patterns need fixing.
    expect(classifyPath("/wp/2026/08/some-post")).toBe("unclassified");
    expect(classifyPath("/motorsport/analysis/x")).toBe("unclassified");
  });

  it("counts articles and static pages as content, funnel as not", () => {
    expect(isContentKind("article")).toBe(true);
    expect(isContentKind("home")).toBe(true);
    expect(isContentKind("funnel")).toBe(false);
    expect(isContentKind("product")).toBe(false);
  });
});

describe("shapeRows", () => {
  it("merges rows the same page produced under two titles", () => {
    // A page retitled mid-window comes back twice, because pageTitle is a dimension. The unique
    // index is on (date, path), so unmerged these two would collide on upsert — or worse, the
    // second would overwrite the first and report half the real traffic.
    const out = shapeRows(
      [
        row({ pageTitle: "Old title", sessions: 10, views: 12, entrances: 8 }),
        row({ pageTitle: "New title", sessions: 5, views: 30, entrances: 3 }),
      ],
      null,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].sessions).toBe(15);
    expect(out.rows[0].views).toBe(42);
    expect(out.rows[0].entrances).toBe(11);
    // The title from the higher-traffic row: what the page was called while most people read it.
    expect(out.rows[0].pageTitle).toBe("New title");
  });

  it("merges UTM variants of one article into one row", () => {
    const out = shapeRows(
      [
        row({ pagePath: "/blogs/news/x", sessions: 100 }),
        row({ pagePath: "/blogs/news/x?utm_source=instagram", sessions: 250 }),
        row({ pagePath: "/blogs/news/x?utm_source=newsletter", sessions: 75 }),
      ],
      null,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].sessions).toBe(425);
  });

  it("does not sum users across merged rows", () => {
    // `users` is de-duplicated by GA4, so adding two overlapping counts overstates it. An
    // undercount that can be explained beats an overcount that cannot.
    const out = shapeRows(
      [row({ users: 90, views: 100 }), row({ users: 80, views: 10 })],
      null,
    );
    expect(out.rows[0].users).toBe(90);
  });

  it("pulls the (other) bucket out instead of storing it as a page", () => {
    // A row literally named "(other)" ranking third in a top-pages table is worse than no row,
    // because it reads as a page someone could go and look at.
    const out = shapeRows(
      [row({ sessions: 10 }), row({ pagePath: OTHER_ROW, sessions: 4_000 })],
      null,
    );
    expect(out.rows.map((r) => r.pagePath)).toEqual(["/blogs/news/monaco-preview"]);
    expect(out.otherByDate.get("2026-08-15")).toBe(4_000);
  });

  it("keeps the (other) sessions per day, not pooled", () => {
    const out = shapeRows(
      [
        row({ date: "20260814", pagePath: OTHER_ROW, sessions: 100 }),
        row({ date: "20260815", pagePath: OTHER_ROW, sessions: 250 }),
      ],
      null,
    );
    expect(out.otherByDate.get("2026-08-14")).toBe(100);
    expect(out.otherByDate.get("2026-08-15")).toBe(250);
  });

  it("marks only dates inside the processing window provisional", () => {
    // Provisional is a property of the DATE against GA4's ~48h reprocessing window — not of the
    // sync's recency. A row fetched today for last week is settled.
    const out = shapeRows(
      [
        row({ date: "20260810", pagePath: "/a" }),
        row({ date: "20260820", pagePath: "/b" }),
      ],
      "2026-08-19",
    );
    const byPath = new Map(out.rows.map((r) => [r.pagePath, r.isProvisional]));
    expect(byPath.get("/a")).toBe(false);
    expect(byPath.get("/b")).toBe(true);
  });

  it("counts an unparseable date as dropped rather than storing it", () => {
    const out = shapeRows([row({ date: "not-a-date" }), row()], null);
    expect(out.droppedRows).toBe(1);
    expect(out.rows).toHaveLength(1);
  });

  it("keeps distinct days and paths separate", () => {
    const out = shapeRows(
      [
        row({ date: "20260814", pagePath: "/a" }),
        row({ date: "20260815", pagePath: "/a" }),
        row({ date: "20260815", pagePath: "/b" }),
      ],
      null,
    );
    expect(out.rows).toHaveLength(3);
  });

  it("handles an empty report", () => {
    const out = shapeRows([], null);
    expect(out.rows).toEqual([]);
    expect(out.droppedRows).toBe(0);
    expect(out.otherByDate.size).toBe(0);
  });
});

describe("provisionalFrom", () => {
  it("is 48 hours behind the given moment", () => {
    expect(provisionalFrom(new Date("2026-08-21T12:00:00Z"))).toBe("2026-08-19");
  });

  it("crosses a month boundary correctly", () => {
    expect(provisionalFrom(new Date("2026-09-01T06:00:00Z"))).toBe("2026-08-30");
  });
});

describe("page size", () => {
  it("stays under GA4's hard row cap", () => {
    // A page size EQUAL to the cap makes "a full page" and "the server truncated us"
    // indistinguishable, so a cut-off report would read as a complete one.
    expect(PAGE_SIZE).toBeLessThan(100_000);
  });
});
