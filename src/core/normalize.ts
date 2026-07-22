import type { Circle, Mask, Rgba } from './types';
import { ACTIVE_MASK_SHRINK, FRAME_CENTER, FRAME_RADIUS, FRAME_SIZE } from './types';
import { circleMask, createRgba, sampleRgba } from './image';
import { rotateClockwise } from './geometry';

export interface NormalizedFrame {
  readonly image: Rgba;
  readonly activeMask: Mask;
  readonly activeAreaPx: number;
}

/**
 * Resample the source image into the canonical frame: the active circle lands
 * centered at FRAME_CENTER with radius FRAME_RADIUS, rotated so the FPCB sits
 * at 6 o'clock.
 *
 * Runs backwards (for each destination pixel, find its source) so every output
 * pixel gets exactly one bilinear sample and no holes appear.
 */
export function normalizeFrame(src: Rgba, circle: Circle, rotationDeg: number): NormalizedFrame {
  const out = createRgba(FRAME_SIZE, FRAME_SIZE);
  const scale = circle.r / FRAME_RADIUS;

  for (let v = 0; v < FRAME_SIZE; v++) {
    for (let u = 0; u < FRAME_SIZE; u++) {
      // Undo the forward transform: destination -> centered -> unrotate -> scale.
      const p = rotateClockwise(u - FRAME_CENTER, v - FRAME_CENTER, -rotationDeg);
      const sx = circle.cx + p.x * scale;
      const sy = circle.cy + p.y * scale;
      sampleRgba(src, sx, sy, out.data, (v * FRAME_SIZE + u) * 4);
    }
  }

  const activeMask = circleMask(
    FRAME_SIZE,
    FRAME_SIZE,
    FRAME_CENTER,
    FRAME_CENTER,
    FRAME_RADIUS * ACTIVE_MASK_SHRINK,
  );
  let activeAreaPx = 0;
  for (let i = 0; i < activeMask.data.length; i++) activeAreaPx += activeMask.data[i];

  return { image: out, activeMask, activeAreaPx };
}

/**
 * Higher-resolution canonical frame used only by the projection Line detector.
 * Coordinates are mapped back to the 512 frame before evidence is stored, so
 * dashboards and manual labels retain one stable coordinate system.
 */
export function normalizeLineFrame(
  src: Rgba,
  circle: Circle,
  rotationDeg: number,
  requestedSize = Math.min(1024, Math.max(FRAME_SIZE, Math.round(circle.r * 2))),
): NormalizedFrame {
  const size = Math.max(FRAME_SIZE, Math.round(requestedSize));
  const center = size / 2;
  const radius = center - 6;
  const out = createRgba(size, size);
  const scale = circle.r / radius;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const p = rotateClockwise(u - center, v - center, -rotationDeg);
      sampleRgba(src, circle.cx + p.x * scale, circle.cy + p.y * scale, out.data, (v * size + u) * 4);
    }
  }
  const activeMask = circleMask(size, size, center, center, radius * ACTIVE_MASK_SHRINK);
  let activeAreaPx = 0;
  for (const value of activeMask.data) activeAreaPx += value;
  return { image: out, activeMask, activeAreaPx };
}

/** Map a point from source-image coordinates into the normalized frame. */
export function sourceToFrame(
  circle: Circle,
  rotationDeg: number,
  x: number,
  y: number,
): { x: number; y: number } {
  const scale = FRAME_RADIUS / circle.r;
  const p = rotateClockwise((x - circle.cx) * scale, (y - circle.cy) * scale, rotationDeg);
  return { x: p.x + FRAME_CENTER, y: p.y + FRAME_CENTER };
}

/** Inverse of `sourceToFrame`. */
export function frameToSource(
  circle: Circle,
  rotationDeg: number,
  x: number,
  y: number,
): { x: number; y: number } {
  const scale = circle.r / FRAME_RADIUS;
  const p = rotateClockwise(x - FRAME_CENTER, y - FRAME_CENTER, -rotationDeg);
  return { x: p.x * scale + circle.cx, y: p.y * scale + circle.cy };
}
