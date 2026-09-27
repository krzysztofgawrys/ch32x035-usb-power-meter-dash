/**
 * @vitest-environment happy-dom
 *
 * Smoke test for the uPlot wiring. It cannot judge how the chart looks - there
 * is no browser here - but it does run the real construction, aggregation and
 * setData path, which is where a wrong option shape, a band pointing at a
 * series that does not exist, or a data/series length mismatch would throw.
 *
 * What it cannot cover: anything resolved from pointer coordinates. uPlot's x
 * scale never initialises against a stubbed canvas - min and max stay null -
 * so posToVal has nothing to work from and gestures cannot be aimed. Tests
 * that pretended otherwise passed for the wrong reason, on a NaN that happened
 * to change a label. The viewport maths is covered exhaustively in
 * viewport.test.ts instead, and the DOM path is held to one thing that is
 * genuinely checkable: an unresolvable gesture must not corrupt the view.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ChartPanel } from "./charts.js";

/** A 2D context that accepts every call and returns something harmless. */
function stubContext(): CanvasRenderingContext2D {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop) {
      if (prop === "canvas") return target["canvas"];
      if (prop === "measureText") return () => ({ width: 10 });
      if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === "createLinearGradient") return () => ({ addColorStop() {} });
      if (prop in target) return target[prop as string];
      return () => undefined;
    },
    set(target, prop, value) { target[prop as string] = value; return true; },
  };
  return new Proxy({} as Record<string, unknown>, handler) as unknown as CanvasRenderingContext2D;
}

function sized(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
  el.getBoundingClientRect = () =>
    ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
}

function build() {
  document.body.innerHTML = `
    <div id="host"></div>
    <select id="win"><option value="30000" selected>30 s</option><option value="0">all</option><option value="custom">custom</option></select>
    <input id="zero" type="checkbox">
    <span id="count"></span>
    <button id="live"></button>
    <span id="vspan"></span><span id="vcov"></span><span id="vsamples"></span><span id="vi"></span>
    <span id="vq"></span><span id="vp"></span><span id="ve"></span>
    <i id="vtq"></i><i id="vte"></i><span id="ab"></span><b id="abn"></b>
    `;

  const host = document.getElementById("host") as HTMLElement;
  sized(host, 900, 600);

  const panel = new ChartPanel({
    host,
    windowSelect: document.getElementById("win") as HTMLSelectElement,
    zeroCheck: document.getElementById("zero") as HTMLInputElement,
    countEl: document.getElementById("count") as HTMLElement,
    liveBtn: document.getElementById("live") as HTMLButtonElement,
    viewSpan: document.getElementById("vspan") as HTMLElement,
    viewCovered: document.getElementById("vcov") as HTMLElement,
    viewSamples: document.getElementById("vsamples") as HTMLElement,
    viewAvgCurrent: document.getElementById("vi") as HTMLElement,
    viewCharge: document.getElementById("vq") as HTMLElement,
    viewAvgPower: document.getElementById("vp") as HTMLElement,
    viewEnergy: document.getElementById("ve") as HTMLElement,
    viewTotalCharge: document.getElementById("vtq") as HTMLElement,
    viewTotalEnergy: document.getElementById("vte") as HTMLElement,
    accBackwards: document.getElementById("ab") as HTMLElement,
    accBackwardsN: document.getElementById("abn") as HTMLElement,
  });

  // uPlot measures its plot boxes; give every one a size.
  for (const plot of document.querySelectorAll<HTMLElement>(".plot")) sized(plot, 900, 140);
  // The overlay is what pointer gestures are measured against.
  for (const over of document.querySelectorAll<HTMLElement>(".u-over")) sized(over, 800, 120);
  return { panel, host };
}

/** Runs the panel's animation-frame driven render to completion. */
async function settle(): Promise<void> {
  for (let k = 0; k < 6; k++) await new Promise((r) => setTimeout(r, 20));
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = stubContext as unknown as
    HTMLCanvasElement["getContext"];
  // uPlot builds its strokes as Path2D, which happy-dom does not implement.
  globalThis.Path2D ??= class {
    moveTo() {} lineTo() {} closePath() {} rect() {} arc() {}
    bezierCurveTo() {} quadraticCurveTo() {} addPath() {}
  } as unknown as typeof Path2D;
  globalThis.ResizeObserver ??= class {
    observe() {} unobserve() {} disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 8) as unknown as number) as typeof requestAnimationFrame;
});

describe("ChartPanel", () => {
  it("builds one chart per metric with a caption and a plot", () => {
    const { host } = build();
    expect(host.querySelectorAll("figure.chart")).toHaveLength(4);
    expect(host.querySelectorAll(".chart-title")).toHaveLength(4);
    expect(host.querySelectorAll(".plot canvas").length).toBeGreaterThanOrEqual(4);
    expect([...host.querySelectorAll(".chart-title")].map((e) => e.textContent))
      .toEqual(["Voltage", "Current", "Power", "V shunt"]);
  });

  it("ingests samples and renders without throwing", async () => {
    const { panel } = build();
    const t0 = Date.now();
    for (let k = 0; k < 20_000; k++) {
      const t = t0 + k / 4;                       // 4000 samples/s
      const i = k % 997 === 0 ? 2.2 : 0.476;
      panel.add(t, 4.914, i, 4.914 * i, i * 0.01);
    }
    await settle();
    expect(panel.count).toBe(20_000);
    expect(document.getElementById("count")!.textContent).toBe("20,000");
  });

  it("updates the per-window statistics from the drawn columns", async () => {
    const { panel, host } = build();
    const t0 = Date.now();
    for (let k = 0; k < 5000; k++) {
      const t = t0 + k / 4;
      const i = k === 2500 ? 2.2 : 0.476;         // one spike, mid window
      panel.add(t, 4.914, i, 4.914 * i, i * 0.01);
    }
    await settle();
    const current = host.querySelectorAll(".chart-stats")[1]!.textContent ?? "";
    expect(current).toContain("min");
    expect(current).toContain("max");
    // 2.2 A must survive aggregation and reach the caption.
    expect(current).toMatch(/max\s+2\.2\d*\s*A/);
  });

  it("exports CSV with a header and one row per sample", async () => {
    const { panel } = build();
    const t0 = Date.now();
    for (let k = 0; k < 50; k++) panel.add(t0 + k, 4.9, 0.476, 2.33, 0.0047);
    const text = await panel.toCSVBlob().text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe("timestamp_iso,t_ms,voltage_V,current_A,power_W,vshunt_V");
    expect(lines).toHaveLength(51);
    expect(lines[1]!.split(",")).toHaveLength(6);
  });


  /**
   * The x scale carries offsets from the newest sample rather than timestamps,
   * so every gesture must add the reference back. Whether it lands on the
   * right pixel cannot be checked here - uPlot's posToVal needs real canvas
   * geometry and returns NaN against the stub - but that is itself worth
   * pinning down: a NaN anchor used to propagate through clampView and leave
   * the viewport permanently NaN, unrecoverable without a reload.
   */
  it("survives a gesture whose coordinates cannot be resolved", async () => {
    const { panel } = build();
    const t0 = Date.now() - 120_000;
    for (let k = 0; k < 12_000; k++) panel.add(t0 + k * 10, 4.9, 1, 4.9, 0.01);
    await settle();

    const over = document.querySelector(".u-over") as HTMLElement;
    for (let k = 0; k < 4; k++) {
      over.dispatchEvent(new WheelEvent("wheel", {
        deltaY: -100, clientX: 400, bubbles: true, cancelable: true,
      }));
      await settle();
    }

    const view = panel.viewRange;
    expect(Number.isFinite(view.start)).toBe(true);
    expect(Number.isFinite(view.windowMs)).toBe(true);
    expect(view.windowMs).toBeGreaterThan(0);
    expect(document.getElementById("vsamples")!.textContent).not.toBe("0");
  });


  /**
   * Charge and energy are read from the device's hardware accumulators, never
   * computed here: the INA228 integrates every ADC conversion, while the app
   * only ever sees the samples the firmware chose to send.
   */
  it("reports charge and energy from the hardware accumulators", async () => {
    const { panel } = build();
    const t0 = Date.now() - 10_000;
    for (let k = 0; k < 40_000; k++) panel.add(t0 + k / 4, 4.9, 1, 4.9, 0.01);
    // Polled once a second: 1 A at 4.9 V is 1 C and 4.9 J per second.
    // Readings at t0 .. t0+9000; the view ends at the last sample, just under
    // t0+10000, so nine intervals fall inside it.
    for (let k = 0; k <= 9; k++) panel.addAcc(t0 + k * 1000, k * 1, k * 4.9);
    await settle();

    // 9 C = 2.5 mAh, 44.1 J = 12.25 mWh.
    expect(parseFloat(document.getElementById("vq")!.textContent!)).toBeCloseTo(2.5, 3);
    expect(parseFloat(document.getElementById("ve")!.textContent!)).toBeCloseTo(12.25, 2);
    expect(document.getElementById("vi")!.textContent).toMatch(/^1\.00\d* A$/);
  });

  it("shows no charge or energy until two accumulator readings land in view", async () => {
    const { panel } = build();
    const t0 = Date.now() - 10_000;
    for (let k = 0; k < 4000; k++) panel.add(t0 + k, 4.9, 1, 4.9, 0.01);
    await settle();
    expect(document.getElementById("vq")!.textContent).toBe("--");

    panel.addAcc(t0 + 1000, 1, 4.9);
    await settle();
    expect(document.getElementById("vq")!.textContent).toBe("--");   // one reading is not a delta

    panel.addAcc(t0 + 2000, 2, 9.8);
    await settle();
    expect(document.getElementById("vq")!.textContent).not.toBe("--");
  });

  it("the all window frames the capture, not the ring's reach", async () => {
    const { panel } = build();
    const win = document.getElementById("win") as HTMLSelectElement;
    const t0 = Date.now() - 10_000;
    for (let k = 0; k < 40_000; k++) panel.add(t0 + k / 4, 4.9, 1, 4.9, 0.01);

    win.value = "0";
    win.dispatchEvent(new Event("change"));
    await settle();

    // Ten seconds of capture must read as about ten seconds, not as the
    // 3.6 hours the coarse tier could theoretically address.
    const span = document.getElementById("vspan")!.textContent ?? "";
    expect(span).toMatch(/^1[01]\.\d+ s$/);
  });

  it("says '< one step' when the window is below the device's resolution", async () => {
    const { panel } = build();
    const t0 = Date.now() - 90_000;
    for (let k = 0; k < 9000; k++) panel.add(t0 + k * 10, 4.9, 1.77e-5, 8.7e-5, 0.01);

    // A 0.001 mAh step early on teaches the resolution, then the device stops
    // moving: at microamp currents 30 s cannot shift its last printed digit.
    panel.addAcc(t0 + 1000, 0, 0);
    panel.addAcc(t0 + 2000, 0.0036, 0.018);
    for (let k = 60; k <= 89; k++) panel.addAcc(t0 + k * 1000, 0.0036, 0.018);
    await settle();

    // The 30 s window holds only the flat readings, so the delta is a true
    // zero - but a bare "0.000" would read as a fault rather than as "too
    // little charge to register".
    const charge = document.getElementById("vq")!.textContent ?? "";
    expect(charge).toBe("< 1.000 uAh");
  });

  it("history reports the whole capture, not just the window", async () => {
    const { panel } = build();
    const win = document.getElementById("win") as HTMLSelectElement;
    const t0 = Date.now() - 90_000;
    // 90 s of capture viewed through the 30 s preset.
    for (let k = 0; k < 9000; k++) panel.add(t0 + k * 10, 4.9, 1, 4.9, 0.01);
    win.value = "30000";
    win.dispatchEvent(new Event("change"));
    await settle();

    expect(document.getElementById("vspan")!.textContent).toMatch(/^30\.0 s$/);
    expect(document.getElementById("vcov")!.textContent).toMatch(/^1m 30s$/);
  });

  it("shows the running total beside the windowed change", async () => {
    const { panel } = build();
    const t0 = Date.now() - 30_000;
    for (let k = 0; k < 3000; k++) panel.add(t0 + k * 10, 4.9, 1, 4.9, 0.01);
    // A long session: the total is far larger than the change in view.
    for (let k = 0; k <= 30; k++) panel.addAcc(t0 + k * 1000, 400 + k, (400 + k) * 4.9);
    await settle();

    // The delta is small, the total is large - and both must be visible, or
    // the delta looks broken next to what `acc` prints.
    // The window ends at the last SAMPLE (t0+29990), so the reading at
    // t0+30000 falls outside: 29 steps of 1 C = 8.056 mAh.
    expect(parseFloat(document.getElementById("vq")!.textContent!)).toBeCloseTo(8.056, 2);
    expect(document.getElementById("vtq")!.textContent).toMatch(/^of \d/);
  });

  /**
   * Charge must survive the stream stopping: the readings taken while it was
   * running stay inside the frozen window. What once broke this was acc
   * readings carrying the previous chunk's timestamp, not the window's reach.
   */
  it("keeps reporting charge after the sample stream stops", async () => {
    const { panel } = build();
    const t0 = Date.now() - 70_000;
    // 30 s of capture with polling running throughout, then the stream stops
    // while polling carries on for another 40 s.
    for (let k = 0; k < 3000; k++) panel.add(t0 + k * 10, 4.9, 1, 4.9, 0.01);
    for (let k = 0; k <= 70; k++) panel.addAcc(t0 + k * 1000, k, k * 4.9);
    await settle();

    expect(document.getElementById("vq")!.textContent).not.toBe("--");
    expect(document.getElementById("vtq")!.textContent).toMatch(/^of /);
  });

  /**
   * Regression: letting accumulator readings extend the timeline made the
   * charts scroll and `history` grow with the measurement stopped - motion
   * with nothing behind it.
   */
  it("freezes the timeline when samples stop, even while polling continues", async () => {
    const { panel } = build();
    const t0 = Date.now() - 70_000;
    for (let k = 0; k < 3000; k++) panel.add(t0 + k * 10, 4.9, 1, 4.9, 0.01);
    for (let k = 0; k <= 30; k++) panel.addAcc(t0 + k * 1000, k, k * 4.9);
    await settle();
    const historyBefore = document.getElementById("vcov")!.textContent;

    // Forty more seconds of polling and not one sample.
    for (let k = 31; k <= 70; k++) panel.addAcc(t0 + k * 1000, k, k * 4.9);
    await settle();

    expect(document.getElementById("vcov")!.textContent).toBe(historyBefore);
    // The running total still moves, so it is clear the device is alive.
    expect(document.getElementById("vtq")!.textContent).toMatch(/^of /);
  });

  /**
   * Regression: with nothing captured the axis ran on Date.now(), and the acc
   * poller redraws once a second - so polling alone made an empty chart's time
   * axis crawl.
   */
  it("does not advance the axis when polling arrives with no samples", async () => {
    const { panel } = build();
    const t0 = Date.now();
    for (let k = 0; k <= 3; k++) panel.addAcc(t0 + k * 1000, k, k * 4.9);
    await settle();
    const first = document.getElementById("vspan")!.textContent;

    await new Promise((r) => setTimeout(r, 120));
    for (let k = 4; k <= 8; k++) panel.addAcc(t0 + k * 1000, k, k * 4.9);
    await settle();

    expect(document.getElementById("vspan")!.textContent).toBe(first);
  });

  /**
   * Regression: the empty span was a token 1 s, and clampView shrank the 30 s
   * preset to fit it - so a freshly loaded chart drew a one-second axis full
   * of sub-second tick labels that read as arbitrary times.
   */
  it("shows a full preset-width axis before any data arrives", async () => {
    build();
    await settle();
    expect(document.getElementById("vspan")!.textContent).toBe("30.0 s");
  });

  /**
   * Regression: any gesture cleared `followAll` while the control went on
   * reading "all", so a stray wheel over a chart silently turned it into a
   * fixed scrolling window with nothing on screen saying so. The only cure
   * was toggling the preset off and back.
   */
  it("stops claiming 'all' once the view no longer is", async () => {
    const { panel } = build();
    const win = document.getElementById("win") as HTMLSelectElement;
    const t0 = Date.now() - 90_000;
    for (let k = 0; k < 9000; k++) panel.add(t0 + k * 10, 4.9, 1, 4.9, 0.01);

    win.value = "0";
    win.dispatchEvent(new Event("change"));
    await settle();
    expect(win.value).toBe("0");

    // Middle-button drag: the one gesture that needs no posToVal, so it is the
    // one that can be aimed in this environment. happy-dom drops shiftKey and
    // clientX from WheelEvent, which is why the wheel cannot be used here.
    const over = document.querySelector(".u-over") as HTMLElement;
    over.dispatchEvent(new PointerEvent("pointerdown", {
      button: 1, clientX: 400, pointerId: 1, bubbles: true, cancelable: true,
    }));
    over.dispatchEvent(new PointerEvent("pointermove", {
      clientX: 500, pointerId: 1, bubbles: true, cancelable: true,
    }));
    over.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    await settle();

    expect(win.value).not.toBe("0");
    expect(win.value).toBe("custom");
  });

  /**
   * Regression: the control was synced to the clamped window, so with less
   * capture than the preset the value never matched an option and the list
   * snapped to "custom" the moment a preset was picked - making the presets
   * unusable.
   */
  it("keeps a preset selected even when the data is shorter than it", async () => {
    const { panel } = build();
    const win = document.getElementById("win") as HTMLSelectElement;
    const t0 = Date.now() - 5000;
    for (let k = 0; k < 500; k++) panel.add(t0 + k * 10, 4.9, 1, 4.9, 0.01);  // 5 s only

    win.value = "30000";
    win.dispatchEvent(new Event("change"));
    await settle();

    expect(win.value).toBe("30000");
    // The bar still tells the truth about what is drawn.
    expect(document.getElementById("vspan")!.textContent).not.toBe("30.0 s");
  });

  it("puts the control back on a preset when one is selected again", async () => {
    const { panel } = build();
    const win = document.getElementById("win") as HTMLSelectElement;
    const t0 = Date.now() - 90_000;
    for (let k = 0; k < 9000; k++) panel.add(t0 + k * 10, 4.9, 1, 4.9, 0.01);

    win.value = "30000";
    win.dispatchEvent(new Event("change"));
    await settle();
    expect(win.value).toBe("30000");
  });

  it("clear() empties the store", async () => {
    const { panel } = build();
    for (let k = 0; k < 100; k++) panel.add(Date.now() + k, 4.9, 0.4, 2, 0.004);
    panel.clear();
    await settle();
    expect(panel.count).toBe(0);
  });

  /**
   * `start` discards the buffer, so the app has to know whether that would
   * throw anything away before it does it silently.
   */
  describe("unsaved", () => {
    const fill = (panel: ChartPanel, n = 100) => {
      const t0 = Date.now();
      for (let k = 0; k < n; k++) panel.add(t0 + k, 4.9, 0.4, 2, 0.004);
    };

    it("is false with nothing captured", () => {
      expect(build().panel.unsaved).toBe(false);
    });

    it("is true once samples arrive", () => {
      const { panel } = build();
      fill(panel);
      expect(panel.unsaved).toBe(true);
    });

    it("is false after an export", () => {
      const { panel } = build();
      fill(panel);
      panel.markSaved();
      expect(panel.unsaved).toBe(false);
    });

    /* A capture that carried on after the export is not saved: the file holds
       the first half only. */
    it("goes back to true when the capture continues after a save", () => {
      const { panel } = build();
      fill(panel);
      panel.markSaved();
      fill(panel);
      expect(panel.unsaved).toBe(true);
    });

    it("is false after clearing, since there is nothing left to lose", async () => {
      const { panel } = build();
      fill(panel);
      panel.clear();
      await settle();
      expect(panel.unsaved).toBe(false);
    });
  });
});
