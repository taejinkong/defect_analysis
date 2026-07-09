import type { Circle } from '../core/types';
import { FRAME_CENTER, FRAME_RADIUS } from '../core/types';
import { offsetFromAngle } from '../core/geometry';

const ACCENT = '#3ddc97';
const WARN = '#ffb454';
const AXIS = '#7aa2ff';

/** Draw the detected circle, its center, and the FPCB direction on the source image. */
export function drawSourceOverlay(
  ctx: CanvasRenderingContext2D,
  circle: Circle,
  tabAngleDeg: number | null,
  reliable: boolean,
): void {
  ctx.save();
  const width = Math.max(1.5, circle.r * 0.008);

  // The rim sits on top of the lit panel, which may be any of R/G/B/W. A single
  // solid color always disappears against one of them, so draw a dark underlay
  // and dash a light stroke over it: one of the two always contrasts.
  ctx.beginPath();
  ctx.arc(circle.cx, circle.cy, circle.r, 0, Math.PI * 2);
  ctx.lineWidth = width * 2.6;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = ACCENT;
  ctx.setLineDash([circle.r * 0.06, circle.r * 0.04]);
  ctx.stroke();
  ctx.setLineDash([]);

  const tick = circle.r * 0.05;
  ctx.beginPath();
  ctx.moveTo(circle.cx - tick, circle.cy);
  ctx.lineTo(circle.cx + tick, circle.cy);
  ctx.moveTo(circle.cx, circle.cy - tick);
  ctx.lineTo(circle.cx, circle.cy + tick);
  ctx.lineWidth = width * 2.6;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = ACCENT;
  ctx.stroke();

  if (tabAngleDeg !== null) {
    const { dx, dy } = offsetFromAngle(tabAngleDeg);
    ctx.strokeStyle = reliable ? WARN : '#888';
    ctx.setLineDash(reliable ? [] : [circle.r * 0.04, circle.r * 0.03]);
    ctx.beginPath();
    ctx.moveTo(circle.cx, circle.cy);
    ctx.lineTo(circle.cx + dx * circle.r * 1.25, circle.cy + dy * circle.r * 1.25);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = reliable ? WARN : '#888';
    ctx.beginPath();
    ctx.arc(circle.cx + dx * circle.r * 1.25, circle.cy + dy * circle.r * 1.25, circle.r * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draw clock ticks on the normalized frame. FPCB must sit at 6 o'clock; the
 * marker there is what the user checks before confirming.
 */
export function drawFrameOverlay(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(122, 162, 255, 0.55)';

  for (let hour = 0; hour < 12; hour++) {
    const angle = hour * 30;
    const { dx, dy } = offsetFromAngle(angle);
    const isCardinal = hour % 3 === 0;
    const inner = FRAME_RADIUS * (isCardinal ? 0.9 : 0.95);
    ctx.beginPath();
    ctx.moveTo(FRAME_CENTER + dx * inner, FRAME_CENTER + dy * inner);
    ctx.lineTo(FRAME_CENTER + dx * FRAME_RADIUS, FRAME_CENTER + dy * FRAME_RADIUS);
    ctx.stroke();
  }

  ctx.strokeStyle = AXIS;
  ctx.beginPath();
  ctx.arc(FRAME_CENTER, FRAME_CENTER, FRAME_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  // FPCB marker at 6 o'clock. It points outward but stays inside the frame:
  // the canvas ends 6px past the rim, so anything drawn beyond it is clipped.
  const apex = FRAME_CENTER + FRAME_RADIUS;
  ctx.fillStyle = WARN;
  ctx.beginPath();
  ctx.moveTo(FRAME_CENTER, apex);
  ctx.lineTo(FRAME_CENTER - 15, apex - 26);
  ctx.lineTo(FRAME_CENTER + 15, apex - 26);
  ctx.closePath();
  ctx.fill();

  ctx.font = '700 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.strokeText('FPCB', FRAME_CENTER, apex - 36);
  ctx.fillText('FPCB', FRAME_CENTER, apex - 36);
  ctx.restore();
}
