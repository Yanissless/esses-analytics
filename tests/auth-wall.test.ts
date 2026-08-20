import { describe, expect, it } from "vitest";
import { isPublic, wallOutcome } from "../src/lib/auth/wall";

/**
 * The session wall is the app's only security boundary — every page and every API route sits
 * behind it. It had no tests until the refresh endpoint exposed the API case, which is a bad
 * place to have no tests.
 */
describe("wallOutcome", () => {
  it("blocks a signed-out visitor from every dashboard page", () => {
    for (const p of ["/", "/profit", "/creatives", "/costs", "/team", "/account"]) {
      expect(wallOutcome(p, false).kind).toBe("redirect-login");
    }
  });

  it("lets a signed-in user through", () => {
    expect(wallOutcome("/profit", true).kind).toBe("allow");
  });

  it("answers an unauthenticated API request with 401, not a redirect", () => {
    // THE bug this replaced. A redirect hands a `fetch` the login page's HTML, so `.json()`
    // throws and the caller reports whatever its generic failure message is — for the auto
    // refresh, "Couldn't update data", which is untrue and sends you hunting a data problem.
    expect(wallOutcome("/api/refresh", false).kind).toBe("unauthorized");
  });

  it("still refuses the API request — only the shape changed", () => {
    // Guards against someone reading the 401 branch as "APIs are open".
    const outcome = wallOutcome("/api/refresh", false);
    expect(outcome.kind).not.toBe("allow");
  });

  it("keeps the scheduler endpoints reachable without a session", () => {
    // They authenticate with CRON_SECRET instead; a redirect to /login would break the cron.
    expect(wallOutcome("/api/sync", false).kind).toBe("allow");
    expect(wallOutcome("/api/health", false).kind).toBe("allow");
    expect(wallOutcome("/login", false).kind).toBe("allow");
  });

  it("sends a signed-in user off the login page", () => {
    expect(wallOutcome("/login", true).kind).toBe("redirect-home");
  });

  it("remembers where the visitor was going, except at the root", () => {
    const deep = wallOutcome("/creatives", false);
    if (deep.kind === "redirect-login") expect(deep.next).toBe("/creatives");
    const root = wallOutcome("/", false);
    // A clean /login rather than /login?next=%2F, which is noise.
    if (root.kind === "redirect-login") expect(root.next).toBeNull();
  });

  it("does not treat a lookalike prefix as public", () => {
    // "/api/syncable" or "/loginsomething" must NOT inherit /api/sync's or /login's exemption.
    expect(isPublic("/api/syncable")).toBe(false);
    expect(isPublic("/loginx")).toBe(false);
    // A real child path does.
    expect(isPublic("/api/sync/all")).toBe(true);
  });

  it("gives a lookalike API prefix the 401 rather than the redirect", () => {
    expect(wallOutcome("/api/syncable", false).kind).toBe("unauthorized");
  });
});
