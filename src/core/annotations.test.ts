import { describe, expect, it } from 'vitest';
import {
  ACTIVE_AREA_PX,
  buildAnnotation,
  combinedDarkAreaPct,
  insideActiveArea,
  judgeFromLabels,
  manualDarkGrade,
  primaryFromLabels,
  representativePoint,
  shapeFromStoredAnnotation,
} from './annotations';
import { FRAME_CENTER, FRAME_RADIUS } from './types';
import { angleDelta } from './geometry';
import { DEFAULT_SETTINGS, DEFECT } from './settings';

const NOW = new Date('2026-07-09T12:00:00.000Z');

describe('representativePoint', () => {
  it('returns a point as-is', () => {
    expect(representativePoint({ geomType: 'point', x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });

  it('returns the midpoint of a line', () => {
    expect(representativePoint({ geomType: 'line', x: 0, y: 0, x2: 10, y2: 20 })).toEqual({ x: 5, y: 10 });
  });

  it('returns the center of a box', () => {
    expect(representativePoint({ geomType: 'box', x: 10, y: 10, x2: 30, y2: 50 })).toEqual({ x: 20, y: 30 });
  });
});

describe('shapeFromStoredAnnotation', () => {
  it('restores the full line instead of drawing only midpoint-to-end', () => {
    const stored = buildAnnotation(
      { geomType: 'line', x: 100, y: 140, x2: 300, y2: 260 },
      DEFECT.BRIGHT_LINE_H,
      1,
      NOW,
    );
    expect(shapeFromStoredAnnotation(stored)).toEqual({
      geomType: 'line',
      x: 100,
      y: 140,
      x2: 300,
      y2: 260,
    });
  });

  it('restores all four corners of the selected box', () => {
    const stored = buildAnnotation(
      { geomType: 'box', x: 120, y: 180, x2: 320, y2: 300 },
      DEFECT.BRIGHT_DOT,
      1,
      NOW,
    );
    expect(shapeFromStoredAnnotation(stored)).toEqual({
      geomType: 'box',
      x: 120,
      y: 180,
      x2: 320,
      y2: 300,
    });
  });
});

describe('buildAnnotation', () => {
  it('places a point at the center as r=0', () => {
    const a = buildAnnotation({ geomType: 'point', x: FRAME_CENTER, y: FRAME_CENTER }, DEFECT.BRIGHT_DOT, 7, NOW);
    expect(a.rRatio).toBe(0);
    expect(a.region).toBe('center');
    expect(a.imageId).toBe(7);
    expect(a.labelSource).toBe('manual');
    expect(a.confidence).toBe(1);
    expect(a.reviewStatus).toBe('pending');
  });

  it('computes clock angle and region from position', () => {
    // Directly below center is 6 o'clock, angle 0, at the rim.
    const a = buildAnnotation(
      { geomType: 'point', x: FRAME_CENTER, y: FRAME_CENTER + FRAME_RADIUS * 0.9 },
      DEFECT.BRIGHT_DOT,
      1,
      NOW,
    );
    expect(angleDelta(a.angleDeg, 0)).toBeLessThan(0.001);
    expect(a.rRatio).toBeCloseTo(0.9, 6);
    expect(a.region).toBe('edge');
  });

  it('reports 9 o clock as 90 degrees', () => {
    const a = buildAnnotation(
      { geomType: 'point', x: FRAME_CENTER - FRAME_RADIUS * 0.5, y: FRAME_CENTER },
      DEFECT.BRIGHT_DOT,
      1,
      NOW,
    );
    expect(angleDelta(a.angleDeg, 90)).toBeLessThan(0.001);
    expect(a.region).toBe('mid');
  });

  it('bins a line by its midpoint, not its endpoints', () => {
    // Endpoints straddle the center; the midpoint is the center.
    const a = buildAnnotation(
      {
        geomType: 'line',
        x: FRAME_CENTER - 200,
        y: FRAME_CENTER,
        x2: FRAME_CENTER + 200,
        y2: FRAME_CENTER,
      },
      DEFECT.BRIGHT_LINE_H,
      1,
      NOW,
    );
    expect(a.rRatio).toBe(0);
    expect(a.region).toBe('center');
    expect(a.x2).toBe(FRAME_CENTER + 200);
  });

  it('measures area only for a box', () => {
    const box = buildAnnotation(
      { geomType: 'box', x: 100, y: 100, x2: 120, y2: 110 },
      DEFECT.DARK_DOT_SMALL,
      1,
      NOW,
    );
    expect(box.areaPx).toBe(200);
    expect(box.areaRatio).toBeCloseTo((200 / ACTIVE_AREA_PX) * 100, 8);

    // A hand-placed point has no measured extent, so it must not pretend to.
    const point = buildAnnotation({ geomType: 'point', x: 100, y: 100 }, DEFECT.DARK_DOT_SMALL, 1, NOW);
    expect(point.areaPx).toBe(0);
    expect(point.areaRatio).toBe(0);

    const line = buildAnnotation(
      { geomType: 'line', x: 0, y: 0, x2: 300, y2: 0 },
      DEFECT.DARK_LINE_H,
      1,
      NOW,
    );
    expect(line.areaPx).toBe(0);
  });

  it('handles a box drawn right-to-left', () => {
    const a = buildAnnotation({ geomType: 'box', x: 120, y: 110, x2: 100, y2: 100 }, DEFECT.BRIGHT_DOT, 1, NOW);
    expect(a.areaPx).toBe(200);
    expect(a.x).toBe(110);
    expect(a.y).toBe(105);
  });

  it('stamps the given time', () => {
    const a = buildAnnotation({ geomType: 'point', x: 1, y: 1 }, DEFECT.BRIGHT_DOT, 1, NOW);
    expect(a.createdAt).toBe('2026-07-09T12:00:00.000Z');
  });
});

describe('insideActiveArea', () => {
  it('accepts the center and rejects beyond the shrunk rim', () => {
    expect(insideActiveArea(FRAME_CENTER, FRAME_CENTER)).toBe(true);
    expect(insideActiveArea(FRAME_CENTER, FRAME_CENTER + FRAME_RADIUS * 0.97)).toBe(true);
    expect(insideActiveArea(FRAME_CENTER, FRAME_CENTER + FRAME_RADIUS)).toBe(false);
    expect(insideActiveArea(0, 0)).toBe(false);
  });
});

describe('judgeFromLabels', () => {
  it('is 양품 with no labels', () => {
    expect(judgeFromLabels([])).toBe(DEFECT.GOOD);
  });

  it('is the single defect when only one kind is present', () => {
    expect(judgeFromLabels([DEFECT.BRIGHT_DOT, DEFECT.BRIGHT_DOT])).toBe(DEFECT.BRIGHT_DOT);
  });

  it('is 복수불량 for two distinct kinds', () => {
    expect(judgeFromLabels([DEFECT.BRIGHT_DOT, DEFECT.DARK_LINE_V])).toBe(DEFECT.MULTI);
  });
});

describe('manual dark-area grading', () => {
  const box = (imageId: number, x: number, y: number, x2: number, y2: number) =>
    buildAnnotation({ geomType: 'box', x, y, x2, y2 }, DEFECT.DARK_DOT_SMALL, imageId, NOW);

  it('unions every selected region and assigns one grade from the total area', () => {
    const labels = [box(1, 150, 200, 210, 300), box(1, 300, 200, 360, 300)];
    const result = manualDarkGrade(labels);
    expect(result.areaPct).toBeGreaterThan(5);
    expect(result.areaPct).toBeLessThan(15);
    expect(result.defectId).toBe(DEFECT.DARK_DOT_MEDIUM);
  });

  it('does not double-count overlapping selections', () => {
    const one = box(1, 190, 190, 290, 290);
    expect(combinedDarkAreaPct([one, one])).toBeCloseTo(combinedDarkAreaPct([one]), 8);
  });

  it('uses the largest pattern total instead of summing the same defect across patterns', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      'dark_dot.medium_max_pct': 8,
    };
    const labels = [box(1, 190, 190, 290, 290), box(2, 190, 190, 290, 290)];
    const result = manualDarkGrade(labels, settings);
    expect(result.areaPct).toBeGreaterThan(5);
    expect(result.areaPct).toBeLessThan(8);
    expect(result.defectId).toBe(DEFECT.DARK_DOT_MEDIUM);
  });
});

describe('primaryFromLabels', () => {
  it('picks the most severe', () => {
    // 미점등(4) outranks 명선(3) outranks 암점 小(1).
    expect(primaryFromLabels([DEFECT.DARK_DOT_SMALL, DEFECT.BRIGHT_LINE_H, DEFECT.NO_DISPLAY])).toBe(
      DEFECT.NO_DISPLAY,
    );
    expect(primaryFromLabels([DEFECT.DARK_DOT_SMALL, DEFECT.BRIGHT_LINE_H])).toBe(DEFECT.BRIGHT_LINE_H);
  });

  it('is 양품 when empty', () => {
    expect(primaryFromLabels([])).toBe(DEFECT.GOOD);
  });
});
