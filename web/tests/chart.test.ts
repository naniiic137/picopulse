import { describe, expect, it, vi } from 'vitest';
import { invalidateThemeColors, niceTicks, themeColors, withAlpha } from '../src/chart';

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

describe('chart colours', () => {
  it('converts hex colours to rgba once', () => {
    expect(withAlpha('#ffb547', 0.25)).toBe('rgba(255, 181, 71, 0.25)');
    expect(withAlpha('red', 0.5)).toBe('red');
  });

  it('reads the CSS theme colours once and caches them', () => {
    const getPropertyValue = vi.fn((name: string) => (name === '--grid' ? ' #1b2430 ' : ''));
    const getComputedStyle = vi.fn(() => ({ getPropertyValue }));
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', getComputedStyle);
    try {
      invalidateThemeColors();
      const first = themeColors();
      for (let i = 0; i < 100; i++) themeColors();
      expect(getComputedStyle).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ grid: '#1b2430', muted: '#889', danger: '#ff5d5d' });
      invalidateThemeColors();
      themeColors();
      expect(getComputedStyle).toHaveBeenCalledTimes(2);
    } finally {
      invalidateThemeColors();
      vi.unstubAllGlobals();
    }
  });
});
