/** Pattern types for the four lit-display captures of one panel. */
export type Pattern = 'R' | 'G' | 'B' | 'W';

export const PATTERNS: readonly Pattern[] = ['R', 'G', 'B', 'W'];

/** Single-channel 8-bit image. */
export interface Gray {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Binary mask, 0 or 1 per pixel. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** RGBA image, 4 bytes per pixel. Matches the browser's ImageData layout. */
export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Active display circle in the coordinate space of the image it was found in. */
export interface Circle {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

/**
 * The normalized frame every downstream stage works in: the active circle is
 * centered at (256, 256) with radius 250, and FPCB points at 6 o'clock.
 */
export const FRAME_SIZE = 512;
export const FRAME_CENTER = 256;
export const FRAME_RADIUS = 250;

/** Fraction of the radius kept when building the active mask, to drop bezel ringing. */
export const ACTIVE_MASK_SHRINK = 0.98;
