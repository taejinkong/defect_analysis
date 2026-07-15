import { describe, expect, it } from 'vitest';
import { boundaryPoints, touchesImageBorder } from './components';
import { circleMask, createMask } from './image';

describe('boundaryPoints', () => {
  it('collects the full rim of a circle drawn with margin', () => {
    const mask = circleMask(100, 100, 50, 50, 30);
    const pts = boundaryPoints(mask);
    const n = pts.length / 2;
    expect(n).toBeGreaterThan(150); // roughly the circumference, 2*pi*30 ~= 188
    for (let i = 0; i < n; i++) {
      const dist = Math.hypot(pts[i * 2]! - 50, pts[i * 2 + 1]! - 50);
      expect(dist).toBeGreaterThan(27);
      expect(dist).toBeLessThan(33);
    }
  });

  it('does not treat a crop-clipped straight edge as boundary', () => {
    // A circle of radius 30 centered at (50, 50), but the mask is cropped to
    // start at x=30 -- 20px inside the true circle, so column 0 of the mask is
    // a straight chord through the interior, not the true rim.
    const full = circleMask(100, 100, 50, 50, 30);
    const cropped = createMask(70, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 70; x++) {
        cropped.data[y * 70 + x] = full.data[y * 100 + (x + 30)]!;
      }
    }

    const pts = boundaryPoints(cropped);
    const n = pts.length / 2;
    // None of the fitted boundary points should sit on the artificial x=0
    // edge unless they are also a genuine rim point (a real transition to
    // background elsewhere in the column).
    let onArtificialEdge = 0;
    for (let i = 0; i < n; i++) if (pts[i * 2] === 0) onArtificialEdge++;
    // Only the couple of points where the true rim actually crosses x=0
    // should remain -- not the whole clipped chord (which would be dozens).
    expect(onArtificialEdge).toBeLessThan(5);
  });
});

describe('touchesImageBorder', () => {
  it('is false for a circle drawn with margin from the frame', () => {
    const mask = circleMask(100, 100, 50, 50, 30);
    expect(touchesImageBorder(mask)).toBe(false);
  });

  it('is true when the shape is cropped flush against the frame', () => {
    const full = circleMask(100, 100, 50, 50, 30);
    const cropped = createMask(70, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 70; x++) {
        cropped.data[y * 70 + x] = full.data[y * 100 + (x + 30)]!;
      }
    }
    expect(touchesImageBorder(cropped)).toBe(true);
  });
});
