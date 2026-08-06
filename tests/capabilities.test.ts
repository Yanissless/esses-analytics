import { describe, expect, it } from "vitest";
import {
  can,
  isRole,
  landingPathFor,
  ROLES,
  ROLE_META,
  type Capability,
} from "../src/lib/auth/capabilities";

const ALL_CAPABILITIES: Capability[] = [
  "marketing",
  "audience",
  "revenue",
  "margin",
  "customers",
  "settings",
  "team",
];

describe("capability map", () => {
  it("gives admin everything", () => {
    for (const c of ALL_CAPABILITIES) expect(can("admin", c)).toBe(true);
  });

  it("keeps viewer as read-everything, write-nothing — unchanged behaviour", () => {
    // Viewer existed before capabilities; this pins that adding the system didn't
    // quietly widen or narrow it.
    expect(can("viewer", "marketing")).toBe(true);
    expect(can("viewer", "audience")).toBe(true);
    expect(can("viewer", "revenue")).toBe(true);
    expect(can("viewer", "margin")).toBe(true);
    expect(can("viewer", "customers")).toBe(true);
    expect(can("viewer", "settings")).toBe(false);
    expect(can("viewer", "team")).toBe(false);
  });
});

/**
 * These are the tests that matter. The marketing role is an access boundary around real
 * financial and personal data, so each exclusion is asserted individually — a single
 * "has the right capabilities" assertion would still pass if the map were widened.
 */
describe("marketing role withholds the right things", () => {
  it("can see acquisition and cohort performance", () => {
    expect(can("marketing", "marketing")).toBe(true);
    expect(can("marketing", "audience")).toBe(true);
  });

  it("CANNOT see cost or margin", () => {
    // /profit, /international, /costs, /shipping — COGS, CM1-CM3, per-market profit.
    expect(can("marketing", "margin")).toBe(false);
  });

  it("CANNOT see individual customer records", () => {
    // /customers shows names, emails and per-person lifetime value.
    expect(can("marketing", "customers")).toBe(false);
  });

  it("CANNOT see the Overview or Forecast pages", () => {
    // Overview carries CM3 and a top-customers table with email addresses; Forecast
    // carries CM3 goals. Both are gated on `revenue`.
    expect(can("marketing", "revenue")).toBe(false);
  });

  it("CANNOT change settings or manage people", () => {
    expect(can("marketing", "settings")).toBe(false);
    expect(can("marketing", "team")).toBe(false);
  });
});

describe("landingPathFor", () => {
  it("sends margin-and-revenue roles to the Overview", () => {
    expect(landingPathFor("admin")).toBe("/");
    expect(landingPathFor("viewer")).toBe("/");
  });

  /**
   * The redirect target must itself be reachable, or `requireCapability` bounces the
   * user between two forbidden pages forever.
   */
  it("sends marketing to a page it can actually reach", () => {
    const path = landingPathFor("marketing");
    expect(path).toBe("/marketing");
    expect(can("marketing", "marketing")).toBe(true);
  });

  it("never lands a role on a page it lacks the capability for", () => {
    const gate: Record<string, Capability> = { "/": "revenue", "/marketing": "marketing" };
    for (const role of ROLES) {
      const path = landingPathFor(role);
      expect(can(role, gate[path])).toBe(true);
    }
  });
});

describe("role validation and metadata", () => {
  it("rejects anything that isn't a known role", () => {
    // The role comes from a database column and a form field, so it's untrusted.
    expect(isRole("admin")).toBe(true);
    expect(isRole("marketing")).toBe(true);
    expect(isRole("Marketing")).toBe(false);
    expect(isRole("superadmin")).toBe(false);
    expect(isRole("")).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  it("describes every role, and spells out what a restricted one withholds", () => {
    for (const r of ROLES) {
      expect(ROLE_META[r].id).toBe(r);
      expect(ROLE_META[r].label.length).toBeGreaterThan(0);
      expect(ROLE_META[r].summary.length).toBeGreaterThan(0);
    }
    // A role that can't see everything must say so, or an admin inviting someone has no
    // way to know what they're granting.
    expect(ROLE_META.marketing.withheld).toBeTruthy();
    expect(ROLE_META.admin.withheld).toBeNull();
    expect(ROLE_META.viewer.withheld).toBeNull();
  });

  it("has metadata for exactly the roles that exist", () => {
    expect(Object.keys(ROLE_META).sort()).toEqual([...ROLES].sort());
  });
});
