import type { Rgba } from '../core/types';

/** Per docs/database_schema.md section 2: capture detail beyond this adds no accuracy. */
export const MAX_LONG_SIDE = 2048;

/**
 * Decode an image file into raw RGBA, downscaling if it exceeds MAX_LONG_SIDE.
 *
 * Everything stays in the page: no network, no upload. The file is read from
 * the user's disk into memory and never leaves it.
 */
export async function fileToRgba(file: File | Blob, maxLongSide = MAX_LONG_SIDE): Promise<Rgba> {
  const bitmap = await createImageBitmap(file);
  try {
    const longSide = Math.max(bitmap.width, bitmap.height);
    const scale = longSide > maxLongSide ? maxLongSide / longSide : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D 캔버스 컨텍스트를 생성할 수 없습니다.');

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { width, height, data: imageData.data };
  } finally {
    bitmap.close();
  }
}

/** Paint an Rgba buffer onto a canvas, sizing the canvas to match. */
export function paintRgba(canvas: HTMLCanvasElement, img: Rgba): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 캔버스 컨텍스트를 생성할 수 없습니다.');
  // Go through createImageData rather than `new ImageData(img.data, ...)`: our
  // buffer may be backed by any ArrayBufferLike, which the constructor rejects.
  const out = ctx.createImageData(img.width, img.height);
  out.data.set(img.data);
  ctx.putImageData(out, 0, 0);
}
