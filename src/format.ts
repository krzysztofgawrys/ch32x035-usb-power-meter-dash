/** Engineering-prefix number formatting shared by the charts. */

export interface Prefix {
  readonly m: number;
  readonly p: string;
}

const PREFIXES: readonly Prefix[] = [
  { m: 1e9, p: "G" }, { m: 1e6, p: "M" }, { m: 1e3, p: "k" },
  { m: 1, p: "" }, { m: 1e-3, p: "m" }, { m: 1e-6, p: "u" },
  { m: 1e-9, p: "n" }, { m: 1e-12, p: "p" },
];

const UNITY = PREFIXES[3]!;

/**
 * Prefix for a whole axis, chosen from its largest magnitude. Picking per
 * value would make tick labels jump between units within one axis.
 */
export function pickPrefix(maxAbs: number): Prefix {
  if (!Number.isFinite(maxAbs) || maxAbs === 0) return UNITY;
  for (const e of PREFIXES) if (maxAbs >= e.m) return e;
  return PREFIXES[PREFIXES.length - 1]!;
}

export function fmtWith(value: number, pref: Prefix, unit: string, digits?: number): string {
  const scaled = value / pref.m;
  const abs = Math.abs(scaled);
  const d = digits ?? (abs >= 100 ? 1 : abs >= 10 ? 2 : 3);
  return `${scaled.toFixed(d)} ${pref.p}${unit}`;
}

export function fmtAuto(value: number, unit: string, digits?: number): string {
  return fmtWith(value, pickPrefix(Math.abs(value)), unit, digits);
}
