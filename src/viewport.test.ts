import { describe, expect, it } from "vitest";
import {
  MIN_WINDOW_MS, atLiveEdge, clampView, coulombsToMilliampHours, fmtAxisOffset, fmtDuration,
  joulesToMilliwattHours, panBy, selectRange, viewTotals, zoomAt,
} from "./viewport.js";

const data = { start: 1000, end: 101_000 };   // 100 s of history

describe("clampView", () => {
  it("leaves a view that already fits alone", () => {
    expect(clampView({ start: 5000, windowMs: 10_000 }, data))
      .toEqual({ start: 5000, windowMs: 10_000 });
  });

  it("pulls a view back inside the right edge", () => {
    expect(clampView({ start: 99_000, windowMs: 10_000 }, data))
      .toEqual({ start: 91_000, windowMs: 10_000 });
  });

  it("pulls a view back inside the left edge", () => {
    expect(clampView({ start: -50_000, windowMs: 10_000 }, data))
      .toEqual({ start: 1000, windowMs: 10_000 });
  });

  it("shrinks a window wider than the data", () => {
    const v = clampView({ start: 0, windowMs: 999_999 }, data);
    expect(v.windowMs).toBe(100_000);
    expect(v.start).toBe(1000);
  });

  it("never goes below the minimum window", () => {
    expect(clampView({ start: 5000, windowMs: 0 }, data).windowMs).toBe(MIN_WINDOW_MS);
  });
});

describe("zoomAt", () => {
  it("keeps the anchor at the same fraction of the window", () => {
    const before = { start: 10_000, windowMs: 10_000 };
    const anchor = 12_500;                       // 25% into the window
    const after = zoomAt(before, anchor, 0.5, data);
    expect(after.windowMs).toBe(5000);
    expect((anchor - after.start) / after.windowMs).toBeCloseTo(0.25, 9);
  });

  it("zooming out stops at the data span", () => {
    const after = zoomAt({ start: 50_000, windowMs: 10_000 }, 55_000, 100, data);
    expect(after.windowMs).toBe(100_000);
    expect(after.start).toBe(1000);
  });

  it("zooming in far still yields a usable window", () => {
    const after = zoomAt({ start: 50_000, windowMs: 10_000 }, 55_000, 1e-9, data);
    expect(after.windowMs).toBeGreaterThanOrEqual(MIN_WINDOW_MS);
    expect(after.start).toBeGreaterThanOrEqual(data.start);
  });

  it("survives repeated zoom in and out without drifting outside the data", () => {
    let v = { start: 40_000, windowMs: 20_000 };
    for (let k = 0; k < 40; k++) v = zoomAt(v, v.start + v.windowMs / 2, k % 2 ? 1.3 : 0.7, data);
    expect(v.start).toBeGreaterThanOrEqual(data.start);
    expect(v.start + v.windowMs).toBeLessThanOrEqual(data.end + 1e-6);
  });
});

describe("panBy", () => {
  it("moves the window and keeps its width", () => {
    const after = panBy({ start: 10_000, windowMs: 5000 }, 2000, data);
    expect(after).toEqual({ start: 12_000, windowMs: 5000 });
  });

  it("stops at the edges instead of running off", () => {
    expect(panBy({ start: 10_000, windowMs: 5000 }, -1e9, data).start).toBe(data.start);
    expect(panBy({ start: 10_000, windowMs: 5000 }, 1e9, data).start).toBe(data.end - 5000);
  });
});

describe("selectRange", () => {
  it("frames the dragged range regardless of drag direction", () => {
    expect(selectRange(30_000, 20_000, data)).toEqual({ start: 20_000, windowMs: 10_000 });
    expect(selectRange(20_000, 30_000, data)).toEqual({ start: 20_000, windowMs: 10_000 });
  });
});

describe("atLiveEdge", () => {
  it("is true at the right edge and false in history", () => {
    expect(atLiveEdge({ start: 91_000, windowMs: 10_000 }, data)).toBe(true);
    expect(atLiveEdge({ start: 20_000, windowMs: 10_000 }, data)).toBe(false);
  });
});

describe("viewTotals", () => {
  it("computes charge and energy from the window average", () => {
    // 1 A and 5 W held for exactly one hour.
    const t = viewTotals(3_600_000, 1000, 1000 * 1, 1000 * 5);
    expect(t.avgCurrent).toBeCloseTo(1, 9);
    expect(t.avgPower).toBeCloseTo(5, 9);
    expect(coulombsToMilliampHours(t.charge)).toBeCloseTo(1000, 6);
    expect(joulesToMilliwattHours(t.energy)).toBeCloseTo(5000, 6);
  });

  it("is safe on an empty window", () => {
    const t = viewTotals(1000, 0, 0, 0);
    expect(t.avgCurrent).toBe(0);
    expect(t.charge).toBe(0);
  });

  it("matches a per-sample summation on uniform sampling", () => {
    // 4000 samples/s for 2 s, current ramping 0..1 A.
    const n = 8000;
    const windowMs = 2000;
    const dt = windowMs / 1000 / n;
    let sum = 0;
    let bySample = 0;
    for (let k = 0; k < n; k++) {
      const i = k / n;
      sum += i;
      bySample += i * dt;
    }
    const t = viewTotals(windowMs, n, sum, 0);
    expect(t.charge).toBeCloseTo(bySample, 9);
  });
});

describe("fmtDuration", () => {
  it.each([
    [0.4, "400 us"],
    [5, "5.00 ms"],
    [250, "250 ms"],
    [2500, "2.50 s"],
    [45_000, "45.0 s"],
    [90_000, "1m 30s"],
    [3_900_000, "1h 05m"],
  ])("%i ms -> %s", (ms, want) => {
    expect(fmtDuration(ms as number)).toBe(want);
  });
});

describe("fmtAxisOffset", () => {
  it.each([
    [0, "now"],
    [-0.0002, "now"],
    [-0.25, "-250ms"],
    [-0.005, "-5.0ms"],
    [-5, "-5.0s"],
    [-30, "-30s"],
    [-90, "-1m30s"],
    [-120, "-2m"],
    [-300, "-5m"],
    [-3900, "-1h05m"],
  ])("%s s -> %s", (sec, want) => {
    expect(fmtAxisOffset(sec as number)).toBe(want);
  });

  it("reads the same for a positive argument, so sign handling cannot flip a label", () => {
    expect(fmtAxisOffset(30)).toBe(fmtAxisOffset(-30));
  });
});

describe("fmtAxisOffset precision follows the tick spacing", () => {
  /**
   * Regression: precision was fixed, so zoomed in every tick rounded to the
   * same label - a 2 s window with 50 ms ticks read "-1.2s" three times over.
   */
  it.each([
    [-1.25, 0.05, "-1.25s"],
    [-1.2, 0.05, "-1.20s"],
    [-0.125, 0.025, "-125ms"],
    [-0.0018, 0.0002, "-1.8ms"],
    [-12.5, 2.5, "-12.5s"],
    [-30, 5, "-30s"],
  ])("%s s at %s s ticks -> %s", (sec, incr, want) => {
    expect(fmtAxisOffset(sec as number, incr as number)).toBe(want);
  });

  it("gives adjacent ticks distinct labels at any zoom", () => {
    for (const incr of [0.0001, 0.001, 0.02, 0.05, 0.25, 1, 5]) {
      const labels = [0, 1, 2, 3].map((k) => fmtAxisOffset(-(k + 1) * incr, incr));
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("still calls the origin now", () => {
    expect(fmtAxisOffset(0, 0.05)).toBe("now");
    expect(fmtAxisOffset(-0.0001, 0.05)).toBe("now");
  });

  it("keeps the old behaviour when no spacing is supplied", () => {
    expect(fmtAxisOffset(-30)).toBe("-30s");
    expect(fmtAxisOffset(-90)).toBe("-1m30s");
  });
});
