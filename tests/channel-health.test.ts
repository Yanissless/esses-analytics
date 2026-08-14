import { describe, expect, it } from "vitest";
import {
  AT_RISK_BAND,
  buildChannelHealth,
  buildChannelHealthList,
  changeFrom,
  gradeMetric,
  MIN_CONVERSIONS_TO_GRADE,
  type ChannelPeriod,
} from "../src/metrics/channel-health";

const chan = (over: Partial<ChannelPeriod> = {}): ChannelPeriod => ({
  channel: "paid-meta",
  attributedRevenueCents: 100_000,
  attributedConversions: 100,
  spendCents: 25_000,
  roas: 4,
  cac: 250,
  ...over,
});

describe("changeFrom", () => {
  it("returns null when the previous value is zero", () => {
    // Going from nothing to something is a new thing, not a percentage increase. Both +∞
    // and +100% would be inventions.
    expect(changeFrom(500, 0)).toBeNull();
    expect(changeFrom(500, null)).toBeNull();
    expect(changeFrom(150, 100)).toBeCloseTo(0.5, 10);
  });

  it("uses the absolute previous value so a negative baseline doesn't flip the sign", () => {
    // CM3 can be negative. Dividing by a negative baseline would report a worsening figure
    // as an improvement.
    expect(changeFrom(-50, -100)).toBeCloseTo(0.5, 10);
  });
});

describe("gradeMetric", () => {
  it("reads CAC in the right direction", () => {
    // The rule this exists to enforce: a comparison UI that paints every rise green teaches
    // people to read CAC backwards.
    expect(gradeMetric(0.3, "lower-is-better", true)).toBe("at-risk");
    expect(gradeMetric(-0.3, "lower-is-better", true)).toBe("healthy");
    expect(gradeMetric(0.3, "higher-is-better", true)).toBe("healthy");
    expect(gradeMetric(-0.3, "higher-is-better", true)).toBe("at-risk");
  });

  it("treats small movement as flat rather than a trend", () => {
    expect(gradeMetric(0.02, "higher-is-better", true)).toBe("healthy");
    expect(gradeMetric(-0.02, "higher-is-better", true)).toBe("healthy");
  });

  it("never grades when the channel lacks volume", () => {
    expect(gradeMetric(-0.9, "higher-is-better", false)).toBe("insufficient");
  });
});

describe("buildChannelHealth", () => {
  it("refuses to grade a low-volume channel however bad it looks", () => {
    // Four conversions can swing 300% on noise. A confident red light on that is how people
    // learn to ignore red lights.
    const h = buildChannelHealth(
      chan({ attributedConversions: MIN_CONVERSIONS_TO_GRADE - 1, roas: 0.2 }),
      chan({ roas: 8 }),
    );
    expect(h.status).toBe("insufficient");
    expect(h.reason).toContain("noise");
  });

  it("flags a channel whose ROAS fell hard", () => {
    const h = buildChannelHealth(chan({ roas: 2 }), chan({ roas: 4 }));
    expect(h.status).toBe("at-risk");
    expect(h.reason).toContain("ROAS");
  });

  it("does not grade spend, because spending more is neither good nor bad", () => {
    const h = buildChannelHealth(chan({ spendCents: 90_000 }), chan({ spendCents: 10_000 }));
    const spend = h.metrics.find((m) => m.key === "spend");
    expect(spend?.status).toBe("insufficient");
    // A 9x spend increase must not by itself make the channel look at-risk.
    expect(h.status).not.toBe("at-risk");
  });

  it("treats a brand-new channel as ungradeable rather than collapsing", () => {
    const h = buildChannelHealth(chan(), null);
    expect(h.status).toBe("insufficient");
    expect(h.metrics.every((m) => m.change === null)).toBe(true);
  });

  it("takes the WORST graded metric as the channel status", () => {
    // ROAS improving must not mask CAC blowing out.
    const h = buildChannelHealth(
      chan({ roas: 5, cac: 400 }),
      chan({ roas: 4, cac: 250 }),
    );
    expect(h.status).toBe("at-risk");
    expect(h.reason).toContain("CAC");
  });
});

describe("buildChannelHealthList", () => {
  it("puts the worst channels first", () => {
    const list = buildChannelHealthList(
      [
        chan({ channel: "good", roas: 5 }),
        chan({ channel: "bad", roas: 1 }),
      ],
      [chan({ channel: "good", roas: 5 }), chan({ channel: "bad", roas: 4 })],
    );
    expect(list[0].channel).toBe("bad");
    expect(list[0].status).toBe("at-risk");
  });

  it("drops channels that no longer run rather than showing them at -100%", () => {
    // "We turned it off" and "it collapsed" are identical in the numbers, and this module
    // cannot tell them apart — so it does not guess.
    const list = buildChannelHealthList([chan({ channel: "still-on" })], [
      chan({ channel: "still-on" }),
      chan({ channel: "switched-off" }),
    ]);
    expect(list.map((c) => c.channel)).toEqual(["still-on"]);
  });

  it("uses the documented at-risk threshold", () => {
    const justUnder = buildChannelHealth(
      chan({ roas: 4 * (1 - (AT_RISK_BAND - 0.01)) }),
      chan({ roas: 4 }),
    );
    const justOver = buildChannelHealth(
      chan({ roas: 4 * (1 - (AT_RISK_BAND + 0.01)) }),
      chan({ roas: 4 }),
    );
    expect(justUnder.status).toBe("watch");
    expect(justOver.status).toBe("at-risk");
  });
});
