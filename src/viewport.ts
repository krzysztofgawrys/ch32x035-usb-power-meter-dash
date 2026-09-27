/**
 * Time viewport for the charts: what slice of history is on screen.
 *
 * Zoom is deliberately expressed as a change of the aggregation window rather
 * than a change of the uPlot scale. The charts hold no data of their own -
 * they are handed one aggregated column per pixel - so rescaling in uPlot
 * would just stretch those columns into blur. Moving the window instead makes
 * ColumnAggregator re-read at the new range, dropping to a finer tier or to
 * raw samples, so zooming in actually reveals detail.
 */

export interface Span {
  /** ms since epoch */
  readonly start: number;
  readonly end: number;
}

export interface View {
  readonly start: number;
  readonly windowMs: number;
}

/** Two samples at 4000 sps. Below this there is nothing left to reveal. */
export const MIN_WINDOW_MS = 0.5;

/** Keeps a view inside the available data, shrinking it if it is too wide. */
export function clampView(view: View, data: Span): View {
  const dataSpan = Math.max(MIN_WINDOW_MS, data.end - data.start);
  const windowMs = Math.min(Math.max(view.windowMs, MIN_WINDOW_MS), dataSpan);
  let start = view.start;
  if (start + windowMs > data.end) start = data.end - windowMs;
  if (start < data.start) start = data.start;
  return { start, windowMs };
}

/** Zoom by `factor`, keeping the time under `anchor` at the same pixel. */
export function zoomAt(view: View, anchor: number, factor: number, data: Span): View {
  const frac = view.windowMs > 0 ? (anchor - view.start) / view.windowMs : 0.5;
  const windowMs = view.windowMs * factor;
  return clampView({ start: anchor - frac * windowMs, windowMs }, data);
}

export function panBy(view: View, deltaMs: number, data: Span): View {
  return clampView({ start: view.start + deltaMs, windowMs: view.windowMs }, data);
}

/** Frames the range a drag selected, smallest useful window enforced. */
export function selectRange(a: number, b: number, data: Span): View {
  const start = Math.min(a, b);
  const windowMs = Math.abs(b - a);
  return clampView({ start, windowMs }, data);
}

/**
 * True when the view sits against the newest data. Panning to the right edge
 * resuming live follow is the behaviour people expect from a tailing view.
 */
export function atLiveEdge(view: View, data: Span): boolean {
  return view.start + view.windowMs >= data.end - Math.max(1, view.windowMs * 0.002);
}

/* ------------------------------------------------------------------ */
/* Derived figures for the view                                        */
/* ------------------------------------------------------------------ */

export interface ViewTotals {
  /** Seconds covered by the view. */
  seconds: number;
  samples: number;
  avgCurrent: number;   // A
  avgPower: number;     // W
  charge: number;       // coulombs
  energy: number;       // joules
}

/**
 * Charge and energy from the window average times its duration.
 *
 * Summing value * dt per sample would be equivalent here: sampling is uniform,
 * so dt is duration/count and the sum collapses to average * duration. It also
 * means these stay correct when the numbers come from summary buckets, where
 * individual sample spacing is no longer available.
 */
export function viewTotals(
  windowMs: number,
  samples: number,
  currentTotal: number,
  powerTotal: number,
): ViewTotals {
  const seconds = windowMs / 1000;
  const avgCurrent = samples ? currentTotal / samples : 0;
  const avgPower = samples ? powerTotal / samples : 0;
  return {
    seconds,
    samples,
    avgCurrent,
    avgPower,
    charge: avgCurrent * seconds,
    energy: avgPower * seconds,
  };
}

export const coulombsToMilliampHours = (c: number): number => c / 3.6;
export const joulesToMilliwattHours = (j: number): number => j / 3.6;

export function fmtDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} us`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  if (m < 60) return `${m}m ${rest.toFixed(0).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m - h * 60).padStart(2, "0")}m`;
}

/**
 * Axis label for a point `seconds` before the newest data, e.g. "-2m30s".
 *
 * The x axis is relative rather than wall-clock: on a 30 s window an absolute
 * clock reads ":22 :23 ... :49", which says nothing about how far back you are
 * looking. The reference is the newest sample, not the right edge of the view,
 * so panning into history reads "-5m30s ... -5m00s" instead of resetting to
 * zero at whatever is on screen.
 *
 * `incr` is the spacing between ticks, which uPlot works out and hands to the
 * formatter. Precision is taken from it rather than from the magnitude: a
 * fixed one decimal was fine at 30 s and useless zoomed in, where consecutive
 * ticks 50 ms apart all rounded to the same "-1.2s".
 */
/**
 * Decimal places needed to write `value` exactly.
 *
 * Deriving it from -log10(incr) instead is tempting and wrong: a 2.5 s tick
 * spacing gives zero, and the tick at -12.5 s then reads "-13s". Distinct from
 * its neighbours, and a lie.
 */
function decimalsOf(value: number): number {
  for (let d = 0; d <= 6; d++) {
    const scaled = value * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return d;
  }
  return 6;
}

export function fmtAxisOffset(seconds: number, incr = 0): string {
  const a = Math.abs(seconds);
  if (a < (incr > 0 ? incr / 2 : 0.0005)) return "now";

  // With a tick spacing, precision comes from it. Without one - direct calls,
  // and the tests that pin the old behaviour - fall back to the magnitude.
  if (a < 1 && (incr === 0 || incr < 1)) {
    const dec = incr > 0 ? Math.max(0, decimalsOf(incr) - 3) : a < 0.01 ? 1 : 0;
    return `-${(a * 1000).toFixed(dec)}ms`;
  }
  if (a < 60) {
    const dec = incr > 0 ? decimalsOf(incr) : a < 10 ? 1 : 0;
    return `-${a.toFixed(dec)}s`;
  }

  const m = Math.floor(a / 60);
  const rest = Math.round(a - m * 60);
  if (m < 60) return rest ? `-${m}m${String(rest).padStart(2, "0")}s` : `-${m}m`;
  const h = Math.floor(m / 60);
  return `-${h}h${String(m - h * 60).padStart(2, "0")}m`;
}
