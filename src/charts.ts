/**
 * Four synchronised strip charts, nRF Power Profiler style, drawn by uPlot.
 *
 * uPlot handles axes, grid, ticks and the shared cursor. It does NOT do
 * aggregation, and it starts to struggle past ~100k in-view points, so the
 * tiered column aggregator in store.ts stays: uPlot is handed exactly one
 * point per pixel column no matter how many samples the window holds.
 *
 * Each chart draws three series - max, min and mean - with a band filled
 * between max and min. The min and max strokes are translucent rather than
 * hidden so the envelope still reads if the band ever fails to paint.
 */

import uPlot from "uplot";
import type { AlignedData, Options } from "uplot";
import "uplot/dist/uPlot.min.css";

import {
  ColumnAggregator, METRICS, PROFILER_CAP, SUMMARY_TIERS, SampleStore, SummaryStore,
  type Column, type Metric,
} from "./store.js";
import { AccumulatorLog } from "./acc.js";
import { fmtAuto, fmtWith, pickPrefix } from "./format.js";
import {
  atLiveEdge, clampView, fmtAxisOffset, fmtDuration, panBy, selectRange, viewTotals, zoomAt,
  type Span, type View,
} from "./viewport.js";

const CHART_FPS = 25;          // redraw ceiling; charts are data views, not animations
const SYNC_KEY = "profiler";

const AXIS_FONT = "10px ui-monospace, Consolas, monospace";
const DIM = "#7c8598";
const GRID = "#1b1f29";
const GRID_Y = "#232734";

/** Pointer gestures a chart forwards to the panel that owns the viewport. */
export interface Gestures {
  /** Drag-selected range, in ms since epoch. */
  select(a: number, b: number): void;
  /** Wheel zoom; anchor in ms since epoch. */
  zoom(anchor: number, factor: number): void;
  /** Horizontal drag or shift-wheel, in plot pixels. */
  pan(deltaPx: number, plotWidthPx: number): void;
  /** Double click: back to following live data. */
  reset(): void;
}

class ChartView {
  readonly root: HTMLElement;
  private readonly plotHost: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly plot: uPlot;

  private xs: number[] = [];
  private mins: (number | null)[] = [];
  private maxs: (number | null)[] = [];
  private means: (number | null)[] = [];
  private lastValue = 0;
  /** Epoch ms that x = 0 corresponds to; x carries offsets, not timestamps. */
  private timeRef = 0;

  zeroBased = false;

  constructor(private readonly metric: Metric, host: HTMLElement,
              private readonly gestures: Gestures, onResize: () => void) {
    const root = document.createElement("figure");
    root.className = "chart";
    root.innerHTML =
      '<figcaption>' +
        '<span class="chart-title"></span>' +
        '<span class="chart-live">--</span>' +
        '<span class="chart-stats"></span>' +
      '</figcaption>' +
      '<div class="plot"></div>';

    const title = root.querySelector<HTMLElement>(".chart-title")!;
    title.textContent = metric.title;
    title.style.color = metric.color;

    this.root = root;
    this.liveEl = root.querySelector<HTMLElement>(".chart-live")!;
    this.statsEl = root.querySelector<HTMLElement>(".chart-stats")!;
    this.plotHost = root.querySelector<HTMLElement>(".plot")!;
    host.appendChild(root);

    this.plot = new uPlot(this.options(200, 100), [[], [], [], []] as AlignedData, this.plotHost);

    new ResizeObserver(() => {
      const w = Math.max(50, Math.floor(this.plotHost.clientWidth));
      const h = Math.max(40, Math.floor(this.plotHost.clientHeight));
      this.plot.setSize({ width: w, height: h });
      onResize();
    }).observe(this.plotHost);

    this.bindGestures();
  }

  /**
   * Time under a client X coordinate, in ms since epoch.
   *
   * The x scale holds seconds relative to the newest sample, so the reference
   * has to be added back - gestures work in absolute time.
   */
  private timeAt(clientX: number): number {
    const rect = this.plot.over.getBoundingClientRect();
    return this.plot.posToVal(clientX - rect.left, "x") * 1000 + this.timeRef;
  }

  private bindGestures(): void {
    const over = this.plot.over;

    over.addEventListener("wheel", (e) => {
      e.preventDefault();
      const step = e.deltaY > 0 ? 1 : -1;
      if (e.shiftKey) this.gestures.pan(step * over.clientWidth * 0.15, over.clientWidth);
      else this.gestures.zoom(this.timeAt(e.clientX), step > 0 ? 1.25 : 0.8);
    }, { passive: false });

    // Middle button: uPlot's own drag handler ignores anything but button 0,
    // so this cannot collide with drag-to-select.
    over.addEventListener("pointerdown", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      // Optional: throws for an unknown pointerId, and is absent in some
      // headless DOMs. Losing capture only costs us the drag past the edge.
      over.setPointerCapture?.(e.pointerId);
      let lastX = e.clientX;
      const move = (ev: PointerEvent) => {
        this.gestures.pan(lastX - ev.clientX, over.clientWidth);
        lastX = ev.clientX;
      };
      const up = () => {
        over.removeEventListener("pointermove", move);
        over.removeEventListener("pointerup", up);
        over.removeEventListener("pointercancel", up);
      };
      over.addEventListener("pointermove", move);
      over.addEventListener("pointerup", up);
      over.addEventListener("pointercancel", up);
    });

    over.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this.gestures.reset();
    });
  }

  private options(width: number, height: number): Options {
    const unit = this.metric.unit;
    return {
      width,
      height,
      legend: { show: false },
      padding: [6, 8, 0, 0],
      cursor: {
        sync: { key: SYNC_KEY },
        y: false,
        points: { show: false },
        // setScale off: uPlot draws the selection rectangle and reports it,
        // but must not rescale itself. Rescaling would stretch the aggregated
        // columns into blur; re-running the aggregation over the selected
        // range is what actually reveals detail.
        drag: { x: true, y: false, setScale: false },
      },
      scales: {
        // Not a time scale: x carries seconds relative to the newest sample,
        // so uPlot picks round offsets (-30, -25, ...) and the labels say how
        // far back you are looking rather than what the wall clock reads.
        x: { time: false },
        y: {
          range: (_u, dMin, dMax) => {
            if (this.zeroBased && dMin >= 0) return uPlot.rangeNum(0, dMax, 0.08, true);
            return uPlot.rangeNum(dMin, dMax, 0.08, true);
          },
        },
      },
      axes: [
        {
          stroke: DIM,
          font: AXIS_FONT,
          grid: { stroke: GRID, width: 1 },
          ticks: { stroke: GRID_Y },
          // uPlot hands the formatter the tick spacing it settled on; the
          // label precision follows it, so zooming in yields finer labels.
          values: (_u, splits, _axisIdx, _space, incr) =>
            splits.map((v) => fmtAxisOffset(v, incr)),
        },
        {
          stroke: DIM,
          font: AXIS_FONT,
          size: 62,
          grid: { stroke: GRID_Y, width: 1 },
          ticks: { stroke: GRID_Y },
          // One engineering prefix for the whole axis, picked from its range,
          // so tick labels do not jump between mA and A within one chart.
          values: (u, splits) => {
            const pref = pickPrefix(Math.max(Math.abs(u.scales.y!.min ?? 0),
                                             Math.abs(u.scales.y!.max ?? 0)));
            return splits.map((v) => fmtWith(v, pref, unit));
          },
        },
      ],
      series: [
        {},
        { stroke: this.metric.color + "66", width: 1, points: { show: false }, spanGaps: true },
        { stroke: this.metric.color + "66", width: 1, points: { show: false }, spanGaps: true },
        { stroke: this.metric.color, width: 1.25, points: { show: false }, spanGaps: true },
      ],
      bands: [{ series: [1, 2], fill: this.metric.color + "33" }],
      hooks: {
        setCursor: [(u) => this.showCursor(u.cursor.idx ?? null)],
        // Fires once on mouse-up, after the drag completes.
        setSelect: [(u) => {
          if (u.select.width < 3) return;
          const a = u.posToVal(u.select.left, "x") * 1000 + this.timeRef;
          const b = u.posToVal(u.select.left + u.select.width, "x") * 1000 + this.timeRef;
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          this.gestures.select(a, b);
        }],
      },
    };
  }

  /** Plot area width in CSS pixels; the aggregator fills one column per pixel. */
  plotWidth(): number {
    const w = this.plot.bbox.width / (window.devicePixelRatio || 1);
    return w > 1 ? w : Math.max(1, this.plotHost.clientWidth - 70);
  }

  setData(xs: number[], col: Column, cols: number, refMs: number): void {
    this.timeRef = refMs;
    if (this.mins.length !== cols) {
      this.mins = new Array<number | null>(cols);
      this.maxs = new Array<number | null>(cols);
      this.means = new Array<number | null>(cols);
    }
    for (let x = 0; x < cols; x++) {
      if (col.cnts[x]) {
        this.mins[x] = col.mins[x]!;
        this.maxs[x] = col.maxs[x]!;
        this.means[x] = col.sums[x]! / col.cnts[x]!;
      } else {
        this.mins[x] = null;
        this.maxs[x] = null;
        this.means[x] = null;
      }
    }
    this.xs = xs;
    this.plot.setData([xs, this.maxs, this.mins, this.means] as unknown as AlignedData);

    if (col.count) {
      const pref = pickPrefix(Math.max(Math.abs(col.dataMin), Math.abs(col.dataMax)));
      this.statsEl.textContent =
        `min ${fmtWith(col.dataMin, pref, this.metric.unit)}   ` +
        `avg ${fmtWith(col.total / col.count, pref, this.metric.unit)}   ` +
        `max ${fmtWith(col.dataMax, pref, this.metric.unit)}`;
    } else {
      this.statsEl.textContent = "";
    }
    this.showCursor(this.plot.cursor.idx ?? null);
  }

  setLatest(value: number): void {
    this.lastValue = value;
  }

  /**
   * Reads the hovered value from the columns that were actually drawn rather
   * than from the raw ring. At high sample rates the ring covers far less time
   * than the summary tiers, so a raw lookup on a wide window would clamp to the
   * oldest sample and report a value from minutes ago.
   */
  private showCursor(idx: number | null): void {
    const hovered = idx != null ? this.means[idx] : null;
    if (hovered != null) {
      this.liveEl.textContent = fmtAuto(hovered, this.metric.unit);
      this.liveEl.classList.add("hovering");
    } else {
      this.liveEl.textContent = this.xs.length ? fmtAuto(this.lastValue, this.metric.unit) : "--";
      this.liveEl.classList.remove("hovering");
    }
  }

  setZeroBased(on: boolean): void {
    this.zeroBased = on;
  }

  redraw(): void {
    this.plot.redraw(false, true);
  }
}

/**
 * Formats a value, or "< step" when the device reported no change at all and
 * we know its resolution - the honest reading of a window too short to move
 * the last printed digit.
 */
function fmtBelow(value: number, step: number, unit: string): string {
  if (step > 0) return `< ${fmtAuto(step, unit)}`;
  // Before any step has been observed a plain zero beats "0.000 Ah", which
  // reads as whole amp-hours.
  if (value === 0) return "0";
  return fmtAuto(value, unit);
}

export interface ChartPanelElements {
  host: HTMLElement;
  windowSelect: HTMLSelectElement;
  zeroCheck: HTMLInputElement;
  countEl: HTMLElement;
  liveBtn: HTMLButtonElement;
  /** Figures for whatever range is currently on screen. */
  viewSpan: HTMLElement;
  viewCovered: HTMLElement;
  viewSamples: HTMLElement;
  viewAvgCurrent: HTMLElement;
  viewCharge: HTMLElement;
  viewAvgPower: HTMLElement;
  /** Charge and energy come from the device's accumulators, not from us. */
  viewEnergy: HTMLElement;
  /** Absolute accumulator totals, exactly as the `acc` command reports them. */
  viewTotalCharge: HTMLElement;
  viewTotalEnergy: HTMLElement;
  accBackwards: HTMLElement;
  accBackwardsN: HTMLElement;
}

export class ChartPanel {
  private readonly store = new SampleStore(PROFILER_CAP);
  private readonly tiers: SummaryStore[];
  private readonly coarse: SummaryStore;
  private readonly agg = new ColumnAggregator();
  private readonly acc = new AccumulatorLog();
  private readonly views: ChartView[] = [];

  private paused = false;
  private dirty = false;
  private frame = 0;
  private lastDraw = 0;
  private xs: number[] = [];
  /** Anchor for the empty chart, so its axis does not crawl with the clock. */
  private emptyAnchor = Date.now();
  /** Geometry of the last drawn frame; identical means nothing to redraw. */
  private lastFrame = "";
  /**
   * Whether everything currently held has been exported. Only a whole-buffer
   * export counts, and only until the next sample lands - a capture that
   * continued after a save is not saved. Starting a new capture discards the
   * buffer, which is what makes this worth tracking.
   */
  private saved = true;

  /* Viewport. When `follow` is set the window is pinned to the newest sample
     and only its width matters; otherwise `view` is used verbatim. */
  private follow = true;
  private view: View = { start: 0, windowMs: 30_000 };
  private followAll = false;    // the "all" preset tracks the growing history
  /* Which preset the user asked for, or null once a gesture has left them all.
     The control follows this rather than the resulting window: with less data
     than the preset, clampView narrows the window, the value stops matching an
     option, and the list jumped to "custom" the instant a preset was picked. */
  private preset: string | null = null;

  constructor(private readonly el: ChartPanelElements) {
    this.tiers = SUMMARY_TIERS.map((t) => new SummaryStore(t.bucketMs, t.cap));
    this.coarse = this.tiers[this.tiers.length - 1]!;

    // Every gesture coordinate comes from uPlot's posToVal, which yields NaN if
    // the plot has no usable geometry yet. A NaN anchor propagates straight
    // through clampView and leaves the viewport permanently NaN, with no way
    // back short of a reload - so non-finite input is dropped at the door.
    const gestures: Gestures = {
      select: (a, b) => {
        if (!Number.isFinite(a) || !Number.isFinite(b)) return;
        this.applyView(selectRange(a, b, this.dataSpan()));
      },
      zoom: (anchor, factor) => {
        if (!Number.isFinite(anchor) || !Number.isFinite(factor)) return;
        const span = this.dataSpan();
        this.applyView(zoomAt(this.effectiveView(span), anchor, factor, span));
      },
      pan: (deltaPx, widthPx) => {
        if (!Number.isFinite(deltaPx) || !Number.isFinite(widthPx)) return;
        const span = this.dataSpan();
        const cur = this.effectiveView(span);
        const deltaMs = (deltaPx / Math.max(1, widthPx)) * cur.windowMs;
        this.applyView(panBy(cur, deltaMs, span), true);
      },
      reset: () => this.goLive(),
    };

    for (const metric of METRICS) {
      this.views.push(new ChartView(metric, el.host, gestures, () => this.schedule()));
    }

    this.preset = el.windowSelect.value || null;

    el.windowSelect.addEventListener("change", () => {
      // "custom" is written by the app, never chosen meaningfully by the user.
      if (el.windowSelect.value === "custom") return;
      this.preset = el.windowSelect.value;
      this.followAll = el.windowSelect.value === "0";
      if (!this.followAll) this.view = { ...this.view, windowMs: Number(el.windowSelect.value) };
      this.goLive();
    });
    el.liveBtn.addEventListener("click", () => this.goLive());
    el.zeroCheck.addEventListener("change", () => {
      for (const v of this.views) v.setZeroBased(el.zeroCheck.checked);
      this.schedule();
    });
    this.schedule();
  }

  add(t: number, v: number, i: number, p: number, s: number): void {
    this.store.push(t, v, i, p, s);
    for (const tier of this.tiers) tier.push(t, v, i, p, s);
    this.saved = false;
    if (!this.paused) this.schedule();
  }

  setPaused(on: boolean): void {
    this.paused = on;
    if (!on) this.schedule();
  }

  /** A reading of the device's own INA228 accumulators, in SI base units. */
  addAcc(t: number, charge: number, energy: number): void {
    this.acc.push(t, charge, energy);
    this.schedule();
  }

  clear(): void {
    this.store.clear();
    for (const tier of this.tiers) tier.clear();
    this.acc.clear();
    this.emptyAnchor = Date.now();
    this.lastFrame = "";
    this.saved = true;
    this.schedule();
  }

  get count(): number { return this.store.count; }

  markSaved(): void { this.saved = true; }

  /** Samples are held that have not been exported. See `saved`. */
  get unsaved(): boolean { return !this.saved && this.store.count > 0; }

  /** The range currently drawn, in ms since epoch. */
  get viewRange(): { start: number; windowMs: number } {
    return this.effectiveView(this.dataSpan());
  }

  /** Range the data actually covers: the coarse tier outlives the raw ring. */
  private dataSpan(): Span {
    // Samples alone define the timeline. Accumulator readings arrive on the
    // wall clock and letting them extend the end made the charts scroll and
    // `history` grow while the measurement was stopped - motion with nothing
    // behind it. Everything freezes together when the stream stops instead.
    //
    // The charge delta keeps working across a stop because the readings taken
    // while the stream was running are still inside the frozen window. What
    // originally broke it was acc readings carrying the PREVIOUS chunk's
    // timestamp, which is fixed in parse.ts, not the reach of the window.
    if (!this.store.count) {
      // Full preset width, not a token second: clampView shrinks the window to
      // whatever this span reports, so a 1 s stand-in collapsed the empty
      // chart's axis to one second of sub-second tick labels.
      //
      // Frozen at load rather than Date.now(), because the acc poller triggers
      // a redraw every second and a live clock here makes the axis of an empty
      // chart crawl on its own.
      const width = this.followAll ? 30_000 : Math.max(1000, this.view.windowMs);
      return { start: this.emptyAnchor - width, end: this.emptyAnchor };
    }
    const end = this.store.time(this.store.n - 1);
    const rawStart = this.store.time(this.store.first);
    const tierStart = this.coarse.last >= 0
      ? this.coarse.firstBucket * this.coarse.bucketMs
      : rawStart;
    return { start: Math.min(rawStart, tierStart), end };
  }

  /**
   * The window that will actually be drawn, following or not, already clamped
   * to the data.
   *
   * Clamping here rather than only in render() matters for gestures: with a
   * 30 s preset over 10 s of capture the nominal window is 30 s but the drawn
   * one is 10 s, and zooming from the nominal value landed straight back on
   * the clamp - the wheel did nothing until the nominal window fell below the
   * data span.
   */
  private effectiveView(span: Span): View {
    if (!this.follow) return clampView(this.view, span);
    const windowMs = this.followAll
      ? Math.max(1000, span.end - span.start)
      : this.view.windowMs;
    return clampView({ start: span.end - windowMs, windowMs }, span);
  }

  /**
   * Adopts a view produced by a gesture. Landing against the newest data
   * resumes live follow at the current zoom, which is what a tailing view is
   * expected to do - but only for pans, since a zoom that happens to end at
   * the edge should still let you inspect a frozen slice.
   */
  private applyView(next: View, resumeAtEdge = false): void {
    const span = this.dataSpan();
    const v = clampView(next, span);
    this.followAll = false;
    this.preset = null;
    if (resumeAtEdge && atLiveEdge(v, span)) {
      this.follow = true;
      this.view = v;
    } else {
      this.follow = false;
      this.view = v;
    }
    this.schedule();
  }

  private goLive(): void {
    this.follow = true;
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.frame) return;
    this.frame = requestAnimationFrame((now) => this.tick(now));
  }

  private tick(now: number): void {
    this.frame = 0;
    if (!this.dirty) return;
    if (now - this.lastDraw < 1000 / CHART_FPS) {
      this.frame = requestAnimationFrame((n) => this.tick(n));
      return;
    }
    if (!this.el.host.clientHeight) return;   // not laid out; ResizeObserver will re-arm
    this.lastDraw = now;
    this.dirty = false;
    this.render();
  }

  private render(): void {
    const span = this.dataSpan();
    const view = this.effectiveView(span);
    if (!this.follow) this.view = view;
    const { start: tStart, windowMs } = view;

    const cols = Math.max(1, Math.floor(this.views[0]!.plotWidth()));

    // Nothing that can change the picture has changed, so leave it alone.
    // Accumulator polling redraws once a second; without this guard any path
    // that lets the clock into the geometry turns that into visible motion on
    // a chart with no new data behind it.
    const frame = `${tStart}|${windowMs}|${cols}|${this.store.n}|${this.el.zeroCheck.checked}`;
    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      this.agg.run(this.store, this.tiers, tStart, windowMs, cols);

      if (this.xs.length !== cols) this.xs = new Array<number>(cols);
      // Seconds relative to the newest sample, so the axis reads "-30s ... now"
      // and keeps reading correctly when panned back into history.
      const step = windowMs / cols;
      for (let x = 0; x < cols; x++) {
        this.xs[x] = (tStart + (x + 0.5) * step - span.end) / 1000;
      }

      const last = this.store.n - 1;
      for (let k = 0; k < this.views.length; k++) {
        const metric = METRICS[k]!;
        if (this.store.count) this.views[k]!.setLatest(this.store.value(metric.key, last));
        this.views[k]!.setData(this.xs, this.agg.get(metric.key), cols, span.end);
      }
    }

    this.el.countEl.textContent = this.store.count.toLocaleString("en-US");
    this.syncWindowSelect();
    this.updateViewStats(tStart, windowMs);
  }

  /**
   * Keeps the window control honest.
   *
   * Any gesture clears `followAll`, but the control went on reading "all" -
   * so a stray wheel over a chart silently turned "all" into a fixed window
   * that scrolled, with nothing on screen saying so. Panning to the live edge
   * makes it worse: follow stays on, so the Live button does not appear
   * either. The only cure was toggling the preset off and back.
   */
  private syncWindowSelect(): void {
    const want = this.preset ?? "custom";
    if (this.el.windowSelect.value !== want) this.el.windowSelect.value = want;
  }


  private updateViewStats(tStart: number, windowMs: number): void {
    const current = this.agg.get("i");
    const power = this.agg.get("p");
    // Integrate over the time samples actually cover, not the width of the
    // window. A 30 s window holding 24 s of capture would otherwise report
    // charge and energy 25% too high - both by the same factor, since only
    // the duration is wrong.
    const t = viewTotals(this.agg.coveredMs, current.count, current.total, power.total);

    this.el.viewSpan.textContent = fmtDuration(windowMs);
    // Total capture held, not coverage inside the window - the window caps the
    // latter, so it could never exceed the preset and told nobody anything.
    const span = this.dataSpan();
    const history = this.store.count ? span.end - span.start : 0;
    this.el.viewCovered.textContent = history > 0 ? fmtDuration(history) : "--";
    this.el.viewSamples.textContent = t.samples.toLocaleString("en-US");
    this.el.viewAvgCurrent.textContent = t.samples ? fmtAuto(t.avgCurrent, "A") : "--";
    this.el.viewAvgPower.textContent = t.samples ? fmtAuto(t.avgPower, "W") : "--";

    // Charge and energy come only from the hardware accumulators. The app's
    // own integral was a sum over transmitted samples and could never match
    // the INA228, which integrates every ADC conversion internally - showing
    // both invited the question of which one to believe.
    const hw = this.acc.deltaOver(tStart, tStart + windowMs);
    const res = this.acc.resolution;
    // Engineering prefixes: sleep-current profiling lands in uAh and nAh, where
    // a fixed "mAh" reads as 0.000 and looks broken.
    this.el.viewCharge.textContent = hw
      ? fmtBelow(hw.charge / 3600, res && hw.charge === 0 ? res.charge / 3600 : 0, "Ah")
      : "--";
    this.el.viewEnergy.textContent = hw
      ? fmtBelow(hw.energy / 3600, res && hw.energy === 0 ? res.energy / 3600 : 0, "Wh")
      : "--";

    // The running totals, printed as `acc` prints them. `charge` above is the
    // change across the VISIBLE RANGE - over a 30 s window it looks nothing
    // like a ten-minute total, and without the total beside it there is no way
    // to tell a correct delta from a broken one. It also ticks once a second,
    // so it doubles as proof that polling is alive.
    const total = this.acc.latest();
    this.el.viewTotalCharge.textContent = total ? `of ${fmtAuto(total.charge / 3600, "Ah")}` : "";
    this.el.viewTotalEnergy.textContent = total ? `of ${fmtAuto(total.energy / 3600, "Wh")}` : "";

    this.el.accBackwards.classList.toggle("hidden", this.acc.backwards === 0);
    this.el.accBackwardsN.textContent = String(this.acc.backwards);

    // The running totals, printed exactly as `acc` reports them. Without this
    // the windowed delta is unverifiable: it looks nothing like the number the
    // device prints, and there is no way to tell a correct delta from a bug.

    this.el.liveBtn.classList.toggle("hidden", this.follow);
  }


  /**
   * Built as Blob parts rather than one joined string: a full buffer is a
   * million rows, and materialising that as a single JavaScript string before
   * handing it to Blob would spike memory for no reason.
   */
  toCSVBlob(): Blob {
    const parts: string[] = ["timestamp_iso,t_ms,voltage_V,current_A,power_W,vshunt_V\r\n"];
    const t0 = this.store.count ? this.store.time(this.store.first) : 0;
    let rows: string[] = [];
    for (let idx = this.store.first; idx < this.store.n; idx++) {
      const t = this.store.time(idx);
      rows.push(
        new Date(t).toISOString() + "," +
        // Three decimals, so the column resolves microseconds. One decimal
        // rounded the device's stamps to 0.1 ms and turned a real 250 us
        // cadence into an alternation of 200 and 300 - an artefact of the
        // export that looked like a property of the hardware.
        (t - t0).toFixed(3) + "," +
        this.store.value("v", idx).toPrecision(7) + "," +
        this.store.value("i", idx).toPrecision(7) + "," +
        this.store.value("p", idx).toPrecision(7) + "," +
        this.store.value("s", idx).toPrecision(7));
      if (rows.length === 20000) {
        parts.push(rows.join("\r\n") + "\r\n");
        rows = [];
      }
    }
    if (rows.length) parts.push(rows.join("\r\n") + "\r\n");
    return new Blob(parts, { type: "text/csv;charset=utf-8" });
  }
}
