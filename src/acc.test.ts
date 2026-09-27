import { describe, expect, it } from "vitest";
import { AccumulatorLog } from "./acc.js";
import { ACC_ECHO, SampleScanner, looksLikeSampleFragment, matchAcc, matchSample } from "./parse.js";

describe("matchAcc", () => {
  it("parses the device reply into SI base units", () => {
    const a = matchAcc("6.342 mAh, 31.098 mWh");
    expect(a).not.toBeNull();
    expect(a!.charge).toBeCloseTo(6.342 * 3.6, 9);   // coulombs
    expect(a!.energy).toBeCloseTo(31.098 * 3.6, 9);  // joules
  });

  it.each([
    "4.819,713968,3440711,7139687",
    "4.914 V, 476695 uA, 2342788 uW, Vsh=4766953 nV",
    "OK: 102 samples in 13697 ms -> 7 sps acquired",
    "> acc",
    "6.342 mAh",
  ])("rejects %j", (line) => {
    expect(matchAcc(line)).toBeNull();
  });

  it("cannot be confused with a measurement row in either direction", () => {
    expect(matchSample("6.342 mAh, 31.098 mWh")).toBeNull();
    expect(matchAcc("4.819,713968,3440711,7139687")).toBeNull();
  });

  it("recognises the echo so the poller can hide it", () => {
    expect(ACC_ECHO.test("acc")).toBe(true);
    expect(ACC_ECHO.test(" acc ")).toBe(true);
    expect(ACC_ECHO.test("acc reset")).toBe(false);
  });
});

describe("SampleScanner acc sink", () => {
  it("routes acc replies to the acc sink and samples to the sample sink", () => {
    const samples: number[] = [];
    const accs: { charge: number; energy: number }[] = [];
    const scanner = new SampleScanner(
      (_t, _v, i) => samples.push(i),
      (_t, a) => accs.push(a),
    );
    const feed = (s: string) => scanner.feed(1000, new TextEncoder().encode(s));

    feed("4.819,713968,3440711,7139687\r\n");
    feed("acc\r\n6.342 mAh, 31.098 mWh\r\n");
    feed("4.822,713250,3439898,7132500\r\n");

    expect(samples).toHaveLength(2);
    expect(accs).toHaveLength(1);
    expect(accs[0]!.charge).toBeCloseTo(6.342 * 3.6, 9);
  });
});

describe("AccumulatorLog", () => {
  const log = () => {
    const l = new AccumulatorLog();
    // 1 A at 5 V, polled once a second: 1 C and 5 J per second.
    for (let k = 0; k <= 10; k++) l.push(1000 + k * 1000, k * 1, k * 5);
    return l;
  };

  it("gives an exact delta across an enclosed range", () => {
    const d = log().deltaOver(3000, 8000);   // readings at t=3000..8000
    expect(d).not.toBeNull();
    expect(d!.charge).toBeCloseTo(5, 9);
    expect(d!.energy).toBeCloseTo(25, 9);
    expect(d!.seconds).toBeCloseTo(5, 9);
  });

  it("is null when fewer than two readings fall inside", () => {
    expect(log().deltaOver(3100, 3900)).toBeNull();
    expect(new AccumulatorLog().deltaOver(0, 1e9)).toBeNull();
  });

  /**
   * Regression: discarding the whole range on a reset meant that after
   * `acc reset` the figures never came back on a wide window - the pre-reset
   * reading stayed in range forever. Only the one step across the reset is
   * unknowable; everything either side of it is real.
   */
  it("stitches across an accumulator reset instead of giving up", () => {
    const l = new AccumulatorLog();
    l.push(1000, 10, 50);
    l.push(2000, 12, 60);        // +2 C, +10 J
    l.push(3000, 0, 0);          // device-side reset, step skipped
    l.push(4000, 3, 15);         // +3 C, +15 J
    const d = l.deltaOver(1000, 4000);
    expect(d).not.toBeNull();
    expect(d!.charge).toBeCloseTo(5, 9);
    expect(d!.energy).toBeCloseTo(25, 9);
  });

  it("keeps working on a wide range long after a reset", () => {
    const l = new AccumulatorLog();
    l.push(1000, 100, 500);
    l.push(2000, 0, 0);                                   // reset
    for (let k = 1; k <= 20; k++) l.push(2000 + k * 1000, k, k * 5);
    // Whole history in range, as the "all" window would ask for.
    const d = l.deltaOver(0, 1e9);
    expect(d).not.toBeNull();
    expect(d!.charge).toBeCloseTo(20, 9);
  });

  it("ignores out-of-order readings", () => {
    const l = new AccumulatorLog();
    l.push(2000, 5, 25);
    l.push(1000, 1, 5);          // late arrival, must not corrupt the series
    expect(l.count).toBe(1);
    expect(l.latest()!.t).toBe(2000);
  });

  it("reports the newest reading", () => {
    expect(log().latest()!.charge).toBe(10);
  });
});

describe("prompt-prefixed lines", () => {
  /**
   * Regression: the device emits "> " without a trailing newline, so the next
   * line assembles as "> acc" rather than a bare "acc". Matching only the bare
   * form let every poll through into the terminal, once a second.
   */
  it("recognises the echo even when the prompt is glued to it", () => {
    expect(ACC_ECHO.test("> acc")).toBe(true);
    expect(ACC_ECHO.test(">acc")).toBe(true);
    expect(ACC_ECHO.test("> > acc")).toBe(true);
    expect(ACC_ECHO.test("> accumulate")).toBe(false);
  });

  it("parses a reply even when the prompt is glued to it", () => {
    const a = matchAcc("> 6.342 mAh, 31.098 mWh");
    expect(a).not.toBeNull();
    expect(a!.charge).toBeCloseTo(6.342 * 3.6, 9);
  });
});

describe("rows the device cuts in half", () => {
  /**
   * Regression: a command reply landing mid-row leaves an orphaned tail such
   * as ".884,476156,2325631,4761562". It cannot be parsed - the leading digit
   * is gone - so it must not reach the charts, and it should not litter the
   * log either.
   */
  it.each([
    ".884,476156,2325631,4761562",
    "4.884,476156,2325",
    "76156,2325631,4761562",
    "4.884,476156,2325631,4761562,99",
  ])("recognises %j as wreckage", (line) => {
    expect(looksLikeSampleFragment(line)).toBe(true);
    expect(matchSample(line)).toBeNull();
  });

  it.each([
    "4.884,476156,2325631,4761562",
    "4.914 V, 476695 uA, 2342788 uW, Vsh=4766953 nV",
    "6.342 mAh, 31.098 mWh",
    "  delivered 102 (7/s), dropped 0 (0/s)",
    "OK: 102 samples in 13697 ms -> 7 sps acquired",
    "> acc",
  ])("leaves %j alone", (line) => {
    expect(looksLikeSampleFragment(line)).toBe(false);
  });

  it("counts wreckage without feeding it to the charts", () => {
    const samples: number[] = [];
    const scanner = new SampleScanner((_t, _v, i) => samples.push(i));
    const feed = (s: string) => scanner.feed(1000, new TextEncoder().encode(s));

    feed("4.884,476156,2325631,4761562\r\n");
    feed(".884,476156,2325631,4761562\r\n");
    feed("4.885,476156,2325631,4761562\r\n");

    expect(samples).toHaveLength(2);
    expect(scanner.mangled).toBe(1);
  });

  it("does not count a normal acc reply as wreckage", () => {
    const scanner = new SampleScanner(() => {}, () => {});
    scanner.feed(1000, new TextEncoder().encode("6.342 mAh, 31.098 mWh\r\n"));
    expect(scanner.mangled).toBe(0);
  });
});


describe("spliced replies must not parse", () => {
  /**
   * Regression: the number pattern was [\d.]+, which accepts more than one
   * decimal point, and parseFloat then quietly returned a prefix. A reply cut
   * into by the sample stream became a plausible but wrong reading, showing up
   * as the accumulators jumping while the device reported a rising series.
   */
  it.each([
    "6.342 mAh, 31.0984.884 mWh",
    "6.3424.884 mAh, 31.098 mWh",
    "6..342 mAh, 31.098 mWh",
    "6.342. mAh, 31.098 mWh",
  ])("rejects %j", (line) => {
    expect(matchAcc(line)).toBeNull();
  });

  it("still accepts well-formed replies, with or without a decimal point", () => {
    expect(matchAcc("6.342 mAh, 31.098 mWh")).not.toBeNull();
    expect(matchAcc("0 mAh, 0 mWh")).not.toBeNull();
    expect(matchAcc("-1.5 mAh, -7.25 mWh")).not.toBeNull();
  });

  it("applies the same strictness to the labelled sample layout", () => {
    expect(matchSample("4.914 V, 476695 uA, 2342788 uW, Vsh=4766953 nV")).not.toBeNull();
    expect(matchSample("4.9.14 V, 476695 uA, 2342788 uW, Vsh=4766953 nV")).toBeNull();
  });
});

describe("device resolution", () => {
  /**
   * At microamp currents a 30 s window can sit entirely below the resolution
   * the device prints, so it reports no change and the delta is a true zero.
   * Showing "0.000 mAh" reads like a fault; knowing the step lets the UI say
   * "< 1 uAh" instead.
   */
  it("learns the smallest step the device reports", () => {
    const l = new AccumulatorLog();
    expect(l.resolution).toBeNull();

    l.push(1000, 0, 0);
    l.push(2000, 0, 0);            // no change yet, nothing learnt
    expect(l.resolution).toBeNull();

    l.push(3000, 0.0036, 0.018);   // 0.001 mAh and 0.005 mWh in SI
    l.push(4000, 0.0144, 0.072);   // a bigger step must not replace it
    expect(l.resolution!.charge).toBeCloseTo(0.0036, 9);
    expect(l.resolution!.energy).toBeCloseTo(0.018, 9);
  });

  it("ignores the negative step across a reset", () => {
    const l = new AccumulatorLog();
    l.push(1000, 10, 50);
    l.push(2000, 10.5, 52);
    l.push(3000, 0, 0);            // reset
    expect(l.resolution!.charge).toBeCloseTo(0.5, 9);
  });

  it("forgets the resolution on clear", () => {
    const l = new AccumulatorLog();
    l.push(1000, 0, 0);
    l.push(2000, 1, 5);
    l.clear();
    expect(l.resolution).toBeNull();
  });

  it("reports a genuine zero delta when the device really has not moved", () => {
    const l = new AccumulatorLog();
    l.push(1000, 5, 25);
    l.push(2000, 5, 25);
    const d = l.deltaOver(0, 1e9);
    expect(d!.charge).toBe(0);
    expect(d!.energy).toBe(0);
  });
});

describe("accumulator running backwards", () => {
  it("counts a decrease instead of only skipping it", () => {
    const l = new AccumulatorLog();
    l.push(1000, 116.759 * 3.6, 559.462 * 3.6);
    l.push(2000, 36.825 * 3.6, 176.128 * 3.6);   // device reported less
    expect(l.backwards).toBe(1);
  });

  it("does not count ordinary rising readings", () => {
    const l = new AccumulatorLog();
    for (let k = 0; k < 10; k++) l.push(1000 + k * 1000, k, k * 5);
    expect(l.backwards).toBe(0);
  });

  it("forgets the count on clear", () => {
    const l = new AccumulatorLog();
    l.push(1000, 10, 50);
    l.push(2000, 1, 5);
    l.clear();
    expect(l.backwards).toBe(0);
  });
});

describe("text sink", () => {
  /**
   * Web Serial exposes no product name, so the device's own greeting is the
   * only readable identity available. It arrives as an ordinary line, mixed in
   * with samples and acc replies, and must reach the caller unchanged.
   */
  it("passes lines that are neither samples, acc replies nor wreckage", () => {
    const lines: string[] = [];
    const scanner = new SampleScanner(() => {}, () => {}, (l) => lines.push(l));
    const feed = (s: string) => scanner.feed(1000, new TextEncoder().encode(s));

    feed("USBpm 1.0.199 - type 'help'\r\n");
    feed("4.819,713968,3440711,7139687\r\n");
    feed("6.342 mAh, 31.098 mWh\r\n");
    feed(".884,476156,2325631,4761562\r\n");
    feed("OK: 102 samples in 13697 ms -> 7 sps acquired\r\n");
    feed("\r\n");

    expect(lines).toEqual([
      "USBpm 1.0.199 - type 'help'",
      "OK: 102 samples in 13697 ms -> 7 sps acquired",
    ]);
  });
});
