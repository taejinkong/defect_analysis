import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTING_SPECS,
  changedKeys,
  formatSetting,
  sanitizeSettings,
} from './settings';
import { gradeDarkDot } from './verdict';

describe('SETTING_SPECS', () => {
  it('covers every user-facing settings key exactly once', () => {
    const keys = SETTING_SPECS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      Object.keys(DEFAULT_SETTINGS).filter((key) => key !== 'pattern.min_confirmations').sort(),
    );
  });

  it('places every default inside its own slider range', () => {
    for (const spec of SETTING_SPECS) {
      const value = DEFAULT_SETTINGS[spec.key];
      expect(value, spec.key).toBeGreaterThanOrEqual(spec.min);
      expect(value, spec.key).toBeLessThanOrEqual(spec.max);
    }
  });
});

describe('sanitizeSettings', () => {
  it('returns the defaults for empty input', () => {
    const { settings, repaired } = sanitizeSettings({});
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(repaired).toEqual([]);
  });

  it('tolerates null and non-objects', () => {
    expect(sanitizeSettings(null).settings).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(undefined).settings).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores unknown keys and keeps known ones', () => {
    const { settings } = sanitizeSettings({ 'blob.min_area_px': 42, nonsense: 1 });
    expect(settings['blob.min_area_px']).toBe(42);
    expect('nonsense' in settings).toBe(false);
  });

  it('drops values of the wrong type', () => {
    const { settings } = sanitizeSettings({ 'blob.min_area_px': 'big', 'line.min_aspect_ratio': NaN });
    expect(settings['blob.min_area_px']).toBe(DEFAULT_SETTINGS['blob.min_area_px']);
    expect(settings['line.min_aspect_ratio']).toBe(DEFAULT_SETTINGS['line.min_aspect_ratio']);
  });

  it('clamps out-of-range values and says so', () => {
    const { settings, repaired } = sanitizeSettings({ 'dark.residual_threshold': 9999 });
    expect(settings['dark.residual_threshold']).toBe(120);
    expect(repaired.join(' ')).toContain('범위 밖');
  });

  it('repairs an inverted dark-dot band instead of leaving 암점 中 unreachable', () => {
    // 小 <= 10 and 中 <= 5 would make the 中 band empty: any ratio above 10
    // jumps straight to 大.
    const { settings, repaired } = sanitizeSettings({
      'dark_dot.small_max_pct': 10,
      'dark_dot.medium_max_pct': 5,
    });
    expect(settings['dark_dot.medium_max_pct']).toBeGreaterThan(settings['dark_dot.small_max_pct']);
    expect(repaired.join(' ')).toContain('암점 中');

    // And the repaired band actually produces all three grades.
    expect(gradeDarkDot(5, settings)).toBe('D001');
    expect(gradeDarkDot(10.05, settings)).toBe('D002');
    expect(gradeDarkDot(20, settings)).toBe('D003');
  });

  it('repairs an inverted region band', () => {
    const { settings, repaired } = sanitizeSettings({
      'region.center_max_r': 0.5,
      'region.mid_max_r': 0.3,
    });
    expect(settings['region.mid_max_r']).toBeGreaterThan(settings['region.center_max_r']);
    expect(repaired.join(' ')).toContain('mid');
  });

  it('keeps the thick-Line aspect threshold at or below the regular threshold', () => {
    const { settings, repaired } = sanitizeSettings({
      'line.min_aspect_ratio': 5,
      'line.thick_min_aspect_ratio': 9,
    });
    expect(settings['line.thick_min_aspect_ratio']).toBe(5);
    expect(repaired.join(' ')).toContain('두꺼운 Line');
  });

  it('round-trips through JSON', () => {
    const tuned = { ...DEFAULT_SETTINGS, 'dark.residual_threshold': 33, 'line.min_aspect_ratio': 12.5 };
    const { settings, repaired } = sanitizeSettings(JSON.parse(JSON.stringify(tuned)));
    expect(settings).toEqual(tuned);
    expect(repaired).toEqual([]);
  });
});

describe('changedKeys', () => {
  it('is empty for the defaults', () => {
    expect(changedKeys(DEFAULT_SETTINGS)).toEqual([]);
  });

  it('lists only what moved', () => {
    expect(changedKeys({ ...DEFAULT_SETTINGS, 'blob.min_area_px': 9 })).toEqual(['blob.min_area_px']);
  });
});

describe('formatSetting', () => {
  it('applies precision and unit', () => {
    expect(formatSetting('blob.min_area_px', 6)).toBe('6px');
    expect(formatSetting('line.min_length_ratio', 0.4)).toBe('0.40');
    expect(formatSetting('dark_dot.small_max_pct', 5)).toBe('5.0%');
  });
});
