/**
 * Readings of the device's hardware accumulators (INA228 CHARGE / ENERGY).
 *
 * These integrate every ADC conversion inside the chip, so they are exact in a
 * way the app's own Riemann sum over transmitted samples can never be: whatever
 * the firmware does not send simply never reaches us. The app polls `acc` on a
 * timer and keeps the answers here, so the difference between two readings
 * gives the true charge and energy for the interval between them.
 *
 * Values are stored in SI base units (coulombs, joules) like everything else;
 * the device reports mAh and mWh.
 */

export interface AccReading {
  /** ms since epoch, taken when the reply arrived. */
  readonly t: number;
  readonly charge: number;   // coulombs
  readonly energy: number;   // joules
}

export interface AccDelta {
  readonly charge: number;   // coulombs
  readonly energy: number;   // joules
  readonly seconds: number;
}

/** Roughly an hour at one poll per second. */
const MAX_READINGS = 7200;

export class AccumulatorLog {
  private readings: AccReading[] = [];

  /* Smallest positive step the device has ever reported, i.e. the resolution
     of its printed value. At microamp currents a short window can sit entirely
     below it, and the device then reports no change at all - worth saying
     "< one step" instead of a bare zero that reads like a fault. */
  private chargeStep = Infinity;
  private energyStep = Infinity;

  /** Times the device reported a value lower than the one before it. */
  backwards = 0;

  push(t: number, charge: number, energy: number): void {
    const last = this.readings[this.readings.length - 1];
    if (last && t <= last.t) return;          // out of order; keep it monotonic
    if (last) {
      const dq = charge - last.charge;
      const de = energy - last.energy;
      if (dq > 0 && dq < this.chargeStep) this.chargeStep = dq;
      if (de > 0 && de < this.energyStep) this.energyStep = de;
      // Counted, not swallowed: deltaOver has to skip the step, but a device
      // whose accumulator runs backwards is something the user must see.
      if (dq < 0 || de < 0) this.backwards++;
    }
    this.readings.push({ t, charge, energy });
    if (this.readings.length > MAX_READINGS) {
      this.readings = this.readings.slice(-MAX_READINGS);
    }
  }

  clear(): void {
    this.readings = [];
    this.chargeStep = Infinity;
    this.energyStep = Infinity;
    this.backwards = 0;
  }

  /** Reported resolution, or null before two distinct readings have arrived. */
  get resolution(): { charge: number; energy: number } | null {
    return isFinite(this.chargeStep) && isFinite(this.energyStep)
      ? { charge: this.chargeStep, energy: this.energyStep }
      : null;
  }

  get count(): number { return this.readings.length; }

  latest(): AccReading | null {
    return this.readings[this.readings.length - 1] ?? null;
  }

  /**
   * Charge and energy accumulated across the range, summed step by step.
   *
   * A negative step means the device-side accumulator was reset between two
   * readings. Only that one step is skipped, not the whole range: the earlier
   * segment is still real charge, and the part between the last reading and
   * the reset instant is simply unknowable.
   *
   * Discarding the whole window instead - the first attempt - meant that after
   * an `acc reset` the figures never came back on a wide window, because the
   * pre-reset reading stayed in range forever.
   *
   * Null only when fewer than two readings fall in the range, so the caller can
   * say "not enough data" rather than show a misleading zero.
   */
  deltaOver(tStart: number, tEnd: number): AccDelta | null {
    let first: AccReading | undefined;
    let last: AccReading | undefined;
    let prev: AccReading | undefined;
    let charge = 0;
    let energy = 0;

    for (const r of this.readings) {
      if (r.t < tStart) continue;
      if (r.t > tEnd) break;
      first ??= r;
      last = r;
      if (prev) {
        const dq = r.charge - prev.charge;
        const de = r.energy - prev.energy;
        if (dq >= 0 && de >= 0) {
          charge += dq;
          energy += de;
        }
      }
      prev = r;
    }

    if (!first || !last || first === last) return null;
    return { charge, energy, seconds: (last.t - first.t) / 1000 };
  }

}
