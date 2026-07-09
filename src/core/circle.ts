import type { Circle } from './types';

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
 * Fit, discard points far from the fitted rim, then refit.
 *
 * The FPCB tab is connected to the display, so the thresholded component's
 * boundary includes the tab's outline. Those points sit well outside the true
 * radius and pull an unweighted least-squares fit toward the tab. One trimming
 * pass drops them; the tab spans only a few percent of the boundary, so the
 * first fit is already close enough to identify them.
 *
 * @param trim Keep points within this fraction of the radius of the rim.
 */
export function fitCircleRobust(pts: Float64Array, trim = 0.08): CircleFit | null {
  const first = fitCircleKasa(pts);
  if (!first) return null;

  const tolerance = first.r * trim;
  const kept: number[] = [];
  for (let i = 0; i < pts.length / 2; i++) {
    const dx = pts[i * 2] - first.cx;
    const dy = pts[i * 2 + 1] - first.cy;
    if (Math.abs(Math.hypot(dx, dy) - first.r) <= tolerance) {
      kept.push(pts[i * 2], pts[i * 2 + 1]);
    }
  }

  // Too few survivors means the first fit was not describing a rim at all;
  // report it as-is and let the caller's residual check reject it.
  if (kept.length / 2 < Math.max(3, (pts.length / 2) * 0.5)) return first;

  return fitCircleKasa(Float64Array.from(kept)) ?? first;
}
