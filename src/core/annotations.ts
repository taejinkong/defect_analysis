import { FRAME_CENTER, FRAME_RADIUS } from './types';
import { FRAME_SIZE } from './types';
import { angleFromOffset, regionFromRadius } from './geometry';
import type { DefectId, Settings } from './settings';
import { DEFAULT_SETTINGS, DEFECT_SEVERITY, DEFECT_NAME, isDarkDotDefect } from './settings';
import type { AnnotationRecord, GeomType, NewAnnotation } from './records';
import { gradeDarkDot } from './verdict';

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
 * `areaPx` is only meaningful for a box. It is clipped to the circular Active
 * area, matching what the operator can actually select on the normalized frame.
 * A hand-placed point or line has no measured extent.
 */
export function buildAnnotation(
  shape: Shape,
  defectId: DefectId,
  imageId: number,
  now: Date = new Date(),
  settings: Settings = DEFAULT_SETTINGS,
  maskRle?: string,
): NewAnnotation {
  const point = representativePoint(shape);
  const dx = point.x - FRAME_CENTER;
  const dy = point.y - FRAME_CENTER;
  const rRatio = Math.hypot(dx, dy) / FRAME_RADIUS;
  const maskArea = maskRle ? maskAreaFromRle(maskRle) : 0;
  const areaPx = maskArea > 0 ? maskArea : shape.geomType === 'box' ? boxAreaInsideActive(shape) : 0;

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
    ...(maskRle ? { maskRle } : {}),
  };
}

export function representativePoint(shape: Shape): { x: number; y: number } {
  if (shape.x2 === undefined || shape.y2 === undefined) return { x: shape.x, y: shape.y };
  return { x: (shape.x + shape.x2) / 2, y: (shape.y + shape.y2) / 2 };
}

export interface StoredShape {
  readonly geomType: GeomType;
  readonly x: number;
  readonly y: number;
  readonly x2: number | null;
  readonly y2: number | null;
}

/**
 * Recover the gesture geometry from a stored annotation.
 *
 * The schema intentionally stores x/y as the representative point used by the
 * heatmap, while x2/y2 stores the drag end. For a line or box the original drag
 * start is therefore `2 * midpoint - end`. Treating x/y as the start made saved
 * lines half-length and saved boxes one quarter of the selected area.
 */
export function shapeFromStoredAnnotation(annotation: StoredShape): Shape {
  if (annotation.geomType === 'point' || annotation.x2 === null || annotation.y2 === null) {
    return { geomType: annotation.geomType, x: annotation.x, y: annotation.y };
  }
  return {
    geomType: annotation.geomType,
    x: annotation.x * 2 - annotation.x2,
    y: annotation.y * 2 - annotation.y2,
    x2: annotation.x2,
    y2: annotation.y2,
  };
}

/** Pixel area of one box after clipping it to the circular Active area. */
function boxAreaInsideActive(shape: Shape): number {
  if (shape.x2 === undefined || shape.y2 === undefined) return 0;
  const minX = Math.max(0, Math.floor(Math.min(shape.x, shape.x2)));
  const maxX = Math.min(FRAME_SIZE, Math.ceil(Math.max(shape.x, shape.x2)));
  const minY = Math.max(0, Math.floor(Math.min(shape.y, shape.y2)));
  const maxY = Math.min(FRAME_SIZE, Math.ceil(Math.max(shape.y, shape.y2)));
  const activeR2 = (FRAME_RADIUS * 0.98) ** 2;
  let area = 0;
  for (let y = minY; y < maxY; y++) {
    const dy = y + 0.5 - FRAME_CENTER;
    for (let x = minX; x < maxX; x++) {
      const dx = x + 0.5 - FRAME_CENTER;
      if (dx * dx + dy * dy <= activeR2) area++;
    }
  }
  return area;
}

/**
 * Union area of all manual dark-area boxes on one image.
 *
 * Rasterizing onto the 512 frame prevents overlapping boxes from being counted
 * twice and excludes the part of a rim box that lies outside the Active circle.
 */
export function combinedDarkAreaPct(
  annotations: readonly Pick<AnnotationRecord, 'defectId' | 'geomType' | 'x' | 'y' | 'x2' | 'y2' | 'maskRle'>[],
): number {
  const mask = new Uint8Array(FRAME_SIZE * FRAME_SIZE);
  let area = 0;
  for (const annotation of annotations) {
    if (!isDarkDotDefect(annotation.defectId) || (annotation.geomType !== 'box' && annotation.geomType !== 'mask')) continue;
    if (annotation.maskRle) {
      for (const index of decodeMaskRle(annotation.maskRle)) {
        if (index < 0 || index >= mask.length || mask[index] === 1) continue;
        const x = index % FRAME_SIZE;
        const y = (index - x) / FRAME_SIZE;
        if ((x + 0.5 - FRAME_CENTER) ** 2 + (y + 0.5 - FRAME_CENTER) ** 2 > (FRAME_RADIUS * 0.98) ** 2) continue;
        mask[index] = 1;
        area++;
      }
      continue;
    }
    const shape = shapeFromStoredAnnotation(annotation);
    if (shape.x2 === undefined || shape.y2 === undefined) continue;
    const minX = Math.max(0, Math.floor(Math.min(shape.x, shape.x2)));
    const maxX = Math.min(FRAME_SIZE, Math.ceil(Math.max(shape.x, shape.x2)));
    const minY = Math.max(0, Math.floor(Math.min(shape.y, shape.y2)));
    const maxY = Math.min(FRAME_SIZE, Math.ceil(Math.max(shape.y, shape.y2)));
    const activeR2 = (FRAME_RADIUS * 0.98) ** 2;
    for (let y = minY; y < maxY; y++) {
      const dy = y + 0.5 - FRAME_CENTER;
      for (let x = minX; x < maxX; x++) {
        const dx = x + 0.5 - FRAME_CENTER;
        if (dx * dx + dy * dy > activeR2) continue;
        const index = y * FRAME_SIZE + x;
        if (mask[index] === 0) {
          mask[index] = 1;
          area++;
        }
      }
    }
  }
  return (area / ACTIVE_AREA_PX) * 100;
}

export interface ManualDarkGrade {
  readonly areaPct: number;
  readonly defectId: DefectId | null;
}

/**
 * Panel grade from manual dark selections.
 *
 * Dark boxes are unioned within each R/G/B/W image, then the largest pattern
 * ratio represents the panel. Taking the maximum mirrors Rule analysis and
 * avoids counting the same physical defect up to four times.
 */
export function manualDarkGrade(
  annotations: readonly Pick<
    AnnotationRecord,
    'imageId' | 'defectId' | 'geomType' | 'x' | 'y' | 'x2' | 'y2' | 'maskRle'
  >[],
  settings: Settings = DEFAULT_SETTINGS,
): ManualDarkGrade {
  const byImage = new Map<number, typeof annotations>();
  for (const annotation of annotations) {
    if (!isDarkDotDefect(annotation.defectId) || (annotation.geomType !== 'box' && annotation.geomType !== 'mask')) continue;
    const list = byImage.get(annotation.imageId) ?? [];
    byImage.set(annotation.imageId, [...list, annotation]);
  }
  let areaPct = 0;
  for (const imageAnnotations of byImage.values()) {
    areaPct = Math.max(areaPct, combinedDarkAreaPct(imageAnnotations));
  }
  return { areaPct, defectId: gradeDarkDot(areaPct, settings) };
}

export function encodeMaskRle(indices: readonly number[]): string {
  if (indices.length === 0) return '';
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0]!;
  let previous = start;
  for (let i = 1; i < sorted.length; i++) {
    const value = sorted[i]!;
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    runs.push(`${start}:${previous - start + 1}`);
    start = previous = value;
  }
  runs.push(`${start}:${previous - start + 1}`);
  return runs.join(',');
}

export function decodeMaskRle(rle: string): number[] {
  const values: number[] = [];
  for (const token of rle.split(',')) {
    const [startText, lengthText] = token.split(':');
    const start = Number(startText);
    const length = Number(lengthText);
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0) continue;
    for (let offset = 0; offset < length; offset++) values.push(start + offset);
  }
  return values;
}

function maskAreaFromRle(rle: string): number {
  return decodeMaskRle(rle).length;
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
  areaRatio?: number;
  rRatio: number;
  angleDeg: number;
  region: string;
}): string {
  const hour = (6 + annotation.angleDeg / 30) % 12;
  const clock = hour < 1 ? hour + 12 : hour;
  const name = isDarkDotDefect(annotation.defectId) ? `암점 영역 → ${DEFECT_NAME[annotation.defectId]}` : DEFECT_NAME[annotation.defectId];
  const area = isDarkDotDefect(annotation.defectId) && (annotation.geomType === 'box' || annotation.geomType === 'mask') && annotation.areaRatio !== undefined
    ? ` · 선택 ${annotation.areaRatio.toFixed(2)}%`
    : '';
  return `${name} · ${annotation.geomType}${area} · ${clock.toFixed(1)}시 · ${annotation.region} (r=${annotation.rRatio.toFixed(2)})`;
}
