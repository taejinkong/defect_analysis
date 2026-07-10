import type { Pattern } from './types';
import type { DefectId, Settings } from './settings';
import { DEFAULT_SETTINGS, DEFECT } from './settings';
import type { Region } from './geometry';
import { angleToClockHour } from './geometry';
import { circularStats, dbscan, polarBins, regionChiSquare, type CircularStats, type PolarBin } from './stats';

/** One defect occurrence with its normalized-frame position. */
export interface DashboardPoint {
  readonly panelId: number;
  readonly defectId: DefectId;
  readonly pattern: Pattern;
  readonly rRatio: number;
  readonly angleDeg: number;
  readonly region: Region;
}

/** A panel as the dashboard sees it: metadata plus its analysis outcome. */
export interface DashboardPanel {
  readonly panelId: number;
  readonly lotId: string;
  readonly model: string;
  readonly processName: string;
  readonly equipmentId: string;
  readonly reviewStatus: string;
  readonly finalJudgementId: DefectId;
  readonly detectedDefectIds: DefectId[];
  readonly confidence: number;
  readonly needsReview: boolean;
  readonly points: DashboardPoint[];
}

export interface Overview {
  readonly total: number;
  readonly good: number;
  readonly defective: number;
  readonly defectRatePct: number;
  readonly multi: number;
  readonly needsReview: number;
  readonly topDefect: DefectId | null;
}

export function overview(panels: readonly DashboardPanel[]): Overview {
  const total = panels.length;
  const good = panels.filter((p) => p.finalJudgementId === DEFECT.GOOD).length;
  const multi = panels.filter((p) => p.finalJudgementId === DEFECT.MULTI).length;
  const needsReview = panels.filter((p) => p.needsReview).length;

  const labelCounts = defectRatioByLabel(panels);
  let topDefect: DefectId | null = null;
  let topCount = 0;
  for (const [defectId, count] of labelCounts) {
    if (count > topCount) {
      topCount = count;
      topDefect = defectId;
    }
  }

  return {
    total,
    good,
    defective: total - good,
    defectRatePct: total > 0 ? ((total - good) / total) * 100 : 0,
    multi,
    needsReview,
    topDefect,
  };
}

/**
 * Panel-basis ratio: each panel counted once under its final judgement, so the
 * shares sum to 100%. A 복수불량 panel lands only in 복수불량.
 */
export function defectRatioByPanel(panels: readonly DashboardPanel[]): Map<DefectId, number> {
  const counts = new Map<DefectId, number>();
  for (const p of panels) counts.set(p.finalJudgementId, (counts.get(p.finalJudgementId) ?? 0) + 1);
  return counts;
}

/**
 * Label-basis ratio: each detected defect counted individually, so a 복수불량
 * panel contributes to several classes. Excludes 양품 and 복수불량, which are
 * panel verdicts, not labels. See docs/dashboard_spec.md section 2.
 */
export function defectRatioByLabel(panels: readonly DashboardPanel[]): Map<DefectId, number> {
  const counts = new Map<DefectId, number>();
  for (const panel of panels) {
    for (const point of panel.points) counts.set(point.defectId, (counts.get(point.defectId) ?? 0) + 1);
  }
  return counts;
}

/** R/G/B/W by defect id, counting each detection under its pattern. */
export function patternAnalysis(panels: readonly DashboardPanel[]): Map<Pattern, Map<DefectId, number>> {
  const out = new Map<Pattern, Map<DefectId, number>>();
  for (const panel of panels) {
    for (const point of panel.points) {
      const row = out.get(point.pattern) ?? new Map<DefectId, number>();
      row.set(point.defectId, (row.get(point.defectId) ?? 0) + 1);
      out.set(point.pattern, row);
    }
  }
  return out;
}

export interface GroupRate {
  readonly key: string;
  readonly total: number;
  readonly defective: number;
  readonly ratePct: number;
  readonly topDefectId: DefectId | null;
}

/**
 * Defect rate grouped by a metadata field (Lot, equipment, process). Groups
 * with too few panels are still returned but the caller must show the count, so
 * a 1-of-3 rate is not read as equal to 500-of-1500. See section 6.
 */
export function groupRates(
  panels: readonly DashboardPanel[],
  field: 'lotId' | 'equipmentId' | 'processName',
): GroupRate[] {
  const groups = new Map<string, DashboardPanel[]>();
  for (const panel of panels) {
    const key = panel[field] || '(미지정)';
    const list = groups.get(key) ?? [];
    list.push(panel);
    groups.set(key, list);
  }

  const rates: GroupRate[] = [];
  for (const [key, members] of groups) {
    const defective = members.filter((p) => p.finalJudgementId !== DEFECT.GOOD).length;
    const defectCounts = new Map<DefectId, number>();
    for (const p of members) {
      if (p.finalJudgementId === DEFECT.GOOD) continue;
      defectCounts.set(p.finalJudgementId, (defectCounts.get(p.finalJudgementId) ?? 0) + 1);
    }
    let topDefectId: DefectId | null = null;
    let top = 0;
    for (const [defectId, count] of defectCounts) {
      if (count > top) {
        top = count;
        topDefectId = defectId;
      }
    }
    rates.push({
      key,
      total: members.length,
      defective,
      ratePct: members.length > 0 ? (defective / members.length) * 100 : 0,
      topDefectId,
    });
  }
  rates.sort((a, b) => b.ratePct - a.ratePct || b.total - a.total);
  return rates;
}

export function collectPoints(panels: readonly DashboardPanel[]): DashboardPoint[] {
  return panels.flatMap((p) => p.points);
}

export interface Hotspot {
  readonly centerAngleDeg: number;
  readonly centerRRatio: number;
  readonly region: Region;
  readonly labelCount: number;
  readonly panelCount: number;
  readonly panelSharePct: number;
  readonly topDefectId: DefectId | null;
}

/**
 * Cluster repeated defect positions across panels.
 *
 * Ranked by panel count, not label count: twenty panels with one defect each at
 * the same spot is a process signal, while one panel with twenty defects there
 * is a single bad unit. Only the former should rise to the top. See section 4.2.
 */
export function hotspots(
  points: readonly DashboardPoint[],
  totalPanels: number,
  settings: Settings = DEFAULT_SETTINGS,
): Hotspot[] {
  const xy = points.map((p) => {
    const rad = (p.angleDeg * Math.PI) / 180;
    return { x: p.rRatio * -Math.sin(rad), y: p.rRatio * Math.cos(rad) };
  });
  const { clusters } = dbscan(xy, 0.08, 3);

  const result: Hotspot[] = clusters.map((cluster) => {
    const members = cluster.indices.map((i) => points[i]!);
    const panelIds = new Set(members.map((m) => m.panelId));
    const defectCounts = new Map<DefectId, number>();
    for (const m of members) defectCounts.set(m.defectId, (defectCounts.get(m.defectId) ?? 0) + 1);
    let topDefectId: DefectId | null = null;
    let top = 0;
    for (const [defectId, count] of defectCounts) {
      if (count > top) {
        top = count;
        topDefectId = defectId;
      }
    }

    const rRatio = Math.hypot(cluster.centroid.x, cluster.centroid.y);
    let angleDeg = (Math.atan2(-cluster.centroid.x, cluster.centroid.y) * 180) / Math.PI;
    if (angleDeg < 0) angleDeg += 360;

    return {
      centerAngleDeg: angleDeg,
      centerRRatio: rRatio,
      region: rRatio <= settings['region.center_max_r'] ? 'center' : rRatio <= settings['region.mid_max_r'] ? 'mid' : 'edge',
      labelCount: members.length,
      panelCount: panelIds.size,
      panelSharePct: totalPanels > 0 ? (panelIds.size / totalPanels) * 100 : 0,
      topDefectId,
    };
  });

  result.sort((a, b) => b.panelCount - a.panelCount || b.labelCount - a.labelCount);
  return result;
}

export function directionConcentration(points: readonly DashboardPoint[]): CircularStats {
  return circularStats(points.map((p) => p.angleDeg));
}

export function polarDensity(
  points: readonly { rRatio: number; angleDeg: number }[],
  sectors = 24,
  rings = 6,
): PolarBin[] {
  return polarBins(points, sectors, rings);
}

export function regionMatrix(points: readonly DashboardPoint[], settings: Settings = DEFAULT_SETTINGS) {
  const byDefect = new Map<string, { center: number; mid: number; edge: number }>();
  for (const point of points) {
    const row = byDefect.get(point.defectId) ?? { center: 0, mid: 0, edge: 0 };
    row[point.region]++;
    byDefect.set(point.defectId, row);
  }
  return regionChiSquare(byDefect, settings['region.center_max_r'], settings['region.mid_max_r']);
}

/** Human-readable clock label, e.g. "7.2시 · edge". */
export function locationLabel(angleDeg: number, region: Region): string {
  return `${angleToClockHour(angleDeg).toFixed(1)}시 · ${region}`;
}
