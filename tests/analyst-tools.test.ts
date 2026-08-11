import { describe, expect, it } from "vitest";
import {
  ANALYST_TOOLS,
  analystToolNamesFor,
  roleCanUseTool,
  toolLabel,
} from "../src/lib/ai/analyst";
import { can, ROLES, type Capability, type Role } from "../src/lib/auth/capabilities";

/**
 * What the AI analyst is allowed to read.
 *
 * The agent is a single endpoint that can reach every metric in the app, and which
 * metrics it reaches is decided by a model reading text that includes the user's own
 * words. So the boundary cannot live in the prompt — asking a model not to look at
 * margin is a request, not a control. It lives in the toolset: the tools a role may not
 * use are absent from the request, so there is nothing to be talked into.
 *
 * These tests pin that boundary. `roleCanUseTool` is the real predicate both gates in
 * `tools.server.ts` call, so this is a test of the mechanism rather than a restatement
 * of it. The marketing case is the one that matters: rule 7 exists because a missed
 * guard leaks financial or customer data rather than merely miscalculating.
 */

const ALL_CAPABILITIES: Capability[] = [
  "marketing",
  "audience",
  "revenue",
  "margin",
  "customers",
  "settings",
  "team",
];

/** Tools that would leak what the marketing role is explicitly denied. */
const MARGIN_TOOLS = [
  "margin_summary",
  "profit_waterfall",
  "market_margins",
  "product_profit",
  "profit_quality",
  "cogs_coverage",
];
const CUSTOMER_TOOLS = ["top_customers"];

describe("analyst tool registry", () => {
  it("gates every tool on a real capability, or on none at all", () => {
    for (const [name, meta] of Object.entries(ANALYST_TOOLS)) {
      if (meta.capability !== undefined) {
        expect(ALL_CAPABILITIES, `${name} has an unknown capability`).toContain(meta.capability);
      }
      expect(meta.label, `${name} needs a label for the UI`).toBeTruthy();
    }
  });

  it("only exempts coverage tools from a capability", () => {
    // A tool with no capability is readable by every role, so the exemption list must
    // stay deliberate and short. data_coverage is exempt because every role should be
    // able to ask how much to trust a number — including the roles that see the fewest.
    const ungated = Object.entries(ANALYST_TOOLS)
      .filter(([, m]) => m.capability === undefined)
      .map(([name]) => name);
    expect(ungated).toEqual(["data_coverage"]);
  });

  it("falls back to the raw name when labelling an unknown tool", () => {
    expect(toolLabel("margin_summary")).toBe("the margin summary");
    expect(toolLabel("not_a_tool")).toBe("not_a_tool");
  });
});

describe("roleCanUseTool fails closed", () => {
  it("refuses an unregistered tool for every role", () => {
    // A tool implemented without a registry entry is unreachable rather than ungated.
    for (const role of ROLES) {
      expect(roleCanUseTool(role, "sql_query")).toBe(false);
      expect(roleCanUseTool(role, "")).toBe(false);
    }
  });

  it("agrees with the capability map for every role and tool", () => {
    for (const role of ROLES) {
      for (const [name, meta] of Object.entries(ANALYST_TOOLS)) {
        const expected = !meta.capability || can(role, meta.capability);
        expect(roleCanUseTool(role, name), `${role} / ${name}`).toBe(expected);
      }
    }
  });
});

describe("the marketing role cannot reach withheld data through the analyst", () => {
  const marketing = analystToolNamesFor("marketing");

  it("has no margin tool at all", () => {
    for (const tool of MARGIN_TOOLS) {
      expect(marketing, `marketing must not reach ${tool}`).not.toContain(tool);
      expect(roleCanUseTool("marketing", tool)).toBe(false);
    }
  });

  it("has no individual-customer tool", () => {
    for (const tool of CUSTOMER_TOOLS) {
      expect(marketing, `marketing must not reach ${tool}`).not.toContain(tool);
      expect(roleCanUseTool("marketing", tool)).toBe(false);
    }
  });

  it("still gets the acquisition tools it exists to use", () => {
    // "Marketing only" cannot mean "no revenue" — MER and ROAS are revenue over spend.
    // Aggregate revenue in a marketing frame is allowed; the margin derived from it is not.
    expect(marketing).toContain("social_summary");
    expect(marketing).toContain("channel_ltv");
    expect(marketing).toContain("churn_cohorts");
    expect(marketing).toContain("personas");
  });

  it("can always ask about data coverage", () => {
    expect(marketing).toContain("data_coverage");
  });

  it("gets strictly fewer tools than a viewer, and no tool a viewer lacks", () => {
    const viewer = analystToolNamesFor("viewer");
    expect(marketing.length).toBeLessThan(viewer.length);
    for (const tool of marketing) expect(viewer).toContain(tool);
  });
});

describe("the other roles", () => {
  it("gives admin every tool", () => {
    expect(analystToolNamesFor("admin")).toEqual(Object.keys(ANALYST_TOOLS).sort());
  });

  it("gives viewer every read tool — no analyst tool writes, so viewer matches admin", () => {
    // The analyst is read-only by construction: there is no tool gated on `settings` or
    // `team`, so the read-only role sees exactly what the admin does. If this test
    // breaks, someone added a write tool, and that is the thing to look at.
    expect(analystToolNamesFor("viewer")).toEqual(analystToolNamesFor("admin"));
  });

  it("gates no tool on settings or team", () => {
    const writeGated = Object.entries(ANALYST_TOOLS).filter(
      ([, m]) => m.capability === "settings" || m.capability === "team",
    );
    expect(writeGated).toEqual([]);
  });

  it("returns a sorted, duplicate-free list for every role", () => {
    for (const role of ROLES as Role[]) {
      const names = analystToolNamesFor(role);
      expect(names).toEqual([...names].sort());
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
