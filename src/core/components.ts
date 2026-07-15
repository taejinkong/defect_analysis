import type { Mask } from './types';
import { createMask } from './image';

export interface Component {
  readonly mask: Mask;
  readonly area: number;
}

/**
 * Largest 4-connected foreground component, found with an explicit-stack flood
 * fill. Recursion would blow the stack on a full-frame display region.
 */
export function largestComponent(mask: Mask): Component | null {
  const { width: w, height: h, data } = mask;
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);

  let bestArea = 0;
  let bestLabel = -1;
  let label = 0;

  for (let start = 0; start < data.length; start++) {
    if (data[start] === 0 || labels[start] !== -1) continue;

    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    let area = 0;

    while (top > 0) {
      const p = stack[--top];
      area++;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }

    if (area > bestArea) {
      bestArea = area;
      bestLabel = label;
    }
    label++;

    function push(q: number): void {
      if (data[q] === 1 && labels[q] === -1) {
        labels[q] = label;
        stack[top++] = q;
      }
    }
  }

  if (bestLabel === -1) return null;

  const out = createMask(w, h);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === bestLabel) out.data[i] = 1;
  }
  return { mask: out, area: bestArea };
}

/**
 * Fill enclosed background regions.
 *
 * A dark defect inside the display leaves a hole in the thresholded component,
 * and its rim would otherwise be reported as boundary and drag the circle fit
 * off. Flood the background inward from the image border; whatever is unset and
 * unreached is enclosed, so set it.
 */
export function fillHoles(mask: Mask): Mask {
  const { width: w, height: h, data } = mask;
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;

  const seed = (i: number): void => {
    if (data[i] === 0 && outside[i] === 0) {
      outside[i] = 1;
      stack[top++] = i;
    }
  };

  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }

  while (top > 0) {
    const p = stack[--top];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (y > 0) seed(p - w);
    if (y < h - 1) seed(p + w);
  }

  const out = createMask(w, h);
  for (let i = 0; i < data.length; i++) out.data[i] = data[i] === 1 || outside[i] === 0 ? 1 : 0;
  return out;
}

/**
 * Points on the component's outer edge: set pixels with at least one unset
 * 4-neighbor.
 *
 * A pixel that only touches the *image's* own border, with no unset neighbor
 * on any side we can actually check, is not treated as boundary. A crop tight
 * enough to clip the true circle leaves a straight run of foreground pixels
 * along that edge; those pixels sit deep inside the true circle, not on its
 * rim, so counting them as boundary would pull an unweighted circle fit
 * toward a straight line instead of the true arc. Genuine rim points that
 * happen to sit on the image border (e.g. a perfectly tight bounding-box
 * crop) still have a real transition to background on their unclipped side
 * and are kept.
 */
export function boundaryPoints(mask: Mask): Float64Array {
  const { width: w, height: h, data } = mask;
  const xs: number[] = [];
  const ys: number[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (data[i] === 0) continue;
      const edge =
        (x > 0 && data[i - 1] === 0) ||
        (x < w - 1 && data[i + 1] === 0) ||
        (y > 0 && data[i - w] === 0) ||
        (y < h - 1 && data[i + w] === 0);
      if (edge) {
        xs.push(x);
        ys.push(y);
      }
    }
  }

  const pts = new Float64Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) {
    pts[i * 2] = xs[i];
    pts[i * 2 + 1] = ys[i];
  }
  return pts;
}

/**
 * True when the component touches the image border for more than a couple of
 * pixels on any side — a sign the source was cropped tighter than the true
 * silhouette, so part of its boundary is permanently invisible and the fitted
 * circle can only ever be an approximation. A lone tangent pixel from an
 * exact bounding-box crop does not count.
 */
export function touchesImageBorder(mask: Mask, minRun = 3): boolean {
  const { width: w, height: h, data } = mask;

  const longestRun = (length: number, at: (k: number) => number): number => {
    let best = 0;
    let run = 0;
    for (let k = 0; k < length; k++) {
      if (data[at(k)] === 1) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    return best;
  };

  const runs = [
    longestRun(w, (x) => x), // top row
    longestRun(w, (x) => (h - 1) * w + x), // bottom row
    longestRun(h, (y) => y * w), // left column
    longestRun(h, (y) => y * w + w - 1), // right column
  ];

  return Math.max(...runs) >= minRun;
}
