import { beforeAll, describe, expect, it } from "vitest";

// Session signing reads AUTH_SECRET at call time — set it before importing.
beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-at-least-32-characters-long!!";
});

describe("session sign/verify", () => {
  it("round-trips a valid session", async () => {
    const { signSession, verifySession } = await import("../src/lib/auth/session");
    const token = await signSession({
      sub: "user-1",
      email: "sam@essesmag.com",
      role: "admin",
      name: "Sam",
    });
    const payload = await verifySession(token);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe("user-1");
    expect(payload?.email).toBe("sam@essesmag.com");
    expect(payload?.role).toBe("admin");
  });

  it("rejects a tampered token", async () => {
    const { signSession, verifySession } = await import("../src/lib/auth/session");
    const token = await signSession({
      sub: "user-1",
      email: "sam@essesmag.com",
      role: "admin",
    });
    const tampered = token.slice(0, -3) + "abc";
    expect(await verifySession(tampered)).toBeNull();
  });

  it("rejects undefined / empty tokens", async () => {
    const { verifySession } = await import("../src/lib/auth/session");
    expect(await verifySession(undefined)).toBeNull();
    expect(await verifySession("")).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const { SignJWT } = await import("jose");
    const { verifySession } = await import("../src/lib/auth/session");
    const forged = await new SignJWT({ email: "x@y.com", role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .sign(new TextEncoder().encode("a-completely-different-secret-value-32+"));
    expect(await verifySession(forged)).toBeNull();
  });
});
