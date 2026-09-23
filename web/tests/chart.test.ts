import { describe, expect, it } from 'vitest';
import { niceTicks } from '../src/chart';

describe('niceTicks', () => {
  it('picks round steps', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(23.2, 26.9, 4)).toEqual([24, 26]);
    expect(niceTicks(23.2, 26.9, 6)).toEqual([24, 25, 26]);
  });

  it('returns nothing for an empty or invalid range', () => {
    expect(niceTicks(5, 5)).toEqual([]);
    expect(niceTicks(NaN, 1)).toEqual([]);
  });
});
