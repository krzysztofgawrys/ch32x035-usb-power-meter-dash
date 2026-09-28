/**
 * Reads the device's current settings out of what it prints.
 *
 * The control panel used to show "..." in every dropdown, on the grounds that
 * the app could not know what the device was set to and should not pretend.
 * True, but useless: the panel is where you go to see how the instrument is
 * configured. The device does say, if asked - `info` dumps the registers, and
 * `mode`, `i2c` and `lcd` each report their own state - so the honest fix is
 * to ask rather than to guess or to shrug.
 *
 * Every pattern is anchored and matches a whole reply line, so nothing here
 * can be triggered by a measurement row or by prose.
 */

/** Averaging counts in ADC_CONFIG field order; the index is the field value. */
export const AVG_COUNTS = ["1", "4", "16", "64", "128", "256", "512", "1024"] as const;

export interface DeviceSettings {
  mode: "slow" | "fast";
  avg: string;
  range: "0" | "1";
  i2c: "soft" | "hw";
  lcd: "on" | "off";
}

/** ADC_CONFIG values the firmware writes for its two named modes. */
const CFG_FAST = 0xb480;
const CFG_SLOW = 0xbb6b;

/**
 * Decodes an INA228 ADC_CONFIG.
 *
 * INA228 only: the averaging field sits at [2:0] here but at [11:9] on an
 * INA226, and the mode constants differ too. The `mode=` line carries the
 * name directly, so mode survives either part; averaging read from a 226
 * would be wrong, which is why nothing calls this on a reply that did not
 * come from ADC_CONFIG.
 */
function fromAdcConfig(adc: number): Partial<DeviceSettings> {
  const out: Partial<DeviceSettings> = { avg: AVG_COUNTS[adc & 0x07] ?? "1" };
  // Anything else is a hand-rolled config with no name to show.
  if (adc === CFG_FAST) out.mode = "fast";
  else if (adc === CFG_SLOW) out.mode = "slow";
  return out;
}

const INFO = /^\s*CFG=0x([0-9a-f]{4})\s+ADC=0x([0-9a-f]{4})\b/i;
const MODE = /^\s*mode=(slow|fast|custom)\s+ADC_CONFIG=0x([0-9a-f]{4})\b/i;
const BACKEND = /^\s*backend=(soft|hw)\b/i;
const LCD = /^\s*LCD (ON|OFF)\s*$/i;

/**
 * What one reply line reveals, or null if it reveals nothing.
 *
 * Returns only the fields it actually learned, so callers can merge without
 * overwriting what they already knew from a different line.
 */
export function parseSetting(line: string): Partial<DeviceSettings> | null {
  const info = INFO.exec(line);
  if (info) {
    const cfg = parseInt(info[1]!, 16);
    const adc = parseInt(info[2]!, 16);
    // ADCRANGE, CONFIG bit 4. Set means the high-resolution +/-40.96 mV range.
    return { ...fromAdcConfig(adc), range: cfg & 0x0010 ? "1" : "0" };
  }

  const mode = MODE.exec(line);
  if (mode) {
    const adc = parseInt(mode[2]!, 16);
    const named = mode[1]!.toLowerCase();
    const out = fromAdcConfig(adc);
    if (named === "slow" || named === "fast") out.mode = named;
    else delete out.mode;
    return out;
  }

  const backend = BACKEND.exec(line);
  if (backend) return { i2c: backend[1]!.toLowerCase() as DeviceSettings["i2c"] };

  const lcd = LCD.exec(line);
  if (lcd) return { lcd: lcd[1]!.toLowerCase() as DeviceSettings["lcd"] };

  return null;
}

/**
 * The commands that make the device state its current settings.
 *
 * Sent on connect, and again after a change - `avg` and `range` answer a
 * successful write with a bare "OK", so the new value has to be read back
 * rather than inferred from the reply.
 */
export const QUERY_COMMANDS = ["info", "i2c", "lcd"] as const;

/**
 * Which query to re-run after a command, if any.
 *
 * `mode` and `lcd` are absent on purpose: each answers with its own new state
 * ("mode=fast  ADC_CONFIG=0x...", "LCD ON"), so asking again would only
 * duplicate a line that is already on its way. `avg` and `range` answer a
 * successful write with a bare "OK" and have to be read back.
 */
export function refreshFor(command: string): string | null {
  const cmd = command.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (cmd === "avg" || cmd === "range" || cmd === "reset") return "info";
  if (cmd === "i2c") return "i2c";
  return null;
}
