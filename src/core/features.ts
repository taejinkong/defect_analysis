import type { Gray, Mask, Pattern } from './types';
import { FRAME_CENTER, FRAME_RADIUS, PATTERNS } from './types';
import { angleFromOffset } from './geometry';
import type { Detection } from './defects';

// Black/White physical-signal masks replaced the driven-channel masks in v2.
// Old embeddings must never be compared with descriptors built from the new
// masks, even though the vector dimensions are unchanged.
export const FEATURE_VERSION = 'v2';

const RINGS = 16;
const SECTORS = 24;
/** 16*2 + 24*2 + 11, per docs/matching_engine.md section 5.1. */
export const IMAGE_FEATURE_DIM = RINGS * 2 + SECTORS * 2 + 11;
export const PANEL_FEATURE_DIM = IMAGE_FEATURE_DIM * PATTERNS.length;

/**
 * A 91-D descriptor of one normalized pattern image.
 *
 * Radial and angular histograms of the dark/bright fraction, plus global
 * statistics. Because the frame is already FPCB-aligned, the angular block
 * carries rotation-registered position: two panels with the same defect in the
 * same place score alike. Every component is scaled into [0, 1] so no single
 * block dominates the later L2 normalization.
 */
export function extractImageFeature(
  gray: Gray,
  activeMask: Mask,
  darkMask: Mask,
  brightMask: Mask,
  detections: readonly Detection[],
  activeAreaPx: number,
): Float32Array {
  const ringCount = new Float64Array(RINGS);
  const ringDark = new Float64Array(RINGS);
  const ringBright = new Float64Array(RINGS);
  const secCount = new Float64Array(SECTORS);
  const secDark = new Float64Array(SECTORS);
  const secBright = new Float64Array(SECTORS);
  const hist = new Float64Array(256);

  let active = 0;
  let dark = 0;
  let bright = 0;
  let sum = 0;
  let sumSq = 0;

  const { width: w, height: h } = gray;
  const sectorSpan = 360 / SECTORS;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (activeMask.data[i] === 0) continue;

      const value = gray.data[i];
      active++;
      sum += value;
      sumSq += value * value;
      hist[value]++;

      const dx = x - FRAME_CENTER;
      const dy = y - FRAME_CENTER;
      const rRatio = Math.hypot(dx, dy) / FRAME_RADIUS;
      const ring = Math.min(RINGS - 1, Math.floor(rRatio * RINGS));
      const sector = Math.min(SECTORS - 1, Math.floor(angleFromOffset(dx, dy) / sectorSpan));

      ringCount[ring]++;
      secCount[sector]++;

      if (darkMask.data[i] === 1) {
        dark++;
        ringDark[ring]++;
        secDark[sector]++;
      } else if (brightMask.data[i] === 1) {
        bright++;
        ringBright[ring]++;
        secBright[sector]++;
      }
    }
  }

  const feat = new Float32Array(IMAGE_FEATURE_DIM);
  let k = 0;
  for (let r = 0; r < RINGS; r++) {
    const denom = ringCount[r] || 1;
    feat[k++] = ringDark[r] / denom;
    feat[k++] = ringBright[r] / denom;
  }
  for (let s = 0; s < SECTORS; s++) {
    const denom = secCount[s] || 1;
    feat[k++] = secDark[s] / denom;
    feat[k++] = secBright[s] / denom;
  }

  const mean = active > 0 ? sum / active : 0;
  const variance = active > 0 ? Math.max(0, sumSq / active - mean * mean) : 0;
  const area = activeAreaPx > 0 ? activeAreaPx : active || 1;

  let lineH = 0;
  let lineV = 0;
  let maxCc = 0;
  let darkCc = 0;
  let brightCc = 0;
  for (const d of detections) {
    maxCc = Math.max(maxCc, d.areaPx);
    if (d.kind.startsWith('dark')) darkCc++;
    else brightCc++;
    const share = d.areaPx / area;
    if (d.kind.endsWith('line-h')) lineH += share;
    else if (d.kind.endsWith('line-v')) lineV += share;
  }

  feat[k++] = mean / 255;
  feat[k++] = Math.sqrt(variance) / 128;
  feat[k++] = percentile(hist, active, 0.01) / 255;
  feat[k++] = percentile(hist, active, 0.99) / 255;
  feat[k++] = active > 0 ? dark / active : 0;
  feat[k++] = active > 0 ? bright / active : 0;
  feat[k++] = Math.min(1, darkCc / 20);
  feat[k++] = Math.min(1, brightCc / 20);
  feat[k++] = Math.min(1, maxCc / area);
  feat[k++] = Math.min(1, lineH);
  feat[k++] = Math.min(1, lineV);

  return feat;
}

function percentile(hist: Float64Array, total: number, q: number): number {
  if (total === 0) return 0;
  const target = q * total;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/**
 * Concatenate the four pattern descriptors (R, G, B, W) and L2-normalize.
 *
 * A missing pattern contributes a zero block, so a partial panel still yields a
 * usable vector; its cosine similarity is structurally lower, which the caller
 * reflects in confidence.
 */
export function combinePanelFeature(byPattern: Partial<Record<Pattern, Float32Array>>): Float32Array {
  const out = new Float32Array(PANEL_FEATURE_DIM);
  PATTERNS.forEach((pattern, index) => {
    const block = byPattern[pattern];
    if (block) out.set(block, index * IMAGE_FEATURE_DIM);
  });

  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-9) {
    for (let i = 0; i < out.length; i++) out[i] /= norm;
  }
  return out;
}

export function toBytes(vector: Float32Array): ArrayBuffer {
  return vector.buffer.slice(0) as ArrayBuffer;
}

export function fromBytes(bytes: ArrayBuffer): Float32Array {
  return new Float32Array(bytes);
}

/** Cosine similarity of two L2-normalized vectors: a plain dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
