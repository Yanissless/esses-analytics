import { describe, expect, it } from "vitest";
import {
  MIN_RUNS_TO_RATE,
  RELIABILITY_WINDOW,
  summariseReliability,
  type SyncRunRow,
} from "../src/lib/sync/sync-log.server";

let seq = 0;
const run = (over: Partial<SyncRunRow> = {}): SyncRunRow => {
  seq += 1;
  return {
    id: `run-${seq}`,
    source: "shopify",
    mode: "incremental",
    status: "success",
    // Ascending timestamps so "newest first" is meaningful. Fixed strings, not Date.now().
    startedAt: `2026-08-${String((seq % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    finishedAt: `2026-08-${String((seq % 28) + 1).padStart(2, "0")}T00:01:00Z`,
    durationMs: 60_000,
    rowsIn: 100,
    rowsUpserted: 100,
    error: null,
    warnings: [],
    ...over,
  };
};

const only = (rows: SyncRunRow[], source = "shopify") =>
  summariseReliability(rows).find((s) => s.source === source)!;

describe("summariseReliability", () => {
  it("counts a partial run against reliability, not as a success", () => {
    // THE case. Shopify's cursor sat frozen for two weeks because every run completed with
    // `partial` status, and everything that looked at it read "completed" as "fine". A summary
    // that repeats that reading would be worse than no summary at all.
    const s = only([
      run({ status: "partial" }),
      run({ status: "success" }),
      run({ status: "success" }),
      run({ status: "success" }),
      run({ status: "success" }),
    ]);
    expect(s.partial).toBe(1);
    expect(s.succeeded).toBe(4);
    expect(s.failureRate).toBeCloseTo(1 / 5);
  });

  it("withholds a rate below the volume floor", () => {
    // One failure out of two is not a 50% failure rate.
    const s = only([run({ status: "failed" }), run({ status: "success" })]);
    expect(s.runs).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.failureRate).toBeNull();
  });

  it("publishes a rate exactly at the floor", () => {
    const rows = Array.from({ length: MIN_RUNS_TO_RATE }, () => run({ status: "success" }));
    expect(only(rows).failureRate).toBe(0);
  });

  it("does not count an in-flight run as either outcome", () => {
    // A run in progress is not evidence. Counting it as a failure would make every dashboard
    // opened during a sync report the source as degraded.
    const rows = [
      // Explicitly the newest, so this also pins that latestStatus reports the run in flight
      // rather than the last settled one. The helper's timestamps ascend with creation order,
      // which would otherwise make this the oldest row.
      run({
        status: "running",
        startedAt: "2026-09-01T00:00:00Z",
        finishedAt: null,
        durationMs: null,
      }),
      ...Array.from({ length: 5 }, () => run({ status: "success" })),
    ];
    const s = only(rows);
    expect(s.runs).toBe(5);
    expect(s.failureRate).toBe(0);
    // ...but it is still the latest thing that happened, and the display should say so.
    expect(s.latestStatus).toBe("running");
  });

  it("windows on the most recent runs, so a fixed source stops reading as broken", () => {
    // 20 recent successes should bury an older run of failures entirely.
    const old = Array.from({ length: 30 }, (_, i) =>
      run({ status: "failed", startedAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
    );
    const recent = Array.from({ length: RELIABILITY_WINDOW }, (_, i) =>
      run({ status: "success", startedAt: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
    );
    const s = only([...old, ...recent]);
    expect(s.runs).toBe(RELIABILITY_WINDOW);
    expect(s.failed).toBe(0);
    expect(s.failureRate).toBe(0);
  });

  it("keeps sources separate", () => {
    const all = summariseReliability([
      run({ source: "meta", status: "failed" }),
      run({ source: "shopify", status: "success" }),
    ]);
    expect(all.find((s) => s.source === "meta")!.failed).toBe(1);
    expect(all.find((s) => s.source === "shopify")!.failed).toBe(0);
  });

  it("sorts the broken source first", () => {
    // A failing source buried under three healthy ones is a failing source nobody sees.
    //
    // The partial run carries a warning because that is the only way a partial exists:
    // finishSyncRun assigns the status FROM the warnings, so a partial with an empty warning
    // list is not a state the app can produce.
    const all = summariseReliability([
      run({ source: "aaa_healthy", status: "success" }),
      run({ source: "zzz_partial", status: "partial", warnings: ["something odd"] }),
      run({ source: "mmm_failed", status: "failed" }),
    ]);
    expect(all.map((s) => s.source)).toEqual(["mmm_failed", "zzz_partial", "aaa_healthy"]);
  });

  it("takes the median duration only from runs that finished", () => {
    // An unfinished run has no duration, and treating a null as zero would drag the median
    // down and hide a source that is drifting toward the platform timeout.
    const s = only([
      run({ durationMs: null, status: "running", finishedAt: null }),
      run({ durationMs: 1_000 }),
      run({ durationMs: 3_000 }),
      run({ durationMs: 2_000 }),
    ]);
    expect(s.medianMs).toBe(2_000);
  });

  it("reports no median when nothing has finished", () => {
    const s = only([run({ durationMs: null, status: "running", finishedAt: null })]);
    expect(s.medianMs).toBeNull();
    expect(s.runs).toBe(0);
  });

  it("returns nothing for no runs rather than a zero row", () => {
    // A source that has never run must not appear as "0% failure rate", which reads as healthy.
    expect(summariseReliability([])).toEqual([]);
  });
});

/**
 * The standing-vs-new split, reproducing the real Shopify data that motivated it: 20 runs, 16
 * partial, and an 85% "trouble rate" that was two known gaps repeating rather than 16 incidents.
 */
describe("standing warnings", () => {
  const SCOPE = "shipping label costs unavailable (needs read_reports scope?)";
  const UNMATCHED = "21 shipping label(s) had no matching order in range";

  /** The observed distribution: the two standing warnings alternate run to run. */
  const shopifyLike = (): SyncRunRow[] => {
    const rows: SyncRunRow[] = [];
    for (let i = 0; i < 8; i++) rows.push(run({ status: "partial", warnings: [SCOPE] }));
    for (let i = 0; i < 7; i++) rows.push(run({ status: "partial", warnings: [UNMATCHED] }));
    for (let i = 0; i < 3; i++) rows.push(run({ status: "success" }));
    rows.push(run({ status: "failed", warnings: [] }));
    return rows;
  };

  it("does not count a repeating known gap as an incident", () => {
    const s = only(shopifyLike());
    // The raw status count is still reported, unchanged and honest.
    expect(s.partial).toBe(15);
    expect(s.failureRate).toBeCloseTo(16 / 19);
    // But the number that should drive attention counts only the one real failure.
    expect(s.anomalies).toBe(1);
    expect(s.anomalyRate).toBeCloseTo(1 / 19);
    expect(s.standingWarnings).toEqual([SCOPE, UNMATCHED].sort());
  });

  it("catches an alternating pair that a threshold of two would miss", () => {
    // Two warnings taking turns look like a series of one-offs unless the threshold exceeds 2.
    const rows = [
      run({ status: "partial", warnings: [SCOPE] }),
      run({ status: "partial", warnings: [UNMATCHED] }),
      run({ status: "partial", warnings: [SCOPE] }),
      run({ status: "partial", warnings: [UNMATCHED] }),
      run({ status: "partial", warnings: [SCOPE] }),
      run({ status: "partial", warnings: [UNMATCHED] }),
    ];
    expect(only(rows).standingWarnings).toEqual([SCOPE, UNMATCHED].sort());
    expect(only(rows).anomalies).toBe(0);
  });

  it("surfaces a genuinely new warning against a noisy background", () => {
    // THE point of the split. A source that is amber every run hides the one thing that changed.
    const rows = shopifyLike();
    rows.push(
      run({
        status: "partial",
        startedAt: "2026-09-01T00:00:00Z",
        warnings: [SCOPE, "order 12345 has a negative line total"],
      }),
    );
    const s = only(rows);
    expect(s.newWarnings).toEqual(["order 12345 has a negative line total"]);
    // The known gap alongside it is not repeated as news.
    expect(s.newWarnings).not.toContain(SCOPE);
  });

  it("reports no new warnings when the latest run carries only known gaps", () => {
    const rows = shopifyLike();
    rows.push(run({ status: "partial", startedAt: "2026-09-01T00:00:00Z", warnings: [SCOPE] }));
    expect(only(rows).newWarnings).toEqual([]);
  });

  it("treats a one-off warning as an anomaly, not a standing gap", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => run({ status: "success" })),
      run({ status: "partial", startedAt: "2026-09-01T00:00:00Z", warnings: ["fetch failed"] }),
    ];
    const s = only(rows);
    expect(s.standingWarnings).toEqual([]);
    expect(s.anomalies).toBe(1);
    expect(s.newWarnings).toEqual(["fetch failed"]);
  });

  it("counts a failed run as an anomaly even with no warnings attached", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => run({ status: "success" })),
      run({ status: "failed", warnings: [], error: "connection reset" }),
    ];
    expect(only(rows).anomalies).toBe(1);
  });

  it("does not let one run repeating a warning promote it to standing", () => {
    // Counted per run, not per occurrence. Otherwise a single run emitting the same warning
    // three times would classify a brand-new problem as a known gap and hide it.
    const s = only([run({ status: "partial", warnings: ["dup", "dup", "dup"] })]);
    expect(s.standingWarnings).toEqual([]);
    expect(s.anomalies).toBe(1);
  });

  it("ranks a source with something new above one with only known gaps", () => {
    const all = summariseReliability([
      ...shopifyLike().map((r) => ({ ...r, source: "shopify" })),
      run({ source: "meta", status: "partial", warnings: ["brand new problem"] }),
    ]);
    expect(all[0].source).toBe("meta");
  });
});
