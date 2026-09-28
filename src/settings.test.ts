import { describe, expect, it } from "vitest";
import { AVG_COUNTS, parseSetting, refreshFor } from "./settings.js";

describe("parseSetting", () => {
  /** `info` is the only reply that carries the ADC range. */
  it("reads mode, averaging and range from an info dump", () => {
    // ADC 0xB480 is the firmware's fast config; CFG bit 4 set is the
    // high-resolution range.
    expect(parseSetting("CFG=0x0011 ADC=0xB480 CAL=13107"))
      .toEqual({ mode: "fast", avg: "1", range: "1" });
    // 0xBB6B ends in 3, so slow mode also means 64x averaging.
    expect(parseSetting("CFG=0x0001 ADC=0xBB6B CAL=13107"))
      .toEqual({ mode: "slow", avg: "64", range: "0" });
  });

  it("decodes every averaging value from the ADC_CONFIG field", () => {
    AVG_COUNTS.forEach((count, bits) => {
      const adc = (0xb480 & ~0x07) | bits;
      const hex = adc.toString(16).padStart(4, "0");
      expect(parseSetting(`CFG=0x0011 ADC=0x${hex} CAL=1`)?.avg).toBe(count);
    });
  });

  it("reads mode and averaging from the mode reply", () => {
    expect(parseSetting("mode=fast  ADC_CONFIG=0xB480"))
      .toEqual({ mode: "fast", avg: "1" });
  });

  /** A hand-rolled config has no name; the dropdown should stay on "...". */
  it("reports no mode for a config that is neither slow nor fast", () => {
    const found = parseSetting("CFG=0x0011 ADC=0xB485 CAL=1")!;
    expect(found.mode).toBeUndefined();
    expect(found.avg).toBe("256");
    expect(found.range).toBe("1");
  });

  it("does not invent a mode when the device says custom", () => {
    expect(parseSetting("mode=custom  ADC_CONFIG=0xB482")).toEqual({ avg: "16" });
  });

  it("reads the I2C backend and the display state", () => {
    expect(parseSetting("backend=soft")).toEqual({ i2c: "soft" });
    expect(parseSetting("backend=hw")).toEqual({ i2c: "hw" });
    expect(parseSetting("LCD ON")).toEqual({ lcd: "on" });
    expect(parseSetting("LCD OFF")).toEqual({ lcd: "off" });
  });

  /**
   * Every pattern is anchored, so nothing the device streams or prints in
   * passing can move a dropdown.
   */
  it.each([
    "4.819,713968,3440711,7139687,1a2b3c",
    "4.914 V, 476695 uA, 2342788 uW, Vsh=4766953 nV",
    "OK",
    "OK: 102 samples in 13697 ms -> 7 sps acquired",
    "> info",
    "I2C read failed - run 'probe'",
    "ERR: avg 1|4|16|64|128|256|512|1024",
    "clock=400 kHz (boot ladder: 400 kHz)",
    "6.342 mAh, 31.098 mWh",
    "",
  ])("ignores %j", (line) => {
    expect(parseSetting(line)).toBeNull();
  });
});

describe("refreshFor", () => {
  /** These answer a successful write with a bare "OK". */
  it.each(["avg 256", "range 1", "reset"])("reads %j back with info", (cmd) => {
    expect(refreshFor(cmd)).toBe("info");
  });

  it("re-reads the backend after changing it", () => {
    expect(refreshFor("i2c hw")).toBe("i2c");
  });

  /**
   * Both already answer with their own new state, so asking again would only
   * duplicate a line that is already on its way.
   */
  it.each(["mode fast", "lcd off"])("asks nothing after %j", (cmd) => {
    expect(refreshFor(cmd)).toBeNull();
  });

  it.each(["start", "stop", "acc", "peak", ""])("asks nothing after %j", (cmd) => {
    expect(refreshFor(cmd)).toBeNull();
  });

  it("is not fooled by case or padding", () => {
    expect(refreshFor("  AVG  512 ")).toBe("info");
  });
});
