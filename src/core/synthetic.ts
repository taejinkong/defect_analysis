import type { Pattern, Rgba } from './types';
import { createRgba } from './image';
import { offsetFromAngle, rotateClockwise } from './geometry';

export interface SyntheticOptions {
  readonly width: number;
  readonly height: number;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly pattern: Pattern;
  /** Where to place the FPCB tab, in the clock convention (0 = 6 o'clock). */
  readonly tabAngleDeg: number;
  readonly tabHalfWidthDeg: number;
  readonly tabOuterFactor: number;
  readonly backgroundLevel: number;
  readonly tabLevel: number;
  readonly noise: number;
  readonly vignette: number;
  readonly seed: number;
}

export const DEFAULT_SYNTHETIC: SyntheticOptions = {
  width: 640,
  height: 640,
  cx: 320,
  cy: 320,
  r: 240,
  pattern: 'W',
  tabAngleDeg: 0,
  tabHalfWidthDeg: 11,
  tabOuterFactor: 1.22,
  backgroundLevel: 12,
  tabLevel: 96,
  noise: 4,
  vignette: 0.12,
  seed: 1,
};

/**
 * Lit levels sit well below 255 on purpose. A real capture is exposed so the
 * panel does not clip; if it did, a bright defect would have no headroom to
 * stand out in and could never be detected.
 */
const CHANNEL_LEVELS: Record<Pattern, [number, number, number]> = {
  R: [190, 14, 14],
  G: [14, 190, 14],
  B: [14, 14, 190],
  W: [200, 200, 200],
};

/** Deterministic PRNG so tests do not flake on noise. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Render a lit circular display on a dark background with an FPCB tab, for
 * exercising the preprocessing pipeline without real capture images.
 *
 * The tab is drawn in the same clock convention the detector reports, so a
 * round trip through `detectActiveCircle` should recover `tabAngleDeg`.
 */
export function renderSyntheticPanel(overrides: Partial<SyntheticOptions> = {}): Rgba {
  const o = { ...DEFAULT_SYNTHETIC, ...overrides };
  const img = createRgba(o.width, o.height);
  const rand = mulberry32(o.seed);
  const [cr, cg, cb] = CHANNEL_LEVELS[o.pattern];

  // Tab geometry: a wedge between r and r*tabOuterFactor. Working in the tab's
  // own rotated frame turns the angular test into a simple sign check.
  const tabDir = offsetFromAngle(o.tabAngleDeg);
  const tabInner = o.r * 0.98;
  const tabOuter = o.r * o.tabOuterFactor;
  const cosHalf = Math.cos((o.tabHalfWidthDeg * Math.PI) / 180);

  for (let y = 0; y < o.height; y++) {
    for (let x = 0; x < o.width; x++) {
      const dx = x - o.cx;
      const dy = y - o.cy;
      const dist = Math.hypot(dx, dy);

      let r: number;
      let g: number;
      let b: number;

      if (dist <= o.r) {
        const t = dist / o.r;
        const fall = 1 - o.vignette * t * t;
        r = cr * fall;
        g = cg * fall;
        b = cb * fall;
      } else {
        const inRing = dist >= tabInner && dist <= tabOuter;
        const aligned = dist > 0 && (dx * tabDir.dx + dy * tabDir.dy) / dist >= cosHalf;
        const level = inRing && aligned ? o.tabLevel : o.backgroundLevel;
        r = g = b = level;
      }

      const n = (rand() - 0.5) * 2 * o.noise;
      const i = (y * o.width + x) * 4;
      img.data[i] = r + n;
      img.data[i + 1] = g + n;
      img.data[i + 2] = b + n;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** Draw a filled dark dot into an already-rendered panel, in source coordinates. */
export function addDarkDot(img: Rgba, x: number, y: number, radius: number, level = 8): void {
  stamp(img, x, y, radius, () => level);
}

/** Draw a filled bright dot into an already-rendered panel. */
export function addBrightDot(img: Rgba, x: number, y: number, radius: number, level = 255): void {
  stamp(img, x, y, radius, () => level);
}

/**
 * Draw a straight line of the given thickness, in source coordinates.
 * `angleDeg` is measured from +x, so 0 is horizontal and 90 is vertical.
 */
export function addLine(
  img: Rgba,
  x: number,
  y: number,
  length: number,
  thickness: number,
  angleDeg: number,
  level: number,
): void {
  const rad = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const half = length / 2;
  const steps = Math.ceil(length * 2);

  for (let s = 0; s <= steps; s++) {
    const t = -half + (length * s) / steps;
    stamp(img, x + ux * t, y + uy * t, thickness / 2, () => level);
  }
}

/** Fill the whole active circle with a uniform level, simulating no-display. */
export function blankPanel(img: Rgba, cx: number, cy: number, r: number, level: number): void {
  stamp(img, cx, cy, r, () => level);
}

/** Overlay horizontal banding, the visual signature of a driving defect. */
export function addBanding(img: Rgba, cx: number, cy: number, r: number, amplitude: number): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    if (y < 0 || y >= img.height) continue;
    const delta = y % 2 === 0 ? amplitude : -amplitude;
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || x >= img.width) continue;
      if (Math.hypot(x - cx, y - cy) > r) continue;
      const i = (y * img.width + x) * 4;
      img.data[i] += delta;
      img.data[i + 1] += delta;
      img.data[i + 2] += delta;
    }
  }
}

function stamp(img: Rgba, x: number, y: number, radius: number, valueAt: () => number): void {
  const value = valueAt();
  for (let v = Math.floor(y - radius); v <= Math.ceil(y + radius); v++) {
    for (let u = Math.floor(x - radius); u <= Math.ceil(x + radius); u++) {
      if (u < 0 || v < 0 || u >= img.width || v >= img.height) continue;
      if (Math.hypot(u - x, v - y) > radius) continue;
      const i = (v * img.width + u) * 4;
      img.data[i] = value;
      img.data[i + 1] = value;
      img.data[i + 2] = value;
    }
  }
}

/**
 * Place a point at `(rRatio, angleDeg)` relative to a synthetic panel's circle,
 * in source-image coordinates. Mirrors the detector's angle convention.
 */
export function polarToSource(
  o: Pick<SyntheticOptions, 'cx' | 'cy' | 'r'>,
  rRatio: number,
  angleDeg: number,
): { x: number; y: number } {
  const { dx, dy } = offsetFromAngle(angleDeg);
  return { x: o.cx + dx * o.r * rRatio, y: o.cy + dy * o.r * rRatio };
}

/** Rotate a synthetic panel's tab angle the way a re-shoot would. */
export function rotatedTabAngle(tabAngleDeg: number, byDeg: number): number {
  const p = rotateClockwise(0, 1, tabAngleDeg + byDeg);
  return Math.atan2(-p.x, p.y) * (180 / Math.PI);
}
