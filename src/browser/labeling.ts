import type { GeomType } from '../core/records';
import { FRAME_SIZE } from '../core/types';
import type { Shape } from '../core/annotations';
import { insideActiveArea } from '../core/annotations';

export interface DrawHandlers {
  readonly getTool: () => GeomType;
  readonly onShape: (shape: Shape) => void;
  /** Called while dragging, so the caller can render a preview. */
  readonly onPreview: (shape: Shape | null) => void;
}

/**
 * Turn pointer events on a canvas into shapes in normalized-frame coordinates.
 *
 * The canvas is 512x512 internally but displayed at whatever CSS size fits, so
 * every event position must be scaled by the ratio between the two. Using
 * `offsetX` directly would silently mislabel every defect on any display where
 * the canvas is not shown at exactly 1:1.
 */
export function attachLabeling(canvas: HTMLCanvasElement, handlers: DrawHandlers): () => void {
  let start: { x: number; y: number } | null = null;

  const toFrame = (event: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * FRAME_SIZE,
      y: ((event.clientY - rect.top) / rect.height) * FRAME_SIZE,
    };
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const point = toFrame(event);
    if (!insideActiveArea(point.x, point.y)) return;

    canvas.setPointerCapture(event.pointerId);
    start = point;

    if (handlers.getTool() === 'point') {
      handlers.onShape({ geomType: 'point', x: point.x, y: point.y });
      start = null;
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!start) return;
    const end = toFrame(event);
    handlers.onPreview({ geomType: handlers.getTool(), x: start.x, y: start.y, x2: end.x, y2: end.y });
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!start) return;
    const end = toFrame(event);
    const tool = handlers.getTool();
    handlers.onPreview(null);
    canvas.releasePointerCapture(event.pointerId);

    // A click that never moved is not a zero-size box; it is a slip. Dropping it
    // beats storing a defect with no extent under a shape that implies one.
    const dragged = Math.hypot(end.x - start.x, end.y - start.y) >= 4;
    if (dragged) handlers.onShape({ geomType: tool, x: start.x, y: start.y, x2: end.x, y2: end.y });
    start = null;
  };

  const onPointerCancel = (): void => {
    start = null;
    handlers.onPreview(null);
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
  };
}

const MANUAL = '#7aa2ff';
const PREVIEW = 'rgba(122, 162, 255, 0.55)';

/** Draw stored manual labels. Deliberately a different colour from AI detections. */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: readonly { geomType: GeomType; x: number; y: number; x2: number | null; y2: number | null }[],
  highlightId?: number,
  ids?: readonly number[],
): void {
  ctx.save();
  ctx.lineWidth = 2.5;
  annotations.forEach((annotation, index) => {
    const active = ids !== undefined && highlightId !== undefined && ids[index] === highlightId;
    ctx.strokeStyle = active ? '#fff' : MANUAL;
    ctx.fillStyle = active ? '#fff' : MANUAL;
    strokeShape(ctx, annotation);
  });
  ctx.restore();
}

export function drawPreview(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = PREVIEW;
  ctx.fillStyle = PREVIEW;
  strokeShape(ctx, { ...shape, x2: shape.x2 ?? null, y2: shape.y2 ?? null });
  ctx.restore();
}

function strokeShape(
  ctx: CanvasRenderingContext2D,
  shape: { geomType: GeomType; x: number; y: number; x2: number | null; y2: number | null },
): void {
  if (shape.geomType === 'point' || shape.x2 === null || shape.y2 === null) {
    ctx.beginPath();
    ctx.arc(shape.x, shape.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(shape.x, shape.y, 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (shape.geomType === 'line') {
    ctx.beginPath();
    ctx.moveTo(shape.x, shape.y);
    ctx.lineTo(shape.x2, shape.y2);
    ctx.stroke();
    return;
  }
  ctx.strokeRect(
    Math.min(shape.x, shape.x2),
    Math.min(shape.y, shape.y2),
    Math.abs(shape.x2 - shape.x),
    Math.abs(shape.y2 - shape.y),
  );
}
