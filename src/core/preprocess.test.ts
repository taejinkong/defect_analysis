import { describe, expect, it } from 'vitest';
import { detectActiveCircle, preprocess } from './preprocess';
import { addLine, polarToSource, renderSyntheticPanel } from './synthetic';
import { addDarkDot } from './synthetic';
import { angleDelta, angleFromOffset } from './geometry';
import { normalizeFrame, sourceToFrame } from './normalize';
import { FRAME_CENTER, FRAME_RADIUS, FRAME_SIZE } from './types';
import { toGray } from './image';
import { createRgba } from './image';
import { detectDefects } from './defects';
import { judgePanel } from './verdict';
import { DEFECT } from './settings';

describe('detectActiveCircle', () => {
  it('recovers the circle of a centered synthetic panel', () => {
    const img = renderSyntheticPanel({ cx: 320, cy: 320, r: 240 });
    const result = detectActiveCircle(img);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.circle.cx).toBeCloseTo(320, 0);
    expect(result.circle.cy).toBeCloseTo(320, 0);
    expect(result.circle.r).toBeCloseTo(240, 0);
    expect(result.rmsResidual).toBeLessThan(240 * 0.05);
  });

  it('recovers an off-center circle', () => {
    const img = renderSyntheticPanel({ width: 800, height: 600, cx: 300, cy: 260, r: 190 });
    const result = detectActiveCircle(img);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.circle.cx).toBeCloseTo(300, 0);
    expect(result.circle.cy).toBeCloseTo(260, 0);
    expect(result.circle.r).toBeCloseTo(190, 0);
  });

  it.each(['R', 'G', 'B', 'W'] as const)('works on the %s pattern', (pattern) => {
    const result = detectActiveCircle(renderSyntheticPanel({ pattern }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Otsu lands a fraction of a pixel differently per channel level, so the
    // fitted rim shifts slightly. Sub-pixel agreement across patterns is what
    // matters; the same panel must not yield different geometry per pattern.
    expect(Math.abs(result.circle.r - 240)).toBeLessThan(1.5);
  });

  it('is not fooled by a large dark defect inside the display', () => {
    const img = renderSyntheticPanel({ r: 240 });
    const p = polarToSource({ cx: 320, cy: 320, r: 240 }, 0.5, 90);
    addDarkDot(img, p.x, p.y, 60);

    const result = detectActiveCircle(img);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The dot punches a hole, but the boundary fit is driven by the outer rim.
    expect(result.circle.cx).toBeCloseTo(320, 0);
    expect(result.circle.r).toBeCloseTo(240, 0);
  });
});

describe('FPCB estimation', () => {
  it.each([0, 37, 90, 150, 214, 270, 333])('recovers a tab placed at %i degrees', (tabAngleDeg) => {
    const img = renderSyntheticPanel({ tabAngleDeg });
    const result = detectActiveCircle(img);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fpcbReliable).toBe(true);
    expect(angleDelta(result.fpcb.tabAngleDeg, tabAngleDeg)).toBeLessThan(3);
    // Applying the suggested rotation should bring the tab to 6 o'clock.
    expect(angleDelta(tabAngleDeg + result.fpcb.rotationDeg, 0)).toBeLessThan(3);
  });

  it('finds a tab that is darker than the background', () => {
    const img = renderSyntheticPanel({ tabAngleDeg: 120, backgroundLevel: 60, tabLevel: 6 });
    const result = detectActiveCircle(img);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(angleDelta(result.fpcb.tabAngleDeg, 120)).toBeLessThan(4);
  });

  it('reports low strength when there is no tab at all', () => {
    const img = renderSyntheticPanel({ tabLevel: DEFAULT_BACKGROUND, noise: 3 });
    const result = detectActiveCircle(img);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nothing to find: the app must fall back to manual confirmation rather
    // than silently rotating by a meaningless angle.
    expect(result.fpcbReliable).toBe(false);
  });
});

const DEFAULT_BACKGROUND = 12;

describe('real-capture robustness', () => {
  it('stays on the physical rim despite strong bloom around the panel', () => {
    // Real captures of a lit panel bleed light past the rim. Otsu alone lands
    // inside the halo and inflates the radius by several pixels; the gradient
    // refinement must snap back to the true edge.
    const img = renderSyntheticPanel({ glow: 0.7, glowFalloffPx: 30 });
    const result = detectActiveCircle(img);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.abs(result.circle.cx - 320)).toBeLessThan(2);
    expect(Math.abs(result.circle.cy - 320)).toBeLessThan(2);
    expect(Math.abs(result.circle.r - 240)).toBeLessThan(2);
  });

  it('recovers the circle when the crop clips one side', () => {
    // cx - r = -20: the left edge of the circle is cut off by the crop.
    const img = renderSyntheticPanel({ width: 620, height: 640, cx: 220, cy: 320, r: 240 });
    const result = detectActiveCircle(img);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.abs(result.circle.cx - 220)).toBeLessThan(3);
    expect(Math.abs(result.circle.cy - 320)).toBeLessThan(3);
    expect(Math.abs(result.circle.r - 240)).toBeLessThan(3);
  });

  it('recovers the circle from a tight crop clipped on all four sides', () => {
    // Only the four corner arcs of background remain; every straight border
    // run must be ignored or the fit collapses toward the crop rectangle.
    const img = renderSyntheticPanel({ width: 460, height: 460, cx: 230, cy: 230, r: 250, tabLevel: 12 });
    const result = detectActiveCircle(img);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.abs(result.circle.cx - 230)).toBeLessThan(3);
    expect(Math.abs(result.circle.cy - 230)).toBeLessThan(3);
    expect(Math.abs(result.circle.r - 250)).toBeLessThan(4);
  });

  it('still calls a line defect a line, not 미점등, on a glowing cropped capture', () => {
    // The reported field failure: a cropped real capture with a line defect
    // was judged 미점등 because the mis-fit circle let background into the
    // active mask. With an accurate rim the line must be detected.
    const img = renderSyntheticPanel({ width: 620, height: 640, cx: 310, cy: 320, r: 250, glow: 0.6 });
    addLine(img, 310 + 40, 320, 320, 4, 90, 6);

    const { detect, frame } = preprocess(img);
    expect(detect.ok).toBe(true);
    expect(frame).not.toBeNull();
    if (!frame) return;

    const detection = detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, 'W');
    expect(detection.noDisplay).toBe('none');
    expect(detection.detections.some((d) => d.kind === 'dark-line-v')).toBe(true);

    const verdict = judgePanel([detection]);
    expect(verdict.finalJudgementId).not.toBe(DEFECT.NO_DISPLAY);
    expect(verdict.detectedDefectIds).toContain(DEFECT.DARK_LINE_V);
  });
});

describe('detection failures', () => {
  it('rejects an all-black image', () => {
    const img = createRgba(200, 200);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    const result = detectActiveCircle(img);
    expect(result.ok).toBe(false);
  });

  it('rejects a display too small to be the panel', () => {
    const img = renderSyntheticPanel({ width: 900, height: 900, cx: 450, cy: 450, r: 90 });
    const result = detectActiveCircle(img);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('component-too-small');
  });

  it('rejects a non-circular bright region', () => {
    const img = createRgba(400, 400);
    for (let y = 0; y < 400; y++) {
      for (let x = 0; x < 400; x++) {
        const i = (y * 400 + x) * 4;
        const lit = x > 40 && x < 360 && y > 120 && y < 280;
        const v = lit ? 220 : 10;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    const result = detectActiveCircle(img);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-circular');
    expect(result.circle).toBeDefined();
  });
});

describe('normalizeFrame', () => {
  it('places the circle at the canonical center and radius', () => {
    const img = renderSyntheticPanel({ width: 800, height: 600, cx: 300, cy: 260, r: 190 });
    const detected = detectActiveCircle(img);
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;

    const { frame } = preprocess(img);
    expect(frame).not.toBeNull();
    const gray = toGray(frame!.image);

    // Center is lit, well outside the circle is not.
    expect(gray.data[FRAME_CENTER * FRAME_SIZE + FRAME_CENTER]).toBeGreaterThan(150);
    expect(gray.data[2 * FRAME_SIZE + 2]).toBeLessThan(60);

    // The rim sits at FRAME_RADIUS: just inside is lit, just outside is not.
    const inside = gray.data[FRAME_CENTER * FRAME_SIZE + (FRAME_CENTER + FRAME_RADIUS - 6)];
    const outside = gray.data[FRAME_CENTER * FRAME_SIZE + (FRAME_CENTER + FRAME_RADIUS + 6)];
    expect(inside).toBeGreaterThan(120);
    expect(outside).toBeLessThan(120);
  });

  it('rotates the tab to 6 o clock', () => {
    const tabAngleDeg = 214;
    const img = renderSyntheticPanel({ tabAngleDeg });
    const { detect, frame } = preprocess(img);
    expect(detect.ok).toBe(true);
    if (!detect.ok || !frame) return;

    const gray = toGray(frame.image);
    // The frame crops at r = 256, so only the innermost sliver of the tab
    // survives. Sample just outside the rim, where background and tab differ.
    // The tab is a ~22-degree-wide plateau, so a raw argmax lands anywhere the
    // pixel noise favors; a brightness-weighted circular centroid of the
    // above-half-max samples is stable.
    const probeRadius = FRAME_RADIUS + 3;
    const values: number[] = [];
    for (let a = 0; a < 360; a += 2) {
      const rad = (a * Math.PI) / 180;
      const x = Math.round(FRAME_CENTER - Math.sin(rad) * probeRadius);
      const y = Math.round(FRAME_CENTER + Math.cos(rad) * probeRadius);
      values.push(gray.data[y * FRAME_SIZE + x]!);
    }
    const sorted = [...values].sort((a, b) => a - b);
    const baseline = sorted[sorted.length >> 1]!;
    const peak = sorted[sorted.length - 1]!;
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < values.length; k++) {
      const w = values[k]! - (baseline + peak) / 2;
      if (w <= 0) continue;
      const rad = (k * 2 * Math.PI) / 180;
      sx += Math.cos(rad) * w;
      sy += Math.sin(rad) * w;
    }
    const centroid = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
    expect(angleDelta(centroid, 0)).toBeLessThan(6);
  });

  it('maps a known defect position to the expected polar coordinates', () => {
    // A dot at r=0.6, 90 degrees (9 o'clock) from a tab at 214 degrees should,
    // after normalization, sit at 90 - 214 = -124 -> 236 degrees.
    const circle = { cx: 320, cy: 320, r: 240 };
    const tabAngleDeg = 214;
    const img = renderSyntheticPanel({ tabAngleDeg });
    const dot = polarToSource(circle, 0.6, 90);
    addDarkDot(img, dot.x, dot.y, 10);

    const detect = detectActiveCircle(img);
    expect(detect.ok).toBe(true);
    if (!detect.ok) return;

    const rotation = detect.fpcb.rotationDeg;
    const mapped = sourceToFrame(detect.circle, rotation, dot.x, dot.y);
    const rRatio = Math.hypot(mapped.x - FRAME_CENTER, mapped.y - FRAME_CENTER) / FRAME_RADIUS;
    const angle = angleFromOffset(mapped.x - FRAME_CENTER, mapped.y - FRAME_CENTER);

    expect(rRatio).toBeCloseTo(0.6, 1);
    expect(angleDelta(angle, 236)).toBeLessThan(4);
  });

  it('is idempotent for an already-aligned panel', () => {
    const img = renderSyntheticPanel({ tabAngleDeg: 0 });
    const detect = detectActiveCircle(img);
    if (!detect.ok) throw new Error('detect failed');
    expect(angleDelta(detect.fpcb.rotationDeg, 0)).toBeLessThan(3);

    const frame = normalizeFrame(img, detect.circle, 0);
    expect(frame.activeAreaPx).toBeGreaterThan(0);
    // pi * (250 * 0.98)^2 ~= 188_500
    expect(frame.activeAreaPx).toBeCloseTo(Math.PI * (FRAME_RADIUS * 0.98) ** 2, -3);
  });
});
