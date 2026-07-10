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
  polarDensity,
  regionMatrix,
  type DashboardPanel,
} from '../core/dashboard';

/** Render the whole dashboard into `root`, replacing its contents. */
export function renderDashboard(root: HTMLElement, panels: readonly DashboardPanel[], settings: Settings): void {
  root.replaceChildren();
  if (panels.length === 0) {
    root.append(empty('분석된 패널이 없습니다. 먼저 불량 분석을 실행하세요.'));
    return;
  }
  const points = collectPoints(panels);

  root.append(
    section('개요', overviewTiles(panels)),
    section('불량 비율', ratioSection(panels)),
    section('위치 상관 — 원형 Heatmap', heatmapSection(points)),
    section('위치 상관 — Hotspot', hotspotSection(panels, points, settings)),
    section('위치 상관 — 방향 집중도', directionSection(points)),
    section('위치 상관 — 불량명 × Region', regionSection(points, settings)),
    section('패턴 분석', patternSection(panels)),
    section('Lot · 설비 · 공정', groupSection(panels)),
  );
}

function section(title: string, body: HTMLElement): HTMLElement {
  const el = document.createElement('section');
  el.className = 'dash-section';
  const h = document.createElement('h3');
  h.textContent = title;
  el.append(h, body);
  return el;
}

function empty(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'dash-empty';
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------- overview

function overviewTiles(panels: readonly DashboardPanel[]): HTMLElement {
  const o = overview(panels);
  const wrap = document.createElement('div');
  wrap.className = 'dash-tiles';
  const tiles: [string, string, boolean?][] = [
    [String(o.total), '전체 Panel'],
    [String(o.good), '양품'],
    [String(o.defective), '불량 Panel', o.defective > 0],
    [`${o.defectRatePct.toFixed(1)}%`, '불량률', o.defectRatePct > 0],
    [String(o.multi), '복수불량', o.multi > 0],
    [String(o.needsReview), '검수 필요', o.needsReview > 0],
    [o.topDefect ? DEFECT_NAME[o.topDefect] : '—', 'Top 불량'],
  ];
  for (const [value, label, alert] of tiles) wrap.append(statTile(value, label, alert ?? false));
  return wrap;
}

function statTile(value: string, label: string, alert: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = alert ? 'stat alert' : 'stat';
  const v = document.createElement('div');
  v.className = 'value';
  v.textContent = value;
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  el.append(v, l);
  return el;
}

// ---------------------------------------------------------------- ratio

function ratioSection(panels: readonly DashboardPanel[]): HTMLElement {
  const wrap = document.createElement('div');

  const controls = document.createElement('div');
  controls.className = 'dash-toggle';
  const panelBtn = toggleButton('Panel 기준', true);
  const labelBtn = toggleButton('Label 기준', false);
  controls.append(panelBtn, labelBtn);

  const chart = document.createElement('div');
  const sub = document.createElement('p');
  sub.className = 'dash-sub';

  const drawPanel = (): void => {
    const counts = defectRatioByPanel(panels);
    sub.textContent = `분모: ${panels.length} panels · 각 패널은 최종 판정 1개로 계수`;
    chart.replaceChildren(barChart(counts));
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

function toggleButton(text: string, on: boolean): HTMLButtonElement {
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

// ---------------------------------------------------------------- heatmap

const SECTORS = 24;
const RINGS = 6;

function heatmapSection(points: readonly { rRatio: number; angleDeg: number }[]): HTMLElement {
  const wrap = document.createElement('div');
  if (points.length === 0) {
    wrap.append(empty('불량 위치 데이터가 없습니다.'));
    return wrap;
  }
  const canvas = document.createElement('canvas');
  const size = 340;
  canvas.width = size;
  canvas.height = size;
  canvas.className = 'dash-polar';
  drawPolarHeatmap(canvas, points as { rRatio: number; angleDeg: number }[]);
  wrap.append(canvas);
  wrap.append(caption('셀 면적으로 정규화된 밀도. 6시(FPCB)가 하단, 시계 방향으로 진행합니다.'));
  return wrap;
}

function drawPolarHeatmap(canvas: HTMLCanvasElement, points: { rRatio: number; angleDeg: number }[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width } = canvas;
  const cx = width / 2;
  const cy = width / 2;
  const R = width / 2 - 30;

  const bins = polarDensity(points, SECTORS, RINGS);
  const maxDensity = bins.reduce((m, b) => Math.max(m, b.density), 0) || 1;

  ctx.clearRect(0, 0, width, width);
  for (const bin of bins) {
    const rIn = (bin.ring / RINGS) * R;
    const rOut = ((bin.ring + 1) / RINGS) * R;
    // Sector s spans clock angles; map to screen so 0 deg (6 o'clock) is down.
    const a0 = sectorToScreen(bin.sector);
    const a1 = sectorToScreen(bin.sector + 1);
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, a0, a1);
    ctx.arc(cx, cy, rIn, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = heatColor(bin.density / maxDensity);
    ctx.fill();
  }

  // Clock reference lines and FPCB marker.
  ctx.strokeStyle = 'rgba(122,162,255,0.5)';
  ctx.lineWidth = 1;
  for (let h = 0; h < 12; h += 3) {
    const { dx, dy } = offsetFromAngle(h * 30);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + dx * R, cy + dy * R);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffb454';
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('FPCB (6시)', cx, cy + R + 18);
}

/** Clock sector index to a canvas arc angle (radians). 6 o'clock is straight down. */
function sectorToScreen(sector: number): number {
  const clockDeg = (sector / SECTORS) * 360;
  const { dx, dy } = offsetFromAngle(clockDeg);
  return Math.atan2(dy, dx);
}

function heatColor(t: number): string {
  // Dark surface -> green -> amber, a perceptually rising sequential ramp.
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped === 0) return 'rgba(31,37,50,0.6)';
  const hue = 160 - clamped * 130; // 160 (green) -> 30 (amber)
  const light = 22 + clamped * 33;
  return `hsl(${hue}, 70%, ${light}%)`;
}

// ---------------------------------------------------------------- hotspots

function hotspotSection(
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
    '<thead><tr><th>#</th><th>위치</th><th>패널 수</th><th>패널 점유율</th><th>라벨 수</th><th>주요 불량</th></tr></thead>';
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
  wrap.append(caption('여러 패널에서 같은 위치에 반복되는 불량. 라벨 수가 아니라 패널 수로 정렬합니다.'));
  return wrap;
}

// ---------------------------------------------------------------- direction

function directionSection(points: ReturnType<typeof collectPoints>): HTMLElement {
  const wrap = document.createElement('div');
  if (points.length === 0) {
    wrap.append(empty('불량 위치 데이터가 없습니다.'));
    return wrap;
  }
  const stats = directionConcentration(points);

  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 300;
  canvas.className = 'dash-polar';
  drawRose(canvas, points, stats.meanDeg);
  wrap.append(canvas);

  const info = document.createElement('div');
  info.className = 'dash-stat-lines';
  const concentrated = stats.resultant >= 0.1;
  info.append(
    statLine('평균 방향', concentrated ? locationLabelClock(stats.meanDeg) : '특정 방향 편중 없음'),
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
  const R = width / 2 - 20;

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
    ctx.fillStyle = 'rgba(61,220,151,0.55)';
    ctx.fill();
  }

  const { dx, dy } = offsetFromAngle(meanDeg);
  ctx.strokeStyle = '#ffb454';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + dx * R, cy + dy * R);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(122,162,255,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#ffb454';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('6시', cx, cy + R + 14);
}

function locationLabelClock(angleDeg: number): string {
  const hour = (6 + (((angleDeg % 360) + 360) % 360) / 30) % 12;
  return `${(hour < 1 ? hour + 12 : hour).toFixed(1)}시`;
}

// ---------------------------------------------------------------- region matrix

function regionSection(points: ReturnType<typeof collectPoints>, settings: Settings): HTMLElement {
  const wrap = document.createElement('div');
  const matrix = regionMatrix(points, settings);
  if (matrix.rows.length === 0) {
    wrap.append(empty('불량 위치 데이터가 없습니다.'));
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'dash-table';
  table.innerHTML =
    '<thead><tr><th>불량명</th><th>center</th><th>mid</th><th>edge</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const row of matrix.rows) {
    const tr = document.createElement('tr');
    tr.append(td(DEFECT_NAME[row.defectId as DefectId] ?? row.defectId));
    for (let j = 0; j < 3; j++) {
      const cell = td(`${row.observed[j]}`);
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
  if (matrix.underpowered) {
    foot.textContent = '표본 부족 — 기대도수가 작아 카이제곱 검정 결과를 표시하지 않습니다. 면적 비례 대비 관측만 참고하세요.';
  } else {
    foot.textContent = `면적 비례 귀무가설 대비 χ²=${matrix.chi2.toFixed(1)}, dof=${matrix.dof}, p=${matrix.pValue < 0.001 ? '<0.001' : matrix.pValue.toFixed(3)}. |잔차|>2σ 셀을 강조합니다.`;
  }
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
      cell.style.background = count > 0 ? heatColor(count / (max || 1)) : 'transparent';
      tr.append(cell);
    }
    tbody.append(tr);
  }
  table.append(head, tbody);
  wrap.append(table);
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
    const col = document.createElement('div');
    const h = document.createElement('h4');
    h.textContent = title;
    col.append(h);

    const rows = groupRates(panels, field);
    for (const rate of rows) {
      const row = document.createElement('div');
      row.className = 'dash-bar-row';
      const name = document.createElement('span');
      name.className = 'dash-bar-name';
      // A rate over a handful of panels is greyed, so 1-of-3 is not read as 33%
      // with the authority of 500-of-1500.
      const small = rate.total < 10;
      name.textContent = `${rate.key} (n=${rate.total})`;
      if (small) name.classList.add('dim');
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
      col.append(row);
    }
    const note = document.createElement('p');
    note.className = 'dash-sub';
    note.textContent = `전체 평균 불량률 ${avg.toFixed(1)}% · n<10은 흐리게 표시`;
    col.append(note);
    wrap.append(col);
  }
  return wrap;
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
function caption(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'dash-sub';
  el.textContent = text;
  return el;
}
