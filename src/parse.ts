/** Line assembly and measurement-sample extraction from the raw byte stream. */

/**
 * The device emits the same four quantities in two layouts, each optionally
 * followed by the sample's own timestamp:
 *
 *   slow:  4.914 V, 476695 uA, 2342788 uW, Vsh=4766953 nV, t=1a2b3c
 *   fast:  4.819,713968,3440711,7139687,1a2b3c
 *
 * Units are identical in both (V, uA, uW, nV); fast mode just drops the
 * labels. Both patterns are anchored at each end so command echoes, prompts
 * and summary lines ("OK: 102 samples in 13697 ms -> 7 sps acquired",
 * "delivered 102 (7/s), dropped 0 (0/s)") can never look like data.
 *
 * The fast pattern requires exactly four bare numbers and nothing else, which
 * is what keeps it from matching prose that happens to contain commas. The
 * timestamp is exactly six hex digits, so a fifth field of any other shape is
 * still a reason to reject the line rather than a stamp to misread.
 *
 * Firmware older than the timestamp simply omits the field; see TickClock for
 * what the reader falls back to.
 *
 * To support another firmware format, add a regex capturing the same four
 * groups in the same units. Nothing else needs changing.
 */
/* Every number is matched strictly, with at most one decimal point. The loose
   [\d.]+ this replaced accepted "6.3424.884" and parseFloat quietly returned
   6.3424 - so a reply spliced by the sample stream turned into a plausible but
   wrong reading instead of being rejected. That showed up as accumulators
   jumping while the device itself reported a rising series. */
export const SAMPLE_FORMATS: readonly RegExp[] = [
  /^\s*(-?\d+(?:\.\d+)?)\s*V\s*,\s*(-?\d+(?:\.\d+)?)\s*uA\s*,\s*(-?\d+(?:\.\d+)?)\s*uW\s*,\s*Vsh\s*=\s*(-?\d+(?:\.\d+)?)\s*nV\s*(?:,\s*t\s*=\s*([0-9a-f]{6})\s*)?$/i,
  /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*([0-9a-f]{6})\s*)?$/,
];

/**
 * Characters a measurement row can consist of, in either layout. Used to
 * decide whether an unterminated fragment might still become one; anything
 * outside this set (a ">" prompt, a letter from a status message) proves it
 * cannot, so the fragment is safe to display immediately.
 *
 * a-f and t are here for the hex timestamp and its label. They widen the set,
 * but only by letters that terminal chatter rarely uses alone: "stop",
 * "reset", "delivered" and the summary lines all still contain a character
 * from outside it.
 */
export const SAMPLE_CHARS = /^[\d.,\s+\-VuAWshnt=a-f]*$/;

/**
 * Reply to the `acc` command, e.g. "6.342 mAh, 31.098 mWh". Cannot be confused
 * with a measurement row: the slow layout needs V/uA/uW/Vsh labels and the fast
 * one needs four bare numbers.
 */
const ACC_FORMAT = /^\s*(?:>\s*)*(-?\d+(?:\.\d+)?)\s*mAh\s*,\s*(-?\d+(?:\.\d+)?)\s*mWh\s*$/i;

export interface AccValues {
  /** coulombs */
  charge: number;
  /** joules */
  energy: number;
}

/** Parses an `acc` reply into SI base units, or null. */
export function matchAcc(line: string): AccValues | null {
  const m = ACC_FORMAT.exec(line);
  if (!m) return null;
  const mAh = parseFloat(m[1]!);
  const mWh = parseFloat(m[2]!);
  if (!isFinite(mAh) || !isFinite(mWh)) return null;
  return { charge: mAh * 3.6, energy: mWh * 3.6 };
}

/**
 * The echo the device prints back for a polled `acc`, so it can be hidden.
 *
 * The leading prompt matters: the device emits "> " without a trailing newline,
 * so the next line assembles as "> acc" rather than a bare "acc". Matching only
 * the bare form let every poll through into the log.
 */
export const ACC_ECHO = /^\s*(?:>\s*)*acc\s*$/i;

/**
 * A line that is built only from measurement characters and has the commas of
 * a sample row, yet does not parse as one: the wreckage of a row the device
 * cut in half.
 *
 * The firmware answers commands from a different context than the one writing
 * samples, so a reply can land mid-row. The `acc` poller makes this happen
 * about once a second in fast mode:
 *
 *     4                              <- row interrupted here
 *     > acc                          <- hidden by the poll filter
 *     6.342 mAh, 31.098 mWh          <- hidden by the poll filter
 *     .884,476156,2325631,4761562    <- orphaned tail, unparseable
 *
 * These are counted rather than silently dropped: losing one sample per poll
 * out of 4000 is harmless, but the user should be able to see it happening.
 */
export function looksLikeSampleFragment(line: string): boolean {
  return line.indexOf(",") >= 0 && SAMPLE_CHARS.test(line) && matchSample(line) === null;
}

/** Capture groups for a measurement line, or null. */
export function matchSample(line: string): RegExpExecArray | null {
  // Cheap reject first: both layouts are comma separated, most terminal
  // chatter is not. Skips two regex runs on the common case.
  if (line.indexOf(",") < 0) return null;
  for (const re of SAMPLE_FORMATS) {
    const m = re.exec(line);
    if (m) return m;
  }
  return null;
}

export interface EolCarrier {
  pendingCR: boolean;
}

/**
 * Collapses CRLF, bare CR and LF to a single LF so every device looks alike.
 *
 * `owner.pendingCR` carries a trailing CR across a chunk boundary. Without it
 * a CRLF split by the USB stack produces a phantom blank line: the CR ends the
 * real line, then the LF arriving in the next chunk ends an empty one. Every
 * caller must clear `pendingCR` whenever it resets its decoder.
 */
export function normaliseEol(owner: EolCarrier, s: string): string {
  if (owner.pendingCR && s.charCodeAt(0) === 10) s = s.slice(1);
  owner.pendingCR = s.charCodeAt(s.length - 1) === 13;
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** The stamp is the low 24 bits of the device's microsecond counter. */
export const TICK_WRAP = 0x100_0000;

/**
 * Turns the device's 24-bit microsecond stamps into a monotonic host-clock
 * timeline.
 *
 * Two jobs, both of which have to be right or the charts tear:
 *
 * Unwrapping. Six hex digits hold 16.777216 s, so the counter rolls over
 * roughly every 17 s of streaming. A stamp lower than its predecessor means
 * one rollover - unambiguous only because no gap in the stream comes close to
 * 16 s (the worst measured is the 23 ms LCD refresh). A device reboot would
 * look the same, but rebooting re-enumerates USB, which resets the reader.
 *
 * Anchoring. The device counts from its own power-on and knows nothing of the
 * host clock, yet the chart axis and the `acc` replies are already expressed
 * in host time. The two are tied together once, at the newest sample of the
 * first chunk that carries a stamp - the sample closest to the moment that
 * chunk arrived. Everything after that is device time, so the spacing is the
 * device's, not the USB stack's.
 *
 * The anchor is never adjusted afterwards. The two clocks drift by maybe a few
 * hundred parts per million, which is a fraction of a second per hour, and
 * re-anchoring to correct it would either move samples already drawn or make
 * the timeline jump backwards.
 */
export class TickClock {
  private prev = -1;
  private carry = 0;
  private base = NaN;

  reset(): void {
    this.prev = -1;
    this.carry = 0;
    this.base = NaN;
  }

  /** True once a stamp has been seen, so the caller can stop interpolating. */
  get anchored(): boolean { return Number.isFinite(this.base); }

  /** Absolute device microseconds for one raw stamp. Must be called in order. */
  absolute(raw: number): number {
    if (this.prev >= 0 && raw < this.prev) this.carry += TICK_WRAP;
    this.prev = raw;
    return this.carry + raw;
  }

  /**
   * Ties absolute device microseconds to the host clock. `hostT` is used only
   * the first time, and `newestUs` must be the newest sample of that chunk.
   */
  anchor(newestUs: number, hostT: number): void {
    if (!Number.isFinite(this.base)) this.base = hostT - newestUs / 1000;
  }

  /** Host-clock milliseconds for an absolute device microsecond count. */
  toHost(us: number): number { return this.base + us / 1000; }
}

export type SampleSink = (t: number, v: number, i: number, p: number, s: number) => void;
export type AccSink = (t: number, acc: AccValues) => void;
/** Every line that is neither a sample, an acc reply, nor wreckage. */
export type TextSink = (line: string) => void;

/**
 * Reassembles lines from the raw byte stream and hands measurement rows to a
 * sink, converted to SI base units.
 *
 * This runs on arrival rather than in the render path, so it keeps working
 * while the terminal is paused or showing a hex dump, and so replaying the
 * byte buffer on a view change cannot feed the charts twice.
 */
export class SampleScanner implements EolCarrier {
  private decoder = new TextDecoder("utf-8", { fatal: false });
  private buf = "";
  private lastT = 0;
  private batch: number[] = [];
  /* Absolute device microseconds per batched sample, NaN where the firmware
     sent no stamp. Parallel to `batch`, one entry per four. */
  private stamps: number[] = [];
  private clock = new TickClock();
  /* Measured sample rate, in samples per second. Reported for the status bar.
     On stamped firmware it no longer places anything; on older firmware it is
     what flushBatch spaces samples by. A nominal figure declared by the device
     would be the intended rate rather than the achieved one - which diverges
     exactly when the device cannot keep up. */
  private rate = 0;
  private rateCount = 0;
  private rateSince = 0;
  pendingCR = false;
  /** Rows the device cut in half; see looksLikeSampleFragment. */
  mangled = 0;

  constructor(
    private readonly sink: SampleSink,
    private readonly accSink?: AccSink,
    private readonly textSink?: TextSink,
  ) {}

  reset(): void {
    this.decoder = new TextDecoder("utf-8", { fatal: false });
    this.buf = "";
    this.pendingCR = false;
    this.lastT = 0;
    this.batch.length = 0;
    this.stamps.length = 0;
    this.clock.reset();
    this.mangled = 0;
    this.rate = 0;
    this.rateCount = 0;
    this.rateSince = 0;
  }

  /** Samples per second, measured; zero until enough have arrived. */
  get samplesPerSecond(): number { return this.rate; }

  /** True once the device has stamped a sample, so nothing is being guessed. */
  get deviceTimed(): boolean { return this.clock.anchored; }

  private trackRate(n: number, tEnd: number): void {
    if (!this.rateSince) { this.rateSince = tEnd; return; }
    this.rateCount += n;
    const elapsed = tEnd - this.rateSince;
    if (elapsed < 500) return;
    const measured = (this.rateCount * 1000) / elapsed;
    // Smoothed: the rate is used to space samples, and a jittery one would
    // show up as the trace breathing.
    this.rate = this.rate > 0 ? this.rate * 0.7 + measured * 0.3 : measured;
    this.rateCount = 0;
    this.rateSince = tEnd;
  }

  feed(t: number, data: Uint8Array): void {
    let s = this.decoder.decode(data, { stream: true });
    if (!s) return;
    s = normaliseEol(this, s);
    if (s) {
      this.buf += s;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        this.parse(this.buf.slice(0, nl), t);
        this.buf = this.buf.slice(nl + 1);
      }
      // A device that never sends a newline must not grow this without bound.
      if (this.buf.length > 8192) this.buf = this.buf.slice(-1024);
    }
    this.flushBatch(t);
  }

  // `t` is this chunk's arrival time. Samples get interpolated timestamps in
  // flushBatch, but an acc reply is a single event and must be stamped now -
  // it used to take `lastT`, which is the PREVIOUS chunk's time.
  private parse(line: string, t: number): void {
    const m = matchSample(line);
    if (!m) {
      if (this.accSink) {
        const acc = matchAcc(line);
        if (acc) {
          this.accSink(t, acc);
          return;
        }
      }
      if (looksLikeSampleFragment(line)) this.mangled++;
      else if (line.trim()) this.textSink?.(line);
      return;
    }
    const v = parseFloat(m[1]!);
    const i = parseFloat(m[2]!) / 1e6;   // uA -> A
    const p = parseFloat(m[3]!) / 1e6;   // uW -> W
    const s = parseFloat(m[4]!) / 1e9;   // nV -> V
    if (!isFinite(v) || !isFinite(i) || !isFinite(p) || !isFinite(s)) return;
    const stamp = m[5];
    this.batch.push(v, i, p, s);
    this.stamps.push(stamp === undefined ? NaN : this.clock.absolute(parseInt(stamp, 16)));
  }

  /**
   * Emits the chunk's samples, preferring the device's own timestamps and
   * falling back to interpolation for firmware that sends none.
   */
  private flushBatch(tEnd: number): void {
    const n = this.batch.length / 4;
    if (n === 0) {
      this.lastT = Math.max(this.lastT, tEnd);
      return;
    }

    this.trackRate(n, tEnd);

    if (Number.isFinite(this.stamps[n - 1])) {
      this.emitStamped(n, tEnd);
      return;
    }

    if (!(this.lastT > 0)) this.lastT = tEnd - n;
    const avail = tEnd - this.lastT;

    // Spacing from the measured cadence when there is one. Dividing the
    // arrival interval by n instead inherits USB jitter, which is visible once
    // you zoom in: samples 250 us apart placed by a clock that moves in jumps.
    let step = this.rate > 0 ? 1000 / this.rate : avail / n;
    if (!(step > 0)) step = 0.05;

    // A gap far longer than the samples account for is real - the device
    // stalled - so anchor at the arrival and leave the gap visible rather than
    // stretching the samples across it.
    const spanned = n * step;
    let first: number;
    if (avail > spanned * 1.5) {
      first = tEnd - (n - 1) * step;
    } else {
      // Continuous with the previous batch. Crucially this never goes
      // backwards: two chunks can share an arrival timestamp because
      // performance.now() is quantised to about 100 us, and the old fallback
      // then rewound by inventing 1 ms per sample - 565 backward steps in a
      // 50 s capture, which the charts drew as tears.
      first = this.lastT + step;
    }

    for (let k = 0; k < n; k++) {
      const o = k * 4;
      this.sink(first + k * step,
                this.batch[o]!, this.batch[o + 1]!, this.batch[o + 2]!, this.batch[o + 3]!);
    }
    this.batch.length = 0;
    this.stamps.length = 0;
    this.lastT = first + (n - 1) * step;
  }

  /**
   * Emits a chunk using the timestamps the device put on each sample.
   *
   * This is the whole point of the stamp. USB hands over a chunk at one
   * instant, so a reader without stamps has to invent the spacing inside it,
   * and the only thing it can invent is an even one. The spacing is not even:
   * the 250 ms LCD refresh alone stops acquisition for runs of up to 23 ms,
   * and an evenly spaced reader smears those samples over the pause instead of
   * drawing it. Between-session rates of 3752 and 3779 sps were the visible
   * symptom; the real error was inside every session.
   *
   * A sample with no stamp can only be one the firmware predates, so the
   * fallback is chosen per chunk on the newest sample rather than per sample.
   */
  private emitStamped(n: number, tEnd: number): void {
    this.clock.anchor(this.stamps[n - 1]!, tEnd);
    let last = this.lastT;
    for (let k = 0; k < n; k++) {
      const o = k * 4;
      const us = this.stamps[k]!;
      // A sample with no stamp among stamped ones would be a fragment that
      // reassembled wrongly. Placing it just after its predecessor keeps the
      // series monotonic without pretending to know when it happened.
      const t = Number.isFinite(us) ? this.clock.toHost(us) : last;
      last = t;
      this.sink(t, this.batch[o]!, this.batch[o + 1]!, this.batch[o + 2]!, this.batch[o + 3]!);
    }
    this.batch.length = 0;
    this.stamps.length = 0;
    this.lastT = last;
  }
}
