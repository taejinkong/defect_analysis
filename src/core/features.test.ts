import { describe, expect, it } from 'vitest';
import {
  IMAGE_FEATURE_DIM,
  PANEL_FEATURE_DIM,
  combinePanelFeature,
  cosine,
  extractImageFeature,
  fromBytes,
  toBytes,
} from './features';
import { detectDefects } from './defects';
import { createGray, createMask } from './image';
import { circleMask } from './image';
import { FRAME_CENTER, FRAME_RADIUS, FRAME_SIZE } from './types';
import { detectActiveCircle } from './preprocess';
import { normalizeFrame } from './normalize';
import { renderSyntheticPanel, addDarkDot, polarToSource } from './synthetic';

const ACTIVE = circleMask(FRAME_SIZE, FRAME_SIZE, FRAME_CENTER, FRAME_CENTER, FRAME_RADIUS * 0.98);
const ACTIVE_AREA = (() => {
  let n = 0;
  for (let i = 0; i < ACTIVE.data.length; i++) n += ACTIVE.data[i];
  return n;
})();

function flatGray(level: number) {
  const g = createGray(FRAME_SIZE, FRAME_SIZE);
  g.data.fill(level);
  return g;
}

describe('extractImageFeature', () => {
  it('has the documented dimension', () => {
    const feat = extractImageFeature(flatGray(180), ACTIVE, createMask(FRAME_SIZE, FRAME_SIZE), createMask(FRAME_SIZE, FRAME_SIZE), [], ACTIVE_AREA);
    expect(feat).toHaveLength(IMAGE_FEATURE_DIM);
    expect(IMAGE_FEATURE_DIM).toBe(91);
  });

  it('is all zeros in the fraction blocks for a clean panel', () => {
    const feat = extractImageFeature(flatGray(180), ACTIVE, createMask(FRAME_SIZE, FRAME_SIZE), createMask(FRAME_SIZE, FRAME_SIZE), [], ACTIVE_AREA);
    // First 32 radial + 48 angular = 80 fraction entries, all zero with no defects.
    for (let i = 0; i < 80; i++) expect(feat[i]).toBe(0);
    // Global mean block still reflects the level.
    expect(feat[80]).toBeCloseTo(180 / 255, 2);
  });

  it('lights the radial ring and angular sector where a dark region sits', () => {
    const dark = createMask(FRAME_SIZE, FRAME_SIZE);
    // A patch at 9 o'clock (angle 90), mid radius.
    const p = { x: FRAME_CENTER - FRAME_RADIUS * 0.5, y: FRAME_CENTER };
    for (let y = -8; y <= 8; y++) {
      for (let x = -8; x <= 8; x++) {
        dark.data[(Math.round(p.y) + y) * FRAME_SIZE + (Math.round(p.x) + x)] = 1;
      }
    }
    const feat = extractImageFeature(flatGray(180), ACTIVE, dark, createMask(FRAME_SIZE, FRAME_SIZE), [], ACTIVE_AREA);

    // Radial: ring 8 of 16 (~0.5) should carry dark fraction; ring 0 should not.
    const ring8Dark = feat[8 * 2];
    const ring0Dark = feat[0];
    expect(ring8Dark).toBeGreaterThan(0);
    expect(ring0Dark).toBe(0);

    // Angular: sector for 90 deg is index 6 of 24 (each 15 deg). dark at [32 + 6*2].
    const sector6Dark = feat[32 + 6 * 2];
    expect(sector6Dark).toBeGreaterThan(0);
  });

  it('separates a defective panel from a clean one', () => {
    const clean = extractImageFeature(flatGray(180), ACTIVE, createMask(FRAME_SIZE, FRAME_SIZE), createMask(FRAME_SIZE, FRAME_SIZE), [], ACTIVE_AREA);
    const dark = createMask(FRAME_SIZE, FRAME_SIZE);
    for (let i = 0; i < dark.data.length; i++) if (ACTIVE.data[i] && i % 7 === 0) dark.data[i] = 1;
    const defective = extractImageFeature(flatGray(180), ACTIVE, dark, createMask(FRAME_SIZE, FRAME_SIZE), [], ACTIVE_AREA);

    let diff = 0;
    for (let i = 0; i < IMAGE_FEATURE_DIM; i++) diff += Math.abs(clean[i] - defective[i]);
    expect(diff).toBeGreaterThan(0.5);
  });
});

describe('combinePanelFeature', () => {
  it('concatenates four blocks and L2-normalizes', () => {
    const block = new Float32Array(IMAGE_FEATURE_DIM).fill(0.5);
    const vec = combinePanelFeature({ R: block, G: block, B: block, W: block });
    expect(vec).toHaveLength(PANEL_FEATURE_DIM);
    let norm = 0;
    for (const v of vec) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('zero-fills a missing pattern', () => {
    const block = new Float32Array(IMAGE_FEATURE_DIM).fill(1);
    const vec = combinePanelFeature({ R: block });
    // The W block (last quarter) is untouched zeros.
    for (let i = 3 * IMAGE_FEATURE_DIM; i < PANEL_FEATURE_DIM; i++) expect(vec[i]).toBe(0);
  });

  it('produces a unit or zero vector, never NaN', () => {
    const empty = combinePanelFeature({});
    expect([...empty].every((v) => v === 0)).toBe(true);
  });
});

describe('cosine', () => {
  it('is 1 for identical unit vectors and 0 for orthogonal', () => {
    const a = combinePanelFeature({ R: new Float32Array(IMAGE_FEATURE_DIM).fill(1) });
    expect(cosine(a, a)).toBeCloseTo(1, 6);

    const x = new Float32Array(4);
    x[0] = 1;
    const y = new Float32Array(4);
    y[1] = 1;
    expect(cosine(x, y)).toBe(0);
  });

  it('ranks a matching panel above a different one', () => {
    // Same defect and position should be more similar than a clean panel.
    const geom = { cx: 320, cy: 320, r: 240 } as const;
    const featureOf = (paint?: (img: import('./types').Rgba) => void): Float32Array => {
      const img = renderSyntheticPanel({ ...geom, pattern: 'W', tabAngleDeg: 0, noise: 2 });
      paint?.(img);
      const detect = detectActiveCircle(img);
      if (!detect.ok) throw new Error('detect failed');
      const frame = normalizeFrame(img, detect.circle, detect.fpcb.rotationDeg);
      const detection = detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, 'W', undefined, {
        withFeature: true,
      });
      return combinePanelFeature({ W: detection.feature! });
    };

    const dot = polarToSource(geom, 0.6, 90);
    const query = featureOf((img) => addDarkDot(img, dot.x, dot.y, 12));
    const sameDefect = featureOf((img) => addDarkDot(img, dot.x, dot.y, 12));
    const clean = featureOf();

    expect(cosine(query, sameDefect)).toBeGreaterThan(cosine(query, clean));
  });
});

describe('byte round-trip', () => {
  it('survives ArrayBuffer conversion', () => {
    const vec = combinePanelFeature({ R: new Float32Array(IMAGE_FEATURE_DIM).fill(0.3) });
    const restored = fromBytes(toBytes(vec));
    expect(Array.from(restored)).toEqual(Array.from(vec));
  });
});
