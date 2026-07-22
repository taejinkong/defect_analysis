import type { DetectResult } from './preprocess';
import type { NormalizedFrame } from './normalize';
import type { Circle, Rgba } from './types';
import type { Settings } from './settings';
import { DEFAULT_SETTINGS } from './settings';
import {
  REVIEW_REASON,
  type PreprocessingStatus,
  type ReviewReason,
} from './review';

export const PREPROCESSING_METRICS_VERSION = '2.0.0';

export interface PreprocessingQualityInput {
  readonly source: Rgba;
  readonly frame: NormalizedFrame;
  readonly detect: DetectResult;
  readonly circle: Circle;
  readonly rotationDeg: number;
  readonly patternCompleteness: number;
  /** True when a dark/unlit image borrows a confirmed sibling's geometry. */
  readonly usedReferenceGeometry: boolean;
  readonly backgroundSaturationRatio?: number;
  readonly localDefectSaturationRatio?: number;
  readonly captureProfileValidated?: boolean;
  readonly goldenReferenceValidated?: boolean;
  readonly expectedMeanRange?: readonly [number, number];
}

export interface PreprocessingQuality {
  readonly status: PreprocessingStatus;
  readonly reviewReasons: ReviewReason[];
  readonly metricsVersion: string;
  readonly activeAreaDetected: boolean;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly centerOffsetRatio: number;
  readonly radiusConfidence: number;
  readonly circularity: number;
  readonly fpcbAlignmentConfidence: number;
  readonly rotationDeg: number;
  readonly clippingRatio: number;
  readonly blurScore: number;
  readonly meanLuminance: number;
  readonly luminanceStdDev: number;
  readonly saturationRatio: number;
  readonly rawSaturationRatio?: number;
  readonly localDefectSaturationRatio?: number;
  readonly activePixelCoverage: number;
  readonly patternCompleteness: number;
}

export function evaluatePreprocessingQuality(
  input: PreprocessingQualityInput,
  settings: Settings = DEFAULT_SETTINGS,
): PreprocessingQuality {
  const intensity = maxChannel(input.frame.image);
  const { mean, stdDev, saturationRatio: rawSaturationRatio } = maskedStats(input.frame, intensity);
  const saturationRatio = input.backgroundSaturationRatio ?? rawSaturationRatio;
  const blurScore = laplacianVariance(input.frame, intensity);
  const clippingRatio = circleClippingRatio(input.circle, input.source.width, input.source.height);

  const activeAreaDetected = input.detect.ok;
  const normalizedResidual = input.detect.ok
    ? input.detect.rmsResidual / Math.max(1, input.detect.circle.r)
    : 1;
  const radiusConfidence = clamp01(1 - normalizedResidual / 0.05);
  const circularity = clamp01(1 - normalizedResidual);
  const fpcbAlignmentConfidence = input.detect.ok ? input.detect.fpcb.strength : 0;
  const halfMin = Math.max(1, Math.min(input.source.width, input.source.height) / 2);
  const centerOffsetRatio =
    Math.hypot(
      input.circle.cx - input.source.width / 2,
      input.circle.cy - input.source.height / 2,
    ) / halfMin;
  const activePixelCoverage =
    input.frame.activeAreaPx / (Math.PI * 250 * 250);

  const reasons = new Set<ReviewReason>();
  let status: PreprocessingStatus = 'PASS';

  if (!activeAreaDetected) {
    reasons.add(REVIEW_REASON.PREPROCESSING_FAILED);
    status = input.usedReferenceGeometry ? 'REVIEW' : 'FAIL';
  }
  if (input.captureProfileValidated === false) reasons.add(REVIEW_REASON.CAPTURE_PROFILE_UNVALIDATED);
  if (input.goldenReferenceValidated === false) reasons.add(REVIEW_REASON.GOLDEN_REFERENCE_MISSING);
  if (radiusConfidence < settings['preprocessing.min_circle_confidence']) {
    reasons.add(REVIEW_REASON.ACTIVE_AREA_LOW_CONFIDENCE);
  }
  if (fpcbAlignmentConfidence < settings['preprocessing.min_fpcb_strength']) {
    reasons.add(REVIEW_REASON.FPCB_ALIGNMENT_LOW_CONFIDENCE);
  }
  if (input.patternCompleteness < 1) reasons.add(REVIEW_REASON.PATTERN_MISSING);
  if (
    clippingRatio > settings['preprocessing.max_clipping_ratio'] ||
    blurScore < settings['preprocessing.min_blur_score'] ||
    mean < (input.expectedMeanRange?.[0] ?? settings['preprocessing.min_mean_luminance']) ||
    mean > (input.expectedMeanRange?.[1] ?? settings['preprocessing.max_mean_luminance']) ||
    saturationRatio > settings['preprocessing.max_saturation_ratio']
  ) {
    reasons.add(REVIEW_REASON.OUT_OF_VALIDATED_RANGE);
  }

  if (status !== 'FAIL' && reasons.size > 0) status = 'REVIEW';

  return {
    status,
    reviewReasons: [...reasons],
    metricsVersion: PREPROCESSING_METRICS_VERSION,
    activeAreaDetected,
    centerX: input.circle.cx,
    centerY: input.circle.cy,
    radius: input.circle.r,
    centerOffsetRatio,
    radiusConfidence,
    circularity,
    fpcbAlignmentConfidence,
    rotationDeg: input.rotationDeg,
    clippingRatio,
    blurScore,
    meanLuminance: mean,
    luminanceStdDev: stdDev,
    saturationRatio,
    rawSaturationRatio,
    localDefectSaturationRatio: input.localDefectSaturationRatio ?? 0,
    activePixelCoverage,
    patternCompleteness: input.patternCompleteness,
  };
}

function maxChannel(frame: Rgba): Uint8ClampedArray {
  const out = new Uint8ClampedArray(frame.width * frame.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = Math.max(frame.data[p]!, frame.data[p + 1]!, frame.data[p + 2]!);
  }
  return out;
}

function maskedStats(
  frame: NormalizedFrame,
  intensity: Uint8ClampedArray,
): { mean: number; stdDev: number; saturationRatio: number } {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let saturated = 0;
  for (let i = 0, p = 0; i < intensity.length; i++, p += 4) {
    if (frame.activeMask.data[i] === 0) continue;
    const value = intensity[i]!;
    n++;
    sum += value;
    sumSq += value * value;
    if (
      frame.image.data[p]! >= 250 &&
      frame.image.data[p + 1]! >= 250 &&
      frame.image.data[p + 2]! >= 250
    ) saturated++;
  }
  const mean = n > 0 ? sum / n : 0;
  return {
    mean,
    stdDev: n > 0 ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0,
    saturationRatio: n > 0 ? saturated / n : 0,
  };
}

function laplacianVariance(frame: NormalizedFrame, intensity: Uint8ClampedArray): number {
  const width = frame.image.width;
  const height = frame.image.height;
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const i = y * width + x;
      if (
        frame.activeMask.data[i] === 0 ||
        frame.activeMask.data[i - 1] === 0 ||
        frame.activeMask.data[i + 1] === 0 ||
        frame.activeMask.data[i - width] === 0 ||
        frame.activeMask.data[i + width] === 0
      ) continue;
      const lap =
        intensity[i - 1]! +
        intensity[i + 1]! +
        intensity[i - width]! +
        intensity[i + width]! -
        4 * intensity[i]!;
      n++;
      sum += lap;
      sumSq += lap * lap;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

export function circleClippingRatio(circle: Circle, width: number, height: number): number {
  const samples = 720;
  let clipped = 0;
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2;
    const x = circle.cx + Math.cos(angle) * circle.r;
    const y = circle.cy + Math.sin(angle) * circle.r;
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) clipped++;
  }
  return clipped / samples;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
