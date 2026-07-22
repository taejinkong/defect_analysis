import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSPECTION_PROFILE,
  profileReadyForAutomaticNoDisplay,
  profileWarnings,
  validateInspectionProfile,
} from './inspectionProfile';

describe('inspection profile', () => {
  it('validates the shipped profile but does not call it production-ready', () => {
    expect(validateInspectionProfile(DEFAULT_INSPECTION_PROFILE).ok).toBe(true);
    expect(profileReadyForAutomaticNoDisplay(DEFAULT_INSPECTION_PROFILE, '')).toBe(false);
  });

  it('requires matching validated capture and golden versions for automatic no-display', () => {
    const profile = {
      ...DEFAULT_INSPECTION_PROFILE,
      capture: { ...DEFAULT_INSPECTION_PROFILE.capture, validated: true },
      golden: { ...DEFAULT_INSPECTION_PROFILE.golden, validated: true, model: 'WATCH-A' },
    };
    expect(profileReadyForAutomaticNoDisplay(profile, 'WATCH-A')).toBe(true);
    expect(profileReadyForAutomaticNoDisplay(profile, 'WATCH-B')).toBe(false);
  });

  it('surfaces auto-camera controls as repeatability warnings', () => {
    const profile = {
      ...DEFAULT_INSPECTION_PROFILE,
      capture: { ...DEFAULT_INSPECTION_PROFILE.capture, autoExposure: true, autoWhiteBalance: true },
    };
    expect(profileWarnings(profile, '').join(' ')).toContain('자동 노출');
    expect(profileWarnings(profile, '').join(' ')).toContain('자동 화이트밸런스');
  });
});
