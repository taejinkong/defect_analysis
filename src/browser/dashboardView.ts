import type { Settings } from '../core/settings';
import { DEFECT_NAME, LABELABLE_DEFECTS, type DefectId } from '../core/settings';
import { PATTERNS } from '../core/types';
import { offsetFromAngle } from '../core/geometry';
import {
  collectPoints,
  defectRatioByLabel,
  defectRatioByPanel,
  directionConcentration,
  groupRates,
  hotspots,
  locationLabel,
  overview,
  patternAnalysis,
  regionMatrix,
  type DashboardPanel,
} from '../core/dashboard';
import { binaryValidationMetrics, separateRealAndSynthetic, type ValidationSample } from '../core/validation';

/**
 * Render the dashboard: a left section-nav plus light, card-based content, in
 * the style of the reference financial dashboard. Heatmaps use the Viridis
 * colorscale of the reference telemetry app.
 */
export function renderDashboard(
  body: HTMLElement,
  nav: HTMLElement,
  panels: readonly DashboardPanel[],
  settings: Settings,
): void {
  body.replaceChildren();
  nav.replaceChildren();

  if (panels.length === 0) {
    body.append(empty('분석된 패널이 없습니다. 먼저 불량 분석을 실행하세요.'));
    return;
  }
  const points = collectPoints(panels);

  const sections: { id: string; label: string; build: () => HTMLElement }[] = [
    { id: 'overview', label: '개요', build: () => overviewSection(panels) },
    { id: 'ratio', label: '불량 비율', build: () => ratioSection(panels) },
    { id: 'location', label: '위치 상관', build: () => locationSection(panels, points, settings) },
    { id: 'pattern', label: '패턴 분석', build: () => patternSection(panels) },
    { id: 'groups', label: 'Lot · 설비 · 공정', build: () => groupSection(panels) },
    { id: 'validation', label: '검증', build: () => validationSection(panels) },
  ];

  for (const s of sections) {
    const el = card(s.id, s.label, s.build());
    body.append(el);

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'dash-nav-item';
    link.textContent = s.label;
    link.addEventListener('click', () => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      nav.querySelectorAll('.dash-nav-item').forEach((n) => n.classList.remove('on'));
      link.classList.add('on');
    });
    nav.append(link);
  }
  nav.querySelector('.dash-nav-item')?.classList.add('on');

  // Highlight the nav item of whichever section is in view.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = sections.findIndex((s) => s.id === entry.target.id);
        if (idx < 0) continue;
        nav.querySelectorAll('.dash-nav-item').forEach((n, i) => n.classList.toggle('on', i === idx));
      }
    },
    { root: body.closest('.dash-main'), threshold: 0.3, rootMargin: '-10% 0px -70% 0px' },
  );
  for (const s of sections) {
    const el = document.getElementById(s.id);
    if (el) observer.observe(el);
  }
}

function validationSection(panels: readonly DashboardPanel[]): HTMLElement {
  const wrap = document.createElement('div');
  const samples: ValidationSample[] = panels.flatMap((panel) =>
    panel.automaticJudgementId && panel.reviewerJudgementId
      ? [{
        panelId: panel.panelId,
        lotId: panel.lotId,
        equipmentId: panel.equipmentId,
        capturedAt: panel.capturedAt ?? '',
        synthetic: panel.synthetic === true,
        predicted: panel.automaticJudgementId,
        actual: panel.reviewerJudgementId,
      }]
      : [],
  );
  if (samples.length === 0) {
    wrap.append(empty('Engineer 승인 Ground Truth가 없습니다. 자동 성능을 표시하지 않습니다.'));
    return wrap;
  }
  const split = separateRealAndSynthetic(samples);
  const grid = document.createElement('div');
  grid.className = 'dash-kpis';
  for (const [name, values] of [['실물', split.real], ['합성', split.synthetic]] as const) {
    const metrics = binaryValidationMetrics(values);
    grid.append(
      kpi(`${name} 검증 표본`, String(metrics.sampleCount), 'Panel 기준 · 서로 합산 금지', 'panel', 'neutral'),
      kpi(`${name} 불량 Recall`, pct(metrics.recall), `FN ${metrics.fn}`, 'rate', metrics.fn > 0 ? 'bad' : 'neutral'),
      kpi(`${name} 불량 유출률`, pct(metrics.falseAcceptRate), '실제 불량을 OK로 판정', 'bad', metrics.fn > 0 ? 'bad' : 'neutral'),
      kpi(`${name} 오검률`, pct(metrics.falseRejectRate), '실제 양품을 NG로 판정', 'review', metrics.fp > 0 ? 'warn' : 'neutral'),
    );
  }
  wrap.append(
    caption('검증은 Engineer 승인 표본만 사용합니다. 실제 운영 검증 세트는 Panel/Lot/설비/시간 단위로 분리해야 하며 무작위 이미지 분리는 금지합니다.'),
    grid,
  );
  return wrap;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function card(id: string, title: string, inner: HTMLElement): HTMLElement {
  const el = document.createElement('section');
  el.className = 'dash-card';
  el.id = id;
  const h = document.createElement('h3');
  h.textContent = title;
  el.append(h, inner);
  return el;
}

function subCard(title: string, inner: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dash-subcard';
  const h = document.createElement('h4');
  h.textContent = title;
  el.append(h, inner);
  return el;
}

function empty(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'dash-empty';
  el.textContent = text;
  return el;
}

function caption(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'dash-sub';
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------- overview

const ICONS: Record<string, string> = {
  panel: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  good: 'M20 6L9 17l-5-5',
  bad: 'M12 2L2 20h20zM12 9v5M12 17v.5',
  rate: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  multi: 'M8 6h13M8 12h13M8 18h13M3 6h.5M3 12h.5M3 18h.5',
  review: 'M12 8v5M12 16v.5M12 3l9 16H3z',
  top: 'M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 27l2-7L2 9h7z',
};

function overviewSection(panels: readonly DashboardPanel[]): HTMLElement {
  const o = overview(panels);
  const wrap = document.createElement('div');
  wrap.className = 'dash-kpis';

  wrap.append(
    kpi('전체 Panel', String(o.total), '', 'panel', 'neutral'),
    kpi('전체 이미지', String(o.totalImages), '', 'panel', 'neutral'),
    kpi('양품', String(o.good), `${o.total > 0 ? ((o.good / o.total) * 100).toFixed(0) : 0}%`, 'good', 'good'),
    kpi('불량 Panel', String(o.defective), o.defective > 0 ? '조치 검토' : '', 'bad', o.defective > 0 ? 'bad' : 'neutral'),
    kpi('불량률', `${o.defectRatePct.toFixed(1)}%`, '', 'rate', o.defectRatePct > 0 ? 'bad' : 'good'),
    kpi('복수불량', String(o.multi), '', 'multi', o.multi > 0 ? 'warn' : 'neutral'),
    kpi('검수 필요', String(o.needsReview), o.needsReview > 0 ? 'Rule·kNN 불일치' : '', 'review', o.needsReview > 0 ? 'warn' : 'neutral'),
    kpi('전처리 실패', String(o.preprocessingFailures), '', 'review', o.preprocessingFailures > 0 ? 'bad' : 'good'),
    kpi('실물 / 합성', `${o.realPanels} / ${o.syntheticPanels}`, '혼합 검증 금지', 'panel', 'neutral'),
    kpi('자동·검수 일치율', o.reviewerAgreementPct === null ? '—' : `${o.reviewerAgreementPct.toFixed(1)}%`, '검수 완료 표본만', 'rate', 'neutral'),
    kpi('Top 불량', o.topDefect ? DEFECT_NAME[o.topDefect] : '—', '', 'top', 'neutral'),
  );
  return wrap;
}

function kpi(label: string, value: string, sub: string, icon: string, tone: 'good' | 'bad' | 'warn' | 'neutral'): HTMLElement {
  const el = document.createElement('div');
  el.className = `dash-kpi tone-${tone}`;

  const head = document.createElement('div');
  head.className = 'dash-kpi-head';
  const l = document.createElement('span');
  l.className = 'dash-kpi-label';
  l.textContent = label;
  head.append(l, iconSvg(ICONS[icon] ?? ''));

  const v = document.createElement('div');
  v.className = 'dash-kpi-value';
  v.textContent = value;

  el.append(head, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'dash-kpi-sub';
    s.textContent = sub;
    el.append(s);
  }
  return el;
}

function iconSvg(path: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'dash-kpi-icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linejoin', 'round');
  p.setAttribute('stroke-linecap', 'round');
  svg.append(p);
  return svg;
}

// ---------------------------------------------------------------- ratio

function ratioSection(panels: readonly DashboardPanel[]): HTMLElement {
  const wrap = document.createElement('div');

  const controls = document.createElement('div');
  controls.className = 'dash-seg-group';
  const panelBtn = seg('Panel 기준', true);
  const labelBtn = seg('Label 기준', false);
  controls.append(panelBtn, labelBtn);

  const sub = document.createElement('p');
  sub.className = 'dash-sub';
  const chart = document.createElement('div');

  const drawPanel = (): void => {
    sub.textContent = `분모: ${panels.length} panels · 각 패널은 최종 판정 1개로 계수`;
    chart.replaceChildren(barChart(defectRatioByPanel(panels)));
  };
  const drawLabel = (): void => {
    const counts = defectRatioByLabel(panels);
    let total = 0;
    for (const c of counts.values()) total += c;
    sub.textContent = `분모: ${total} labels · 검출된 개별 불량으로 계수 (양품·복수불량 제외)`;
    chart.replaceChildren(barChart(counts));
  };

  panelBtn.addEventListener('click', () => {
    panelBtn.classList.add('on');
    labelBtn.classList.remove('on');
    drawPanel();
  });
  labelBtn.addEventListener('click', () => {
    labelBtn.classList.add('on');
    panelBtn.classList.remove('on');
    drawLabel();
  });

  drawPanel();
  wrap.append(controls, sub, chart);
  return wrap;
}

function seg(text: string, on: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = on ? 'dash-seg on' : 'dash-seg';
  b.textContent = text;
  return b;
}

function barChart(counts: ReadonlyMap<DefectId, number>): HTMLElement {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = rows.reduce((m, [, c]) => Math.max(m, c), 0) || 1;
  let total = 0;
  for (const [, c] of rows) total += c;

  const wrap = document.createElement('div');
  wrap.className = 'dash-bars';
  if (rows.length === 0) {
    wrap.append(empty('불량이 검출되지 않았습니다.'));
    return wrap;
  }
  for (const [defectId, count] of rows) {
    const row = document.createElement('div');
    row.className = 'dash-bar-row';
    const name = document.createElement('span');
    name.className = 'dash-bar-name';
    name.textContent = DEFECT_NAME[defectId];
    const track = document.createElement('div');
    track.className = 'dash-bar-track';
    const fill = document.createElement('div');
    fill.className = 'dash-bar-fill';
    fill.style.width = `${(count / max) * 100}%`;
    track.append(fill);
    const val = document.createElement('span');
    val.className = 'dash-bar-val';
    val.textContent = `${count} (${((count / total) * 100).toFixed(1)}%)`;
    row.append(name, track, val);
    wrap.append(row);
  }
  return wrap;
}

// ---------------------------------------------------------------- location

const SECTORS = 24;

function locationSection(
  panels: readonly DashboardPanel[],
  points: ReturnType<typeof collectPoints>,
  settings: Settings,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dash-loc-grid';
  wrap.append(
    subCard('원형 Heatmap', heatmapBody(points)),
    subCard('방향 집중도', directionBody(points)),
    subCard('Hotspot', hotspotBody(panels, points, settings)),
    subCard('불량명 × Region', regionBody(points, settings)),
  );
  return wrap;
}

function heatmapBody(points: readonly { rRatio: number; angleDeg: number }[]): HTMLElement {
  const wrap = document.createElement('div');
  if (points.length === 0) {
    wrap.append(empty('불량 위치 데이터가 없습니다.'));
    return wrap;
  }
  const row = document.createElement('div');
  row.className = 'dash-heat-row';

  const canvas = document.createElement('canvas');
  const size = 300;
  canvas.width = size;
  canvas.height = size;
  canvas.className = 'dash-polar';
  const present = drawPolarBubbles(canvas, points as BubblePoint[]);

  row.append(canvas, defectLegend(present));
  wrap.append(row);
  wrap.append(
    caption('불량 하나가 버블 하나. 버블 크기는 불량 면적, 색은 불량 종류입니다. 6시(FPCB)가 하단, 시계 방향으로 진행합니다.'),
  );
  return wrap;
}

interface BubblePoint {
  rRatio: number;
  angleDeg: number;
  areaPx: number;
  defectId: DefectId;
}

/**
 * Bubble scatter over the circular display, in the style of the reference
 * drug-discovery plot: each defect is a bubble at its (angle, radius) position.
 * Bubble area encodes the defect's pixel area, and colour encodes the defect
 * class. Returns the set of defect ids drawn, for the categorical legend.
 */
function drawPolarBubbles(canvas: HTMLCanvasElement, points: BubblePoint[]): DefectId[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const { width } = canvas;
  const cx = width / 2;
  const cy = width / 2;
  const R = width / 2 - 26;

  ctx.clearRect(0, 0, width, width);

  // Display outline, clock spokes, and FPCB marker first, so bubbles sit on top.
  ctx.fillStyle = '#f6f8fc';
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(80,100,140,0.30)';
  ctx.lineWidth = 1;
  for (let h = 0; h < 12; h += 3) {
    const { dx, dy } = offsetFromAngle(h * 30);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + dx * R, cy + dy * R);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(80,100,140,0.45)';
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();

  // Bubble radius scales with sqrt(area) so that bubble *area* tracks defect
  // area, the way area-encoded scatter plots are meant to be read.
  const maxArea = points.reduce((m, p) => Math.max(m, p.areaPx), 1);
  const radiusOf = (areaPx: number): number => 3 + 14 * Math.sqrt(Math.max(0, areaPx) / maxArea);

  // Largest bubbles first, so small ones stay visible on top of big ones.
  const order = [...points.keys()].sort((i, j) => points[j]!.areaPx - points[i]!.areaPx);
  const present = new Set<DefectId>();
  for (const i of order) {
    const p = points[i]!;
    present.add(p.defectId);
    const rad = (p.angleDeg * Math.PI) / 180;
    const x = cx + p.rRatio * -Math.sin(rad) * R;
    const y = cy + p.rRatio * Math.cos(rad) * R;
    ctx.beginPath();
    ctx.arc(x, y, radiusOf(p.areaPx), 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(DEFECT_COLOR[p.defectId] ?? '#888', 0.72);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.stroke();
  }

  ctx.fillStyle = '#3b6fd4';
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('FPCB (6시)', cx, cy + R + 18);
  return [...present];
}

/** Categorical legend: colour swatch + defect name for each class drawn. */
function defectLegend(defectIds: readonly DefectId[]): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dash-legend';
  const title = document.createElement('div');
  title.className = 'dash-legend-title';
  title.textContent = '불량 종류';
  el.append(title);

  const sorted = [...defectIds].sort();
  for (const id of sorted) {
    const item = document.createElement('div');
    item.className = 'dash-legend-item';
    const sw = document.createElement('span');
    sw.className = 'dash-legend-swatch';
    sw.style.background = DEFECT_COLOR[id] ?? '#888';
    const name = document.createElement('span');
    name.textContent = DEFECT_NAME[id];
    item.append(sw, name);
    el.append(item);
  }
  const note = document.createElement('div');
  note.className = 'dash-legend-note';
  note.textContent = '버블 크기 = 면적';
  el.append(note);
  return el;
}

function sectorToScreen(sector: number): number {
  const clockDeg = (sector / SECTORS) * 360;
  const { dx, dy } = offsetFromAngle(clockDeg);
  return Math.atan2(dy, dx);
}

/** A vertical Viridis colorbar with min/max labels. */
function colorbar(min: number, max: number, title: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dash-colorbar';
  const t = document.createElement('div');
  t.className = 'dash-colorbar-title';
  t.textContent = title;
  const hi = document.createElement('span');
  hi.className = 'dash-colorbar-tick';
  hi.textContent = max.toFixed(max >= 100 ? 0 : 1);
  const bar = document.createElement('div');
  bar.className = 'dash-colorbar-bar';
  const lo = document.createElement('span');
  lo.className = 'dash-colorbar-tick';
  lo.textContent = String(min);
  el.append(t, hi, bar, lo);
  return el;
}

function directionBody(points: ReturnType<typeof collectPoints>): HTMLElement {
  const wrap = document.createElement('div');
  if (points.length === 0) {
    wrap.append(empty('불량 위치 데이터가 없습니다.'));
    return wrap;
  }
  const stats = directionConcentration(points);

  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 240;
  canvas.className = 'dash-polar';
  drawRose(canvas, points, stats.meanDeg);
  wrap.append(canvas);

  const info = document.createElement('div');
  info.className = 'dash-stat-lines';
  const concentrated = stats.resultant >= 0.1;
  info.append(
    statLine('평균 방향', concentrated ? clockOf(stats.meanDeg) : '편중 없음'),
    statLine('집중도 R̄', stats.resultant.toFixed(3)),
    statLine('Rayleigh p', stats.rayleighP < 0.001 ? '<0.001' : stats.rayleighP.toFixed(3)),
    statLine('방향성', stats.rayleighP < 0.05 && concentrated ? '유의 (p<0.05)' : '유의하지 않음'),
  );
  wrap.append(info);
  return wrap;
}

function drawRose(canvas: HTMLCanvasElement, points: { angleDeg: number }[], meanDeg: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width } = canvas;
  const cx = width / 2;
  const cy = width / 2;
  const R = width / 2 - 18;

  const counts = new Int32Array(SECTORS);
  for (const p of points) {
    let a = p.angleDeg % 360;
    if (a < 0) a += 360;
    counts[Math.min(SECTORS - 1, Math.floor((a / 360) * SECTORS))]++;
  }
  const max = counts.reduce((m, c) => Math.max(m, c), 0) || 1;

  ctx.clearRect(0, 0, width, width);
  for (let s = 0; s < SECTORS; s++) {
    const len = (counts[s]! / max) * R;
    const a0 = sectorToScreen(s);
    const a1 = sectorToScreen(s + 1);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, len, a0, a1);
    ctx.closePath();
    ctx.fillStyle = 'rgba(59,111,212,0.5)';
    ctx.fill();
  }

  const { dx, dy } = offsetFromAngle(meanDeg);
  ctx.strokeStyle = '#e0662a';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + dx * R, cy + dy * R);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(80,100,140,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#6b7688';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('6시', cx, cy + R + 13);
}

function hotspotBody(
  panels: readonly DashboardPanel[],
  points: ReturnType<typeof collectPoints>,
  settings: Settings,
): HTMLElement {
  const wrap = document.createElement('div');
  if (points.length < 10) {
    wrap.append(empty('표본 부족 — Hotspot 분석에는 최소 10개 라벨이 필요합니다.'));
    return wrap;
  }
  const spots = hotspots(points, panels.length, settings);
  if (spots.length === 0) {
    wrap.append(empty('반복되는 Hotspot이 발견되지 않았습니다.'));
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'dash-table';
  table.innerHTML =
    '<thead><tr><th>#</th><th>위치</th><th>패널 수</th><th>점유율</th><th>라벨</th><th>주요 불량</th></tr></thead>';
  const tbody = document.createElement('tbody');
  spots.forEach((spot, i) => {
    const tr = document.createElement('tr');
    tr.append(
      td(`#${i + 1}`),
      td(`${locationLabel(spot.centerAngleDeg, spot.region)} · r=${spot.centerRRatio.toFixed(2)}`),
      td(String(spot.panelCount)),
      td(`${spot.panelSharePct.toFixed(1)}%`),
      td(String(spot.labelCount)),
      td(spot.topDefectId ? DEFECT_NAME[spot.topDefectId] : '—'),
    );
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.append(table);
  wrap.append(caption('여러 패널에 반복되는 불량. 라벨 수가 아니라 패널 수로 정렬합니다.'));
  return wrap;
}

function regionBody(points: ReturnType<typeof collectPoints>, settings: Settings): HTMLElement {
  const wrap = document.createElement('div');
  const matrix = regionMatrix(points, settings);
  if (matrix.rows.length === 0) {
    wrap.append(empty('불량 위치 데이터가 없습니다.'));
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'dash-table';
  table.innerHTML = '<thead><tr><th>불량명</th><th>center</th><th>mid</th><th>edge</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const row of matrix.rows) {
    const tr = document.createElement('tr');
    tr.append(td(DEFECT_NAME[row.defectId as DefectId] ?? row.defectId));
    for (let j = 0; j < 3; j++) {
      const cell = td(String(row.observed[j]));
      const res = row.residual[j]!;
      if (Math.abs(res) > 2) {
        cell.classList.add(res > 0 ? 'cell-over' : 'cell-under');
        cell.title = `표준화 잔차 ${res.toFixed(1)}`;
        cell.textContent = `${row.observed[j]} (${res > 0 ? '+' : ''}${res.toFixed(1)}σ)`;
      }
      tr.append(cell);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);

  const foot = document.createElement('p');
  foot.className = 'dash-sub';
  foot.textContent = matrix.underpowered
    ? '표본 부족 — 기대도수가 작아 카이제곱 검정을 표시하지 않습니다. 면적 비례 대비 관측만 참고하세요.'
    : `면적 비례 귀무가설 대비 χ²=${matrix.chi2.toFixed(1)}, dof=${matrix.dof}, p=${matrix.pValue < 0.001 ? '<0.001' : matrix.pValue.toFixed(3)}. |잔차|>2σ 셀 강조.`;
  wrap.append(foot);
  return wrap;
}

// ---------------------------------------------------------------- pattern

function patternSection(panels: readonly DashboardPanel[]): HTMLElement {
  const wrap = document.createElement('div');
  const pa = patternAnalysis(panels);
  const present = LABELABLE_DEFECTS.filter((d) => PATTERNS.some((p) => (pa.get(p)?.get(d) ?? 0) > 0));
  if (present.length === 0) {
    wrap.append(empty('불량이 검출되지 않았습니다.'));
    return wrap;
  }

  let max = 0;
  for (const p of PATTERNS) for (const d of present) max = Math.max(max, pa.get(p)?.get(d) ?? 0);

  const row = document.createElement('div');
  row.className = 'dash-heat-row';

  const table = document.createElement('table');
  table.className = 'dash-table dash-heat-table';
  const head = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.append(th(''));
  for (const p of PATTERNS) hr.append(th(p));
  head.append(hr);
  const tbody = document.createElement('tbody');
  for (const defectId of present) {
    const tr = document.createElement('tr');
    tr.append(td(DEFECT_NAME[defectId]));
    for (const p of PATTERNS) {
      const count = pa.get(p)?.get(defectId) ?? 0;
      const cell = td(count > 0 ? String(count) : '·');
      if (count > 0) {
        const t = count / (max || 1);
        cell.style.background = viridis(t);
        cell.style.color = t > 0.55 ? '#10261f' : '#eef6ff';
      }
      tr.append(cell);
    }
    tbody.append(tr);
  }
  table.append(head, tbody);
  row.append(table, colorbar(0, max, '건수'));
  wrap.append(row);
  return wrap;
}

// ---------------------------------------------------------------- groups

function groupSection(panels: readonly DashboardPanel[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dash-groups';
  const fields: [string, 'lotId' | 'equipmentId' | 'processName'][] = [
    ['Lot별 불량률', 'lotId'],
    ['설비별 불량률', 'equipmentId'],
    ['공정별 불량률', 'processName'],
  ];
  const avg = panels.length > 0 ? (panels.filter((p) => p.finalJudgementId !== 'D000').length / panels.length) * 100 : 0;

  for (const [title, field] of fields) {
    const col = subCard(title, groupBars(groupRates(panels, field)));
    const note = document.createElement('p');
    note.className = 'dash-sub';
    note.textContent = `전체 평균 불량률 ${avg.toFixed(1)}% · n<10은 흐리게 표시`;
    col.append(note);
    wrap.append(col);
  }
  return wrap;
}

function groupBars(rows: ReturnType<typeof groupRates>): HTMLElement {
  const box = document.createElement('div');
  box.className = 'dash-bars';
  for (const rate of rows) {
    const small = rate.total < 10;
    const row = document.createElement('div');
    row.className = 'dash-bar-row';
    const name = document.createElement('span');
    name.className = small ? 'dash-bar-name dim' : 'dash-bar-name';
    name.textContent = `${rate.key} (n=${rate.total})`;
    const track = document.createElement('div');
    track.className = 'dash-bar-track';
    const fill = document.createElement('div');
    fill.className = 'dash-bar-fill';
    fill.style.width = `${rate.ratePct}%`;
    if (small) fill.style.opacity = '0.4';
    track.append(fill);
    const val = document.createElement('span');
    val.className = 'dash-bar-val';
    val.textContent = `${rate.ratePct.toFixed(0)}%`;
    row.append(name, track, val);
    box.append(row);
  }
  return box;
}

// ---------------------------------------------------------------- viridis

/**
 * Viridis colorscale, matching the reference telemetry heatmap. Piecewise-linear
 * interpolation over the standard anchor colors is close enough for a legend the
 * eye reads qualitatively.
 */
const VIRIDIS: [number, [number, number, number]][] = [
  [0.0, [68, 1, 84]],
  [0.25, [59, 82, 139]],
  [0.5, [33, 145, 140]],
  [0.75, [94, 201, 98]],
  [1.0, [253, 231, 37]],
];

function viridisComponents(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < VIRIDIS.length; i++) {
    const [t1, c1] = VIRIDIS[i]!;
    if (x <= t1) {
      const [t0, c0] = VIRIDIS[i - 1]!;
      const f = (x - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return [253, 231, 37];
}

function viridis(t: number): string {
  const [r, g, b] = viridisComponents(t);
  return `rgb(${r},${g},${b})`;
}

/**
 * Categorical colours for the defect classes, used by the bubble plot's legend
 * and marks. Dark-dot grades share a blue ramp (小→大 deepening); the other
 * classes get distinct hues.
 */
const DEFECT_COLOR: Record<string, string> = {
  D000: '#16a34a', // 양품 (not plotted as a point)
  D001: '#9ecae1', // 암점 小
  D002: '#4292c6', // 암점 中
  D003: '#08519c', // 암점 大
  D004: '#f59e0b', // 명점
  D005: '#41ab5d', // 명선_가로줄
  D006: '#12a4a4', // 명선_세로줄
  D007: '#8856a7', // 암선_가로줄
  D008: '#e7298a', // 암선_세로줄
  D009: '#a1622f', // 구동불량
  D010: '#737b8c', // 미점등
  D011: '#dc2626', // 복수불량 (derived)
};

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------- helpers

function td(text: string): HTMLTableCellElement {
  const el = document.createElement('td');
  el.textContent = text;
  return el;
}
function th(text: string): HTMLTableCellElement {
  const el = document.createElement('th');
  el.textContent = text;
  return el;
}
function statLine(label: string, value: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dash-stat-line';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('strong');
  v.textContent = value;
  el.append(l, v);
  return el;
}
function clockOf(angleDeg: number): string {
  const hour = (6 + (((angleDeg % 360) + 360) % 360) / 30) % 12;
  return `${(hour < 1 ? hour + 12 : hour).toFixed(1)}시`;
}
