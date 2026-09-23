/** Fixed-capacity ring buffer of numeric samples with O(n) summary stats. */
export class Series {
  private readonly t: Float64Array;
  private readonly v: Float64Array;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.t = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
  }

  push(time: number, value: number): void {
    this.t[this.head] = time;
    this.v[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  get length(): number {
    return this.count;
  }

  /** i = 0 is the oldest sample. */
  timeAt(i: number): number {
    return this.t[(this.head - this.count + i + this.capacity) % this.capacity];
  }

  valueAt(i: number): number {
    return this.v[(this.head - this.count + i + this.capacity) % this.capacity];
  }

  last(): number | undefined {
    return this.count ? this.valueAt(this.count - 1) : undefined;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Stats of the samples newer than `since` (all samples if omitted). */
  stats(since = -Infinity): Stats {
    const values: number[] = [];
    for (let i = 0; i < this.count; i++) {
      if (this.timeAt(i) >= since) values.push(this.valueAt(i));
    }
    return summarize(values);
  }
}

export interface Stats {
  count: number;
  min: number;
  max: number;
  avg: number;
}

export const EMPTY_STATS: Stats = { count: 0, min: NaN, max: NaN, avg: NaN };

export function summarize(values: readonly number[]): Stats {
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const x of values) {
    if (!Number.isFinite(x)) continue;
    count++;
    sum += x;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (count === 0) return { ...EMPTY_STATS };
  return { count, min, max, avg: sum / count };
}

/**
 * Threshold alert with hysteresis, so a value hovering right at the limit
 * does not fire an alert on every sample.
 * Fires when value >= threshold, clears when value < threshold - hysteresis.
 */
export class ThresholdAlert {
  active = false;

  constructor(
    public threshold: number,
    public hysteresis = 0.5,
  ) {}

  /** Returns 'raised' / 'cleared' on a state change, otherwise null. */
  update(value: number | null): 'raised' | 'cleared' | null {
    if (value === null || !Number.isFinite(value)) return null;
    if (!this.active && value >= this.threshold) {
      this.active = true;
      return 'raised';
    }
    if (this.active && value < this.threshold - this.hysteresis) {
      this.active = false;
      return 'cleared';
    }
    return null;
  }
}

/** The RP2040 temperature sensor's rated range: an alert outside it could never fire (or always would). */
export const THRESHOLD_MIN = -40;
export const THRESHOLD_MAX = 125;
export const DEFAULT_THRESHOLD = 30;

export type ThresholdParse = { ok: true; value: number } | { ok: false; error: string };

/**
 * Validates the alert limit typed by the user. Empty is not 0 °C, and
 * "1e9" or "-500" are not temperatures the Pico can report.
 */
export function parseThreshold(raw: string | null | undefined): ThresholdParse {
  const text = (raw ?? '').trim().replace(',', '.');
  if (text === '') return { ok: false, error: 'Enter a temperature.' };
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return { ok: false, error: 'Enter a number, e.g. 30 or 42.5.' };
  const value = Number(text);
  if (value < THRESHOLD_MIN || value > THRESHOLD_MAX) {
    return { ok: false, error: `Use ${THRESHOLD_MIN} to ${THRESHOLD_MAX} °C, the RP2040 sensor range.` };
  }
  // -0 would be displayed as "0" but stored as "-0".
  return { ok: true, value: value === 0 ? 0 : value };
}

/** Rolling rate estimate (messages per second) from arrival timestamps. */
export function measuredRate(times: readonly number[]): number {
  if (times.length < 2) return 0;
  const span = times[times.length - 1] - times[0];
  return span > 0 ? ((times.length - 1) * 1000) / span : 0;
}
