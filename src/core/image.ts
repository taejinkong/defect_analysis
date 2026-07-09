import type { Gray, Mask, Rgba } from './types';

export function createGray(width: number, height: number): Gray {
  return { width, height, data: new Uint8ClampedArray(width * height) };
}

export function createMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) };
}

export function createRgba(width: number, height: number): Rgba {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/**
 * Per-pixel max of R, G, B.
 *
 * Use this, not luma, to find the lit display. Rec. 709 weights blue at 0.0722,
 * so a blue-pattern capture reads darker than a neutral-gray FPCB tab and Otsu
 * would segment the tab instead of the panel. Max-channel keeps all four
 * patterns at comparable brightness.
 */
export function toIntensity(img: Rgba): Gray {
  const out = createGray(img.width, img.height);
  const src = img.data;
  const dst = out.data;
  for (let i = 0, p = 0; i < dst.length; i++, p += 4) {
    const r = src[p];
    const g = src[p + 1];
    const b = src[p + 2];
    dst[i] = r > g ? (r > b ? r : b) : g > b ? g : b;
  }
  return out;
}

/** Rec. 709 luma. For photometric work; see `toIntensity` for segmentation. */
export function toGray(img: Rgba): Gray {
  const out = createGray(img.width, img.height);
  const src = img.data;
  const dst = out.data;
  for (let i = 0, p = 0; i < dst.length; i++, p += 4) {
    dst[i] = 0.2126 * src[p] + 0.7152 * src[p + 1] + 0.0722 * src[p + 2];
  }
  return out;
}

/**
 * Separable box blur with radius `r`, applied `passes` times.
 * Three passes approximate a Gaussian closely enough for thresholding.
 */
export function boxBlur(src: Gray, radius: number, passes = 1): Gray {
  let cur = src;
  for (let p = 0; p < passes; p++) {
    cur = blurPass(cur, radius);
  }
  return cur === src ? { ...src, data: new Uint8ClampedArray(src.data) } : cur;
}

function blurPass(src: Gray, radius: number): Gray {
  const { width: w, height: h } = src;
  const tmp = createGray(w, h);
  const out = createGray(w, h);
  const win = radius * 2 + 1;

  // Horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += src.data[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp.data[row + x] = sum / win;
      sum -= src.data[row + clamp(x - radius, 0, w - 1)];
      sum += src.data[row + clamp(x + radius + 1, 0, w - 1)];
    }
  }
  // Vertical
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp.data[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out.data[y * w + x] = sum / win;
      sum -= tmp.data[clamp(y - radius, 0, h - 1) * w + x];
      sum += tmp.data[clamp(y + radius + 1, 0, h - 1) * w + x];
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Bilinear sample of a grayscale image. Out-of-bounds reads return 0. */
export function sampleGray(img: Gray, x: number, y: number): number {
  if (x < 0 || y < 0 || x > img.width - 1 || y > img.height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, img.width - 1);
  const y1 = Math.min(y0 + 1, img.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = img.data[y0 * img.width + x0];
  const b = img.data[y0 * img.width + x1];
  const c = img.data[y1 * img.width + x0];
  const d = img.data[y1 * img.width + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Bilinear sample of an RGBA image, writing 4 channels into `out`. */
export function sampleRgba(img: Rgba, x: number, y: number, out: Uint8ClampedArray, at: number): void {
  if (x < 0 || y < 0 || x > img.width - 1 || y > img.height - 1) {
    out[at] = out[at + 1] = out[at + 2] = 0;
    out[at + 3] = 255;
    return;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, img.width - 1);
  const y1 = Math.min(y0 + 1, img.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const i00 = (y0 * img.width + x0) * 4;
  const i10 = (y0 * img.width + x1) * 4;
  const i01 = (y1 * img.width + x0) * 4;
  const i11 = (y1 * img.width + x1) * 4;
  for (let c = 0; c < 4; c++) {
    out[at + c] =
      img.data[i00 + c] * w00 + img.data[i10 + c] * w10 + img.data[i01 + c] * w01 + img.data[i11 + c] * w11;
  }
}

/** Filled circle mask in the given frame. */
export function circleMask(width: number, height: number, cx: number, cy: number, r: number): Mask {
  const mask = createMask(width, height);
  const r2 = r * r;
  const yLo = Math.max(0, Math.floor(cy - r));
  const yHi = Math.min(height - 1, Math.ceil(cy + r));
  for (let y = yLo; y <= yHi; y++) {
    const dy = y - cy;
    const halfSpan = Math.sqrt(Math.max(0, r2 - dy * dy));
    const xLo = Math.max(0, Math.ceil(cx - halfSpan));
    const xHi = Math.min(width - 1, Math.floor(cx + halfSpan));
    for (let x = xLo; x <= xHi; x++) mask.data[y * width + x] = 1;
  }
  return mask;
}

export function countMask(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) n += mask.data[i];
  return n;
}
