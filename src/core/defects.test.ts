import { describe, expect, it } from 'vitest';
import type { Pattern, Rgba } from './types';
import { PATTERNS } from './types';
import { blackSignal, detectDefects, whiteSignal, type ImageDetection } from './defects';
import { judgePanel, gradeDarkDot } from './verdict';
import { DEFAULT_SETTINGS, DEFECT, type Settings } from './settings';
import { detectActiveCircle } from './preprocess';
import { normalizeFrame, normalizeLineFrame } from './normalize';
import {
  addBanding,
  addBrightDot,
  addDarkDot,
  addLine,
  blankPanel,
  polarToSource,
  renderSyntheticPanel,
} from './synthetic';
import { angleDelta } from './geometry';

const GEOM = { cx: 320, cy: 320, r: 240 } as const;

describe('physical Black/White signals', () => {
  it('requires every channel to fall for black and every channel to rise for white', () => {
    const frame: Rgba = {
      width: 3,
      height: 1,
      data: new Uint8ClampedArray([
        190, 14, 14, 255, // normal R pattern
        8, 8, 8, 255, // physically black defect
        245, 245, 245, 255, // physically white defect
      ]),
    };
    expect([...blackSignal(frame).data]).toEqual([190, 8, 245]);
    expect([...whiteSignal(frame).data]).toEqual([14, 8, 245]);
  });
});

/**
 * Detect a circle on the clean capture, then paint the defect and normalize
 * using that geometry.
 *
 * This mirrors the app: the circle and rotation are confirmed once per panel,
 * then reused for every pattern. Re-detecting per image would be impossible for
 * a fully unlit panel, which has no circle to find.
 */
function analyze(
  pattern: Pattern,
  paint?: (img: Rgba) => void,
  settings: Settings = DEFAULT_SETTINGS,
): ImageDetection {
  return analyzeWithGeometry(GEOM, pattern, paint, settings);
}

function analyzeWithGeometry(
  geometry: { readonly width?: number; readonly height?: number; readonly cx: number; readonly cy: number; readonly r: number },
  pattern: Pattern,
  paint?: (img: Rgba) => void,
  settings: Settings = DEFAULT_SETTINGS,
): ImageDetection {
  const options = { width: 640, height: 640, ...geometry, pattern, tabAngleDeg: 0, noise: 2 } as const;
  const clean = renderSyntheticPanel(options);
  const detect = detectActiveCircle(clean);
  if (!detect.ok) throw new Error('circle detection failed on the clean panel');

  const img = renderSyntheticPanel(options);
  paint?.(img);
  const frame = normalizeFrame(img, detect.circle, detect.fpcb.rotationDeg);
  return detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, pattern, settings);
}

/** All four patterns of one panel, with the same defect painted into each. */
function analyzePanel(paint?: (img: Rgba, pattern: Pattern) => void): ImageDetection[] {
  return PATTERNS.map((pattern) => analyze(pattern, (img) => paint?.(img, pattern)));
}

describe('clean panel', () => {
  it('finds nothing on every pattern', () => {
    for (const image of analyzePanel()) {
      expect(image.noDisplay).toBe('none');
      expect(image.detections).toHaveLength(0);
      expect(image.darkAreaPct).toBe(0);
    }
  });

  it('judges a clean panel as 양품', () => {
    const verdict = judgePanel(analyzePanel());
    expect(verdict.finalJudgementId).toBe(DEFECT.GOOD);
    expect(verdict.detectedDefectIds).toEqual([]);
  });
});

describe('dark dot', () => {
  it('detects a small dark dot and locates it', () => {
    const dot = polarToSource(GEOM, 0.6, 90); // 9 o'clock
    const image = analyze('W', (img) => addDarkDot(img, dot.x, dot.y, 8));

    const dark = image.detections.filter((d) => d.kind === 'dark-dot');
    expect(dark).toHaveLength(1);
    expect(dark[0]!.rRatio).toBeCloseTo(0.6, 1);
    expect(angleDelta(dark[0]!.angleDeg, 90)).toBeLessThan(4);
    expect(image.darkAreaPct).toBeGreaterThan(0);
    expect(image.darkAreaPct).toBeLessThan(5);
  });

  it('grades by total area, not by count', () => {
    const verdict = judgePanel(
      analyzePanel((img) => {
        for (const angle of [0, 72, 144, 216, 288]) {
          const p = polarToSource(GEOM, 0.5, angle);
          addDarkDot(img, p.x, p.y, 6);
        }
      }),
    );
    // Five separate dots, still one grade and one defect kind: not 복수불량.
    expect(verdict.finalJudgementId).toBe(DEFECT.DARK_DOT_SMALL);
    expect(verdict.detectedDefectIds).toEqual([DEFECT.DARK_DOT_SMALL]);
  });

  it('escalates the grade as area grows', () => {
    const small = judgePanel(analyzePanel((img) => addDarkDot(img, GEOM.cx, GEOM.cy, 30)));
    const medium = judgePanel(analyzePanel((img) => addDarkDot(img, GEOM.cx, GEOM.cy, 70)));
    const large = judgePanel(analyzePanel((img) => addDarkDot(img, GEOM.cx, GEOM.cy, 120)));

    expect(small.finalJudgementId).toBe(DEFECT.DARK_DOT_SMALL);
    expect(medium.finalJudgementId).toBe(DEFECT.DARK_DOT_MEDIUM);
    expect(large.finalJudgementId).toBe(DEFECT.DARK_DOT_LARGE);
    expect(small.darkAreaPct).toBeLessThan(medium.darkAreaPct);
    expect(medium.darkAreaPct).toBeLessThan(large.darkAreaPct);
  });
});

describe('gradeDarkDot boundaries', () => {
  it('uses (lo, hi] intervals with no gap', () => {
    expect(gradeDarkDot(0)).toBeNull();
    expect(gradeDarkDot(0.01)).toBe(DEFECT.DARK_DOT_SMALL);
    expect(gradeDarkDot(5)).toBe(DEFECT.DARK_DOT_SMALL);
    expect(gradeDarkDot(5.01)).toBe(DEFECT.DARK_DOT_MEDIUM);
    expect(gradeDarkDot(15)).toBe(DEFECT.DARK_DOT_MEDIUM);
    // The old spec left 15..16 undefined. Nothing may fall through now.
    expect(gradeDarkDot(15.5)).toBe(DEFECT.DARK_DOT_LARGE);
    expect(gradeDarkDot(16)).toBe(DEFECT.DARK_DOT_LARGE);
  });
});

describe('bright dot', () => {
  it('detects a bright dot', () => {
    const p = polarToSource(GEOM, 0.3, 270);
    const image = analyze('W', (img) => addBrightDot(img, p.x, p.y, 6, 255));
    const bright = image.detections.filter((d) => d.kind === 'bright-dot');
    expect(bright).toHaveLength(1);
    expect(bright[0]!.region).toBe('center');
  });

  it('judges a confirmed bright dot as 명점', () => {
    const p = polarToSource(GEOM, 0.3, 270);
    const verdict = judgePanel(analyzePanel((img) => addBrightDot(img, p.x, p.y, 6, 255)));
    expect(verdict.finalJudgementId).toBe(DEFECT.BRIGHT_DOT);
  });

  it('finds a white defect on R even when the already-driven R channel does not rise', () => {
    const p = polarToSource(GEOM, 0.3, 270);
    // Normal R is about [190, 14, 14]. Painting [190, 190, 190] changes only
    // the weak G/B channels, which the old R-channel-only detector missed.
    const image = analyze('R', (img) => addBrightDot(img, p.x, p.y, 8, 190));
    expect(image.detections.some((d) => d.kind === 'bright-dot')).toBe(true);
  });

  it('separates local defect saturation from capture-background saturation', () => {
    const image = analyze('W', (img) => addBrightDot(img, GEOM.cx, GEOM.cy, 32, 255));
    expect(image.whiteSaturationPct).toBeGreaterThanOrEqual(1);
    expect(image.localDefectSaturationPct).toBeGreaterThan(0);
    expect(image.backgroundSaturationPct).toBeLessThan(image.whiteSaturationPct);
    expect(image.qualityWarnings.join(' ')).not.toContain('촬영 과노출');
  });

  it('uses the lower W-specific threshold for subtle white-on-white defects', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      'bright.residual_threshold': 120,
      'bright.w_residual_threshold': 20,
    };
    const image = analyze('W', (img) => addBrightDot(img, GEOM.cx, GEOM.cy, 8, 230), settings);
    expect(image.brightThreshold).toBe(20);
    expect(image.detections.some((d) => d.kind === 'bright-dot')).toBe(true);
  });
});

describe('lines', () => {
  it('classifies a horizontal bright line', () => {
    const image = analyze('W', (img) => addLine(img, GEOM.cx, GEOM.cy - 60, 300, 3, 0, 255));
    const lines = image.detections.filter((d) => d.kind === 'bright-line-h');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]!.aspect).toBeGreaterThan(8);
  });

  it('classifies a vertical dark line', () => {
    const image = analyze('W', (img) => addLine(img, GEOM.cx + 40, GEOM.cy, 300, 3, 90, 6));
    const lines = image.detections.filter((d) => d.kind === 'dark-line-v');
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['horizontal', 0],
    ['vertical', 90],
  ] as const)('recognizes a thick %s bright line', (_label, angle) => {
    const image = analyze('W', (img) => addLine(img, GEOM.cx, GEOM.cy, 330, 55, angle, 255));
    const expected = angle === 0 ? 'bright-line-h' : 'bright-line-v';
    expect(
      image.detections.some((d) => d.kind === expected),
      JSON.stringify(image.detections.map((d) => ({ kind: d.kind, aspect: d.aspect, bbox: d.bbox }))),
    ).toBe(true);
  });

  it('recognizes a thick bright line when the panel nearly fills the photograph', () => {
    const geometry = { width: 700, height: 700, cx: 350, cy: 350, r: 315 } as const;
    const image = analyzeWithGeometry(geometry, 'W', (img) =>
      addLine(img, geometry.cx, geometry.cy, geometry.r * 1.35, 60, 0, 255),
    );
    expect(
      image.detections.some((d) => d.kind === 'bright-line-h'),
      JSON.stringify(image.detections.map((d) => ({ kind: d.kind, aspect: d.aspect, bbox: d.bbox }))),
    ).toBe(true);
  });

  it('retains high-resolution projection evidence for a large source panel', () => {
    const geometry = { width: 760, height: 760, cx: 380, cy: 380, r: 340 } as const;
    const options = { ...geometry, pattern: 'W' as const, tabAngleDeg: 0, noise: 2 };
    const clean = renderSyntheticPanel(options);
    const detectedCircle = detectActiveCircle(clean);
    expect(detectedCircle.ok).toBe(true);
    if (!detectedCircle.ok) return;
    const image = renderSyntheticPanel(options);
    addLine(image, geometry.cx, geometry.cy, geometry.r * 1.35, 24, 0, 245);
    const frame = normalizeFrame(image, detectedCircle.circle, detectedCircle.fpcb.rotationDeg);
    const high = normalizeLineFrame(image, detectedCircle.circle, detectedCircle.fpcb.rotationDeg);
    const result = detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, 'W', DEFAULT_SETTINGS, {
      highResolutionLineFrame: high,
    });
    expect(result.detections.some((d) => d.analysisScale === 'high-resolution-projection')).toBe(true);
  });

  it('recognizes a thick bright line with modest contrast above the lit panel', () => {
    const image = analyze('W', (img) => addLine(img, GEOM.cx, GEOM.cy, 330, 55, 0, 238));
    expect(image.detections.some((d) => d.kind === 'bright-line-h')).toBe(true);
  });

  it('uses the recognized thick line in the panel verdict', () => {
    const verdict = judgePanel(
      analyzePanel((img) => addLine(img, GEOM.cx, GEOM.cy, 330, 55, 90, 238)),
    );
    expect(verdict.finalJudgementId).toBe(DEFECT.BRIGHT_LINE_V);
    expect(verdict.detectedDefectIds).toEqual([DEFECT.BRIGHT_LINE_V]);
  });

  it('calls a short bright streak a dot, not a line', () => {
    // 40px is well under line.min_length_ratio * 500 = 200px.
    const image = analyze('W', (img) => addLine(img, GEOM.cx, GEOM.cy, 40, 3, 0, 255));
    expect(image.detections.every((d) => d.kind === 'bright-dot')).toBe(true);
  });

  it('calls a long diagonal streak a dot, since it is neither horizontal nor vertical', () => {
    const image = analyze('W', (img) => addLine(img, GEOM.cx, GEOM.cy, 300, 3, 45, 255));
    expect(image.detections.some((d) => d.kind === 'bright-line-h')).toBe(false);
    expect(image.detections.some((d) => d.kind === 'bright-line-v')).toBe(false);
  });

  it.each([0, 57, 124, 233, 310])(
    'still calls a panel-horizontal line 가로줄 when the capture is rotated %i degrees',
    (tabAngleDeg) => {
      // The line is panel-horizontal, so in the rotated capture it lies at
      // `tabAngleDeg`. Normalization must undo exactly that, or a line defect
      // degrades into a diagonal streak and gets reported as a dot.
      const options = { ...GEOM, pattern: 'W', tabAngleDeg, noise: 2 } as const;
      const detect = detectActiveCircle(renderSyntheticPanel(options));
      expect(detect.ok).toBe(true);
      if (!detect.ok) return;

      const img = renderSyntheticPanel(options);
      const p = polarToSource(GEOM, 0.3, 180 + tabAngleDeg);
      addLine(img, p.x, p.y, GEOM.r * 1.3, 3, tabAngleDeg, 255);

      const frame = normalizeFrame(img, detect.circle, detect.fpcb.rotationDeg);
      const image = detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, 'W');

      expect(image.detections.some((d) => d.kind === 'bright-line-h')).toBe(true);
    },
  );

  it('excludes dark lines from the dark-dot area budget', () => {
    // A dark line is 암선, not 암점. Counting its pixels toward dark_area_ratio
    // would silently inflate the dark-dot grade.
    const image = analyze('W', (img) => addLine(img, GEOM.cx, GEOM.cy, 300, 3, 90, 6));
    expect(image.detections.some((d) => d.kind === 'dark-line-v')).toBe(true);
    expect(image.darkAreaPct).toBe(0);
  });
});

describe('no display', () => {
  it('flags a fully dark panel', () => {
    const image = analyze('W', (img) => blankPanel(img, GEOM.cx, GEOM.cy, GEOM.r, 5));
    expect(image.noDisplay).toBe('full');
    expect(image.detections).toHaveLength(0);
  });

  it('holds a dark capture when capture and Golden profiles are not validated', () => {
    const options = { ...GEOM, width: 640, height: 640, pattern: 'W' as const, tabAngleDeg: 0, noise: 2 };
    const clean = renderSyntheticPanel(options);
    const circle = detectActiveCircle(clean);
    expect(circle.ok).toBe(true);
    if (!circle.ok) return;
    const image = renderSyntheticPanel(options);
    blankPanel(image, GEOM.cx, GEOM.cy, GEOM.r, 5);
    const frame = normalizeFrame(image, circle.circle, circle.fpcb.rotationDeg);
    const result = detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, 'W', DEFAULT_SETTINGS, {
      inspection: { validatedCaptureAndGolden: false, expectedMinMean: 15 },
    });
    expect(result.noDisplay).toBe('underexposed-review');
    expect(judgePanel([result]).underexposedReview).toBe(true);
    expect(judgePanel([result]).finalJudgementId).toBe(DEFECT.GOOD);
  });

  it('flags a mostly dark panel as partial', () => {
    const image = analyze('W', (img) => addDarkDot(img, GEOM.cx, GEOM.cy, GEOM.r * 0.82, 8));
    expect(image.noDisplay).toBe('partial');
  });

  it('outranks everything else in the panel verdict', () => {
    const images = analyzePanel((img, pattern) => {
      if (pattern === 'B') blankPanel(img, GEOM.cx, GEOM.cy, GEOM.r, 5);
      else addBrightDot(img, GEOM.cx, GEOM.cy, 6, 255);
    });
    const verdict = judgePanel(images);
    expect(verdict.finalJudgementId).toBe(DEFECT.NO_DISPLAY);
  });
});

describe('multi defect', () => {
  it('reports 복수불량 for two distinct kinds', () => {
    const dot = polarToSource(GEOM, 0.55, 200);
    const verdict = judgePanel(
      analyzePanel((img) => {
        addDarkDot(img, dot.x, dot.y, 10);
        addLine(img, GEOM.cx, GEOM.cy - 70, 300, 3, 0, 255);
      }),
    );
    expect(verdict.finalJudgementId).toBe(DEFECT.MULTI);
    expect(verdict.detectedDefectIds).toContain(DEFECT.DARK_DOT_SMALL);
    expect(verdict.detectedDefectIds).toContain(DEFECT.BRIGHT_LINE_H);
  });

  it('picks the most severe defect as primary', () => {
    const dot = polarToSource(GEOM, 0.55, 200);
    const verdict = judgePanel(
      analyzePanel((img) => {
        addDarkDot(img, dot.x, dot.y, 10);
        addLine(img, GEOM.cx, GEOM.cy - 70, 300, 3, 0, 255);
      }),
    );
    // 명선(severity 3) outranks 암점 小(severity 1).
    expect(verdict.primaryDefectId).toBe(DEFECT.BRIGHT_LINE_H);
  });

  it('does not call repeated dots of one kind 복수불량', () => {
    const verdict = judgePanel(
      analyzePanel((img) => {
        for (const angle of [30, 150, 270]) {
          const p = polarToSource(GEOM, 0.6, angle);
          addBrightDot(img, p.x, p.y, 5, 255);
        }
      }),
    );
    expect(verdict.finalJudgementId).toBe(DEFECT.BRIGHT_DOT);
  });
});

describe('pattern confirmation', () => {
  it('keeps a single-pattern bright defect but requires review', () => {
    const p = polarToSource(GEOM, 0.4, 45);
    const images = analyzePanel((img, pattern) => {
      if (pattern === 'R') addBrightDot(img, p.x, p.y, 6, 255);
    });
    const verdict = judgePanel(images);

    expect(verdict.finalJudgementId).toBe(DEFECT.BRIGHT_DOT);
    expect(verdict.patternOnlyDefect).toBe(true);
    expect(verdict.labeled.some((l) => l.kind === 'bright-dot' && l.counted)).toBe(true);
  });

  it('accepts a defect seen in two patterns', () => {
    const p = polarToSource(GEOM, 0.4, 45);
    const images = analyzePanel((img, pattern) => {
      if (pattern === 'R' || pattern === 'G') addBrightDot(img, p.x, p.y, 6, 255);
    });
    expect(judgePanel(images).finalJudgementId).toBe(DEFECT.BRIGHT_DOT);
  });

  it('does not merge same-kind detections at different panel positions', () => {
    const left = polarToSource(GEOM, 0.55, 90);
    const right = polarToSource(GEOM, 0.55, 270);
    const images = analyzePanel((img, pattern) => {
      if (pattern === 'R') addBrightDot(img, left.x, left.y, 7, 255);
      if (pattern === 'G') addBrightDot(img, right.x, right.y, 7, 255);
    });
    const verdict = judgePanel(images);
    expect(verdict.finalJudgementId).toBe(DEFECT.BRIGHT_DOT);
    expect(verdict.patternOnlyDefect).toBe(true);
    expect(verdict.labeled.filter((item) => item.counted)).toHaveLength(2);
  });

  it('does not grade a black area seen in only one pattern', () => {
    const p = polarToSource(GEOM, 0.4, 30);
    const images = analyzePanel((img, pattern) => {
      if (pattern === 'B') addDarkDot(img, p.x, p.y, 20, 6);
    });
    const verdict = judgePanel(images);
    expect(verdict.finalJudgementId).toBe(DEFECT.GOOD);
    expect(verdict.darkAreaPct).toBe(0);
    expect(verdict.suppressed).toContain('dark-dot');
  });
});

describe('confidence', () => {
  it('is the rule-only baseline for a full panel', () => {
    expect(judgePanel(analyzePanel()).confidence).toBeCloseTo(0.6, 5);
  });

  it('is penalized for each missing pattern', () => {
    const images = analyzePanel().slice(0, 2);
    const verdict = judgePanel(images);
    expect(verdict.missingPatterns).toEqual(['B', 'W']);
    expect(verdict.confidence).toBeCloseTo(0.6 * 0.85 ** 2, 5);
  });
});

describe('driving defect signal', () => {
  it('raises a flag on banded output but does not judge it', () => {
    const image = analyze('W', (img) => addBanding(img, GEOM.cx, GEOM.cy, GEOM.r, 18));
    expect(image.drivingFlag).toBe(true);

    const verdict = judgePanel([image]);
    // Rule detection alone must never assert 구동불량; that is the kNN stage's job.
    expect(verdict.finalJudgementId).not.toBe(DEFECT.DRIVING);
    expect(verdict.drivingFlag).toBe(true);
    expect(verdict.decisionReason).toContain('구동불량 의심');
  });

  it('does not flag a clean panel', () => {
    expect(analyze('W').drivingFlag).toBe(false);
  });
});
