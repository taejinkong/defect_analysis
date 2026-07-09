import { describe, expect, it } from 'vitest';
import type { Pattern, Rgba } from './types';
import { PATTERNS } from './types';
import { detectDefects, type ImageDetection } from './defects';
import { judgePanel, gradeDarkDot } from './verdict';
import { DEFECT } from './settings';
import { detectActiveCircle } from './preprocess';
import { normalizeFrame } from './normalize';
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

/**
 * Detect a circle on the clean capture, then paint the defect and normalize
 * using that geometry.
 *
 * This mirrors the app: the circle and rotation are confirmed once per panel,
 * then reused for every pattern. Re-detecting per image would be impossible for
 * a fully unlit panel, which has no circle to find.
 */
function analyze(pattern: Pattern, paint?: (img: Rgba) => void): ImageDetection {
  const options = { ...GEOM, pattern, tabAngleDeg: 0, noise: 2 } as const;
  const clean = renderSyntheticPanel(options);
  const detect = detectActiveCircle(clean);
  if (!detect.ok) throw new Error('circle detection failed on the clean panel');

  const img = renderSyntheticPanel(options);
  paint?.(img);
  const frame = normalizeFrame(img, detect.circle, detect.fpcb.rotationDeg);
  return detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, pattern);
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
  it('suppresses a defect seen in only one pattern', () => {
    const p = polarToSource(GEOM, 0.4, 45);
    const images = analyzePanel((img, pattern) => {
      if (pattern === 'R') addBrightDot(img, p.x, p.y, 6, 255);
    });
    const verdict = judgePanel(images);

    expect(verdict.finalJudgementId).toBe(DEFECT.GOOD);
    expect(verdict.suppressed).toContain('bright-dot');
    // Suppressed, but still surfaced to the reviewer rather than discarded.
    expect(verdict.labeled.some((l) => l.kind === 'bright-dot' && !l.counted)).toBe(true);
  });

  it('accepts a defect seen in two patterns', () => {
    const p = polarToSource(GEOM, 0.4, 45);
    const images = analyzePanel((img, pattern) => {
      if (pattern === 'R' || pattern === 'G') addBrightDot(img, p.x, p.y, 6, 255);
    });
    expect(judgePanel(images).finalJudgementId).toBe(DEFECT.BRIGHT_DOT);
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
