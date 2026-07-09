import type { Gray, Mask, Pattern, Rgba } from './types';
import { FRAME_CENTER, FRAME_RADIUS } from './types';
import { createMask, toGray } from './image';
import { fitBackgroundSurface, residual } from './background';
import { blobPoints, findBlobs, minAreaRect, type Blob } from './blobs';
import { angleFromOffset, regionFromRadius, type Region } from './geometry';
import type { Settings } from './settings';
import { DEFAULT_SETTINGS } from './settings';

/** What the rule engine saw, before a defect id is assigned. */
export type BlobKind =
  | 'dark-dot'
  | 'bright-dot'
  | 'bright-line-h'
  | 'bright-line-v'
  | 'dark-line-h'
  | 'dark-line-v';

export interface Detection {
  readonly kind: BlobKind;
  readonly x: number;
  readonly y: number;
  readonly areaPx: number;
  readonly rRatio: number;
  readonly angleDeg: number;
  readonly region: Region;
  readonly bbox: readonly [number, number, number, number];
  readonly aspect: number;
  readonly orientationDeg: number;
}

export type NoDisplay = 'none' | 'full' | 'partial';

export interface ImageDetection {
  readonly pattern: Pattern;
  readonly detections: Detection[];
  /** Dark-dot area as a percentage of the active area. Lines are excluded. */
  readonly darkAreaPct: number;
  readonly noDisplay: NoDisplay;
  readonly meanLuma: number;
  /** Weak signal only. Never enough on its own to call 구동불량. */
  readonly drivingFlag: boolean;
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
): ImageDetection {
  const gray = channelOf(frame, pattern);

  const meanLuma = maskedMean(gray, activeMask);
  const background = fitBackgroundSurface(gray, activeMask);
  const res = residual(gray, background, activeMask);

  const darkThreshold = settings['dark.residual_threshold'];
  const brightThreshold = settings['bright.residual_threshold'];

  const darkMask = createMask(frame.width, frame.height);
  const brightMask = createMask(frame.width, frame.height);
  for (let i = 0; i < res.length; i++) {
    if (activeMask.data[i] === 0) continue;
    if (res[i] < -darkThreshold) darkMask.data[i] = 1;
    else if (res[i] > brightThreshold) brightMask.data[i] = 1;
  }

  // Despeckle by area alone. A morphological opening would erode thin lines out
  // of existence: a 3px line, once the capture is rotated and bilinearly
  // resampled, thresholds to a ~2px core that a 3x3 erosion erases entirely.
  // Since captures are never perfectly aligned, that would lose every line
  // defect. The minimum-area filter removes isolated noise without thinning.
  const minArea = settings['blob.min_area_px'];
  const darkBlobs = findBlobs(darkMask, minArea);
  const brightBlobs = findBlobs(brightMask, minArea);

  const noDisplay = classifyNoDisplay(meanLuma, darkBlobs, activeAreaPx, settings);

  // A blank panel has no meaningful internal structure; reporting a thousand
  // "dark dots" inside an unlit display would be noise.
  if (noDisplay !== 'none') {
    return { pattern, detections: [], darkAreaPct: 0, noDisplay, meanLuma, drivingFlag: false };
  }

  const detections: Detection[] = [];
  let darkDotAreaPx = 0;

  for (const blob of darkBlobs) {
    const d = classify(blob, frame.width, false, settings);
    detections.push(d);
    if (d.kind === 'dark-dot') darkDotAreaPx += blob.areaPx;
  }
  for (const blob of brightBlobs) {
    detections.push(classify(blob, frame.width, true, settings));
  }

  return {
    pattern,
    detections,
    darkAreaPct: activeAreaPx > 0 ? (darkDotAreaPx / activeAreaPx) * 100 : 0,
    noDisplay,
    meanLuma,
    drivingFlag: detectDrivingSignals(gray, activeMask),
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
): NoDisplay {
  if (meanLuma < settings['no_display.mean_luma_threshold']) return 'full';
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
function classify(blob: Blob, width: number, bright: boolean, settings: Settings): Detection {
  const rect = minAreaRect(blobPoints(blob, width));
  const aspect = rect.long / Math.max(rect.short, 1);
  const lengthRatio = rect.long / (FRAME_RADIUS * 2);

  const tolerance = settings['line.angle_tolerance_deg'];
  const elongated =
    aspect >= settings['line.min_aspect_ratio'] && lengthRatio >= settings['line.min_length_ratio'];
  const horizontal = rect.angleDeg <= tolerance || rect.angleDeg >= 180 - tolerance;
  const vertical = Math.abs(rect.angleDeg - 90) <= tolerance;

  let kind: BlobKind;
  if (elongated && horizontal) kind = bright ? 'bright-line-h' : 'dark-line-h';
  else if (elongated && vertical) kind = bright ? 'bright-line-v' : 'dark-line-v';
  else kind = bright ? 'bright-dot' : 'dark-dot';

  const dx = blob.cx - FRAME_CENTER;
  const dy = blob.cy - FRAME_CENTER;
  const rRatio = Math.hypot(dx, dy) / FRAME_RADIUS;

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
  };
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
