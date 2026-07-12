import { describe, expect, it } from 'vitest';
import {
  collectPoints,
  defectRatioByLabel,
  defectRatioByPanel,
  directionConcentration,
  groupRates,
  hotspots,
  overview,
  patternAnalysis,
  type DashboardPanel,
  type DashboardPoint,
} from './dashboard';
import { DEFECT } from './settings';
import type { Pattern } from './types';

function point(overrides: Partial<DashboardPoint> = {}): DashboardPoint {
  return {
    panelId: 1,
    defectId: 'D004',
    pattern: 'W',
    rRatio: 0.5,
    angleDeg: 90,
    region: 'mid',
    areaPx: 10,
    ...overrides,
  };
}

function panel(overrides: Partial<DashboardPanel> = {}): DashboardPanel {
  return {
    panelId: 1,
    lotId: 'LOT1',
    model: 'M',
    processName: 'Cell',
    equipmentId: 'EQ1',
    reviewStatus: 'pending',
    finalJudgementId: DEFECT.GOOD,
    detectedDefectIds: [],
    confidence: 0.6,
    needsReview: false,
    points: [],
    ...overrides,
  };
}

describe('overview', () => {
  it('counts good, defective, multi and rate', () => {
    const panels = [
      panel({ panelId: 1, finalJudgementId: DEFECT.GOOD }),
      panel({ panelId: 2, finalJudgementId: DEFECT.BRIGHT_DOT, points: [point({ panelId: 2 })] }),
      panel({ panelId: 3, finalJudgementId: DEFECT.MULTI, needsReview: true }),
      panel({ panelId: 4, finalJudgementId: DEFECT.GOOD }),
    ];
    const o = overview(panels);
    expect(o.total).toBe(4);
    expect(o.good).toBe(2);
    expect(o.defective).toBe(2);
    expect(o.defectRatePct).toBe(50);
    expect(o.multi).toBe(1);
    expect(o.needsReview).toBe(1);
    expect(o.topDefect).toBe(DEFECT.BRIGHT_DOT);
  });
});

describe('defect ratio', () => {
  it('panel basis counts each panel once and sums to the panel total', () => {
    const panels = [
      panel({ panelId: 1, finalJudgementId: DEFECT.MULTI, points: [point({ defectId: 'D001' }), point({ defectId: 'D004' })] }),
      panel({ panelId: 2, finalJudgementId: DEFECT.BRIGHT_DOT, points: [point({ defectId: 'D004' })] }),
    ];
    const byPanel = defectRatioByPanel(panels);
    expect(byPanel.get(DEFECT.MULTI)).toBe(1);
    expect(byPanel.get(DEFECT.BRIGHT_DOT)).toBe(1);
    let sum = 0;
    for (const c of byPanel.values()) sum += c;
    expect(sum).toBe(2);
  });

  it('label basis counts every individual defect', () => {
    const panels = [
      panel({ panelId: 1, finalJudgementId: DEFECT.MULTI, points: [point({ defectId: 'D001' }), point({ defectId: 'D004' })] }),
      panel({ panelId: 2, finalJudgementId: DEFECT.BRIGHT_DOT, points: [point({ defectId: 'D004' })] }),
    ];
    const byLabel = defectRatioByLabel(panels);
    expect(byLabel.get('D001')).toBe(1);
    expect(byLabel.get('D004')).toBe(2);
    // Neither 양품 nor 복수불량 appears as a label.
    expect(byLabel.has(DEFECT.MULTI)).toBe(false);
    expect(byLabel.has(DEFECT.GOOD)).toBe(false);
  });
});

describe('patternAnalysis', () => {
  it('buckets detections by pattern', () => {
    const panels = [
      panel({
        points: [
          point({ pattern: 'R', defectId: 'D004' }),
          point({ pattern: 'R', defectId: 'D004' }),
          point({ pattern: 'W', defectId: 'D001' }),
        ],
      }),
    ];
    const pa = patternAnalysis(panels);
    expect(pa.get('R' as Pattern)!.get('D004')).toBe(2);
    expect(pa.get('W' as Pattern)!.get('D001')).toBe(1);
  });
});

describe('groupRates', () => {
  it('computes per-lot defect rate and keeps small groups visible', () => {
    const panels = [
      panel({ panelId: 1, lotId: 'A', finalJudgementId: DEFECT.GOOD }),
      panel({ panelId: 2, lotId: 'A', finalJudgementId: DEFECT.BRIGHT_DOT }),
      panel({ panelId: 3, lotId: 'B', finalJudgementId: DEFECT.DARK_DOT_LARGE }),
    ];
    const rates = groupRates(panels, 'lotId');
    const a = rates.find((r) => r.key === 'A')!;
    const b = rates.find((r) => r.key === 'B')!;
    expect(a.total).toBe(2);
    expect(a.ratePct).toBe(50);
    expect(b.total).toBe(1);
    expect(b.ratePct).toBe(100);
    expect(b.topDefectId).toBe(DEFECT.DARK_DOT_LARGE);
  });
});

describe('hotspots', () => {
  it('ranks a spot hit by many panels above a spot hit many times by one panel', () => {
    // Cluster A: 4 different panels, one point each at 9 o'clock mid.
    const clusterA: DashboardPoint[] = [1, 2, 3, 4].map((id) =>
      point({ panelId: id, rRatio: 0.5, angleDeg: 90 }),
    );
    // Cluster B: one panel, 5 points bunched at 3 o'clock mid.
    const clusterB: DashboardPoint[] = [0, 1, 2, 3, 4].map((i) =>
      point({ panelId: 99, rRatio: 0.5, angleDeg: 270 + i * 0.3 }),
    );

    const spots = hotspots([...clusterA, ...clusterB], 5);
    expect(spots.length).toBeGreaterThanOrEqual(2);
    // The many-panel cluster must rank first despite having fewer labels.
    expect(spots[0]!.panelCount).toBe(4);
    expect(spots[0]!.labelCount).toBe(4);
    const single = spots.find((s) => s.panelCount === 1)!;
    expect(single.labelCount).toBe(5);
  });

  it('locates the cluster centroid near its true angle', () => {
    const pts = [1, 2, 3, 4].map((id) => point({ panelId: id, rRatio: 0.6, angleDeg: 90 }));
    const spots = hotspots(pts, 4);
    expect(spots).toHaveLength(1);
    expect(Math.abs(spots[0]!.centerAngleDeg - 90)).toBeLessThan(5);
    expect(spots[0]!.centerRRatio).toBeCloseTo(0.6, 1);
  });
});

describe('directionConcentration', () => {
  it('detects a directional bias toward the FPCB', () => {
    const pts = [2, -2, 1, 0, -1].map((d) => point({ angleDeg: (d + 360) % 360 }));
    const stats = directionConcentration(pts);
    expect(Math.min(stats.meanDeg, 360 - stats.meanDeg)).toBeLessThan(5);
    expect(stats.resultant).toBeGreaterThan(0.9);
  });
});

describe('collectPoints', () => {
  it('flattens points across panels', () => {
    const panels = [
      panel({ points: [point(), point()] }),
      panel({ points: [point()] }),
    ];
    expect(collectPoints(panels)).toHaveLength(3);
  });
});
