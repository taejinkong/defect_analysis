import { describe, expect, it } from 'vitest';
import { fitCircleKasa } from './circle';

function sampleCircle(cx: number, cy: number, r: number, n: number, jitter = 0, seed = 1): Float64Array {
  const pts = new Float64Array(n * 2);
  let s = seed;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts[i * 2] = cx + Math.cos(a) * r + rand() * jitter;
    pts[i * 2 + 1] = cy + Math.sin(a) * r + rand() * jitter;
  }
  return pts;
}

describe('fitCircleKasa', () => {
  it('recovers an exact circle', () => {
    const fit = fitCircleKasa(sampleCircle(123.5, 71.25, 240, 128));
    expect(fit).not.toBeNull();
    expect(fit!.cx).toBeCloseTo(123.5, 6);
    expect(fit!.cy).toBeCloseTo(71.25, 6);
    expect(fit!.r).toBeCloseTo(240, 6);
    expect(fit!.rmsResidual).toBeLessThan(1e-6);
  });

  it('stays accurate for a circle far from the origin', () => {
    // The mean-centering step exists for this case; without it the normal
    // matrix is badly conditioned and the radius drifts.
    const fit = fitCircleKasa(sampleCircle(5000, 4000, 250, 256));
    expect(fit!.cx).toBeCloseTo(5000, 4);
    expect(fit!.cy).toBeCloseTo(4000, 4);
    expect(fit!.r).toBeCloseTo(250, 4);
  });

  it('reports residual under noise but keeps the center', () => {
    const fit = fitCircleKasa(sampleCircle(300, 300, 200, 512, 2.0));
    expect(fit!.cx).toBeCloseTo(300, 0);
    expect(fit!.cy).toBeCloseTo(300, 0);
    expect(fit!.r).toBeCloseTo(200, 0);
    expect(fit!.rmsResidual).toBeGreaterThan(0.1);
    expect(fit!.rmsResidual).toBeLessThan(2);
  });

  it('returns null for degenerate input', () => {
    expect(fitCircleKasa(new Float64Array([0, 0, 1, 1]))).toBeNull();
    const collinear = new Float64Array([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(fitCircleKasa(collinear)).toBeNull();
  });
});
