import { describe, expect, it } from 'vitest';
import { createRgba } from './image';
import { normalizeFrame } from './normalize';
import { detectActiveCircle } from './preprocess';
import { evaluatePreprocessingQuality } from './preprocessingQuality';
import { REVIEW_REASON } from './review';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import { renderSyntheticPanel } from './synthetic';

const RELAXED: Settings = {
  ...DEFAULT_SETTINGS,
  'preprocessing.min_circle_confidence': 0.1,
  'preprocessing.min_fpcb_strength': 0.5,
  'preprocessing.max_clipping_ratio': 1,
  'preprocessing.min_blur_score': 0,
  'preprocessing.min_mean_luminance': 0,
  'preprocessing.max_mean_luminance': 255,
  'preprocessing.max_saturation_ratio': 1,
};

describe('preprocessing quality', () => {
  it('measures a valid synthetic capture and passes it', () => {
    const source = renderSyntheticPanel({ pattern: 'W', noise: 3 });
    const detect = detectActiveCircle(source);
    expect(detect.ok).toBe(true);
    if (!detect.ok) return;
    const frame = normalizeFrame(source, detect.circle, detect.fpcb.rotationDeg);
    const quality = evaluatePreprocessingQuality({
      source,
      frame,
      detect,
      circle: detect.circle,
      rotationDeg: detect.fpcb.rotationDeg,
      patternCompleteness: 1,
      usedReferenceGeometry: false,
    }, RELAXED);
    expect(quality.status).toBe('PASS');
    expect(quality.radiusConfidence).toBeGreaterThan(0);
    expect(quality.circularity).toBeGreaterThan(0.9);
    expect(quality.activePixelCoverage).toBeGreaterThan(0.9);
    expect(quality.meanLuminance).toBeGreaterThan(100);
  });

  it('fails when no Active Area exists and no reference geometry is available', () => {
    const source = createRgba(640, 640);
    const detect = detectActiveCircle(source);
    expect(detect.ok).toBe(false);
    const circle = { cx: 320, cy: 320, r: 240 };
    const frame = normalizeFrame(source, circle, 0);
    const quality = evaluatePreprocessingQuality({
      source,
      frame,
      detect,
      circle,
      rotationDeg: 0,
      patternCompleteness: 1,
      usedReferenceGeometry: false,
    }, RELAXED);
    expect(quality.status).toBe('FAIL');
    expect(quality.reviewReasons).toContain(REVIEW_REASON.PREPROCESSING_FAILED);
  });

  it('reviews an unlit image that borrows a sibling geometry instead of failing it', () => {
    const source = createRgba(640, 640);
    const detect = detectActiveCircle(source);
    const circle = { cx: 320, cy: 320, r: 240 };
    const quality = evaluatePreprocessingQuality({
      source,
      frame: normalizeFrame(source, circle, 0),
      detect,
      circle,
      rotationDeg: 0,
      patternCompleteness: 1,
      usedReferenceGeometry: true,
    }, RELAXED);
    expect(quality.status).toBe('REVIEW');
    expect(quality.reviewReasons).toContain(REVIEW_REASON.PREPROCESSING_FAILED);
  });

  it('sends an incomplete R/G/B/W set to review', () => {
    const source = renderSyntheticPanel({ pattern: 'R' });
    const detect = detectActiveCircle(source);
    expect(detect.ok).toBe(true);
    if (!detect.ok) return;
    const quality = evaluatePreprocessingQuality({
      source,
      frame: normalizeFrame(source, detect.circle, detect.fpcb.rotationDeg),
      detect,
      circle: detect.circle,
      rotationDeg: detect.fpcb.rotationDeg,
      patternCompleteness: 0.75,
      usedReferenceGeometry: false,
    }, RELAXED);
    expect(quality.status).toBe('REVIEW');
    expect(quality.reviewReasons).toContain(REVIEW_REASON.PATTERN_MISSING);
  });
});
