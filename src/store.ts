/**
 * Sample storage and column aggregation.
 *
 * Samples are held in SI base units in a fixed-size ring of typed arrays, plus
 * two pre-aggregated tiers maintained on insert.
 *
 * Why tiers: scanning raw samples costs O(visible), which at a full buffer
 * measured 248 ms per redraw - past the frame budget the render loop never
 * catches up and the page locks. Two resolutions, because one cannot serve
 * both ends: a 5 ms bucket keeps a 10 s window smooth at 4000 samples/s, but
 * scanning 5 ms buckets across 15 minutes would be 180k iterations.
 *
 * Buckets carry exact min, max, sum and count, so no spike is ever lost. Only
 * horizontal position is quantised, and the tier is chosen so the quantum
 * stays below one pixel column.
 */

export type MetricKey = "v" | "i" | "p" | "s";

export interface Metric {
  readonly key: MetricKey;
  readonly title: string;
  readonly unit: string;
  readonly color: string;
}

export const METRICS: readonly Metric[] = [
  { key: "v", title: "Voltage", unit: "V", color: "#4da3ff" },
  { key: "i", title: "Current", unit: "A", color: "#e0a34d" },
  { key: "p", title: "Power", unit: "W", color: "#4ec9a0" },
  { key: "s", title: "V shunt", unit: "V", color: "#b48ead" },
];

export const PROFILER_CAP = 1_000_000;
export const RAW_SCAN_LIMIT = 20_000;

export const SUMMARY_TIERS = [
  { bucketMs: 5, cap: 65536 },     // 327 s of fine detail
  { bucketMs: 200, cap: 65536 },   // 3.6 h of coarse detail
] as const;

type Channels<T> = { readonly [K in MetricKey]: T };

function channels<T>(make: () => T): Channels<T> {
  return { v: make(), i: make(), p: make(), s: make() };
}

export class SampleStore {
  readonly cap: number;
  n = 0;                       // total ever written (logical end index)
  readonly t: Float64Array;    // ms since epoch; needs Float64
  readonly ch: Channels<Float32Array>;

  constructor(cap: number) {
    this.cap = cap;
    this.t = new Float64Array(cap);
    // Float32 for values: the device sends at most 7 significant digits, which
    // Float32 holds exactly, and halving the width is what lets a 1 M ring plus
    // two tiers fit in roughly 32 MB.
    this.ch = channels(() => new Float32Array(cap));
  }

  push(t: number, v: number, i: number, p: number, s: number): void {
    const k = this.n % this.cap;
    this.t[k] = t;
    this.ch.v[k] = v;
    this.ch.i[k] = i;
    this.ch.p[k] = p;
    this.ch.s[k] = s;
    this.n++;
  }

  clear(): void { this.n = 0; }

  get count(): number { return Math.min(this.n, this.cap); }

  /** First logical index still held in the ring. */
  get first(): number { return this.n > this.cap ? this.n - this.cap : 0; }

  time(idx: number): number { return this.t[idx % this.cap]!; }
  value(key: MetricKey, idx: number): number { return this.ch[key][idx % this.cap]!; }

  /** First logical index whose timestamp is >= tMin. Timestamps are monotonic. */
  seek(tMin: number): number {
    let lo = this.first;
    let hi = this.n;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.time(mid) < tMin) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/**
 * Fixed-resolution summary of the same stream.
 *
 * Slot `b % cap` also stores the logical bucket index it holds, so gaps in the
 * stream and ring wrap-around need no clearing pass: a reader skips a slot
 * whose stored index does not match the one it asked for.
 *
 * Sample counts are shared across metrics because every sample feeds all four.
 */
export class SummaryStore {
  readonly bucketMs: number;
  readonly cap: number;
  last = -1;
  /** Oldest bucket ever written since the last clear; -1 when empty. */
  private firstSeen = -1;
  readonly bidx: Float64Array;
  readonly cnt: Int32Array;
  readonly min: Channels<Float32Array>;
  readonly max: Channels<Float32Array>;
  readonly sum: Channels<Float32Array>;

  constructor(bucketMs: number, cap: number) {
    this.bucketMs = bucketMs;
    this.cap = cap;
    this.bidx = new Float64Array(cap).fill(-1);
    this.cnt = new Int32Array(cap);
    this.min = channels(() => new Float32Array(cap));
    this.max = channels(() => new Float32Array(cap));
    this.sum = channels(() => new Float32Array(cap));
  }

  clear(): void {
    this.bidx.fill(-1);
    this.last = -1;
    this.firstSeen = -1;
  }

  /**
   * Oldest bucket still held: whichever is newer of the first one ever written
   * and the ring's reach.
   *
   * Reporting only the ring's reach made the "all" window open 3.6 hours wide
   * from the very first sample, squeezing the whole capture into a sliver at
   * the right edge - bucket indices are absolute (time / bucketMs), so
   * `last - cap + 1` is a real timestamp far in the past, not an empty marker.
   */
  get firstBucket(): number {
    if (this.last < 0) return 0;
    return Math.max(this.firstSeen, this.last - this.cap + 1);
  }
  get span(): number {
    return this.last < 0 ? 0 : (this.last + 1 - this.firstBucket) * this.bucketMs;
  }

  push(t: number, v: number, i: number, p: number, s: number): void {
    const b = Math.floor(t / this.bucketMs);
    const k = b % this.cap;
    const { min, max, sum } = this;

    if (this.bidx[k] !== b) {
      this.bidx[k] = b;
      this.cnt[k] = 1;
      min.v[k] = max.v[k] = sum.v[k] = v;
      min.i[k] = max.i[k] = sum.i[k] = i;
      min.p[k] = max.p[k] = sum.p[k] = p;
      min.s[k] = max.s[k] = sum.s[k] = s;
    } else {
      this.cnt[k]++;
      if (v < min.v[k]!) min.v[k] = v; else if (v > max.v[k]!) max.v[k] = v;
      if (i < min.i[k]!) min.i[k] = i; else if (i > max.i[k]!) max.i[k] = i;
      if (p < min.p[k]!) min.p[k] = p; else if (p > max.p[k]!) max.p[k] = p;
      if (s < min.s[k]!) min.s[k] = s; else if (s > max.s[k]!) max.s[k] = s;
      sum.v[k]! += v;
      sum.i[k]! += i;
      sum.p[k]! += p;
      sum.s[k]! += s;
    }
    if (b > this.last) this.last = b;
    if (this.firstSeen < 0 || b < this.firstSeen) this.firstSeen = b;
  }
}

/** Per-pixel-column aggregate for one metric. */
export interface Column {
  mins: Float64Array;
  maxs: Float64Array;
  sums: Float64Array;
  cnts: Int32Array;
  dataMin: number;
  dataMax: number;
  total: number;
  count: number;
}

function newColumn(cols: number): Column {
  return {
    mins: new Float64Array(cols),
    maxs: new Float64Array(cols),
    sums: new Float64Array(cols),
    cnts: new Int32Array(cols),
    dataMin: Infinity, dataMax: -Infinity, total: 0, count: 0,
  };
}

function resetColumn(c: Column, cols: number): void {
  c.mins.fill(Infinity, 0, cols);
  c.maxs.fill(-Infinity, 0, cols);
  c.sums.fill(0, 0, cols);
  c.cnts.fill(0, 0, cols);
  c.dataMin = Infinity;
  c.dataMax = -Infinity;
  c.total = 0;
  c.count = 0;
}

function addSample(c: Column, x: number, val: number): void {
  if (val < c.mins[x]!) c.mins[x] = val;
  if (val > c.maxs[x]!) c.maxs[x] = val;
  c.sums[x]! += val;
  c.cnts[x]!++;
  if (val < c.dataMin) c.dataMin = val;
  if (val > c.dataMax) c.dataMax = val;
  c.total += val;
  c.count++;
}

function addBucket(c: Column, x: number, mn: number, mx: number, sum: number, cnt: number): void {
  if (mn < c.mins[x]!) c.mins[x] = mn;
  if (mx > c.maxs[x]!) c.maxs[x] = mx;
  c.sums[x]! += sum;
  c.cnts[x]! += cnt;
  if (mn < c.dataMin) c.dataMin = mn;
  if (mx > c.dataMax) c.dataMax = mx;
  c.total += sum;
  c.count += cnt;
}

/**
 * Fills all four metrics' columns in one pass.
 *
 * All four charts share one x axis, so doing this per chart would read the
 * data four times for no benefit.
 */
export class ColumnAggregator {
  private cols = 0;
  private data: Channels<Column> = channels(() => newColumn(1));

  /* Extent actually covered by samples in the last run. Integrals must use
     this, not the window width: a 30 s window holding 24 s of data would
     otherwise inflate charge and energy by 30/24. */
  private tFirst = Infinity;
  private tLast = -Infinity;

  get(key: MetricKey): Column { return this.data[key]; }

  /** Milliseconds between the first and last sample inside the window. */
  get coveredMs(): number {
    return this.tLast > this.tFirst ? this.tLast - this.tFirst : 0;
  }

  private ensure(cols: number): void {
    if (this.cols === cols) return;
    this.cols = cols;
    this.data = channels(() => newColumn(cols));
  }

  /**
   * Returns the bucket duration actually used, which is the horizontal
   * resolution of what ends up on screen. Zero means raw samples.
   */
  run(store: SampleStore, tiers: readonly SummaryStore[],
      tStart: number, windowMs: number, cols: number): number {
    this.ensure(cols);
    for (const m of METRICS) resetColumn(this.data[m.key], cols);

    // Covered extent comes from raw timestamps whenever the ring still holds
    // this window - exact, and independent of which tier draws the columns.
    // Bucket edges are only a fallback for windows older than the ring, where
    // they cost up to one bucket of error at each end.
    this.tFirst = Infinity;
    this.tLast = -Infinity;
    const tEnd = tStart + windowMs;
    const firstIdx = store.seek(tStart);
    const lastIdx = store.seek(tEnd) - 1;
    if (firstIdx < store.n && lastIdx >= firstIdx) {
      this.tFirst = store.time(firstIdx);
      this.tLast = store.time(lastIdx);
    }

    const msPerCol = windowMs / cols;

    // Coarsest tier whose buckets still fit inside a pixel column: anything
    // coarser looks blocky, anything finer just costs more iterations.
    let chosen: SummaryStore | null = null;
    for (const tier of tiers) {
      if (tier.bucketMs <= msPerCol) chosen = tier;
    }

    if (!chosen) {
      // Columns finer than even the finest bucket: only raw will do.
      const from = store.seek(tStart);
      if (store.n - from <= RAW_SCAN_LIMIT) {
        this.fromRaw(store, tStart, windowMs, cols, from);
        return 0;
      }
      chosen = tiers[0]!;
    }

    this.fromSummary(chosen, tStart, windowMs, cols);
    return chosen.bucketMs;
  }

  private fromRaw(store: SampleStore, tStart: number, windowMs: number,
                  cols: number, from: number): void {
    const { v: cv, i: ci, p: cp, s: cs } = this.data;
    const cap = store.cap;
    const ts = store.t;
    const sv = store.ch.v, si = store.ch.i, sp = store.ch.p, ss = store.ch.s;
    const scale = cols / windowMs;

    for (let idx = from; idx < store.n; idx++) {
      const k = idx % cap;
      let x = Math.floor((ts[k]! - tStart) * scale);
      if (x < 0) x = 0; else if (x >= cols) x = cols - 1;
      addSample(cv, x, sv[k]!);
      addSample(ci, x, si[k]!);
      addSample(cp, x, sp[k]!);
      addSample(cs, x, ss[k]!);
    }
  }

  private fromSummary(sum: SummaryStore, tStart: number, windowMs: number, cols: number): void {
    const rawKnown = this.tFirst !== Infinity;
    const { v: cv, i: ci, p: cp, s: cs } = this.data;
    const { cap, bidx, cnt, bucketMs: ms } = sum;
    const mn = sum.min, mx = sum.max, sm = sum.sum;
    const scale = cols / windowMs;
    const bEnd = Math.floor((tStart + windowMs) / ms);

    for (let b = Math.max(Math.floor(tStart / ms), sum.firstBucket); b <= bEnd; b++) {
      const k = b % cap;
      if (bidx[k] !== b) continue;           // empty slot, gap, or overwritten
      let x = Math.floor((b * ms - tStart) * scale);
      if (x < 0) x = 0; else if (x >= cols) x = cols - 1;
      const c = cnt[k]!;
      // Fallback only: the raw ring no longer reaches this window, so the
      // extent has to come from bucket edges, clipped to the window.
      if (!rawKnown) {
        if (this.tFirst === Infinity) this.tFirst = Math.max(tStart, b * ms);
        this.tLast = Math.min(tStart + windowMs, (b + 1) * ms);
      }
      addBucket(cv, x, mn.v[k]!, mx.v[k]!, sm.v[k]!, c);
      addBucket(ci, x, mn.i[k]!, mx.i[k]!, sm.i[k]!, c);
      addBucket(cp, x, mn.p[k]!, mx.p[k]!, sm.p[k]!, c);
      addBucket(cs, x, mn.s[k]!, mx.s[k]!, sm.s[k]!, c);
    }
  }
}
