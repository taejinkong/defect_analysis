import type { Gray, Mask, Pattern, Rgba } from './types';
import { FRAME_CENTER, FRAME_RADIUS, FRAME_SIZE } from './types';
import { createMask, toGray } from './image';
import { fitBackgroundSurface, residual } from './background';
import { blobPoints, findBlobs, minAreaRect, type Blob } from './blobs';
import { extractImageFeature } from './features';
import { angleFromOffset, regionFromRadius } from './geometry';
import type { Settings } from './settings';
import { DEFAULT_SETTINGS } from './settings';
import {
  runDefectDetectors,
  type BlobKind,
  type CandidateDetection,
  type Detection,
} from './detectors';

export type { BlobKind, Detection } from './detectors';

export type NoDisplay = 'none' | 'full' | 'partial' | 'underexposed-review';

export interface ImageDetection {
  readonly pattern: Pattern;
  readonly detections: Detection[];
  readonly activeAreaPx: number;
  /** Dark-dot area as a percentage of the active area. Lines are excluded. */
  readonly darkAreaPct: number;
  readonly noDisplay: NoDisplay;
  readonly meanLuma: number;
  readonly blackBackgroundMean: number;
  readonly whiteBackgroundMean: number;
  readonly darkThreshold: number;
  readonly brightThreshold: number;
  /** Raw share of Active pixels whose R, G and B channels are all at least 250. */
  readonly whiteSaturationPct: number;
  /** Capture clipping metric after excluding detected bright-defect regions. */
  readonly backgroundSaturationPct: number;
  /** Saturation inside detected bright-defect boxes. Evidence, not a capture failure. */
  readonly localDefectSaturationPct: number;
  readonly qualityWarnings: string[];
  /** Weak signal only. Never enough on its own to call 구동불량. */
  readonly drivingFlag: boolean;
  /** 91-D descriptor, present only when requested. See extractImageFeature. */
  readonly feature?: Float32Array;
  /** Optional review preview; omitted during batch analysis to limit memory. */
  readonly darkResidual?: Int16Array;
  readonly brightResidual?: Int16Array;
}

export interface DetectOptions {
  /**
   * Also compute the kNN feature vector. Off by default: the extra full-frame
   * histogram pass is wasted work for the live tuning preview, which redraws
   * many times a second and never uses the feature.
   */
  readonly withFeature?: boolean;
  readonly withResiduals?: boolean;
  readonly highResolutionLineFrame?: {
    readonly image: Rgba;
    readonly activeMask: Mask;
    readonly activeAreaPx: number;
  };
  readonly inspection?: {
    readonly validatedCaptureAndGolden: boolean;
    readonly expectedMinMean?: number;
    readonly expectedMaxMean?: number;
    readonly maxBackgroundSaturationRatio?: number;
  };
}

/**
 * Detect defect candidates in one normalized frame.
 *
 * The frame must already be normalized (active circle centered, FPCB at 6
 * o'clock), so all coordinates reported here are directly comparable across
 * panels.
 */
export function detectDefects(
  frame: Rgba,
  activeMask: Mask,
  activeAreaPx: number,
  pattern: Pattern,
  settings: Settings = DEFAULT_SETTINGS,
  options: DetectOptions = {},
): ImageDetection {
  // Dark defects are physically black: all channels fall, so max(R,G,B)
  // collapses even on a colored R/G/B background. Bright defects are white:
  // all channels rise, so min(R,G,B) separates them from a colored background
  // even when the driven channel itself is already near saturation.
  const gray = channelOf(frame, pattern);
  const black = blackSignal(frame);
  const white = whiteSignal(frame);

  const meanLuma = maskedMean(black, activeMask);
  const blackBackground = fitBackgroundSurface(black, activeMask);
  // On an RGB pattern the normal min(R,G,B) level is intentionally low. Tell
  // the fitter that a small upper Otsu class is the white defect; otherwise it
  // can mistake that class for the background simply because the lower class
  // is not itself bright.
  const whiteBackground = fitBackgroundSurface(white, activeMask, 4, 'bright');
  const darkResidual = residual(black, blackBackground, activeMask);
  const brightResidual = residual(white, whiteBackground, activeMask);

  const darkThreshold = settings['dark.residual_threshold'];
  const brightThreshold =
    pattern === 'W' ? settings['bright.w_residual_threshold'] : settings['bright.residual_threshold'];

  const darkMask = createMask(frame.width, frame.height);
  const brightMask = createMask(frame.width, frame.height);
  for (let i = 0; i < darkResidual.length; i++) {
    if (activeMask.data[i] === 0) continue;
    if (darkResidual[i] < -darkThreshold) darkMask.data[i] = 1;
    if (brightResidual[i] > brightThreshold) brightMask.data[i] = 1;
  }

  // Despeckle by area alone. A morphological opening would erode thin lines out
  // of existence: a 3px line, once the capture is rotated and bilinearly
  // resampled, thresholds to a ~2px core that a 3x3 erosion erases entirely.
  // Since captures are never perfectly aligned, that would lose every line
  // defect. The minimum-area filter removes isolated noise without thinning.
  const minArea = settings['blob.min_area_px'];
  const darkBlobs = findBlobs(darkMask, minArea);
  const brightBlobs = findBlobs(brightMask, minArea);

  const noDisplay = classifyNoDisplay(
    meanLuma,
    darkBlobs,
    activeAreaPx,
    settings,
    options.inspection?.validatedCaptureAndGolden ?? true,
    options.inspection?.expectedMinMean,
  );

  const candidates: CandidateDetection[] = [];
  let darkDotAreaPx = 0;

  // A blank panel has no meaningful internal structure, so it produces no
  // detections; but it still needs a feature vector so kNN can match one unlit
  // panel to another.
  if (noDisplay === 'none') {
    for (const blob of darkBlobs) {
      const d = classify(blob, frame.width, false, settings, darkResidual);
      candidates.push({ ...d, analysisScale: 'normalized-component' });
      if (d.kind === 'dark-dot') darkDotAreaPx += blob.areaPx;
    }
    for (const blob of brightBlobs) {
      candidates.push({ ...classify(blob, frame.width, true, settings, brightResidual), analysisScale: 'normalized-component' });
    }
    if (options.highResolutionLineFrame) {
      candidates.push(...projectionLineCandidates(options.highResolutionLineFrame, pattern, settings));
    }
  }

  const detections = runDefectDetectors(pattern, dedupeCandidates(candidates));

  const feature = options.withFeature
    ? extractImageFeature(gray, activeMask, darkMask, brightMask, detections, activeAreaPx)
    : undefined;

  const saturation = saturationEvidence(white, activeMask, detections);
  const whiteSaturationPct = saturation.totalPct;
  const backgroundSaturationPct = saturation.backgroundPct;
  const localDefectSaturationPct = saturation.localDefectPct;
  const saturationLimitPct = (options.inspection?.maxBackgroundSaturationRatio ?? 0.25) * 100;
  const qualityWarnings =
    pattern === 'W' && backgroundSaturationPct > saturationLimitPct
      ? [`W 배경 포화 ${backgroundSaturationPct.toFixed(1)}% — 촬영 과노출 가능성이 있습니다.`]
      : noDisplay === 'underexposed-review'
        ? ['촬영/Golden 프로파일이 검증되지 않아 저휘도 영상을 미점등으로 자동 확정하지 않았습니다.']
        : [];

  return {
    pattern,
    detections,
    activeAreaPx,
    darkAreaPct: noDisplay === 'none' && activeAreaPx > 0 ? (darkDotAreaPx / activeAreaPx) * 100 : 0,
    noDisplay,
    meanLuma,
    blackBackgroundMean: maskedMean(blackBackground, activeMask),
    whiteBackgroundMean: maskedMean(whiteBackground, activeMask),
    darkThreshold,
    brightThreshold,
    whiteSaturationPct,
    backgroundSaturationPct,
    localDefectSaturationPct,
    qualityWarnings,
    drivingFlag: noDisplay === 'none' && detectDrivingSignals(gray, activeMask),
    ...(feature ? { feature } : {}),
    ...(options.withResiduals ? { darkResidual, brightResidual } : {}),
  };
}

/** Blackness observation: a pixel is black only when even its strongest channel is low. */
export function blackSignal(frame: Rgba): Gray {
  const data = new Uint8ClampedArray(frame.width * frame.height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = Math.max(frame.data[p]!, frame.data[p + 1]!, frame.data[p + 2]!);
  }
  return { width: frame.width, height: frame.height, data };
}

/** Whiteness observation: a pixel is white only when even its weakest channel is high. */
export function whiteSignal(frame: Rgba): Gray {
  const data = new Uint8ClampedArray(frame.width * frame.height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = Math.min(frame.data[p]!, frame.data[p + 1]!, frame.data[p + 2]!);
  }
  return { width: frame.width, height: frame.height, data };
}

function saturationEvidence(
  white: Gray,
  mask: Mask,
  detections: readonly Detection[],
): { totalPct: number; backgroundPct: number; localDefectPct: number } {
  const brightBoxes = detections
    .filter((detection) => detection.kind.startsWith('bright-'))
    .map((detection) => detection.bbox);
  let saturated = 0;
  let active = 0;
  let backgroundSaturated = 0;
  let background = 0;
  let localSaturated = 0;
  let local = 0;
  for (let i = 0; i < white.data.length; i++) {
    if (mask.data[i] === 0) continue;
    const x = i % white.width;
    const y = (i - x) / white.width;
    const inDefect = brightBoxes.some(([x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2);
    const clipped = white.data[i]! >= 250;
    active++;
    if (clipped) saturated++;
    if (inDefect) {
      local++;
      if (clipped) localSaturated++;
    } else {
      background++;
      if (clipped) backgroundSaturated++;
    }
  }
  return {
    totalPct: active > 0 ? (saturated / active) * 100 : 0,
    backgroundPct: background > 0 ? (backgroundSaturated / background) * 100 : 0,
    localDefectPct: local > 0 ? (localSaturated / local) * 100 : 0,
  };
}

/**
 * The channel the pattern actually drives. Reading luma from a pure-red frame
 * throws away three quarters of the signal and the noise floor swamps small
 * defects.
 */
function channelOf(frame: Rgba, pattern: Pattern): Gray {
  if (pattern === 'W') return toGray(frame);
  const offset = pattern === 'R' ? 0 : pattern === 'G' ? 1 : 2;
  const data = new Uint8ClampedArray(frame.width * frame.height);
  for (let i = 0, p = offset; i < data.length; i++, p += 4) data[i] = frame.data[p];
  return { width: frame.width, height: frame.height, data };
}

function maskedMean(gray: Gray, mask: Mask): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < gray.data.length; i++) {
    if (mask.data[i] === 1) {
      sum += gray.data[i];
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

function classifyNoDisplay(
  meanLuma: number,
  darkBlobs: Blob[],
  activeAreaPx: number,
  settings: Settings,
  validatedCaptureAndGolden: boolean,
  expectedMinMean?: number,
): NoDisplay {
  const threshold = expectedMinMean === undefined
    ? settings['no_display.mean_luma_threshold']
    : Math.min(settings['no_display.mean_luma_threshold'], expectedMinMean);
  if (meanLuma < threshold) return validatedCaptureAndGolden ? 'full' : 'underexposed-review';
  if (activeAreaPx === 0) return 'none';
  const largest = darkBlobs.reduce((m, b) => Math.max(m, b.areaPx), 0);
  // Partial no-display outranks 암점 大: both are large dark regions, and the
  // 60% line is where taxonomy section 4 says the call flips.
  if (largest / activeAreaPx >= settings['no_display.partial_area_ratio']) return 'partial';
  return 'none';
}

/**
 * Line or dot? A component is a line only when it is both elongated and long in
 * absolute terms, and its long axis is near horizontal or near vertical.
 * Anything else falls back to a dot, per docs/defect_taxonomy.md section 3.
 */
function classify(
  blob: Blob,
  width: number,
  bright: boolean,
  settings: Settings,
  contrastResidual: Int16Array,
): CandidateDetection {
  const rect = minAreaRect(blobPoints(blob, width));
  const aspect = rect.long / Math.max(rect.short, 1);
  const lengthRatio = rect.long / (FRAME_RADIUS * 2);

  const tolerance = settings['line.angle_tolerance_deg'];
  const minLength = settings['line.min_length_ratio'];
  const regularLine = aspect >= settings['line.min_aspect_ratio'] && lengthRatio >= minLength;
  // A real line can be thick enough that long/short falls below the thin-line
  // threshold. Only relax the aspect requirement when the component is much
  // longer than the ordinary minimum; this keeps short rectangular stains and
  // round bright dots in the dot class.
  const thickLine =
    aspect >= settings['line.thick_min_aspect_ratio'] &&
    lengthRatio >= Math.min(1, minLength * 1.5);
  const elongated = regularLine || thickLine;
  const horizontal = rect.angleDeg <= tolerance || rect.angleDeg >= 180 - tolerance;
  const vertical = Math.abs(rect.angleDeg - 90) <= tolerance;

  let kind: BlobKind;
  if (elongated && horizontal) kind = bright ? 'bright-line-h' : 'dark-line-h';
  else if (elongated && vertical) kind = bright ? 'bright-line-v' : 'dark-line-v';
  else kind = bright ? 'bright-dot' : 'dark-dot';

  const dx = blob.cx - FRAME_CENTER;
  const dy = blob.cy - FRAME_CENTER;
  const rRatio = Math.hypot(dx, dy) / FRAME_RADIUS;
  let contrastSum = 0;
  let peakContrast = 0;
  for (const index of blob.points) {
    const contrast = bright ? contrastResidual[index]! : -contrastResidual[index]!;
    contrastSum += contrast;
    if (contrast > peakContrast) peakContrast = contrast;
  }

  return {
    kind,
    x: blob.cx,
    y: blob.cy,
    areaPx: blob.areaPx,
    rRatio,
    angleDeg: angleFromOffset(dx, dy),
    region: regionFromRadius(rRatio, settings['region.center_max_r'], settings['region.mid_max_r']),
    bbox: [blob.minX, blob.minY, blob.maxX, blob.maxY],
    aspect,
    orientationDeg: rect.angleDeg,
    meanContrast: contrastSum / Math.max(1, blob.areaPx),
    peakContrast,
  };
}

/**
 * Directional high-resolution pass for thick, faint or fragmented axis-aligned
 * Lines. It evaluates abnormal-pixel continuity along each row/column after
 * low-frequency background removal, then maps evidence back to the 512 frame.
 */
function projectionLineCandidates(
  frame: { readonly image: Rgba; readonly activeMask: Mask; readonly activeAreaPx: number },
  pattern: Pattern,
  settings: Settings,
): CandidateDetection[] {
  if (frame.image.width <= FRAME_SIZE || frame.image.height <= FRAME_SIZE) return [];
  const black = blackSignal(frame.image);
  const white = whiteSignal(frame.image);
  const blackResidual = residual(black, fitBackgroundSurface(black, frame.activeMask), frame.activeMask);
  const whiteResidual = residual(white, fitBackgroundSurface(white, frame.activeMask, 4, 'bright'), frame.activeMask);
  const brightThreshold = pattern === 'W'
    ? settings['bright.w_residual_threshold']
    : settings['bright.residual_threshold'];
  return [
    ...scanProjectionLines(blackResidual, frame.activeMask, false, settings['dark.residual_threshold'], settings),
    ...scanProjectionLines(whiteResidual, frame.activeMask, true, brightThreshold, settings),
  ];
}

function scanProjectionLines(
  values: Int16Array,
  mask: Mask,
  bright: boolean,
  threshold: number,
  settings: Settings,
): CandidateDetection[] {
  const out: CandidateDetection[] = [];
  for (const horizontal of [true, false]) {
    const major = horizontal ? mask.height : mask.width;
    const minor = horizontal ? mask.width : mask.height;
    const rows: Array<{
      index: number;
      count: number;
      first: number;
      last: number;
      contrast: number;
      peak: number;
      continuity: number;
      gapRatio: number;
    }> = [];
    let maxActive = 0;
    const activeCounts = new Int32Array(major);
    for (let a = 0; a < major; a++) {
      let active = 0;
      for (let b = 0; b < minor; b++) {
        const x = horizontal ? b : a;
        const y = horizontal ? a : b;
        if (mask.data[y * mask.width + x] === 1) active++;
      }
      activeCounts[a] = active;
      if (active > maxActive) maxActive = active;
    }
    for (let a = 0; a < major; a++) {
      if (activeCounts[a]! < maxActive * 0.5) continue;
      let count = 0;
      let first = minor;
      let last = -1;
      let contrast = 0;
      let peak = 0;
      for (let b = 0; b < minor; b++) {
        const x = horizontal ? b : a;
        const y = horizontal ? a : b;
        const i = y * mask.width + x;
        if (mask.data[i] === 0) continue;
        const strength = bright ? values[i]! : -values[i]!;
        if (strength <= threshold) continue;
        count++;
        first = Math.min(first, b);
        last = Math.max(last, b);
        contrast += strength;
        peak = Math.max(peak, strength);
      }
      if (count === 0) continue;
      const span = last - first + 1;
      const lengthRatio = span / maxActive;
      const continuity = count / Math.max(1, span);
      const gapRatio = 1 - continuity;
      if (
        lengthRatio < settings['line.min_length_ratio'] ||
        continuity < settings['line.min_continuity_ratio'] ||
        gapRatio > settings['line.max_gap_ratio']
      ) continue;
      rows.push({ index: a, count, first, last, contrast: contrast / count, peak, continuity, gapRatio });
    }

    for (const run of mergeAdjacentProjectionRows(rows)) {
      const first = Math.min(...run.map((row) => row.first));
      const last = Math.max(...run.map((row) => row.last));
      const firstAxis = run[0]!.index;
      const lastAxis = run[run.length - 1]!.index;
      const scaleX = FRAME_SIZE / mask.width;
      const scaleY = FRAME_SIZE / mask.height;
      const bbox: readonly [number, number, number, number] = horizontal
        ? [first * scaleX, firstAxis * scaleY, last * scaleX, lastAxis * scaleY]
        : [firstAxis * scaleX, first * scaleY, lastAxis * scaleX, last * scaleY];
      const x = (bbox[0] + bbox[2]) / 2;
      const y = (bbox[1] + bbox[3]) / 2;
      const dx = x - FRAME_CENTER;
      const dy = y - FRAME_CENTER;
      const length = horizontal ? bbox[2] - bbox[0] + 1 : bbox[3] - bbox[1] + 1;
      const thickness = horizontal ? bbox[3] - bbox[1] + 1 : bbox[2] - bbox[0] + 1;
      const meanContrast = run.reduce((sum, row) => sum + row.contrast, 0) / run.length;
      const continuity = Math.min(...run.map((row) => row.continuity));
      const gapRatio = Math.max(...run.map((row) => row.gapRatio));
      const rRatio = Math.hypot(dx, dy) / FRAME_RADIUS;
      out.push({
        kind: bright
          ? horizontal ? 'bright-line-h' : 'bright-line-v'
          : horizontal ? 'dark-line-h' : 'dark-line-v',
        x,
        y,
        areaPx: run.reduce((sum, row) => sum + row.count, 0) * scaleX * scaleY,
        rRatio,
        angleDeg: angleFromOffset(dx, dy),
        region: regionFromRadius(rRatio, settings['region.center_max_r'], settings['region.mid_max_r']),
        bbox,
        aspect: length / Math.max(1, thickness),
        orientationDeg: horizontal ? 0 : 90,
        meanContrast,
        peakContrast: Math.max(...run.map((row) => row.peak)),
        continuity,
        gapRatio,
        edgeContact: first <= 2 || last >= minor - 3,
        analysisScale: 'high-resolution-projection',
      });
    }
  }
  return out;
}

function mergeAdjacentProjectionRows<T extends { readonly index: number }>(rows: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (const row of rows) {
    const current = runs[runs.length - 1];
    if (!current || row.index > current[current.length - 1]!.index + 1) runs.push([row]);
    else current.push(row);
  }
  return runs;
}

function dedupeCandidates(candidates: readonly CandidateDetection[]): CandidateDetection[] {
  const sorted = [...candidates].sort((a, b) =>
    Number(b.analysisScale === 'high-resolution-projection') - Number(a.analysisScale === 'high-resolution-projection') ||
    b.areaPx - a.areaPx,
  );
  const kept: CandidateDetection[] = [];
  for (const candidate of sorted) {
    const duplicate = kept.some((other) =>
      other.kind === candidate.kind &&
      Math.hypot(other.x - candidate.x, other.y - candidate.y) <= FRAME_RADIUS * 0.08 &&
      bboxIou(other.bbox, candidate.bbox) > 0.15,
    );
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

function bboxIou(a: readonly [number, number, number, number], b: readonly [number, number, number, number]): number {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + 1);
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + 1);
  const intersection = width * height;
  const areaA = Math.max(0, a[2] - a[0] + 1) * Math.max(0, a[3] - a[1] + 1);
  const areaB = Math.max(0, b[2] - b[0] + 1) * Math.max(0, b[3] - b[1] + 1);
  return intersection / Math.max(1, areaA + areaB - intersection);
}

/**
 * Weak evidence of a driving defect: periodic banding along rows or columns.
 *
 * Rule detection cannot call 구동불량 reliably; this only raises a flag for the
 * kNN stage and the reviewer. See docs/matching_engine.md section 3.5.
 */
function detectDrivingSignals(gray: Gray, mask: Mask): boolean {
  const rowProfile = profile(gray, mask, true);
  const colProfile = profile(gray, mask, false);
  return oscillationScore(rowProfile) > 0.35 || oscillationScore(colProfile) > 0.35;
}

function profile(gray: Gray, mask: Mask, byRow: boolean): Float64Array {
  const { width: w, height: h } = gray;
  const n = byRow ? h : w;
  const out = new Float64Array(n);
  const counts = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask.data[i] === 0) continue;
      const k = byRow ? y : x;
      out[k] += gray.data[i];
      counts[k]++;
    }
  }
  // Rows that clip the top or bottom of the circle average only a handful of
  // pixels, so their means are dominated by shot noise. Including them makes a
  // clean panel look like it is banding.
  let maxCount = 0;
  for (let k = 0; k < n; k++) if (counts[k] > maxCount) maxCount = counts[k];
  const minCount = maxCount * 0.5;

  for (let k = 0; k < n; k++) out[k] = counts[k] >= minCount ? out[k] / counts[k] : Number.NaN;
  return out;
}

/**
 * Fraction of the profile's variance carried by alternating lag-1 differences.
 * Smooth vignetting scores near zero; row-to-row banding scores high.
 */
function oscillationScore(values: Float64Array): number {
  const valid = Array.from(values).filter(Number.isFinite);
  if (valid.length < 8) return 0;

  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
  if (variance < 1) return 0;

  let alternating = 0;
  for (let i = 1; i < valid.length - 1; i++) {
    const second = valid[i + 1]! - 2 * valid[i]! + valid[i - 1]!;
    alternating += second * second;
  }
  alternating /= valid.length - 2;
  // Second differences of a smooth ramp vanish; of a 1-pixel band they are ~4x
  // the amplitude. Normalizing by variance makes the score scale-free.
  return Math.min(1, alternating / (16 * variance));
}
