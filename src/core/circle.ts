import type { Circle, Gray } from './types';
import { sampleGray } from './image';

export interface CircleFit extends Circle {
  /** RMS of |distance-to-center - r| over the input points, in pixels. */
  readonly rmsResidual: number;
}

/**
 * Kasa least-squares circle fit.
 *
 * Minimizing the algebraic error |p|^2 - (2a*x + 2b*y + c) is linear in
 * (a, b, c), so a single 3x3 normal-equation solve gives a closed form with no
 * iteration. Points are centered on their mean first: without that the x^2+y^2
 * terms dominate and the normal matrix loses conditioning on off-origin circles.
 *
 * @param pts Flat [x0, y0, x1, y1, ...] coordinates. Needs at least 3 points.
 */
export function fitCircleKasa(pts: Float64Array): CircleFit | null {
  const n = pts.length / 2;
  if (n < 3) return null;

  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += pts[i * 2];
    my += pts[i * 2 + 1];
  }
  mx /= n;
  my /= n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;

  for (let i = 0; i < n; i++) {
    const x = pts[i * 2] - mx;
    const y = pts[i * 2 + 1] - my;
    const z = x * x + y * y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }

  // Solve for the center (u, v) of the mean-centered points:
  //   [sxx sxy] [u]   [sxz] / 2
  //   [sxy syy] [v] = [syz] / 2
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9) return null; // collinear

  const u = (syy * sxz - sxy * syz) / (2 * det);
  const v = (sxx * syz - sxy * sxz) / (2 * det);

  const rSquared = u * u + v * v + sz / n;
  if (!(rSquared > 0)) return null;

  const cx = u + mx;
  const cy = v + my;
  const r = Math.sqrt(rSquared);

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 2] - cx;
    const dy = pts[i * 2 + 1] - cy;
    const e = Math.hypot(dx, dy) - r;
    sumSq += e * e;
  }

  return { cx, cy, r, rmsResidual: Math.sqrt(sumSq / n) };
}

/**
 * Fit, discard points far from the fitted rim, then refit — repeatedly.
 *
 * The FPCB tab is connected to the display, so the thresholded component's
 * boundary includes the tab's outline. Those points sit well outside the true
 * radius and pull an unweighted least-squares fit toward the tab. Trimming
 * drops them. A single pass is not always enough: when outliers (tab, glow
 * lobes, crop remnants) pull the first fit far off, points they should have
 * excluded survive the first tolerance band. Each refit tightens the estimate,
 * so up to `passes` rounds run until the fit stops moving.
 *
 * @param trim Keep points within this fraction of the radius of the rim.
 */
export function fitCircleRobust(pts: Float64Array, trim = 0.08, passes = 3): CircleFit | null {
  let fit = fitCircleKasa(pts);
  if (!fit) return null;
  let current = pts;

  for (let pass = 0; pass < passes; pass++) {
    const tolerance = fit.r * trim;
    const kept: number[] = [];
    for (let i = 0; i < current.length / 2; i++) {
      const dx = current[i * 2] - fit.cx;
      const dy = current[i * 2 + 1] - fit.cy;
      if (Math.abs(Math.hypot(dx, dy) - fit.r) <= tolerance) {
        kept.push(current[i * 2], current[i * 2 + 1]);
      }
    }

    // Too few survivors (relative to the original input) means the fit was not
    // describing a rim at all; report the last fit as-is and let the caller's
    // residual check reject it.
    if (kept.length / 2 < Math.max(3, (pts.length / 2) * 0.5)) return fit;

    const next = fitCircleKasa(Float64Array.from(kept));
    if (!next) return fit;

    const moved = Math.hypot(next.cx - fit.cx, next.cy - fit.cy) + Math.abs(next.r - fit.r);
    fit = next;
    current = Float64Array.from(kept);
    if (moved < 0.25) break; // converged
  }
  return fit;
}

/**
 * Refine a coarse circle by locating the true rim with radial gradients.
 *
 * Threshold-based segmentation systematically overshoots on real captures: the
 * lit panel bleeds light into the surroundings (bloom/halo), and Otsu's
 * threshold lands somewhere inside that halo, inflating the radius. The
 * steepest intensity *drop* along a ray from the center, however, stays pinned
 * to the physical rim no matter how far the glow reaches, because glow decays
 * smoothly from the edge outward.
 *
 * For each of `rays` directions this samples the intensity profile across
 * [0.7r, 1.35r], finds the most negative smoothed derivative, sharpens it to
 * sub-pixel with a parabolic fit, and robust-fits a circle through the edge
 * points. Rays that leave the image before clearing the rim (cropped captures)
 * or that see no inside/outside contrast are skipped; the FPCB tab direction
 * survives as a small minority of outliers that the trimmed fit discards.
 *
 * Returns null when the evidence is too thin or inconsistent, in which case
 * the caller should keep the coarse fit.
 */
export function refineCircleEdge(gray: Gray, initial: Circle, rays = 240): CircleFit | null {
  const tLo = 0.7;
  const tHi = 1.35;
  const span = (tHi - tLo) * initial.r;
  const samples = Math.max(48, Math.min(192, Math.round(span)));
  const step = span / (samples - 1);
  // The rim plus a safety margin must be visible for a ray to say anything.
  const minUsable = Math.ceil(((1.08 - tLo) * initial.r) / step);
  const minContrast = 16;

  const profile = new Float64Array(samples);
  const smooth = new Float64Array(samples);
  const edge: number[] = [];

  for (let s = 0; s < rays; s++) {
    const a = (s / rays) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);

    // Walk outward until the ray exits the image.
    let n = 0;
    for (let k = 0; k < samples; k++) {
      const rr = initial.r * tLo + k * step;
      const x = initial.cx + dx * rr;
      const y = initial.cy + dy * rr;
      if (x < 0 || y < 0 || x > gray.width - 1 || y > gray.height - 1) break;
      profile[n++] = sampleGray(gray, x, y);
    }
    if (n < minUsable) continue;

    for (let k = 0; k < n; k++) {
      const lo = Math.max(0, k - 2);
      const hi = Math.min(n - 1, k + 2);
      let sum = 0;
      for (let j = lo; j <= hi; j++) sum += profile[j];
      smooth[k] = sum / (hi - lo + 1);
    }

    const inside = median(smooth.subarray(0, Math.min(8, n)));
    const outside = median(smooth.subarray(Math.max(0, n - 8), n));
    if (inside - outside < minContrast) continue;

    let bestK = -1;
    let bestD = 0;
    for (let k = 1; k < n - 1; k++) {
      const d = smooth[k + 1] - smooth[k - 1];
      if (d < bestD) {
        bestD = d;
        bestK = k;
      }
    }
    if (bestK < 1 || bestD > -2) continue;

    // Parabolic sub-sample interpolation around the derivative minimum.
    let offset = 0;
    if (bestK >= 2 && bestK <= n - 3) {
      const dm = smooth[bestK] - smooth[bestK - 2];
      const d0 = bestD;
      const dp = smooth[bestK + 2] - smooth[bestK];
      const denom = dm - 2 * d0 + dp;
      if (denom !== 0) offset = Math.max(-1, Math.min(1, (0.5 * (dm - dp)) / denom));
    }

    const re = initial.r * tLo + (bestK + offset) * step;
    edge.push(initial.cx + dx * re, initial.cy + dy * re);
  }

  if (edge.length / 2 < 16) return null;

  const fit = fitCircleRobust(Float64Array.from(edge), 0.05);
  if (!fit) return null;

  // A refinement that is not tight, or that wanders far from the coarse fit,
  // latched onto something other than the rim.
  if (fit.rmsResidual > fit.r * 0.03) return null;
  const drift = Math.hypot(fit.cx - initial.cx, fit.cy - initial.cy);
  if (drift > initial.r * 0.2 || Math.abs(fit.r - initial.r) > initial.r * 0.25) return null;

  return fit;
}

function median(values: ArrayLike<number>): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
