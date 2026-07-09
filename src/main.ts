import './styles.css';

import type { Circle, Pattern, Rgba } from './core/types';
import { PATTERNS } from './core/types';
import { groupByFilename, type PanelGroup } from './core/filename';
import { detectActiveCircle, type DetectResult } from './core/preprocess';
import { normalizeFrame } from './core/normalize';
import { formatClock, normalizeAngle } from './core/geometry';
import { renderSyntheticPanel } from './core/synthetic';
import { fileToRgba, paintRgba } from './browser/decode';
import { drawFrameOverlay, drawSourceOverlay } from './browser/overlay';

interface Item {
  readonly id: string;
  readonly name: string;
  readonly rgba: Rgba;
  detect: DetectResult;
  /** Manual override when detection failed or the user adjusted the circle. */
  circle: Circle;
  rotationDeg: number;
  rotationSource: 'auto' | 'manual';
  confirmed: boolean;
}

const items: Item[] = [];
let selected: Item | null = null;
let sampleCount = 0;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 요소를 찾을 수 없습니다.`);
  return el as T;
};

const dropzone = $('dropzone');
const fileInput = $<HTMLInputElement>('file-input');
const panelsEl = $('panels');
const summaryEl = $('summary');
const detailEl = $('detail');
const srcCanvas = $<HTMLCanvasElement>('src-canvas');
const frameCanvas = $<HTMLCanvasElement>('frame-canvas');
const rotationInput = $<HTMLInputElement>('rotation');
const rotationValue = $('rotation-value');
const manualBox = $('manual-circle');
const cxInput = $<HTMLInputElement>('cx');
const cyInput = $<HTMLInputElement>('cy');
const crInput = $<HTMLInputElement>('cr');

// ---------------------------------------------------------------- intake

$('pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files) void addFiles([...fileInput.files]);
  fileInput.value = '';
});

$('sample').addEventListener('click', () => {
  sampleCount++;
  // One click yields a whole panel: four patterns of the same physical capture,
  // so they share circle geometry and tab angle, as real captures would.
  const geometry = {
    tabAngleDeg: Math.round(Math.random() * 3600) / 10,
    cx: 300 + Math.random() * 40,
    cy: 300 + Math.random() * 40,
    r: 215 + Math.random() * 30,
  };
  const code = `P${String(sampleCount).padStart(3, '0')}`;
  for (const [i, pattern] of PATTERNS.entries()) {
    const rgba = renderSyntheticPanel({ ...geometry, pattern, seed: sampleCount * 977 + i });
    addItem(`SAMPLE_${code}_${pattern}.png`, rgba);
  }
  render();
});

for (const type of ['dragenter', 'dragover'] as const) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop'] as const) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
}
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (files?.length) void addFiles([...files]);
});

async function addFiles(files: File[]): Promise<void> {
  for (const file of files) {
    try {
      const rgba = await fileToRgba(file);
      addItem(file.name, rgba);
    } catch (err) {
      console.error(file.name, err);
      alert(`${file.name} 을(를) 읽을 수 없습니다.`);
    }
  }
  render();
}

function addItem(name: string, rgba: Rgba): void {
  const detect = detectActiveCircle(rgba);
  const fallback: Circle = { cx: rgba.width / 2, cy: rgba.height / 2, r: Math.min(rgba.width, rgba.height) * 0.4 };
  const circle = detect.ok ? detect.circle : (detect.circle ?? fallback);

  items.push({
    id: `${name}#${items.length}`,
    name,
    rgba,
    detect,
    circle,
    // Auto rotation is only a suggestion; `confirmed` stays false until the user
    // signs off. See docs/matching_engine.md section 2.2.
    rotationDeg: detect.ok ? detect.fpcb.rotationDeg : 0,
    rotationSource: 'auto',
    confirmed: false,
  });
}

// ---------------------------------------------------------------- rendering

function render(): void {
  const { panels, unparsed } = groupByFilename(items, (it) => it.name);
  renderSummary(panels.length, unparsed.length);

  panelsEl.replaceChildren();
  for (const panel of panels) panelsEl.append(renderPanel(panel));
  if (unparsed.length) panelsEl.append(renderUnparsed(unparsed));
}

function renderSummary(panelCount: number, unparsedCount: number): void {
  if (items.length === 0) {
    summaryEl.hidden = true;
    return;
  }
  summaryEl.hidden = false;

  const failed = items.filter((it) => !it.detect.ok).length;
  const unreliable = items.filter((it) => it.detect.ok && !it.detect.fpcbReliable).length;
  const confirmed = items.filter((it) => it.confirmed).length;

  summaryEl.replaceChildren(
    stat(String(items.length), '이미지'),
    stat(String(panelCount), '패널'),
    stat(`${confirmed}/${items.length}`, '회전각 확정', confirmed < items.length),
    stat(String(failed), '검출 실패', failed > 0),
    stat(String(unreliable), 'FPCB 추정 불확실', unreliable > 0),
    stat(String(unparsedCount), '파일명 파싱 실패', unparsedCount > 0),
  );
}

function stat(value: string, label: string, alert = false): HTMLElement {
  const el = document.createElement('div');
  el.className = alert ? 'stat alert' : 'stat';
  el.innerHTML = `<div class="value"></div><div class="label"></div>`;
  el.querySelector('.value')!.textContent = value;
  el.querySelector('.label')!.textContent = label;
  return el;
}

function renderPanel(panel: PanelGroup<Item>): HTMLElement {
  const el = document.createElement('section');
  el.className = 'panel';

  const head = document.createElement('div');
  head.className = 'panel-head';

  const id = document.createElement('span');
  id.className = 'panel-id';
  id.textContent = `${panel.lotId} / ${panel.panelCode}`;
  head.append(id);

  const present = PATTERNS.filter((p) => panel.images[p]);
  const meta = document.createElement('span');
  meta.className = 'panel-meta';
  meta.textContent = `${present.length}/4 패턴`;
  head.append(meta);

  if (panel.missing.length) head.append(badge(`결손 ${panel.missing.join(', ')}`, 'warn'));
  if (panel.duplicates.length) head.append(badge(`중복 ${panel.duplicates.join(', ')}`, 'danger'));

  const allConfirmed = present.every((p) => panel.images[p]!.confirmed);
  if (allConfirmed && present.length > 0) head.append(badge('회전각 확정', 'ok'));

  el.append(head);

  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  for (const pattern of PATTERNS) {
    const item = panel.images[pattern];
    if (item) tiles.append(renderTile(item, pattern));
  }
  el.append(tiles);
  return el;
}

function renderUnparsed(unparsed: Item[]): HTMLElement {
  const el = document.createElement('section');
  el.className = 'panel';
  const head = document.createElement('div');
  head.className = 'panel-head';
  const id = document.createElement('span');
  id.className = 'panel-id';
  id.textContent = '파일명 파싱 실패';
  head.append(id, badge('수동 그룹핑 필요', 'danger'));
  el.append(head);

  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  for (const item of unparsed) tiles.append(renderTile(item, null));
  el.append(tiles);
  return el;
}

function badge(text: string, kind: 'ok' | 'warn' | 'danger'): HTMLElement {
  const el = document.createElement('span');
  el.className = `badge ${kind}`;
  el.textContent = text;
  return el;
}

function renderTile(item: Item, pattern: Pattern | null): HTMLElement {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.addEventListener('click', () => openDetail(item));

  const canvas = document.createElement('canvas');
  drawThumb(canvas, item);
  tile.append(canvas);

  const foot = document.createElement('div');
  foot.className = 'tile-foot';
  const label = document.createElement('span');
  label.className = 'tile-pattern';
  label.textContent = pattern ?? '?';
  const note = document.createElement('span');
  note.className = 'tile-note';
  note.textContent = tileNote(item);
  foot.append(label, note);
  tile.append(foot);
  return tile;
}

function tileNote(item: Item): string {
  if (!item.detect.ok) return '검출 실패';
  if (item.confirmed) return `확정 ${item.rotationDeg.toFixed(1)}°`;
  if (!item.detect.fpcbReliable) return 'FPCB 불확실';
  return `추정 ${item.rotationDeg.toFixed(1)}°`;
}

const THUMB = 256;

function drawThumb(canvas: HTMLCanvasElement, item: Item): void {
  canvas.width = THUMB;
  canvas.height = THUMB;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const scratch = document.createElement('canvas');
  paintRgba(scratch, item.rgba);

  const scale = THUMB / Math.max(item.rgba.width, item.rgba.height);
  const w = item.rgba.width * scale;
  const h = item.rgba.height * scale;
  ctx.drawImage(scratch, (THUMB - w) / 2, (THUMB - h) / 2, w, h);

  ctx.save();
  ctx.translate((THUMB - w) / 2, (THUMB - h) / 2);
  ctx.scale(scale, scale);
  const tab = item.detect.ok ? normalizeAngle(-item.rotationDeg) : null;
  drawSourceOverlay(ctx, item.circle, tab, item.detect.ok && item.detect.fpcbReliable);
  ctx.restore();
}

// ---------------------------------------------------------------- detail

function openDetail(item: Item): void {
  selected = item;
  detailEl.hidden = false;

  $('detail-title').textContent = item.name;

  const status = $('detail-status');
  status.className = 'detail-status';
  if (!item.detect.ok) {
    status.classList.add('error');
    status.textContent = `검출 실패 (${item.detect.reason}) — ${item.detect.message}`;
  } else if (!item.detect.fpcbReliable) {
    status.classList.add('warn');
    status.textContent = `FPCB 자동 추정이 불확실합니다 (신뢰도 ${item.detect.fpcb.strength.toFixed(
      1,
    )}σ). 회전각을 직접 맞춰 주세요.`;
  } else {
    status.textContent = `원 중심 (${item.circle.cx.toFixed(1)}, ${item.circle.cy.toFixed(
      1,
    )}) · 반지름 ${item.circle.r.toFixed(1)}px · 잔차 ${item.detect.rmsResidual.toFixed(
      2,
    )}px · FPCB 추정 ${formatClock(normalizeAngle(-item.rotationDeg))} 방향`;
  }

  manualBox.hidden = item.detect.ok;
  const maxDim = Math.max(item.rgba.width, item.rgba.height);
  for (const [input, value] of [
    [cxInput, item.circle.cx],
    [cyInput, item.circle.cy],
    [crInput, item.circle.r],
  ] as const) {
    input.max = String(maxDim);
    input.value = String(value);
  }

  rotationInput.value = String(item.rotationDeg);
  redrawDetail();
}

function redrawDetail(): void {
  const item = selected;
  if (!item) return;

  rotationValue.textContent = `${item.rotationDeg.toFixed(1)}°`;

  paintRgba(srcCanvas, item.rgba);
  const srcCtx = srcCanvas.getContext('2d');
  if (srcCtx) {
    // The tab direction implied by the current rotation: rotating the content by
    // `rotationDeg` must land the tab at 6 o'clock, so the tab is at -rotationDeg.
    drawSourceOverlay(srcCtx, item.circle, normalizeAngle(-item.rotationDeg), item.detect.ok && item.detect.fpcbReliable);
  }

  const frame = normalizeFrame(item.rgba, item.circle, item.rotationDeg);
  paintRgba(frameCanvas, frame.image);
  const frameCtx = frameCanvas.getContext('2d');
  if (frameCtx) drawFrameOverlay(frameCtx);
}

rotationInput.addEventListener('input', () => {
  if (!selected) return;
  selected.rotationDeg = normalizeAngle(Number(rotationInput.value));
  selected.rotationSource = 'manual';
  redrawDetail();
});

for (const input of [cxInput, cyInput, crInput]) {
  input.addEventListener('input', () => {
    if (!selected) return;
    selected.circle = { cx: Number(cxInput.value), cy: Number(cyInput.value), r: Math.max(1, Number(crInput.value)) };
    redrawDetail();
  });
}

$('reset-rotation').addEventListener('click', () => {
  if (!selected || !selected.detect.ok) return;
  selected.rotationDeg = selected.detect.fpcb.rotationDeg;
  selected.rotationSource = 'auto';
  rotationInput.value = String(selected.rotationDeg);
  redrawDetail();
});

$('apply-panel').addEventListener('click', () => {
  if (!selected) return;
  const { panels } = groupByFilename(items, (it) => it.name);
  const group = panels.find((p) => PATTERNS.some((pat) => p.images[pat] === selected));
  if (!group) {
    alert('파일명이 파싱되지 않아 패널을 특정할 수 없습니다.');
    return;
  }
  for (const pattern of PATTERNS) {
    const sibling = group.images[pattern];
    if (sibling && sibling !== selected) {
      sibling.rotationDeg = selected.rotationDeg;
      sibling.rotationSource = 'manual';
    }
  }
  render();
});

$('confirm').addEventListener('click', () => {
  if (!selected) return;
  selected.confirmed = true;
  closeDetail();
  render();
});

$('detail-close').addEventListener('click', closeDetail);
detailEl.addEventListener('click', (e) => {
  if (e.target === detailEl) closeDetail();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !detailEl.hidden) closeDetail();
});

function closeDetail(): void {
  detailEl.hidden = true;
  selected = null;
}
