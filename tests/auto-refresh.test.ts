import { describe, expect, it } from "vitest";
import {
  COOLDOWN_MINUTES,
  decideRefresh,
  STALE_AFTER_MINUTES,
  type RefreshFacts,
} from "../src/lib/sync/auto-refresh.server";

const facts = (over: Partial<RefreshFacts> = {}): RefreshFacts => ({
  ageMinutes: STALE_AFTER_MINUTES + 60,
  sinceLastAttemptMinutes: COOLDOWN_MINUTES + 10,
  inFlight: false,
  ...over,
});

/**
 * These gates are what stand between "the app keeps itself up to date" and "every page view
 * spends money at Shopify, Skio, Stripe and Meta". The ORDER is the design, so the order is
 * what these tests pin — a DB-only implementation would hide it.
 */
describe("decideRefresh", () => {
  it("refreshes when the data is stale and nothing is in the way", () => {
    const d = decideRefresh(facts());
    expect(d.refresh).toBe(true);
  });

  it("never starts a second sync while one is running", () => {
    // Four people opening the dashboard at 9am must not start four concurrent syncs writing
    // the same rows.
    const d = decideRefresh(facts({ inFlight: true }));
    expect(d.refresh).toBe(false);
    if (!d.refresh) expect(d.blockedBy).toBe("in-flight");
  });

  it("puts in-flight ahead of every other gate", () => {
    // Even with everything else screaming "refresh", a run in progress wins.
    const d = decideRefresh(
      facts({ inFlight: true, ageMinutes: 99_999, sinceLastAttemptMinutes: 99_999 }),
    );
    if (!d.refresh) expect(d.blockedBy).toBe("in-flight");
  });

  it("refuses to start the very first sync automatically", () => {
    // The first run has no cursor, so Skio walks all 3,935 subscriptions (~8 min) and Shopify
    // walks its whole history. A page view must not start that.
    const d = decideRefresh(facts({ sinceLastAttemptMinutes: null, ageMinutes: null }));
    expect(d.refresh).toBe(false);
    if (!d.refresh) expect(d.blockedBy).toBe("never-synced-manually");
  });

  it("holds off inside the cooldown even when the data is very stale", () => {
    // THE important case. A broken source never becomes fresh, so staleness alone would retry
    // on every page view forever, billing a third-party API each time. Nobody is watching when
    // that happens, which is exactly why it has to be structural.
    const d = decideRefresh(
      facts({ ageMinutes: 60 * 24 * 30, sinceLastAttemptMinutes: COOLDOWN_MINUTES - 1 }),
    );
    expect(d.refresh).toBe(false);
    if (!d.refresh) expect(d.blockedBy).toBe("cooldown");
  });

  it("checks cooldown BEFORE staleness, not after", () => {
    // Reversed, a permanently-failing source would report "stale, refreshing" on every render.
    const d = decideRefresh(
      facts({ ageMinutes: 99_999, sinceLastAttemptMinutes: 1 }),
    );
    if (!d.refresh) expect(d.blockedBy).toBe("cooldown");
  });

  it("does nothing when the data is fresh", () => {
    const d = decideRefresh(facts({ ageMinutes: 5 }));
    expect(d.refresh).toBe(false);
    if (!d.refresh) expect(d.blockedBy).toBe("fresh");
  });

  it("uses the documented thresholds exactly", () => {
    expect(decideRefresh(facts({ ageMinutes: STALE_AFTER_MINUTES - 1 })).refresh).toBe(false);
    expect(decideRefresh(facts({ ageMinutes: STALE_AFTER_MINUTES })).refresh).toBe(true);
    expect(
      decideRefresh(facts({ sinceLastAttemptMinutes: COOLDOWN_MINUTES - 1 })).refresh,
    ).toBe(false);
    expect(decideRefresh(facts({ sinceLastAttemptMinutes: COOLDOWN_MINUTES })).refresh).toBe(
      true,
    );
  });

  it("will refresh when runs have started but none has ever completed", () => {
    // A source that has only ever failed: attempts exist, completions don't. Past the cooldown
    // it should try again — that is different from never having run at all, which must not
    // auto-start a backfill.
    const d = decideRefresh(
      facts({ ageMinutes: null, sinceLastAttemptMinutes: COOLDOWN_MINUTES + 1 }),
    );
    expect(d.refresh).toBe(true);
    expect(d.reason).toContain("ever completed");
  });
});
