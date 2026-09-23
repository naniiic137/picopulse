import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Row } from '../src/csv';
import { AnnounceThrottle, RedrawGate, RowBuffer, SeqTracker, formatUptime, nearestRateIndex } from '../src/session';

const row = (received: number, seq = received): Row => ({
  received,
  msg: { t: 'tel', seq, ms: received, temp: 25, adc0: null },
});

describe('RowBuffer', () => {
  it('keeps rows in order up to its capacity, dropping the oldest', () => {
    const b = new RowBuffer(3, Infinity);
    for (let i = 1; i <= 5; i++) b.push(row(i));
    expect(b.length).toBe(3);
    expect(b.toArray().map((r) => r.msg.seq)).toEqual([3, 4, 5]);
    expect(b.dropped).toBe(2);
  });

  it('drops rows older than maxAgeMs', () => {
    const b = new RowBuffer(100, 1000);
    b.push(row(0));
    b.push(row(500));
    b.push(row(1200)); // row 0 is now 1200 ms old
    expect(b.toArray().map((r) => r.received)).toEqual([500, 1200]);
    b.trim(2000);
    expect(b.toArray().map((r) => r.received)).toEqual([1200]);
  });

  it('stays bounded over a long session', () => {
    const b = new RowBuffer(36_000, 30 * 60_000);
    for (let t = 0; t < 3 * 3600_000; t += 50) b.push(row(t)); // 3 h at 20 Hz
    expect(b.length).toBe(36_000);
    const rows = b.toArray();
    expect(rows[rows.length - 1].received - rows[0].received).toBeLessThanOrEqual(30 * 60_000);
  });

  it('clears', () => {
    const b = new RowBuffer(2, Infinity);
    b.push(row(1));
    b.push(row(2));
    b.push(row(3));
    b.clear();
    expect(b.length).toBe(0);
    expect(b.dropped).toBe(0);
    b.push(row(4));
    expect(b.toArray().map((r) => r.msg.seq)).toEqual([4]);
  });
});

describe('SeqTracker', () => {
  it('counts gaps and detects restarts', () => {
    const s = new SeqTracker();
    expect(s.update(5)).toBe('ok');
    expect(s.update(6)).toBe('ok');
    expect(s.update(9)).toBe('gap');
    expect(s.lost).toBe(2);
    expect(s.update(1)).toBe('restart');
    expect(s.update(2)).toBe('ok');
    expect(s.lost).toBe(2);
  });
});

describe('RedrawGate', () => {
  it('draws only when something changed, at most maxFps', () => {
    const g = new RedrawGate(30, 500);
    const frames = Array.from({ length: 60 }, (_, i) => i * (1000 / 60)); // one second at 60 Hz
    let draws = 0;
    for (const t of frames) {
      g.markDirty(); // new data on every frame
      if (g.shouldDraw(t, true)) draws++;
    }
    expect(draws).toBe(30);
  });

  it('does not redraw an idle dashboard', () => {
    const g = new RedrawGate(30, 500);
    expect(g.shouldDraw(0, false)).toBe(true); // first paint
    let draws = 0;
    for (let t = 16; t < 10_000; t += 16) if (g.shouldDraw(t, false)) draws++;
    expect(draws).toBe(0);
    g.markDirty();
    expect(g.shouldDraw(10_000, false)).toBe(true);
  });

  it('keeps the time axis moving slowly while streaming at a low rate', () => {
    const g = new RedrawGate(30, 500);
    g.shouldDraw(0, true);
    let draws = 0;
    for (let t = 16; t <= 5000; t += 16) if (g.shouldDraw(t, true)) draws++;
    expect(draws).toBeGreaterThanOrEqual(9);
    expect(draws).toBeLessThanOrEqual(10);
  });
});

describe('AnnounceThrottle', () => {
  afterEach(() => vi.useRealTimers());

  it('announces immediately, then at most once per gap with the latest text', () => {
    vi.useFakeTimers();
    const said: string[] = [];
    const a = new AnnounceThrottle(5000, (t) => said.push(t), () => Date.now());
    a.say('Alert: 31 °C');
    a.say('Back to 29 °C');
    a.say('Alert: 32 °C');
    expect(said).toEqual(['Alert: 31 °C']);
    vi.advanceTimersByTime(4999);
    expect(said).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(said).toEqual(['Alert: 31 °C', 'Alert: 32 °C']);
    vi.advanceTimersByTime(10_000);
    expect(said).toHaveLength(2);
    a.say('Back to 29 °C');
    expect(said).toHaveLength(3);
  });

  it('cancel() drops a pending announcement', () => {
    vi.useFakeTimers();
    const said: string[] = [];
    const a = new AnnounceThrottle(1000, (t) => said.push(t), () => Date.now());
    a.say('one');
    a.say('two');
    a.cancel();
    vi.advanceTimersByTime(5000);
    expect(said).toEqual(['one']);
  });
});

describe('formatting helpers', () => {
  it('formats uptime, including multi-day runs', () => {
    expect(formatUptime(65_000)).toBe('01:05');
    expect(formatUptime(3_725_000)).toBe('1:02:05');
    expect(formatUptime(7 * 86_400_000 + 3_725_000)).toBe('7d 01:02:05');
    expect(formatUptime(-5)).toBe('00:00');
  });

  it('picks the nearest slider rate', () => {
    const rates = [0.2, 0.5, 1, 2, 5, 10, 20];
    expect(nearestRateIndex(rates, 2)).toBe(3);
    expect(nearestRateIndex(rates, 7)).toBe(4);
    expect(nearestRateIndex(rates, 100)).toBe(6);
  });
});
