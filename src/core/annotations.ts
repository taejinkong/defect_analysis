import { FRAME_CENTER, FRAME_RADIUS } from './types';
import { angleFromOffset, regionFromRadius } from './geometry';
import type { DefectId, Settings } from './settings';
import { DEFAULT_SETTINGS, DEFECT_SEVERITY, DEFECT_NAME } from './settings';
import type { GeomType, NewAnnotation } from './records';

export interface Shape {
  readonly geomType: GeomType;
  readonly x: number;
  readonly y: number;
  readonly x2?: number;
  readonly y2?: number;
}

/** Area of the active mask in the normalized frame, used as the ratio denominator. */
export const ACTIVE_AREA_PX = Math.PI * (FRAME_RADIUS * 0.98) ** 2;

/**
 * Build a stored annotation from a shape drawn on the normalized frame.
 *
 * The representative point differs by geometry: a line reports its midpoint and
 * a box its center, because that is the value the location heatmap bins. See
 * docs/database_schema.md section 3.4.
 *
 * `areaPx` is only meaningful for a box. A hand-placed point or line has no
 * measured extent, so it contributes nothing to `dark_area_ratio`; manual dark
 * dots therefore cannot drive the 小/中/大 grade. Grading stays with the rule
 * engine's pixel masks, which is the only place real area is known.
 */
export function buildAnnotation(
  shape: Shape,
  defectId: DefectId,
  imageId: number,
  now: Date = new Date(),
  settings: Settings = DEFAULT_SETTINGS,
): NewAnnotation {
  const point = representativePoint(shape);
  const dx = point.x - FRAME_CENTER;
  const dy = point.y - FRAME_CENTER;
  const rRatio = Math.hypot(dx, dy) / FRAME_RADIUS;
  const areaPx = shape.geomType === 'box' ? boxArea(shape) : 0;

  return {
    imageId,
    defectId,
    labelSource: 'manual',
    geomType: shape.geomType,
    x: point.x,
    y: point.y,
    x2: shape.x2 ?? null,
    y2: shape.y2 ?? null,
    areaPx,
    areaRatio: (areaPx / ACTIVE_AREA_PX) * 100,
    rRatio,
    angleDeg: angleFromOffset(dx, dy),
    region: regionFromRadius(rRatio, settings['region.center_max_r'], settings['region.mid_max_r']),
    confidence: 1,
    reviewStatus: 'pending',
    createdAt: now.toISOString(),
  };
}

export function representativePoint(shape: Shape): { x: number; y: number } {
  if (shape.x2 === undefined || shape.y2 === undefined) return { x: shape.x, y: shape.y };
  return { x: (shape.x + shape.x2) / 2, y: (shape.y + shape.y2) / 2 };
}

function boxArea(shape: Shape): number {
  if (shape.x2 === undefined || shape.y2 === undefined) return 0;
  return Math.abs(shape.x2 - shape.x) * Math.abs(shape.y2 - shape.y);
}

/** Is the point inside the active display area of the normalized frame? */
export function insideActiveArea(x: number, y: number): boolean {
  return Math.hypot(x - FRAME_CENTER, y - FRAME_CENTER) <= FRAME_RADIUS * 0.98;
}

/**
 * The panel-level judgement implied by a set of hand-placed labels.
 *
 * Mirrors docs/defect_taxonomy.md section 7, but from labels rather than pixels:
 * two or more distinct defect kinds is 복수불량, one is that defect, none is 양품.
 */
export function judgeFromLabels(defectIds: readonly DefectId[]): DefectId {
  const distinct = [...new Set(defectIds)];
  if (distinct.length === 0) return 'D000';
  if (distinct.length >= 2) return 'D011';
  return distinct[0]!;
}

/** Highest-severity label, used as the panel's primary defect. */
export function primaryFromLabels(defectIds: readonly DefectId[]): DefectId {
  if (defectIds.length === 0) return 'D000';
  return [...defectIds].sort((a, b) => DEFECT_SEVERITY[b] - DEFECT_SEVERITY[a])[0]!;
}

export function describeAnnotation(annotation: {
  defectId: DefectId;
  geomType: GeomType;
  rRatio: number;
  angleDeg: number;
  region: string;
}): string {
  const hour = (6 + annotation.angleDeg / 30) % 12;
  const clock = hour < 1 ? hour + 12 : hour;
  return `${DEFECT_NAME[annotation.defectId]} · ${annotation.geomType} · ${clock.toFixed(1)}시 · ${annotation.region} (r=${annotation.rRatio.toFixed(2)})`;
}
