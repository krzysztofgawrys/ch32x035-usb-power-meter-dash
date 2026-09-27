/**
 * The device's shell, described as data.
 *
 * Taken from the command table in the firmware (`shell_cmds` in App/main.c),
 * not from the `help` text, so argument ranges and side effects are the real
 * ones. Adding a command here is all it takes to give it a button.
 */

export interface ButtonControl {
  readonly kind: "button";
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly hint: string;
  /** Requires a second click to confirm. */
  readonly danger?: boolean;
}

export interface SelectControl {
  readonly kind: "select";
  readonly id: string;
  readonly label: string;
  /** Command sent when an option is chosen. */
  readonly command: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly hint: string;
}

export type Control = ButtonControl | SelectControl;

export interface ControlGroup {
  readonly title: string;
  readonly controls: readonly Control[];
}

export const CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    title: "Streaming",
    controls: [
      {
        kind: "button", id: "start", label: "Start", command: "start",
        hint: "Continuous streaming. Zeroes the accumulators, so charge and energy are per session.",
      },
      {
        kind: "button", id: "stop", label: "Stop", command: "stop",
        hint: "Stops streaming and freezes the accumulators. Prints the session summary.",
      },
      {
        kind: "button", id: "read", label: "Read once", command: "read",
        hint: "A single V/I/P reading without starting the stream.",
      },
      {
        kind: "select", id: "mode", label: "Converter", command: "mode",
        options: [{ value: "slow", label: "slow" }, { value: "fast", label: "fast" }],
        hint: "ADC conversion mode. Switching it can tear the stream mid-row.",
      },
    ],
  },
  {
    title: "Accumulators",
    controls: [
      {
        kind: "button", id: "acc", label: "Read acc", command: "acc",
        hint: "mAh and mWh accumulated since the last start. The app polls this once a second anyway.",
      },
      {
        kind: "button", id: "acc-reset", label: "Reset acc", command: "acc reset",
        hint: "Zeroes the accumulators without restarting the stream.",
      },
      {
        kind: "button", id: "peak", label: "Read peaks", command: "peak",
        hint: "Minimum and maximum voltage and current seen so far.",
      },
      {
        kind: "button", id: "peak-reset", label: "Reset peaks", command: "peak reset",
        hint: "Clears the min/max trackers.",
      },
    ],
  },
  {
    title: "Acquisition",
    controls: [
      {
        kind: "select", id: "avg", label: "Averaging", command: "avg",
        // The INA228 AVG field takes these eight values and nothing between.
        options: ["1", "4", "16", "64", "128", "256", "512", "1024"]
          .map((v) => ({ value: v, label: v })),
        hint: "Samples averaged per conversion. Higher means slower but quieter; 512 already pushes a conversion past a second.",
      },
      {
        kind: "select", id: "range", label: "ADC range", command: "range",
        options: [{ value: "0", label: "0 (±163.84 mV)" }, { value: "1", label: "1 (±40.96 mV)" }],
        hint: "Shunt voltage range. An INA226 has a single fixed range and will refuse this.",
      },
      {
        kind: "button", id: "abs", label: "Toggle abs", command: "abs",
        hint: "Absolute-current mode: report magnitude instead of a signed value.",
      },
      {
        kind: "button", id: "cal", label: "Calibrate zero", command: "cal",
        hint: "Zero-current calibration. Takes several seconds and blocks; remove the load first.",
      },
      {
        kind: "select", id: "lcd", label: "Display", command: "lcd",
        options: [{ value: "on", label: "on" }, { value: "off", label: "off" }],
        // Sent automatically around start and stop; the control is here for
        // the times you want the panel dark, or lit, outside a capture.
        hint: "Device display refresh. Drawing costs samples, so the app blanks the panel for the duration of a capture.",
      },
    ],
  },
  {
    title: "Diagnostics",
    controls: [
      {
        kind: "button", id: "info", label: "INA228 info", command: "info",
        hint: "Decoded register dump.",
      },
      {
        kind: "button", id: "raw", label: "Raw registers", command: "raw",
        hint: "Undecoded register dump.",
      },
      {
        kind: "button", id: "probe", label: "Probe chip", command: "probe",
        hint: "Verifies the INA228 identification registers.",
      },
      {
        kind: "button", id: "prof", label: "Timing profile", command: "prof",
        hint: "Where the sample path spends its time.",
      },
      {
        kind: "button", id: "i2c", label: "I2C status", command: "i2c",
        hint: "Backend, clock and the failure and retry counters. Run it after streaming to see whether the throughput was clean.",
      },
      {
        kind: "select", id: "i2c-backend", label: "I2C backend", command: "i2c",
        options: [{ value: "soft", label: "soft" }, { value: "hw", label: "hw" }],
        hint: "Bit-banged or hardware peripheral.",
      },
      {
        kind: "button", id: "pd", label: "USB-PD status", command: "pd",
        hint: "State of the USB-PD sniffer.",
      },
      {
        kind: "button", id: "pd-stream", label: "Toggle PD stream", command: "pd stream",
        hint: "Live USB-PD event stream. Adds traffic to the same link as the samples.",
      },
      {
        kind: "button", id: "help", label: "Help", command: "help",
        hint: "The device's own command list.",
      },
    ],
  },
  {
    title: "Danger",
    controls: [
      {
        kind: "button", id: "reset", label: "Full reset", command: "reset", danger: true,
        hint: "Re-initialises the INA228 and clears accumulators, calibration offset and peaks.",
      },
      {
        kind: "button", id: "dfu", label: "Reboot to DFU", command: "dfu", danger: true,
        hint: "Reboots into the bootloader for dfu-util. The serial connection will drop.",
      },
    ],
  },
];

/** The command a select sends for a chosen value. */
export function selectCommand(control: SelectControl, value: string): string {
  return `${control.command} ${value}`;
}

/**
 * Whether a command line we are about to send changes the streaming state.
 *
 * It matters because the device's accumulators only move between `start` and
 * `stop` - the firmware integrates inside `if (usb_streaming)` - so polling
 * `acc` outside that window interrogates a frozen counter and injects a
 * command into the stream for nothing.
 *
 * `dfu` reboots, which stops streaming as surely as `stop` does.
 */
export function streamEffect(line: string): "start" | "stop" | null {
  const cmd = line.trim().toLowerCase();
  if (cmd === "start") return "start";
  if (cmd === "stop" || cmd === "dfu") return "stop";
  return null;
}

/**
 * Whether the device reboots in response, so nothing sent after it is read.
 *
 * `reset` is not one of these despite the name: cmd_reset re-inits the INA228
 * and clears the accumulators, but the firmware keeps running.
 */
export function reboots(line: string): boolean {
  return line.trim().toLowerCase() === "dfu";
}

/**
 * The lines to actually send for one user command, in order.
 *
 * The device's panel is the last thing in its main loop that still costs
 * samples: even with the draw split across loop iterations, rendering a glyph
 * is work the acquisition loop is not doing. During a capture nobody is
 * looking at the panel and everybody is looking at the samples, so the display
 * is blanked for exactly that window.
 *
 * Order is the whole point. `lcd off` has to reach the device before streaming
 * begins, or the first refresh still lands in the data; `lcd on` has to follow
 * the stop, or it repaints into the tail of the capture.
 */
export function commandSequence(text: string): readonly string[] {
  const effect = streamEffect(text);
  if (effect === "start") return ["lcd off", text];
  if (effect === "stop" && !reboots(text)) return [text, "lcd on"];
  return [text];
}
