/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_GROUPS, commandSequence, reboots, selectCommand, streamEffect, type SelectControl,
} from "./commands.js";
import { ControlPanel } from "./control.js";

function build() {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById("host") as HTMLElement;
  const panel = new ControlPanel(host);
  const sent: string[] = [];
  panel.onCommand = (c) => sent.push(c);
  return { panel, host, sent };
}

const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click();

describe("command catalogue", () => {
  it("has no duplicate control ids", () => {
    const ids = CONTROL_GROUPS.flatMap((g) => g.controls.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every control a hint, since the labels alone are cryptic", () => {
    for (const g of CONTROL_GROUPS) {
      for (const c of g.controls) expect(c.hint.length).toBeGreaterThan(10);
    }
  });

  it("offers only the averaging values the INA228 accepts", () => {
    const avg = CONTROL_GROUPS.flatMap((g) => g.controls)
      .find((c) => c.id === "avg") as SelectControl;
    expect(avg.options.map((o) => o.value))
      .toEqual(["1", "4", "16", "64", "128", "256", "512", "1024"]);
  });

  it("builds an argument command from a select", () => {
    const mode = CONTROL_GROUPS.flatMap((g) => g.controls)
      .find((c) => c.id === "mode") as SelectControl;
    expect(selectCommand(mode, "fast")).toBe("mode fast");
  });

  it("offers the display toggle, which the app drives around a capture", () => {
    const lcd = CONTROL_GROUPS.flatMap((g) => g.controls)
      .find((c) => c.id === "lcd") as SelectControl;
    expect(lcd.options.map((o) => o.value)).toEqual(["on", "off"]);
    expect(selectCommand(lcd, "off")).toBe("lcd off");
  });

  it("marks reboot and wipe as dangerous and nothing else", () => {
    const danger = CONTROL_GROUPS.flatMap((g) => g.controls)
      .filter((c) => c.kind === "button" && c.danger)
      .map((c) => c.id);
    expect(danger.sort()).toEqual(["dfu", "reset"]);
  });
});

describe("ControlPanel", () => {
  it("starts disabled, because a command before connecting goes nowhere", () => {
    const { host } = build();
    for (const b of host.querySelectorAll("button")) expect(b.disabled).toBe(true);
  });

  it("sends a plain command on click", () => {
    const { panel, sent } = build();
    panel.setEnabled(true);
    click("cmd-start");
    expect(sent).toEqual(["start"]);
  });

  it("sends the argument form from a select and resets it", () => {
    const { panel, sent } = build();
    panel.setEnabled(true);
    const avg = document.getElementById("cmd-avg") as HTMLSelectElement;
    avg.value = "256";
    avg.dispatchEvent(new Event("change"));
    expect(sent).toEqual(["avg 256"]);
    // Back to the placeholder: the control must not claim to know the device's
    // current setting, which it has no way to read.
    expect(avg.value).toBe("");
  });

  /**
   * `reset` wipes calibration and `dfu` reboots the device, and both sit one
   * stray click away from the diagnostics buttons.
   */
  it("requires a second click for a dangerous command", () => {
    const { panel, sent } = build();
    panel.setEnabled(true);

    click("cmd-dfu");
    expect(sent).toEqual([]);
    expect((document.getElementById("cmd-dfu") as HTMLButtonElement).textContent).toBe("Sure?");

    click("cmd-dfu");
    expect(sent).toEqual(["dfu"]);
    expect((document.getElementById("cmd-dfu") as HTMLButtonElement).textContent).toBe("Reboot to DFU");
  });

  it("disarms a dangerous command after the confirm window", async () => {
    vi.useFakeTimers();
    try {
      const { panel, sent } = build();
      panel.setEnabled(true);
      click("cmd-reset");
      vi.advanceTimersByTime(4000);
      click("cmd-reset");            // counts as a fresh first click
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The panel has no output of its own: it sits directly above the terminal,
   * where every reply appears. A feed here would duplicate it.
   */
  it("renders controls and nothing that would duplicate the terminal", () => {
    const { host } = build();
    expect(host.querySelector(".control-feed")).toBeNull();
    expect(host.querySelectorAll("button").length).toBeGreaterThan(10);
    expect(host.querySelectorAll("select").length).toBeGreaterThan(2);
  });

  it("re-enables every control on connect and disables them again on drop", () => {
    const { panel, host } = build();
    panel.setEnabled(true);
    for (const b of host.querySelectorAll("button")) expect(b.disabled).toBe(false);
    for (const sel of host.querySelectorAll("select")) expect(sel.disabled).toBe(false);
    panel.setEnabled(false);
    for (const b of host.querySelectorAll("button")) expect(b.disabled).toBe(true);
  });

});

describe("streamEffect", () => {
  it.each([
    ["start", "start"],
    ["  START  ", "start"],
    ["stop", "stop"],
    ["Stop", "stop"],
    ["dfu", "stop"],
  ])("%j -> %s", (line, want) => {
    expect(streamEffect(line as string)).toBe(want);
  });

  it.each(["acc", "acc reset", "read", "mode fast", "peak", "", "startle", "stopwatch", "reset"])(
    "leaves %j alone",
    (line) => { expect(streamEffect(line)).toBeNull(); },
  );

  it("does not treat a full reset as a stop, because the firmware keeps streaming", () => {
    // cmd_reset re-inits the INA228 and clears the accumulators but never
    // touches usb_streaming, so the stream - and the polling - carry on.
    expect(streamEffect("reset")).toBeNull();
  });
});

describe("reboots", () => {
  it("knows dfu takes the device away", () => {
    expect(reboots("dfu")).toBe(true);
    expect(reboots("  DFU  ")).toBe(true);
  });

  /**
   * The name invites the mistake. cmd_reset re-inits the INA228 and clears the
   * accumulators; the firmware keeps running and still answers. Getting this
   * wrong would skip the `lcd on` that pairs with a stop.
   */
  it("does not count a full reset", () => {
    expect(reboots("reset")).toBe(false);
  });

  it.each(["stop", "start", "acc", "lcd off", ""])("leaves %j alone", (line) => {
    expect(reboots(line)).toBe(false);
  });
});

describe("commandSequence", () => {
  /**
   * Order is the whole point. The device's panel is the last thing in its main
   * loop that still costs samples, so it is blanked for exactly the duration
   * of the capture - `lcd off` has to land BEFORE streaming begins or the
   * first refresh is still in the data.
   */
  it("blanks the display before start", () => {
    expect(commandSequence("start")).toEqual(["lcd off", "start"]);
  });

  it("restores it after stop, not before", () => {
    expect(commandSequence("stop")).toEqual(["stop", "lcd on"]);
  });

  it("is not fooled by whitespace or case", () => {
    expect(commandSequence("  START ")).toEqual(["lcd off", "  START "]);
    expect(commandSequence("Stop")).toEqual(["Stop", "lcd on"]);
  });

  /** dfu stops the stream but takes the device with it; nothing reads the reply. */
  it("sends nothing after dfu", () => {
    expect(commandSequence("dfu")).toEqual(["dfu"]);
  });

  it.each(["acc", "read", "mode fast", "reset", "lcd on", ""])(
    "leaves %j on its own",
    (line) => { expect(commandSequence(line)).toEqual([line]); },
  );
});
