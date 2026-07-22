import type { Gray, Mask } from './types';
import { createGray } from './image';
import { otsuThresholdMasked } from './otsu';

/**
 * Estimate the lit panel's illumination surface, so subtracting it leaves only
 * defects.
 *
 * A local median filter cannot do this job. Once a dark defect grows wider than
 * the kernel, the kernel sits entirely inside the defect, the background
 * estimate equals the defect's own level, and the residual collapses to zero.
 * A 25% dark dot then measures as 0% and 암점 大 becomes undetectable.
 *
 * Instead fit one quadratic surface over the whole active area:
 *
 *   bg(x, y) = c0 + c1*u + c2*v + c3*u^2 + c4*v^2 + c5*u*v
 *
 * Six terms capture radial vignetting exactly (it is linear in r^2) and also
 * absorb a directional illumination gradient, which a purely radial model
 * cannot. Because the model is global, no defect can hide from it by being big.
 *
 * Robustness comes in two layers:
 *
 *   1. A genuine Otsu split excludes the defect-side intensity class up front.
 *      Usually that is the lower (dark) class. When a small bright upper class
 *      sits on an already-lit lower class, it is instead recognized as a thick
 *      bright defect and excluded. This survives both large dark areas and
 *      bright lines too wide for residual reweighting to reject by itself.
 *   2. Iteratively reweighted least squares with Tukey's biweight then
 *      suppresses the remaining outliers, chiefly bright dots and lines.
 */
/** Class-mean separation, in pooled within-class sigmas, above which we split. */
const BIMODAL_SEPARATION = 4;
/** A high-intensity class this small is allowed to be treated as a bright defect. */
const BRIGHT_TAIL_MAX_FRACTION = 0.25;
/** Its lower class must itself be lit, not a majority-dark partial no-display. */
const LIT_LOWER_MIN_RATIO = 0.45;

export function fitBackgroundSurface(
  gray: Gray,
  mask: Mask,
  iterations = 4,
  defectPolarity: 'auto' | 'bright' = 'auto',
): Gray {
  const { width: w, height: h } = gray;

  let active = 0;
  for (let i = 0; i < gray.data.length; i++) if (mask.data[i] === 1) active++;
  if (active === 0) return createGray(w, h);

  // Only trust the Otsu split when the histogram is genuinely bimodal. On a
  // clean panel it is one smooth mode, and Otsu's threshold would merely lop off
  // the vignetted rim, starving the fit of the samples that pin its curvature.
  // Keying this on separation rather than on the dark pixel count matters: any
  // fixed "at least N% dark" rule puts a discontinuity in the middle of the
  // 암점 大 range, where a defect is big enough to bias the fit but not big
  // enough to trip the rule. Otsu does not say which class is the defect,
  // though. A thick bright line creates the opposite split: the broad lower
  // class is the lit panel and the narrow upper class is the defect.
  const otsu = otsuThresholdMasked(gray, mask);
  const bimodal = otsu.separation > BIMODAL_SEPARATION;
  const upperIsBrightDefect =
    bimodal &&
    otsu.upperFraction <= BRIGHT_TAIL_MAX_FRACTION &&
    (defectPolarity === 'bright' || otsu.lowerMean >= otsu.upperMean * LIT_LOWER_MIN_RATIO);
  const floor = bimodal && !upperIsBrightDefect ? otsu.threshold : -1;
  const ceiling = upperIsBrightDefect ? otsu.threshold : 255;

  // Subsample: a quadratic has six unknowns and tens of thousands of samples
  // already over-determine it.
  const step = 2;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = y * w + x;
      if (mask.data[i] === 0) continue;
      const v = gray.data[i];
      if (v <= floor || v > ceiling) continue;
      xs.push((x - w / 2) / (w / 2));
      ys.push((y - h / 2) / (h / 2));
      zs.push(v);
    }
  }
  if (zs.length < 32) return flat(gray, mask, w, h);

  const n = zs.length;
  const weights = new Float64Array(n).fill(1);
  let coeffs = solveWeighted(xs, ys, zs, weights);
  if (!coeffs) return flat(gray, mask, w, h);

  const residuals = new Float64Array(n);
  for (let iter = 1; iter < iterations; iter++) {
    for (let k = 0; k < n; k++) residuals[k] = zs[k]! - evaluate(coeffs, xs[k]!, ys[k]!);

    const sigma = 1.4826 * medianAbs(residuals);
    if (!(sigma > 1e-6)) break;

    // Tukey biweight: outliers beyond 4.685 sigma get exactly zero weight,
    // rather than the merely-small weight Huber would give them.
    const c = 4.685 * sigma;
    for (let k = 0; k < n; k++) {
      const t = residuals[k]! / c;
      weights[k] = Math.abs(t) < 1 ? (1 - t * t) ** 2 : 0;
    }

    const next = solveWeighted(xs, ys, zs, weights);
    if (!next) break;
    coeffs = next;
  }

  const out = createGray(w, h);
  for (let y = 0; y < h; y++) {
    const v = (y - h / 2) / (h / 2);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask.data[i] === 0) continue;
      out.data[i] = evaluate(coeffs, (x - w / 2) / (w / 2), v);
    }
  }
  return out;
}

/** Fallback: a constant surface at the masked mean. */
function flat(gray: Gray, mask: Mask, w: number, h: number): Gray {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < gray.data.length; i++) {
    if (mask.data[i] === 1) {
      sum += gray.data[i];
      n++;
    }
  }
  const out = createGray(w, h);
  const mean = n > 0 ? sum / n : 0;
  for (let i = 0; i < out.data.length; i++) if (mask.data[i] === 1) out.data[i] = mean;
  return out;
}

const TERMS = 6;

function basis(x: number, y: number, into: Float64Array): void {
  into[0] = 1;
  into[1] = x;
  into[2] = y;
  into[3] = x * x;
  into[4] = y * y;
  into[5] = x * y;
}

function evaluate(c: Float64Array, x: number, y: number): number {
  return c[0]! + c[1]! * x + c[2]! * y + c[3]! * x * x + c[4]! * y * y + c[5]! * x * y;
}

/** Normal equations for weighted least squares, solved by Gaussian elimination. */
function solveWeighted(xs: number[], ys: number[], zs: number[], weights: Float64Array): Float64Array | null {
  const ata = new Float64Array(TERMS * TERMS);
  const atb = new Float64Array(TERMS);
  const phi = new Float64Array(TERMS);

  for (let k = 0; k < zs.length; k++) {
    const wk = weights[k]!;
    if (wk === 0) continue;
    basis(xs[k]!, ys[k]!, phi);
    for (let i = 0; i < TERMS; i++) {
      atb[i] += wk * phi[i]! * zs[k]!;
      for (let j = i; j < TERMS; j++) ata[i * TERMS + j] += wk * phi[i]! * phi[j]!;
    }
  }
  for (let i = 0; i < TERMS; i++) for (let j = 0; j < i; j++) ata[i * TERMS + j] = ata[j * TERMS + i]!;

  return gaussianSolve(ata, atb);
}

function gaussianSolve(a: Float64Array, b: Float64Array): Float64Array | null {
  const m = new Float64Array(a);
  const x = new Float64Array(b);

  for (let col = 0; col < TERMS; col++) {
    let pivot = col;
    for (let row = col + 1; row < TERMS; row++) {
      if (Math.abs(m[row * TERMS + col]!) > Math.abs(m[pivot * TERMS + col]!)) pivot = row;
    }
    if (Math.abs(m[pivot * TERMS + col]!) < 1e-12) return null;

    if (pivot !== col) {
      for (let j = 0; j < TERMS; j++) {
        const t = m[col * TERMS + j]!;
        m[col * TERMS + j] = m[pivot * TERMS + j]!;
        m[pivot * TERMS + j] = t;
      }
      const t = x[col]!;
      x[col] = x[pivot]!;
      x[pivot] = t;
    }

    for (let row = col + 1; row < TERMS; row++) {
      const factor = m[row * TERMS + col]! / m[col * TERMS + col]!;
      if (factor === 0) continue;
      for (let j = col; j < TERMS; j++) m[row * TERMS + j] -= factor * m[col * TERMS + j]!;
      x[row] -= factor * x[col]!;
    }
  }

  for (let row = TERMS - 1; row >= 0; row--) {
    let sum = x[row]!;
    for (let j = row + 1; j < TERMS; j++) sum -= m[row * TERMS + j]! * x[j]!;
    x[row] = sum / m[row * TERMS + row]!;
  }
  return x;
}

function medianAbs(values: Float64Array): number {
  const abs = Array.from(values, Math.abs).sort((a, b) => a - b);
  const mid = abs.length >> 1;
  return abs.length % 2 === 0 ? (abs[mid - 1]! + abs[mid]!) / 2 : abs[mid]!;
}

/** `gray - background`, zero outside the mask. */
export function residual(gray: Gray, background: Gray, mask: Mask): Int16Array {
  const out = new Int16Array(gray.data.length);
  for (let i = 0; i < out.length; i++) {
    if (mask.data[i] === 0) continue;
    out[i] = gray.data[i] - background.data[i];
  }
  return out;
}
