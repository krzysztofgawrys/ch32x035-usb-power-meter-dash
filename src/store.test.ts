import { describe, expect, it } from "vitest";
import {
  ColumnAggregator, SUMMARY_TIERS, SampleStore, SummaryStore,
} from "./store.js";

interface Rig {
  store: SampleStore;
  tiers: SummaryStore[];
  values: number[];
  times: number[];
}

/** Builds a stream at `sps` with periodic single-sample spikes and dips. */
function makeRig(n: number, sps: number, cap = 1_000_000): Rig {
  const store = new SampleStore(cap);
  const tiers = SUMMARY_TIERS.map((t) => new SummaryStore(t.bucketMs, t.cap));
  const values: number[] = [];
  const times: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = 1.7e12 + (k * 1000) / sps;
    const i = k % 9377 === 0 ? 2.2 : k % 6151 === 0 ? 0.0009 : 0.476 + Math.sin(k / 1500) * 0.02;
    store.push(t, 4.914, i, 4.914 * i, i * 0.01);
    for (const tier of tiers) tier.push(t, 4.914, i, 4.914 * i, i * 0.01);
    values.push(Math.fround(i));   // same rounding the Float32 buffers apply
    times.push(t);
  }
  return { store, tiers, values, times };
}

describe("SampleStore", () => {
  it("wraps without losing the newest samples", () => {
    const s = new SampleStore(8);
    for (let k = 0; k < 20; k++) s.push(k, k, k, k, k);
    expect(s.count).toBe(8);
    expect(s.first).toBe(12);
    expect(s.value("v", 19)).toBe(19);
    expect(s.time(12)).toBe(12);
  });

  it("seek finds the first index at or after a timestamp", () => {
    const s = new SampleStore(100);
    for (let k = 0; k < 50; k++) s.push(k * 10, 0, 0, 0, 0);
    expect(s.seek(-5)).toBe(0);
    expect(s.seek(0)).toBe(0);
    expect(s.seek(101)).toBe(11);
    expect(s.seek(1e9)).toBe(50);
  });
});

describe("SummaryStore", () => {
  it("keeps exact min and max inside a bucket", () => {
    const t = new SummaryStore(10, 64);
    for (const v of [5, 1, 9, 3]) t.push(100, v, v, v, v);
    const k = Math.floor(100 / 10) % 64;
    expect(t.min.v[k]).toBe(1);
    expect(t.max.v[k]).toBe(9);
    expect(t.cnt[k]).toBe(4);
  });

  it("does not report stale slots after a gap larger than the ring", () => {
    const t = new SummaryStore(10, 4);   // 4 buckets of 10 ms
    t.push(0, 1, 1, 1, 1);
    t.push(10_000, 2, 2, 2, 2);          // far future; ring wrapped many times
    // The old bucket's slot may be reused, but its stored index no longer
    // matches, which is what lets readers skip it without a clearing pass.
    expect(t.bidx[0 % 4]).not.toBe(0);
  });
});

describe("ColumnAggregator", () => {
  const cols = 700;

  it("loses no spike at 4000 samples/s on any window", () => {
    const { store, tiers, values, times } = makeRig(400_000, 4000);
    const agg = new ColumnAggregator();
    const tEnd = times[times.length - 1]!;

    for (const windowMs of [10_000, 30_000, 60_000, 300_000, 100_000]) {
      const tStart = tEnd - windowMs;
      let trueMin = Infinity;
      let trueMax = -Infinity;
      let trueCount = 0;
      for (let k = 0; k < values.length; k++) {
        if (times[k]! < tStart) continue;
        trueMin = Math.min(trueMin, values[k]!);
        trueMax = Math.max(trueMax, values[k]!);
        trueCount++;
      }

      const bucketMs = agg.run(store, tiers, tStart, windowMs, cols);
      const col = agg.get("i");

      expect(col.dataMax).toBeCloseTo(trueMax, 6);
      expect(col.dataMin).toBeCloseTo(trueMin, 6);

      // The bucket straddling each window edge is counted whole, so the count
      // may differ by up to one bucket's worth of samples per edge.
      const perBucket = Math.ceil((bucketMs / 1000) * 4000) + 1;
      expect(Math.abs(col.count - trueCount)).toBeLessThanOrEqual(2 * perBucket);
    }
  });

  it("picks the coarsest tier that still fits inside a pixel column", () => {
    const { store, tiers, times } = makeRig(100_000, 4000);
    const agg = new ColumnAggregator();
    const tEnd = times[times.length - 1]!;
    // 30 s over 700 columns is 43 ms per column: too coarse for raw, too fine
    // for the 200 ms tier.
    expect(agg.run(store, tiers, tEnd - 30_000, 30_000, cols)).toBe(5);
    // 15 min over 700 columns is 1286 ms per column.
    expect(agg.run(store, tiers, tEnd - 900_000, 900_000, cols)).toBe(200);
  });

  it("reads raw samples when columns are finer than the finest bucket", () => {
    const { store, tiers, times } = makeRig(2000, 200);   // 10 s of slow data
    const agg = new ColumnAggregator();
    const tEnd = times[times.length - 1]!;
    // 2 s over 700 columns is 2.9 ms per column, below the 5 ms bucket.
    expect(agg.run(store, tiers, tEnd - 2000, 2000, cols)).toBe(0);
  });

  it("agrees between the raw and summary paths on the same data", () => {
    const { store, tiers, times } = makeRig(30_000, 4000);
    const agg = new ColumnAggregator();
    const tEnd = times[times.length - 1]!;
    const windowMs = 2000;

    // Narrow window: raw.
    expect(agg.run(store, tiers, tEnd - windowMs, windowMs, cols)).toBe(0);
    const raw = { ...agg.get("i") };

    // Same window forced through the tier by asking for one column.
    agg.run(store, tiers, tEnd - windowMs, windowMs, 1);
    const tier = agg.get("i");

    expect(tier.dataMax).toBeCloseTo(raw.dataMax, 6);
    expect(tier.dataMin).toBeCloseTo(raw.dataMin, 6);
  });
});

describe("ColumnAggregator covered extent", () => {
  const cols = 700;

  it("measures the time samples cover, not the window width", () => {
    // 10 s of capture sitting inside a 30 s window.
    const { store, tiers, times } = makeRig(40_000, 4000);
    const agg = new ColumnAggregator();
    const tEnd = times[times.length - 1]!;

    agg.run(store, tiers, tEnd - 30_000, 30_000, cols);
    // 40000 samples at 4000/s span just under 10 s, nowhere near 30 s.
    expect(agg.coveredMs).toBeGreaterThan(9_990);
    expect(agg.coveredMs).toBeLessThan(10_010);
  });

  it("is zero for a window with no samples in it", () => {
    const { store, tiers, times } = makeRig(1000, 4000);
    const agg = new ColumnAggregator();
    agg.run(store, tiers, times[0]! - 120_000, 60_000, cols);
    expect(agg.coveredMs).toBe(0);
  });

  it("matches on both the raw and the summary path", () => {
    const { store, tiers, times } = makeRig(30_000, 4000);
    const agg = new ColumnAggregator();
    const tEnd = times[times.length - 1]!;

    agg.run(store, tiers, tEnd - 2000, 2000, cols);   // raw
    const raw = agg.coveredMs;
    agg.run(store, tiers, tEnd - 2000, 2000, 1);      // forced through a tier
    expect(agg.coveredMs).toBeCloseTo(raw, 6);
  });
});

describe("SummaryStore reach", () => {
  /**
   * Regression: bucket indices are absolute (time / bucketMs), so reporting
   * `last - cap + 1` as the oldest bucket named a real timestamp hours in the
   * past even on an empty store. The "all" window then opened 3.6 h wide from
   * the first sample and squeezed the capture into a sliver.
   */
  it("reports only the span it really holds", () => {
    const t = new SummaryStore(200, 65536);
    const t0 = 1.7e12;
    for (let k = 0; k <= 50; k++) t.push(t0 + k * 200, 1, 1, 1, 1);   // 10 s
    expect(t.span).toBeCloseTo(10_200, 0);
    expect(t.firstBucket * t.bucketMs).toBeCloseTo(t0, -3);
  });

  it("falls back to the ring's reach once it wraps", () => {
    const t = new SummaryStore(10, 4);        // 4 buckets of 10 ms
    for (let k = 0; k < 20; k++) t.push(k * 10, 1, 1, 1, 1);
    expect(t.firstBucket).toBe(16);           // last (19) - cap (4) + 1
    expect(t.span).toBe(40);
  });

  it("is empty before anything is written", () => {
    expect(new SummaryStore(200, 64).span).toBe(0);
  });

  it("forgets its reach on clear", () => {
    const t = new SummaryStore(200, 64);
    t.push(1.7e12, 1, 1, 1, 1);
    t.clear();
    expect(t.span).toBe(0);
  });
});
