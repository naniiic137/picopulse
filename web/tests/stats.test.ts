import { describe, expect, it } from 'vitest';
import { Series, THRESHOLD_MAX, THRESHOLD_MIN, ThresholdAlert, measuredRate, parseThreshold, summarize } from '../src/stats';

describe('summarize', () => {
  it('computes min, max and mean', () => {
    expect(summarize([3, 1, 2, 6])).toEqual({ count: 4, min: 1, max: 6, avg: 3 });
  });

  it('returns NaNs for no data and ignores non-finite values', () => {
    const empty = summarize([]);
    expect(empty.count).toBe(0);
    expect(empty.avg).toBeNaN();
    expect(summarize([NaN, 5, Infinity])).toEqual({ count: 1, min: 5, max: 5, avg: 5 });
  });
});

describe('Series', () => {
  it('keeps samples in order and wraps at capacity', () => {
    const s = new Series(3);
    [10, 20, 30, 40].forEach((v, i) => s.push(i * 100, v));
    expect(s.length).toBe(3);
    expect([s.valueAt(0), s.valueAt(1), s.valueAt(2)]).toEqual([20, 30, 40]);
    expect(s.timeAt(0)).toBe(100);
    expect(s.last()).toBe(40);
  });

  it('computes stats over a time window', () => {
    const s = new Series(100);
    for (let i = 0; i < 10; i++) s.push(i * 1000, i);
    expect(s.stats()).toMatchObject({ count: 10, min: 0, max: 9, avg: 4.5 });
    expect(s.stats(7000)).toMatchObject({ count: 3, min: 7, max: 9, avg: 8 });
  });

  it('clear() empties the series', () => {
    const s = new Series(4);
    s.push(0, 1);
    s.clear();
    expect(s.length).toBe(0);
    expect(s.last()).toBeUndefined();
    expect(s.stats().count).toBe(0);
  });
});

describe('ThresholdAlert', () => {
  it('raises once, stays raised inside the hysteresis band, then clears', () => {
    const a = new ThresholdAlert(30, 0.5);
    expect(a.update(29.9)).toBeNull();
    expect(a.update(30)).toBe('raised');
    expect(a.update(31)).toBeNull();
    expect(a.update(29.7)).toBeNull(); // still within 0.5 of the limit
    expect(a.active).toBe(true);
    expect(a.update(29.4)).toBe('cleared');
    expect(a.active).toBe(false);
  });

  it('ignores missing readings', () => {
    const a = new ThresholdAlert(30);
    expect(a.update(null)).toBeNull();
    expect(a.update(NaN)).toBeNull();
    expect(a.active).toBe(false);
  });
});

describe('measuredRate', () => {
  it('estimates messages per second from arrival times', () => {
    expect(measuredRate([0, 100, 200, 300, 400])).toBeCloseTo(10);
    expect(measuredRate([0])).toBe(0);
  });
});

describe('parseThreshold', () => {
  it('accepts temperatures in the RP2040 sensor range', () => {
    expect(parseThreshold('30')).toEqual({ ok: true, value: 30 });
    expect(parseThreshold(' 42.5 ')).toEqual({ ok: true, value: 42.5 });
    expect(parseThreshold('42,5')).toEqual({ ok: true, value: 42.5 });
    expect(parseThreshold('0')).toEqual({ ok: true, value: 0 });
    expect(parseThreshold('-0')).toEqual({ ok: true, value: 0 });
    expect(parseThreshold(String(THRESHOLD_MIN))).toEqual({ ok: true, value: -40 });
    expect(parseThreshold(String(THRESHOLD_MAX))).toEqual({ ok: true, value: 125 });
  });

  it('does not treat an empty field as 0 °C', () => {
    for (const raw of ['', '   ', null, undefined]) {
      expect(parseThreshold(raw)).toEqual({ ok: false, error: 'Enter a temperature.' });
    }
  });

  it('rejects values outside -40..125 °C', () => {
    for (const raw of ['-500', '1e9', '125.5', '-40.1', '1e3']) {
      const r = parseThreshold(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/-40 to 125 °C/);
    }
  });

  it('rejects text that is not a number', () => {
    for (const raw of ['abc', '30C', '1.2.3', 'NaN', 'Infinity', '--5', '0x20']) {
      expect(parseThreshold(raw).ok, raw).toBe(false);
    }
  });

  it('accepts exponent notation only when the result is in range', () => {
    expect(parseThreshold('3e1')).toEqual({ ok: true, value: 30 });
  });
});
