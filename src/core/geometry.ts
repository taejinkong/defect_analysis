/**
 * Angle convention, per docs/defect_taxonomy.md section 5.
 *
 * All angles are degrees in [0, 360) measured from the FPCB at 6 o'clock,
 * increasing clockwise on screen. Screen coordinates have y growing downward.
 *
 *     0 deg -> 6 o'clock (bottom, FPCB)
 *    90 deg -> 9 o'clock (left)
 *   180 deg -> 12 o'clock (top)
 *   270 deg -> 3 o'clock (right)
 */

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

/** Clock-referenced angle of the offset (dx, dy) from the display center. */
export function angleFromOffset(dx: number, dy: number): number {
  const deg = Math.atan2(-dx, dy) * DEG;
  return deg < 0 ? deg + 360 : deg;
}

/** Unit offset pointing along `angleDeg`. Inverse of `angleFromOffset`. */
export function offsetFromAngle(angleDeg: number): { dx: number; dy: number } {
  const rad = angleDeg * RAD;
  return { dx: -Math.sin(rad), dy: Math.cos(rad) };
}

/**
 * Clock face position, e.g. 0 deg -> 6.0, 270 deg -> 3.0.
 *
 * Returns a value in (0, 12]: a clock has no "0 o'clock", so anything just past
 * the top reads as 12.x rather than 0.x.
 */
export function angleToClockHour(angleDeg: number): number {
  const hour = (6 + normalizeAngle(angleDeg) / 30) % 12;
  return hour < 1 ? hour + 12 : hour;
}

export function formatClock(angleDeg: number): string {
  const hour = angleToClockHour(angleDeg);
  return `${hour.toFixed(1)}시`;
}

export function normalizeAngle(angleDeg: number): number {
  const a = angleDeg % 360;
  return a < 0 ? a + 360 : a;
}

/** Smallest absolute difference between two angles, in [0, 180]. */
export function angleDelta(a: number, b: number): number {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b)) % 360;
  return d > 180 ? 360 - d : d;
}

export type Region = 'center' | 'mid' | 'edge';

export function regionFromRadius(rRatio: number, centerMax = 0.35, midMax = 0.75): Region {
  if (rRatio <= centerMax) return 'center';
  if (rRatio <= midMax) return 'mid';
  return 'edge';
}

/**
 * Rotate (x, y) clockwise on screen by `angleDeg`.
 *
 * With y pointing down this is [[cos, -sin], [sin, cos]]: it sends the +x axis
 * (3 o'clock) toward +y (6 o'clock) for a positive angle, matching the
 * clockwise-positive convention above.
 */
export function rotateClockwise(x: number, y: number, angleDeg: number): { x: number; y: number } {
  const rad = angleDeg * RAD;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: x * c - y * s, y: x * s + y * c };
}
