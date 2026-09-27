import { describe, expect, it } from "vitest";
import { SAMPLE_CHARS, SampleScanner, TICK_WRAP, TickClock, matchSample, normaliseEol } from "./parse.js";

const enc = (s: string) => new TextEncoder().encode(s);

function collect(chunks: string[], chunkT?: (i: number) => number) {
  const got: { t: number; v: number; i: number; p: number; s: number }[] = [];
  const scanner = new SampleScanner((t, v, i, p, s) => got.push({ t, v, i, p, s }));
  chunks.forEach((c, k) => scanner.feed(chunkT ? chunkT(k) : 1000 + k, enc(c)));
  return got;
}

describe("matchSample", () => {
  it("accepts the slow (labelled) layout", () => {
    const m = matchSample("4.914 V, 476695 uA, 2342788 uW, Vsh=4766953 nV");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("4.914");
    expect(m![4]).toBe("4766953");
  });

  it("accepts the fast (bare) layout", () => {
    const m = matchSample("4.819,713968,3440711,7139687");
    expect(m).not.toBeNull();
    expect(m![2]).toBe("713968");
  });

  it.each([
    "> stop",
    "stop",
    "OK: 102 samples in 13697 ms -> 7 sps acquired",
    "  delivered 102 (7/s), dropped 0 (0/s)",
    "> ",
    "",
    "4,5",                        // too few fields
    "4.8,1,2,3,4",                // fifth field is not a stamp
    "4.8,1,2,3,1a2b3c4d",         // eight hex digits, so not a stamp either
    "4.8,1,2,3,1a2b3c,9",         // stamp plus a sixth field
    "4.819,713968,3440711,abc",   // not a number
  ])("rejects %j", (line) => {
    expect(matchSample(line)).toBeNull();
  });

  it("captures the device timestamp from the fast layout", () => {
    const m = matchSample("4.819,713968,3440711,7139687,1a2b3c");
    expect(m).not.toBeNull();
    expect(m![2]).toBe("713968");
    expect(m![5]).toBe("1a2b3c");
  });

  it("captures the device timestamp from the slow layout", () => {
    const m = matchSample("4.914 V, 476695 uA, 2342788 uW, Vsh=4766953 nV, t=00f4b1");
    expect(m).not.toBeNull();
    expect(m![4]).toBe("4766953");
    expect(m![5]).toBe("00f4b1");
  });

  /** Firmware that predates the stamp must keep working unchanged. */
  it.each([
    "4.819,713968,3440711,7139687",
    "4.914 V, 476695 uA, 2342788 uW, Vsh=4766953 nV",
  ])("still accepts the unstamped line %j", (line) => {
    const m = matchSample(line);
    expect(m).not.toBeNull();
    expect(m![5]).toBeUndefined();
  });
});

describe("TickClock", () => {
  it("passes stamps through while the counter is rising", () => {
    const c = new TickClock();
    expect(c.absolute(100)).toBe(100);
    expect(c.absolute(350)).toBe(350);
  });

  /**
   * Six hex digits hold 16.777216 s, so a session longer than that rolls over.
   * Handing the raw value to the charts would drag the trace back to the start
   * of the axis every 17 seconds.
   */
  it("unwraps the 24-bit counter across a rollover", () => {
    const c = new TickClock();
    c.absolute(TICK_WRAP - 250);
    expect(c.absolute(0)).toBe(TICK_WRAP);
    expect(c.absolute(250)).toBe(TICK_WRAP + 250);
  });

  it("keeps counting across many rollovers", () => {
    const c = new TickClock();
    let last = -1;
    for (let wrap = 0; wrap < 5; wrap++) {
      for (const raw of [0, 1_000_000, 8_000_000, TICK_WRAP - 1]) {
        const abs = c.absolute(raw);
        expect(abs).toBeGreaterThan(last);
        last = abs;
      }
    }
    expect(last).toBe(4 * TICK_WRAP + TICK_WRAP - 1);
  });

  it("anchors once and then reports host time from device time", () => {
    const c = new TickClock();
    expect(c.anchored).toBe(false);
    c.anchor(5_000_000, 9000);     // newest sample sits at host t=9000
    expect(c.anchored).toBe(true);
    expect(c.toHost(5_000_000)).toBeCloseTo(9000, 9);
    expect(c.toHost(4_000_000)).toBeCloseTo(8000, 9);
    // A later chunk must not move the anchor, or the drawn timeline shifts.
    c.anchor(9_000_000, 99_999);
    expect(c.toHost(5_000_000)).toBeCloseTo(9000, 9);
  });

  it("forgets everything on reset, since a reconnect is a new device clock", () => {
    const c = new TickClock();
    c.absolute(TICK_WRAP - 1);
    c.absolute(0);
    c.anchor(TICK_WRAP, 1000);
    c.reset();
    expect(c.anchored).toBe(false);
    expect(c.absolute(42)).toBe(42);
  });
});

describe("normaliseEol", () => {
  /** Splits a stream into chunks and returns the completed lines. */
  function split(chunks: string[]): string[] {
    const owner = { pendingCR: false };
    let partial = "";
    const out: string[] = [];
    for (const raw of chunks) {
      const t = normaliseEol(owner, raw);
      if (!t) continue;
      const parts = (partial + t).split("\n");
      partial = parts.pop() ?? "";
      out.push(...parts);
    }
    return out;
  }

  const L = "4.819,713968,3440711,7139687";

  it.each([
    ["whole", [L + "\r\n" + L + "\r\n"], 0],
    ["CRLF cut in half", [L + "\r", "\n" + L + "\r", "\n"], 0],
    ["byte at a time", (L + "\r\n" + L + "\r\n").split(""), 0],
    ["LF only", [L + "\n" + L + "\n"], 0],
    ["CR only", [L + "\r" + L + "\r"], 0],
    ["a genuine blank line", [L + "\r\n\r\n" + L + "\r\n"], 1],
  ])("%s -> 2 data lines, %i blank", (_name, chunks, blanks) => {
    const out = split(chunks as string[]);
    expect(out.filter((x) => x === L)).toHaveLength(2);
    expect(out.filter((x) => x === "")).toHaveLength(blanks as number);
  });

  it("keeps a blank line the device really sent", () => {
    // The tempting fix for phantom blanks is to drop every empty line. That
    // would also erase real ones, so this case guards against it.
    expect(split(["a\r\n\r\nb\r\n"])).toEqual(["a", "", "b"]);
  });
});

describe("SampleScanner", () => {
  it("converts to SI base units", () => {
    const [s] = collect(["4.914 V, 476695 uA, 2342788 uW, Vsh=4766953 nV\r\n"]);
    expect(s!.v).toBeCloseTo(4.914, 9);
    expect(s!.i).toBeCloseTo(0.476695, 9);
    expect(s!.p).toBeCloseTo(2.342788, 9);
    expect(s!.s).toBeCloseTo(0.004766953, 12);
  });

  it("agrees between the two layouts", () => {
    const slow = collect(["4.819 V, 713968 uA, 3440711 uW, Vsh=7139687 nV\r\n"])[0]!;
    const fast = collect(["4.819,713968,3440711,7139687\r\n"])[0]!;
    expect(fast.v).toBe(slow.v);
    expect(fast.i).toBe(slow.i);
    expect(fast.p).toBe(slow.p);
    expect(fast.s).toBe(slow.s);
  });

  it("survives the stream being cut at arbitrary byte boundaries", () => {
    const lines = Array.from({ length: 200 },
      (_, k) => `4.8${(k % 90) + 10},${713000 + k},${3440000 + k},${7139000 + k}`);
    const blob = lines.join("\r\n") + "\r\n";
    for (const size of [1, 3, 7, 64, 511]) {
      const chunks: string[] = [];
      for (let o = 0; o < blob.length; o += size) chunks.push(blob.slice(o, o + size));
      expect(collect(chunks)).toHaveLength(200);
    }
  });

  it("ignores commands and summary lines mixed into the stream", () => {
    const got = collect([
      "4.819,713968,3440711,7139687\r\n",
      "> mode fast\r\nmode fast\r\n",
      "OK: 102 samples in 13697 ms -> 7 sps acquired\r\n",
      "  delivered 102 (7/s), dropped 0 (0/s)\r\n",
      "4.822,713250,3439898,7132500\r\n",
    ]);
    expect(got).toHaveLength(2);
  });

  it("spreads a chunk's samples across the interval since the previous chunk", () => {
    // Four samples arriving in one chunk must not share a timestamp, or they
    // all land in one pixel column and the trace looks dashed.
    const rows = Array.from({ length: 4 },
      (_, k) => `4.81${k},71300${k},344000${k},713900${k}`).join("\r\n") + "\r\n";
    const got = collect(["4.800,713000,3440000,7139000\r\n", rows], (k) => 1000 + k * 100);
    const times = got.slice(1).map((s) => s.t);
    expect(new Set(times).size).toBe(4);
    for (let k = 1; k < times.length; k++) expect(times[k]!).toBeGreaterThan(times[k - 1]!);
    expect(Math.max(...times)).toBeLessThanOrEqual(1100);
  });

  it("reports monotonically increasing timestamps", () => {
    const got = collect(
      Array.from({ length: 20 }, () => "4.819,713968,3440711,7139687\r\n"),
      (k) => 5000 + k * 13);
    for (let k = 1; k < got.length; k++) {
      expect(got[k]!.t).toBeGreaterThanOrEqual(got[k - 1]!.t);
    }
  });
});

describe("SAMPLE_CHARS", () => {
  it.each([
    ["4.819,7139", true],
    ["4.914 V, 476695 uA", true],
    ["Vsh=4766", true],
    ["> ", false],
    ["OK: 102 samples", false],
    ["  delivered 102 (7/s)", false],
    ["stop", false],
  ])("%j held back: %s", (text, held) => {
    expect(SAMPLE_CHARS.test(text as string)).toBe(held);
  });
});

describe("sample timestamps", () => {
  function run(batches: { t: number; n: number }[]) {
    const times: number[] = [];
    const scanner = new SampleScanner((t) => times.push(t));
    for (const b of batches) {
      const rows = Array.from({ length: b.n }, (_, k) => `4.8${k % 10},1,2,3`).join("\r\n");
      scanner.feed(b.t, enc(rows + "\r\n"));
    }
    return { times, scanner };
  }

  /**
   * Regression, from a real 50 s capture: 565 timestamps went backwards.
   * performance.now() is quantised to about 100 us, so two chunks can share an
   * arrival time; the old fallback then invented 1 ms per sample and rewound
   * over rows it had already emitted. The charts drew those as tears.
   */
  it("never goes backwards when two chunks share an arrival time", () => {
    const { times } = run([
      { t: 1000, n: 3 },
      { t: 1000, n: 3 },     // same instant
      { t: 1000, n: 3 },
      { t: 1000.4, n: 3 },
    ]);
    for (let k = 1; k < times.length; k++) {
      expect(times[k]!).toBeGreaterThan(times[k - 1]!);
    }
  });

  it("never goes backwards across a long randomised stream", () => {
    const batches: { t: number; n: number }[] = [];
    let t = 5000;
    for (let k = 0; k < 400; k++) {
      // Arrival jitter including repeats, which is what the clock really does.
      t += [0, 0, 0.1, 0.4, 1.3, 17][k % 6]!;
      batches.push({ t, n: 1 + (k % 9) });
    }
    const { times } = run(batches);
    for (let k = 1; k < times.length; k++) {
      expect(times[k]!).toBeGreaterThan(times[k - 1]!);
    }
  });

  it("measures the achieved rate rather than assuming one", () => {
    const batches: { t: number; n: number }[] = [];
    for (let k = 1; k <= 120; k++) batches.push({ t: 1000 + k * 10, n: 20 });
    const { scanner } = run(batches);
    // 20 samples every 10 ms is 2000 per second.
    expect(scanner.samplesPerSecond).toBeGreaterThan(1800);
    expect(scanner.samplesPerSecond).toBeLessThan(2200);
  });

  it("leaves a real stall visible instead of stretching samples over it", () => {
    const batches: { t: number; n: number }[] = [];
    for (let k = 1; k <= 120; k++) batches.push({ t: 1000 + k * 10, n: 20 });
    const before = 1000 + 120 * 10;
    batches.push({ t: before + 200, n: 20 });        // 200 ms of nothing
    const { times } = run(batches);

    const gaps: number[] = [];
    for (let k = 1; k < times.length; k++) gaps.push(times[k]! - times[k - 1]!);
    const biggest = Math.max(...gaps);
    // The stall survives as a gap of its own order, not smeared into spacing.
    expect(biggest).toBeGreaterThan(150);
  });

  /** Builds one fast-layout line carrying an absolute microsecond stamp. */
  const stamped = (us: number) =>
    `4.819,713968,3440711,7139687,${(us % TICK_WRAP).toString(16).padStart(6, "0")}`;

  function runStamped(chunks: { t: number; us: number[] }[]) {
    const times: number[] = [];
    const scanner = new SampleScanner((t) => times.push(t));
    for (const c of chunks) {
      scanner.feed(c.t, enc(c.us.map(stamped).join("\r\n") + "\r\n"));
    }
    return { times, scanner };
  }

  it("uses the device's timestamps instead of spreading the chunk evenly", () => {
    // Arrival says "five samples at t=1000". The stamps say they were taken
    // 250 us apart ending 1 ms before that. Only the stamps are true.
    const { times, scanner } = runStamped([
      { t: 1000, us: [0, 250, 500, 750, 1000] },
    ]);
    expect(scanner.deviceTimed).toBe(true);
    // Newest sample anchored at the arrival, the rest laid out behind it.
    expect(times).toEqual([999, 999.25, 999.5, 999.75, 1000]);
  });

  /**
   * The reason the stamp exists. The firmware's 250 ms LCD refresh stops
   * acquisition for runs of up to 23 ms; an evenly spaced reader smears those
   * samples across the pause and the gap disappears from the chart.
   */
  it("reproduces an acquisition pause exactly rather than smearing it", () => {
    const us = [0, 250, 500, 23_500, 23_750, 24_000];
    const { times } = runStamped([{ t: 5000, us }]);
    const gaps = times.slice(1).map((t, k) => t - times[k]!);
    expect(gaps.map((g) => Math.round(g * 1000) / 1000))
      .toEqual([0.25, 0.25, 23, 0.25, 0.25]);
  });

  it("holds the anchor across chunks so the timeline is the device's", () => {
    // The second chunk is delivered 40 ms late by the host, but the device
    // says its samples came 1 ms after the first chunk's. The host clock must
    // not get a vote after the anchor.
    const { times } = runStamped([
      { t: 1000, us: [0, 250] },
      { t: 1040, us: [1250, 1500] },
    ]);
    expect(times).toEqual([999.75, 1000, 1001, 1001.25]);
  });

  it("stays monotonic when the device counter wraps mid-stream", () => {
    const { times } = runStamped([
      { t: 1000, us: [TICK_WRAP - 500, TICK_WRAP - 250] },
      { t: 1001, us: [TICK_WRAP, TICK_WRAP + 250] },
    ]);
    for (let k = 1; k < times.length; k++) {
      expect(times[k]!).toBeGreaterThan(times[k - 1]!);
    }
    expect(times[3]! - times[0]!).toBeCloseTo(0.75, 9);
  });

  /** Older firmware sends no stamp at all, and must still be plotted. */
  it("falls back to interpolation when the device sends no timestamps", () => {
    const batches: { t: number; n: number }[] = [];
    for (let k = 1; k <= 20; k++) batches.push({ t: 1000 + k * 10, n: 20 });
    const { times, scanner } = run(batches);
    expect(scanner.deviceTimed).toBe(false);
    expect(times.length).toBe(400);
    for (let k = 1; k < times.length; k++) {
      expect(times[k]!).toBeGreaterThan(times[k - 1]!);
    }
  });

  it("keeps samples inside the interval when the stream is steady", () => {
    const batches: { t: number; n: number }[] = [];
    for (let k = 1; k <= 60; k++) batches.push({ t: 1000 + k * 10, n: 20 });
    const { times } = run(batches);
    expect(times[times.length - 1]!).toBeLessThanOrEqual(1000 + 60 * 10 + 1);
  });
});
