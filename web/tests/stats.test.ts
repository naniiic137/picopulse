import { describe, expect, it } from 'vitest';
import { Series, ThresholdAlert, measuredRate, summarize } from '../src/stats';

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
