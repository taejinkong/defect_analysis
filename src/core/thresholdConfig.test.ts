import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import {
  createThresholdConfig,
  duplicateThresholdConfig,
  thresholdConfigToSettings,
  validateThresholdConfig,
} from './thresholdConfig';

describe('versioned threshold config', () => {
  it('round-trips every engine setting through the structured config', () => {
    const tuned = { ...DEFAULT_SETTINGS, 'bright.w_residual_threshold': 17 };
    const config = createThresholdConfig(tuned, '2.3.4', 'reviewer');
    expect(config.version).toBe('2.3.4');
    expect(config.updatedBy).toBe('reviewer');
    expect(thresholdConfigToSettings(config)).toEqual(tuned);
    expect(validateThresholdConfig(config)).toMatchObject({ ok: true, migratedLegacy: false });
  });

  it('rejects invalid input instead of repairing and applying it', () => {
    const config = createThresholdConfig();
    const invalid = {
      ...config,
      darkDot: { ...config.darkDot, smallMaxPct: 20, mediumMaxPct: 5 },
    };
    const result = validateThresholdConfig(invalid);
    expect(result.ok).toBe(false);
    expect(result.config).toBeUndefined();
    expect(result.errors.join(' ')).toContain('암점 中');
  });

  it('migrates a valid legacy flat settings JSON', () => {
    const legacy = { ...DEFAULT_SETTINGS, 'blob.min_area_px': 12 };
    const result = validateThresholdConfig(legacy);
    expect(result.ok).toBe(true);
    expect(result.migratedLegacy).toBe(true);
    expect(thresholdConfigToSettings(result.config!)['blob.min_area_px']).toBe(12);
  });

  it('duplicates a version without mutating the source', () => {
    const original = createThresholdConfig(DEFAULT_SETTINGS, '1.4.9');
    const duplicate = duplicateThresholdConfig(original, 'admin');
    expect(duplicate.version).toBe('1.4.10');
    expect(duplicate.updatedBy).toBe('admin');
    expect(original.version).toBe('1.4.9');
    expect(thresholdConfigToSettings(duplicate)).toEqual(DEFAULT_SETTINGS);
  });
});
