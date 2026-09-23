import { describe, expect, it } from 'vitest';
import { CSV_HEADER, toCsv } from '../src/csv';

describe('toCsv', () => {
  it('writes a header and one row per sample, blanks for nulls', () => {
    const csv = toCsv([
      {
        received: Date.UTC(2026, 0, 1),
        msg: { t: 'tel', seq: 1, ms: 500, temp: 24.5, temp_raw: 25, adc0: null, mem: 1000, led: true },
      },
    ]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(CSV_HEADER.join(','));
    expect(lines[1]).toBe('2026-01-01T00:00:00.000Z,1,500,24.5,25,,1000,1');
  });

  it('only writes the header for an empty session', () => {
    expect(toCsv([])).toBe(CSV_HEADER.join(',') + '\r\n');
  });
});
