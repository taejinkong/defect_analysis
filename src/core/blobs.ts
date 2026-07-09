import type { Mask } from './types';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Blob {
  readonly areaPx: number;
  /** Centroid, used as the defect's representative point. */
  readonly cx: number;
  readonly cy: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly points: Int32Array;
}

/** All 8-connected components with at least `minArea` pixels. */
export function findBlobs(mask: Mask, minArea = 1): Blob[] {
  const { width: w, height: h, data } = mask;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const blobs: Blob[] = [];

  for (let start = 0; start < data.length; start++) {
    if (data[start] === 0 || seen[start] === 1) continue;

    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const pixels: number[] = [];

    while (top > 0) {
      const p = stack[--top];
      pixels.push(p);
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (data[q] === 1 && seen[q] === 0) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
    }

    if (pixels.length < minArea) continue;

    let sumX = 0;
    let sumY = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pixels) {
      const x = p % w;
      const y = (p - x) / w;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    blobs.push({
      areaPx: pixels.length,
      cx: sumX / pixels.length,
      cy: sumY / pixels.length,
      minX,
      minY,
      maxX,
      maxY,
      points: Int32Array.from(pixels),
    });
  }
  return blobs;
}

/** Andrew's monotone chain. Returns the hull in counter-clockwise order. */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return [...points];
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);

  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const build = (input: Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of input) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };

  return [...build(pts), ...build(pts.reverse())];
}

export interface MinAreaRect {
  readonly long: number;
  readonly short: number;
  /** Orientation of the long side, degrees in [0, 180) measured from +x. */
  readonly angleDeg: number;
}

/**
 * Minimum-area enclosing rectangle via rotating calipers.
 *
 * The optimal rectangle always has one side collinear with a hull edge, so
 * testing each edge as a candidate axis suffices. Hulls here have a few dozen
 * vertices, so the O(h^2) projection loop is cheaper than the bookkeeping a
 * true O(h) caliper walk would need.
 */
export function minAreaRect(points: Point[]): MinAreaRect {
  const hull = convexHull(points);
  if (hull.length < 2) return { long: 1, short: 1, angleDeg: 0 };

  let best: MinAreaRect | null = null;
  let bestArea = Infinity;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    // +1 px: a single row of pixels spans zero in the projection but is one
    // pixel wide. Without this a perfect 1px line has zero area and zero width,
    // making its aspect ratio infinite or NaN.
    const du = maxU - minU + 1;
    const dv = maxV - minV + 1;
    const area = du * dv;
    if (area >= bestArea) continue;

    bestArea = area;
    const longAlongU = du >= dv;
    const axisAngle = Math.atan2(uy, ux) * (180 / Math.PI);
    const angle = longAlongU ? axisAngle : axisAngle + 90;
    best = {
      long: Math.max(du, dv),
      short: Math.min(du, dv),
      angleDeg: ((angle % 180) + 180) % 180,
    };
  }

  return best ?? { long: 1, short: 1, angleDeg: 0 };
}

export function blobPoints(blob: Blob, width: number): Point[] {
  const pts: Point[] = [];
  for (const p of blob.points) {
    const x = p % width;
    pts.push({ x, y: (p - x) / width });
  }
  return pts;
}
