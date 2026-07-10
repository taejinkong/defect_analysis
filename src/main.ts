import './styles.css';

import type { Circle, Pattern, Rgba } from './core/types';
import { PATTERNS } from './core/types';
import { parseFilename } from './core/filename';
import { detectActiveCircle } from './core/preprocess';
import { normalizeFrame } from './core/normalize';
import { formatClock, normalizeAngle } from './core/geometry';
import { addBrightDot, addDarkDot, addLine, blankPanel, polarToSource, renderSyntheticPanel } from './core/synthetic';
import { detectDefects, type ImageDetection } from './core/defects';
import { judgePanel, type PanelVerdict } from './core/verdict';
import { combinePanelFeature, fromBytes, toBytes, FEATURE_VERSION, PANEL_FEATURE_DIM } from './core/features';
import { knnSearch, type SearchEntry } from './core/knn';
import { fuseVerdict, type FusedVerdict } from './core/fusion';
import { DEFECT, DEFECT_NAME, LABELABLE_DEFECTS, type DefectId, type Settings } from './core/settings';
import type { AnnotationRecord, GeomType, ImageRecord, PanelRecord, Purpose, Repository } from './core/records';
import { IndexedDbRepository } from './core/db';
import { buildAnnotation, describeAnnotation, judgeFromLabels, type Shape } from './core/annotations';
import { exportLabels, hasPixels, importLabels } from './core/transfer';
import { fileToRgba, paintRgba, rgbaToBlob } from './browser/decode';
import { drawDetections, drawFrameOverlay, drawSourceOverlay } from './browser/overlay';
import { attachLabeling, drawAnnotations, drawPreview } from './browser/labeling';
import { createSettingsPanel, loadSettings } from './browser/settingsPanel';

// ---------------------------------------------------------------- state

let repo: Repository;
let panels: PanelRecord[] = [];
let images: ImageRecord[] = [];
let annotations: AnnotationRecord[] = [];

/** Decoded pixels, keyed by image id. Blobs are decoded once and kept. */
const pixels = new Map<number, Rgba>();

interface PanelAnalysis {
  readonly rule: PanelVerdict;
  readonly fused: FusedVerdict;
}
const verdicts = new Map<number, PanelAnalysis>();

let settings: Settings = loadSettings();
let verdictsStale = false;
let lastRunNote = '';
let selected: ImageRecord | null = null;
let previewShape: Shape | null = null;
let sampleCount = 0;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 요소를 찾을 수 없습니다.`);
  return el as T;
};

const dropzone = $('dropzone');
const fileInput = $<HTMLInputElement>('file-input');
const importInput = $<HTMLInputElement>('import-input');
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
const toolbar = $('toolbar');
const analyzeNote = $('analyze-note');
const detailDetections = $('detail-detections');
const defectSelect = $<HTMLSelectElement>('label-defect');
const toolSelect = $<HTMLSelectElement>('label-tool');
const labelList = $('label-list');
const settingsMount = $('settings-mount');

const imagesOf = (panelId: number): ImageRecord[] => images.filter((i) => i.panelId === panelId);
const imageOf = (panelId: number, pattern: Pattern): ImageRecord | undefined =>
  images.find((i) => i.panelId === panelId && i.pattern === pattern);
const annotationsOf = (imageId: number): AnnotationRecord[] => annotations.filter((a) => a.imageId === imageId);
const panelOf = (image: ImageRecord): PanelRecord | undefined => panels.find((p) => p.id === image.panelId);
const circleOf = (image: ImageRecord): Circle => ({ cx: image.activeCx, cy: image.activeCy, r: image.activeR });

// ---------------------------------------------------------------- thresholds

const settingsPanel = createSettingsPanel(settings, {
  onChange: (next) => {
    settings = next;
    if (verdicts.size > 0) verdictsStale = true;
    scheduleLivePreview();
  },
  onCommit: () => renderAnalyzeNote(),
});
settingsMount.append(settingsPanel.element);

/**
 * The tuning loop needs the sliders and the preview on screen together, but the
 * detail view is a full-screen modal. Move the one panel element in and out
 * rather than keeping two copies of the sliders in sync.
 */
function moveSettingsPanel(into: HTMLElement): void {
  into.append(settingsPanel.element);
}

let previewPending = false;

/** Coalesce redraws to one per frame; a slider outruns a ~70ms detection pass. */
function scheduleLivePreview(): void {
  if (previewPending || !selected) return;
  previewPending = true;
  requestAnimationFrame(() => {
    previewPending = false;
    if (selected) redrawDetail();
  });
}

// ---------------------------------------------------------------- boot

async function reload(): Promise<void> {
  const [allPanels, allImages, allAnnotations] = await Promise.all([
    repo.listPanels(),
    repo.listImages(),
    repo.listAnnotations(),
  ]);
  panels = allPanels.filter((p) => p.deletedAt === null);
  images = allImages;
  annotations = allAnnotations;

  for (const image of images) {
    if (pixels.has(image.id) || !hasPixels(image)) continue;
    pixels.set(image.id, await fileToRgba(image.originalBlob));
  }
  render();
}

void (async () => {
  try {
    repo = await IndexedDbRepository.open();
    await IndexedDbRepository.requestPersistence();
    await reload();
  } catch (err) {
    console.error(err);
    alert(`저장소를 열 수 없습니다: ${String(err)}`);
  }
})();

// ---------------------------------------------------------------- intake

interface Metadata {
  purpose: Purpose;
  model: string;
  processName: string;
  equipmentId: string;
  user: string;
}

function metadata(): Metadata {
  return {
    purpose: $<HTMLSelectElement>('meta-purpose').value as Purpose,
    model: $<HTMLInputElement>('meta-model').value.trim(),
    processName: $<HTMLInputElement>('meta-process').value.trim(),
    equipmentId: $<HTMLInputElement>('meta-equipment').value.trim(),
    user: $<HTMLInputElement>('meta-user').value.trim(),
  };
}

$('pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files) void addFiles([...fileInput.files]);
  fileInput.value = '';
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
      await addImage(file.name, rgba, file);
    } catch (err) {
      console.error(file.name, err);
      alert(`${file.name} 을(를) 읽을 수 없습니다.`);
    }
  }
  invalidateVerdicts();
  await reload();
}

/**
 * Find or create the panel a filename belongs to, then store the image.
 *
 * A name that does not parse becomes its own single-image panel rather than
 * being dropped: the pixels are never lost, and the panel list shows it for
 * manual attention.
 */
async function addImage(name: string, rgba: Rgba, source?: Blob): Promise<void> {
  const meta = metadata();
  const parsed = parseFilename(name);
  const lotId = parsed?.lotId ?? '미분류';
  const panelCode = parsed?.panelCode ?? name;
  const pattern: Pattern = parsed?.pattern ?? 'W';

  const existing = panels.find(
    (p) => p.lotId === lotId && p.panelCode === panelCode && p.purpose === meta.purpose,
  );

  let panelId: number;
  if (existing) {
    panelId = existing.id;
    if (imageOf(panelId, pattern)) {
      alert(`${lotId}/${panelCode} 의 ${pattern} 패턴이 이미 있습니다. 건너뜁니다.`);
      return;
    }
  } else {
    const record: Omit<PanelRecord, 'id'> = {
      panelCode,
      lotId,
      model: meta.model,
      processName: meta.processName,
      equipmentId: meta.equipmentId,
      purpose: meta.purpose,
      uploadedAt: new Date().toISOString(),
      uploadedBy: meta.user,
      reviewStatus: 'pending',
      deletedAt: null,
    };
    panelId = await repo.addPanel(record);
    // Keep the local list current so the next file in this batch finds the panel
    // instead of creating a duplicate.
    panels.push({ id: panelId, ...record });
  }

  const detect = detectActiveCircle(rgba);
  const fallback: Circle = { cx: rgba.width / 2, cy: rgba.height / 2, r: Math.min(rgba.width, rgba.height) * 0.4 };
  const circle = detect.ok ? detect.circle : (detect.circle ?? fallback);

  const imageId = await repo.addImage({
    panelId,
    pattern,
    originalBlob: source ?? (await rgbaToBlob(rgba)),
    origWidth: rgba.width,
    origHeight: rgba.height,
    activeCx: circle.cx,
    activeCy: circle.cy,
    activeR: circle.r,
    // Auto rotation is a suggestion; `confirmed` stays false until the user
    // signs off. See docs/matching_engine.md section 2.2.
    rotationDeg: detect.ok ? detect.fpcb.rotationDeg : 0,
    rotationSource: 'auto',
    confirmed: false,
    detectOk: detect.ok,
    detectMessage: detect.ok ? '' : detect.message,
    fpcbStrength: detect.ok ? detect.fpcb.strength : 0,
  });
  pixels.set(imageId, rgba);
  images.push({
    id: imageId,
    panelId,
    pattern,
    originalBlob: new Blob(),
    origWidth: rgba.width,
    origHeight: rgba.height,
    activeCx: circle.cx,
    activeCy: circle.cy,
    activeR: circle.r,
    rotationDeg: detect.ok ? detect.fpcb.rotationDeg : 0,
    rotationSource: 'auto',
    confirmed: false,
    detectOk: detect.ok,
    detectMessage: detect.ok ? '' : detect.message,
    fpcbStrength: detect.ok ? detect.fpcb.strength : 0,
  });
}

// ---------------------------------------------------------------- sample data

type Geometry = { cx: number; cy: number; r: number };

/**
 * Defects are painted in *panel* coordinates, then rotated into the capture.
 *
 * "가로줄" means horizontal with respect to the panel's pixel grid, which is only
 * horizontal on screen once FPCB sits at 6 o'clock. A capture whose tab is at
 * angle T shows every panel-fixed feature rotated by T.
 */
interface Scenario {
  readonly name: string;
  readonly paint: (img: Rgba, g: Geometry, tabAngleDeg: number) => void;
}

const place = (g: Geometry, rRatio: number, panelAngleDeg: number, tab: number): { x: number; y: number } =>
  polarToSource(g, rRatio, panelAngleDeg + tab);

const SCENARIOS: readonly Scenario[] = [
  { name: '양품', paint: () => {} },
  {
    name: '암점 小',
    paint: (img, g, tab) => {
      const p = place(g, 0.62, 128, tab);
      addDarkDot(img, p.x, p.y, g.r * 0.05);
    },
  },
  { name: '암점 中', paint: (img, g) => addDarkDot(img, g.cx, g.cy, g.r * 0.3) },
  {
    name: '암점 大',
    paint: (img, g, tab) => {
      const p = place(g, 0.25, 300, tab);
      addDarkDot(img, p.x, p.y, g.r * 0.45);
    },
  },
  {
    name: '명점',
    paint: (img, g, tab) => {
      const p = place(g, 0.4, 45, tab);
      addBrightDot(img, p.x, p.y, g.r * 0.03, 255);
    },
  },
  {
    name: '명선_가로줄',
    paint: (img, g, tab) => {
      const p = place(g, 0.3, 180, tab);
      addLine(img, p.x, p.y, g.r * 1.3, 3, tab, 255);
    },
  },
  {
    name: '암선_세로줄',
    paint: (img, g, tab) => {
      const p = place(g, 0.2, 270, tab);
      addLine(img, p.x, p.y, g.r * 1.3, 3, 90 + tab, 6);
    },
  },
  {
    name: '복수불량',
    paint: (img, g, tab) => {
      const dot = place(g, 0.6, 210, tab);
      addDarkDot(img, dot.x, dot.y, g.r * 0.05);
      const line = place(g, 0.35, 180, tab);
      addLine(img, line.x, line.y, g.r * 1.2, 3, tab, 255);
    },
  },
  {
    // Partial rather than total: a totally unlit capture has no circle to find.
    name: '미점등 (부분)',
    paint: (img, g) => blankPanel(img, g.cx, g.cy, g.r * 0.85, 5),
  },
];

$('sample').addEventListener('click', () => {
  void (async () => {
    sampleCount++;
    const geometry: Geometry = {
      cx: 300 + Math.random() * 40,
      cy: 300 + Math.random() * 40,
      r: 215 + Math.random() * 30,
    };
    const tabAngleDeg = Math.round(Math.random() * 3600) / 10;
    const scenario = SCENARIOS[(sampleCount - 1) % SCENARIOS.length]!;
    // Panel codes must be unique across reloads, or a fresh sample collides with
    // a stored panel of the same name.
    const code = `P${Date.now().toString(36).slice(-5).toUpperCase()}`;

    for (const [i, pattern] of PATTERNS.entries()) {
      const rgba = renderSyntheticPanel({ ...geometry, tabAngleDeg, pattern, seed: sampleCount * 977 + i });
      scenario.paint(rgba, geometry, tabAngleDeg);
      await addImage(`SAMPLE_${code}_${pattern}.png`, rgba);
    }
    invalidateVerdicts();
    await reload();
  })();
});

// ---------------------------------------------------------------- analysis

function invalidateVerdicts(): void {
  verdicts.clear();
  verdictsStale = false;
  lastRunNote = '';
}

function analyzeImage(
  image: ImageRecord,
  circle: Circle,
  rotationDeg: number,
  withFeature: boolean,
): ImageDetection | null {
  const rgba = pixels.get(image.id);
  if (!rgba) return null;
  const frame = normalizeFrame(rgba, circle, rotationDeg);
  return detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, image.pattern, settings, {
    withFeature,
  });
}

/**
 * Detect every pattern of a panel once, returning both the per-image detections
 * (for the Rule verdict) and the combined feature vector (for kNN). One pass, so
 * the expensive background fit is not repeated.
 */
function analyzePanel(panelId: number): { detections: ImageDetection[]; feature: Float32Array | null; skipped: number } {
  const panelImages = imagesOf(panelId);
  // An unlit image has no circle of its own, which is exactly the image where
  // 미점등 must be found. Borrow geometry from a sibling of the same capture.
  const reference = panelImages.find((i) => i.detectOk && pixels.has(i.id));
  if (!reference) return { detections: [], feature: null, skipped: panelImages.length };

  const detections: ImageDetection[] = [];
  const byPattern: Partial<Record<Pattern, Float32Array>> = {};
  let skipped = 0;
  for (const image of panelImages) {
    const source = image.detectOk ? image : reference;
    const detection = analyzeImage(image, circleOf(source), source.rotationDeg, true);
    if (detection) {
      detections.push(detection);
      if (detection.feature) byPattern[image.pattern] = detection.feature;
    } else {
      skipped++;
    }
  }
  const feature = detections.length > 0 ? combinePanelFeature(byPattern) : null;
  return { detections, feature, skipped };
}

/** Approved training panels, loaded as kNN search candidates. */
async function loadSearchCandidates(): Promise<SearchEntry[]> {
  const embeddings = await repo.listEmbeddings();
  return embeddings
    .filter((e) => e.isSearchable && e.featureVersion === FEATURE_VERSION && e.dim === PANEL_FEATURE_DIM)
    .map((e) => ({ panelId: e.panelId, labelDefectId: e.labelDefectId, vector: fromBytes(e.vector) }));
}

$('analyze').addEventListener('click', () => {
  void (async () => {
    verdicts.clear();
    const candidates = await loadSearchCandidates();
    const started = performance.now();
    let skipped = 0;

    for (const panel of panels) {
      const { detections, feature, skipped: panelSkipped } = analyzePanel(panel.id);
      skipped += panelSkipped;
      if (detections.length === 0) continue;

      const rule = judgePanel(detections, settings);
      // A panel cannot match itself: exclude its own training embedding from the
      // candidate set, or an already-approved panel would trivially vote for its
      // own label at similarity 1.
      const others = candidates.filter((c) => c.panelId !== panel.id);
      const knn = feature ? knnSearch(feature, others, settings) : { status: 'insufficient-data' as const, candidateCount: others.length };
      verdicts.set(panel.id, { rule, fused: fuseVerdict(rule, knn) });
    }

    verdictsStale = false;
    lastRunNote = `${verdicts.size}개 패널 분석 완료 · ${(performance.now() - started).toFixed(0)}ms · 학습 ${candidates.length}개`;
    if (skipped > 0) lastRunNote += ` · ${skipped}장 제외 (원 검출 실패 또는 이미지 없음)`;
    render();
  })();
});

// ---------------------------------------------------------------- transfer

$('export').addEventListener('click', () => {
  void (async () => {
    const file = await exportLabels(repo);
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `defect-labels-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  })();
});

$('import').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', () => {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (!file) return;

  void (async () => {
    try {
      const result = await importLabels(repo, JSON.parse(await file.text()));
      invalidateVerdicts();
      await reload();
      const lines = [
        `패널 ${result.panels}개, 이미지 ${result.images}개, 라벨 ${result.annotations}개를 가져왔습니다.`,
        '이미지 픽셀은 포함되지 않으므로 가져온 패널은 재분석할 수 없습니다.',
      ];
      if (result.warnings.length > 0) lines.push('', ...result.warnings.slice(0, 8));
      alert(lines.join('\n'));
    } catch (err) {
      alert(`가져오기 실패: ${String(err)}`);
    }
  })();
});

$('wipe').addEventListener('click', () => {
  if (!confirm('저장된 패널, 이미지, 라벨을 모두 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
  void (async () => {
    await repo.clear();
    pixels.clear();
    invalidateVerdicts();
    await reload();
  })();
});

// ---------------------------------------------------------------- rendering

function render(): void {
  renderSummary();
  toolbar.hidden = panels.length === 0;
  renderAnalyzeNote();

  panelsEl.replaceChildren();
  const sorted = [...panels].sort(
    (a, b) =>
      a.purpose.localeCompare(b.purpose) ||
      a.lotId.localeCompare(b.lotId) ||
      a.panelCode.localeCompare(b.panelCode),
  );
  for (const panel of sorted) panelsEl.append(renderPanel(panel));
}

function renderSummary(): void {
  if (panels.length === 0) {
    summaryEl.hidden = true;
    return;
  }
  summaryEl.hidden = false;

  const training = panels.filter((p) => p.purpose === 'training').length;
  const approved = panels.filter((p) => p.reviewStatus === 'approved').length;
  const failed = images.filter((i) => !i.detectOk).length;
  const confirmed = images.filter((i) => i.confirmed).length;

  summaryEl.replaceChildren(
    stat(String(images.length), '이미지'),
    stat(`${training}/${panels.length}`, '학습용 패널'),
    stat(String(annotations.length), '수동 라벨'),
    stat(`${approved}/${panels.length}`, '승인됨', approved < panels.length),
    stat(`${confirmed}/${images.length}`, '회전각 확정', confirmed < images.length),
    stat(String(failed), '검출 실패', failed > 0),
  );
}

function stat(value: string, label: string, alert = false): HTMLElement {
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

function renderAnalyzeNote(): void {
  analyzeNote.replaceChildren();
  if (verdictsStale) {
    const warn = document.createElement('span');
    warn.className = 'stale';
    warn.textContent = '임계값 또는 기하가 바뀌었습니다 — 재분석이 필요합니다.';
    analyzeNote.append(warn);
    return;
  }
  if (lastRunNote) {
    analyzeNote.textContent = lastRunNote;
    return;
  }
  const unconfirmed = images.filter((i) => i.detectOk && !i.confirmed).length;
  analyzeNote.textContent =
    unconfirmed > 0 ? `회전각 미확정 ${unconfirmed}건 — 자동 추정값으로 분석됩니다.` : '';
}

function renderPanel(panel: PanelRecord): HTMLElement {
  const el = document.createElement('section');
  el.className = 'panel';

  const head = document.createElement('div');
  head.className = 'panel-head';

  const id = document.createElement('span');
  id.className = 'panel-id';
  id.textContent = `${panel.lotId} / ${panel.panelCode}`;
  head.append(id, badge(panel.purpose === 'training' ? '학습용' : '분석용', panel.purpose === 'training' ? 'ok' : 'info'));

  const panelImages = imagesOf(panel.id);
  const meta = document.createElement('span');
  meta.className = 'panel-meta';
  meta.textContent = [`${panelImages.length}/4 패턴`, panel.model, panel.processName, panel.equipmentId]
    .filter(Boolean)
    .join(' · ');
  head.append(meta);

  const missing = PATTERNS.filter((p) => !imageOf(panel.id, p));
  if (missing.length) head.append(badge(`결손 ${missing.join(', ')}`, 'warn'));
  if (panelImages.length > 0 && panelImages.every((i) => i.confirmed)) head.append(badge('회전각 확정', 'ok'));
  if (panel.reviewStatus === 'approved') head.append(badge('승인됨', 'ok'));
  if (panelImages.length > 0 && !panelImages.some(hasPixels)) head.append(badge('이미지 없음', 'warn'));

  head.append(spacer(), approveButton(panel), deleteButton(panel));
  el.append(head);

  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  for (const pattern of PATTERNS) {
    const image = imageOf(panel.id, pattern);
    if (image) tiles.append(renderTile(image));
  }
  el.append(tiles);

  const labels = panelImages.flatMap((i) => annotationsOf(i.id));
  if (labels.length > 0) el.append(renderLabelSummary(labels));

  const analysis = verdicts.get(panel.id);
  if (analysis) el.append(renderVerdict(analysis));
  return el;
}

function spacer(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'spacer';
  return el;
}

function approveButton(panel: PanelRecord): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost small';
  btn.textContent = panel.reviewStatus === 'approved' ? '승인 취소' : '승인';
  btn.addEventListener('click', () => {
    void (async () => {
      const next = panel.reviewStatus === 'approved' ? 'pending' : 'approved';
      await repo.updatePanel(panel.id, { reviewStatus: next });
      // Approving a panel approves its labels; that is what "승인된 라벨만
      // 학습 DB에 반영" in docs/PRD.md means in practice.
      for (const image of imagesOf(panel.id)) {
        for (const annotation of annotationsOf(image.id)) {
          await repo.updateAnnotation(annotation.id, { reviewStatus: next });
        }
      }

      if (next === 'approved') {
        await storeEmbedding(panel.id);
      } else {
        // Unapproving pulls the panel out of the search set immediately.
        await repo.deleteEmbeddingsByPanel(panel.id);
      }
      if (verdicts.size > 0) verdictsStale = true;
      await reload();
    })();
  });
  return btn;
}

/**
 * Compute and store the panel's search embedding.
 *
 * The vote label comes from the reviewer's own manual labels, not from Rule
 * detection: an approved panel is a human-verified example, and its hand-placed
 * labels are the ground truth kNN should learn. A panel with no labels is a
 * verified 양품 example, which is just as useful for confirming good panels.
 */
async function storeEmbedding(panelId: number): Promise<void> {
  const { feature } = analyzePanel(panelId);
  if (!feature) return; // no usable image; nothing to learn from

  const labels = imagesOf(panelId).flatMap((i) => annotationsOf(i.id));
  await repo.putEmbedding({
    panelId,
    vector: toBytes(feature),
    dim: PANEL_FEATURE_DIM,
    labelDefectId: judgeFromLabels(labels.map((l) => l.defectId)),
    isSearchable: true,
    featureVersion: FEATURE_VERSION,
    createdAt: new Date().toISOString(),
  });
}

function deleteButton(panel: PanelRecord): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost small';
  btn.textContent = '삭제';
  btn.addEventListener('click', () => {
    if (!confirm(`${panel.lotId}/${panel.panelCode} 패널과 라벨을 삭제할까요?`)) return;
    void (async () => {
      for (const image of imagesOf(panel.id)) pixels.delete(image.id);
      await repo.deletePanel(panel.id);
      verdicts.delete(panel.id);
      await reload();
    })();
  });
  return btn;
}

function renderLabelSummary(labels: AnnotationRecord[]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'verdict';

  const line = document.createElement('div');
  line.className = 'verdict-line';

  const caption = document.createElement('span');
  caption.className = 'label-caption';
  caption.textContent = '수동 라벨';
  line.append(caption);

  const judgement = judgeFromLabels(labels.map((l) => l.defectId));
  const name = document.createElement('span');
  name.className = `judgement ${judgement === DEFECT.GOOD ? 'good' : 'bad'}`;
  name.textContent = DEFECT_NAME[judgement];
  line.append(name);

  const counts = new Map<DefectId, number>();
  for (const label of labels) counts.set(label.defectId, (counts.get(label.defectId) ?? 0) + 1);
  for (const [defectId, count] of counts) line.append(badge(`${DEFECT_NAME[defectId]} ×${count}`, 'info'));

  box.append(line);
  return box;
}

function badge(text: string, kind: 'ok' | 'warn' | 'danger' | 'info'): HTMLElement {
  const el = document.createElement('span');
  el.className = `badge ${kind}`;
  el.textContent = text;
  return el;
}

function renderVerdict(analysis: PanelAnalysis): HTMLElement {
  const { rule, fused } = analysis;
  const box = document.createElement('div');
  box.className = 'verdict';

  const line = document.createElement('div');
  line.className = 'verdict-line';

  const caption = document.createElement('span');
  caption.className = 'label-caption';
  caption.textContent = 'AI 판정';
  line.append(caption);

  const good = fused.finalJudgementId === DEFECT.GOOD;
  const judgement = document.createElement('span');
  judgement.className = `judgement ${good ? 'good' : 'bad'}`;
  judgement.textContent = DEFECT_NAME[fused.finalJudgementId];
  line.append(judgement);

  if (!good) for (const id of rule.detectedDefectIds) line.append(badge(DEFECT_NAME[id], 'warn'));
  line.append(badge(`신뢰도 ${fused.confidence.toFixed(2)}`, fused.confidence < 0.6 ? 'warn' : 'ok'));
  if (fused.needsReview) line.append(badge('검수 필요', 'danger'));
  if (rule.suppressed.length > 0) line.append(badge('단일 패턴 검출', 'warn'));
  if (rule.drivingFlag) line.append(badge('구동불량 의심', 'warn'));
  if (fused.neighbors.length > 0) line.append(badge(`kNN 이웃 ${fused.neighbors.length}`, 'info'));
  box.append(line);

  const reason = document.createElement('p');
  reason.className = 'reason';
  reason.textContent = fused.decisionReason;
  box.append(reason);
  return box;
}

function renderTile(image: ImageRecord): HTMLElement {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.addEventListener('click', () => openDetail(image));

  const canvas = document.createElement('canvas');
  drawThumb(canvas, image);
  tile.append(canvas);

  const foot = document.createElement('div');
  foot.className = 'tile-foot';
  const label = document.createElement('span');
  label.className = 'tile-pattern';
  label.textContent = image.pattern;
  const note = document.createElement('span');
  note.className = 'tile-note';
  note.textContent = tileNote(image);
  foot.append(label, note);
  tile.append(foot);
  return tile;
}

function tileNote(image: ImageRecord): string {
  const labels = annotationsOf(image.id).length;
  if (labels > 0) return `라벨 ${labels}개`;
  if (!pixels.has(image.id)) return '이미지 없음';
  if (!image.detectOk) return '검출 실패';
  if (image.confirmed) return `확정 ${image.rotationDeg.toFixed(1)}°`;
  if (image.fpcbStrength < 3) return 'FPCB 불확실';
  return `추정 ${image.rotationDeg.toFixed(1)}°`;
}

const THUMB = 256;

function drawThumb(canvas: HTMLCanvasElement, image: ImageRecord): void {
  canvas.width = THUMB;
  canvas.height = THUMB;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rgba = pixels.get(image.id);
  if (!rgba) {
    ctx.fillStyle = '#1f2532';
    ctx.fillRect(0, 0, THUMB, THUMB);
    ctx.fillStyle = '#97a0b3';
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('이미지 없음', THUMB / 2, THUMB / 2);
    return;
  }

  const scratch = document.createElement('canvas');
  paintRgba(scratch, rgba);
  const scale = THUMB / Math.max(rgba.width, rgba.height);
  const w = rgba.width * scale;
  const h = rgba.height * scale;
  ctx.drawImage(scratch, (THUMB - w) / 2, (THUMB - h) / 2, w, h);

  ctx.save();
  ctx.translate((THUMB - w) / 2, (THUMB - h) / 2);
  ctx.scale(scale, scale);
  drawSourceOverlay(
    ctx,
    circleOf(image),
    image.detectOk ? normalizeAngle(-image.rotationDeg) : null,
    image.fpcbStrength >= 3,
  );
  ctx.restore();
}

// ---------------------------------------------------------------- labeling

for (const defectId of LABELABLE_DEFECTS) {
  const option = document.createElement('option');
  option.value = defectId;
  option.textContent = `${DEFECT_NAME[defectId]} (${defectId})`;
  defectSelect.append(option);
}

attachLabeling(frameCanvas, {
  getTool: () => toolSelect.value as GeomType,
  onPreview: (shape) => {
    previewShape = shape;
    redrawDetail();
  },
  onShape: (shape) => {
    if (!selected) return;
    const image = selected;
    void (async () => {
      await repo.addAnnotation(buildAnnotation(shape, defectSelect.value as DefectId, image.id, new Date(), settings));
      annotations = await repo.listAnnotations();
      renderLabelList();
      redrawDetail();
      render();
    })();
  },
});

function renderLabelList(): void {
  labelList.replaceChildren();
  if (!selected) return;

  const list = annotationsOf(selected.id);
  if (list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'label-empty';
    empty.textContent = '라벨 없음';
    labelList.append(empty);
    return;
  }

  for (const annotation of list) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = describeAnnotation(annotation) + (annotation.reviewStatus === 'approved' ? ' ✓' : '');

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost small';
    remove.textContent = '삭제';
    remove.addEventListener('click', () => {
      void (async () => {
        await repo.deleteAnnotation(annotation.id);
        annotations = await repo.listAnnotations();
        renderLabelList();
        redrawDetail();
        render();
      })();
    });

    li.append(text, remove);
    labelList.append(li);
  }
}

// ---------------------------------------------------------------- detail

function openDetail(image: ImageRecord): void {
  selected = image;
  previewShape = null;
  detailEl.hidden = false;
  moveSettingsPanel($('detail-settings'));

  const panel = panelOf(image);
  $('detail-title').textContent = `${panel?.lotId ?? ''} / ${panel?.panelCode ?? ''} · ${image.pattern}`;

  const status = $('detail-status');
  status.className = 'detail-status';
  if (!pixels.has(image.id)) {
    status.classList.add('warn');
    status.textContent = '가져온 라벨입니다. 이미지 픽셀이 없어 검출과 미리보기를 할 수 없습니다.';
  } else if (!image.detectOk) {
    status.classList.add('error');
    status.textContent = `검출 실패 — ${image.detectMessage}`;
  } else if (image.fpcbStrength < 3) {
    status.classList.add('warn');
    status.textContent = `FPCB 자동 추정이 불확실합니다 (신뢰도 ${image.fpcbStrength.toFixed(1)}σ). 회전각을 직접 맞춰 주세요.`;
  } else {
    status.textContent = `원 중심 (${image.activeCx.toFixed(1)}, ${image.activeCy.toFixed(1)}) · 반지름 ${image.activeR.toFixed(1)}px · FPCB 추정 ${formatClock(normalizeAngle(-image.rotationDeg))} 방향`;
  }

  manualBox.hidden = image.detectOk;
  const maxDim = Math.max(image.origWidth, image.origHeight, 1);
  for (const [input, value] of [
    [cxInput, image.activeCx],
    [cyInput, image.activeCy],
    [crInput, image.activeR],
  ] as const) {
    input.max = String(maxDim);
    input.value = String(value);
  }

  rotationInput.value = String(image.rotationDeg);
  renderLabelList();
  redrawDetail();
}

function redrawDetail(): void {
  const image = selected;
  if (!image) return;

  rotationValue.textContent = `${image.rotationDeg.toFixed(1)}°`;

  const rgba = pixels.get(image.id);
  if (!rgba) {
    for (const canvas of [srcCanvas, frameCanvas]) {
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#0d1017';
        ctx.fillRect(0, 0, 512, 512);
      }
    }
    detailDetections.textContent = '이미지 픽셀이 없습니다.';
    return;
  }

  paintRgba(srcCanvas, rgba);
  const srcCtx = srcCanvas.getContext('2d');
  if (srcCtx) {
    // The tab direction implied by the current rotation: rotating the content by
    // `rotationDeg` lands the tab at 6 o'clock, so the tab is at -rotationDeg.
    drawSourceOverlay(srcCtx, circleOf(image), normalizeAngle(-image.rotationDeg), image.fpcbStrength >= 3);
  }

  // An unlit image has no circle of its own; borrow a sibling's, as analysis does.
  const reference = image.detectOk ? image : (imagesOf(image.panelId).find((i) => i.detectOk) ?? image);
  const frame = normalizeFrame(rgba, circleOf(reference), reference.rotationDeg);

  paintRgba(frameCanvas, frame.image);
  const ctx = frameCanvas.getContext('2d');
  if (!ctx) return;
  drawFrameOverlay(ctx);

  const detection = detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, image.pattern, settings);
  const analysis = verdictsStale ? undefined : verdicts.get(image.panelId);
  const suppressed = new Set(analysis?.rule.suppressed ?? []);
  drawDetections(
    ctx,
    detection.detections.map((d) => ({ x: d.x, y: d.y, bbox: d.bbox, counted: !suppressed.has(d.kind) })),
  );

  drawAnnotations(ctx, annotationsOf(image.id));
  if (previewShape) drawPreview(ctx, previewShape);

  detailDetections.textContent = describeDetection(detection);
}

function describeDetection(detection: ImageDetection): string {
  if (detection.noDisplay !== 'none') {
    const label = detection.noDisplay === 'full' ? '전체 미점등' : '부분 미점등';
    return `${label} · 평균 휘도 ${detection.meanLuma.toFixed(1)}`;
  }
  const counts = new Map<string, number>();
  for (const d of detection.detections) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);

  const parts = [`dark_area_ratio ${detection.darkAreaPct.toFixed(2)}%`];
  parts.push(counts.size > 0 ? [...counts].map(([k, n]) => `${k} ×${n}`).join(', ') : '검출 없음');
  if (detection.drivingFlag) parts.push('구동불량 의심');
  return parts.join(' · ');
}

// ---------------------------------------------------------------- geometry edits

async function patchSelected(patch: Partial<ImageRecord>): Promise<void> {
  if (!selected) return;
  Object.assign(selected, patch);
  await repo.updateImage(selected.id, patch);
  if (verdicts.size > 0) verdictsStale = true;
}

rotationInput.addEventListener('input', () => {
  if (!selected) return;
  selected.rotationDeg = normalizeAngle(Number(rotationInput.value));
  selected.rotationSource = 'manual';
  redrawDetail();
});
rotationInput.addEventListener('change', () => {
  void patchSelected({ rotationDeg: normalizeAngle(Number(rotationInput.value)), rotationSource: 'manual' });
});

for (const input of [cxInput, cyInput, crInput]) {
  input.addEventListener('input', () => {
    if (!selected) return;
    selected.activeCx = Number(cxInput.value);
    selected.activeCy = Number(cyInput.value);
    selected.activeR = Math.max(1, Number(crInput.value));
    redrawDetail();
  });
  input.addEventListener('change', () => {
    // A hand-placed circle is as good as a detected one for everything downstream.
    void patchSelected({
      activeCx: Number(cxInput.value),
      activeCy: Number(cyInput.value),
      activeR: Math.max(1, Number(crInput.value)),
      detectOk: true,
      detectMessage: '',
    });
  });
}

$('reset-rotation').addEventListener('click', () => {
  const image = selected;
  if (!image) return;
  const rgba = pixels.get(image.id);
  if (!rgba) return;
  const detect = detectActiveCircle(rgba);
  if (!detect.ok) return;
  rotationInput.value = String(detect.fpcb.rotationDeg);
  void patchSelected({ rotationDeg: detect.fpcb.rotationDeg, rotationSource: 'auto' }).then(() => redrawDetail());
});

$('apply-panel').addEventListener('click', () => {
  const source = selected;
  if (!source) return;
  void (async () => {
    for (const sibling of imagesOf(source.panelId)) {
      if (sibling.id === source.id) continue;
      sibling.rotationDeg = source.rotationDeg;
      sibling.rotationSource = 'manual';
      await repo.updateImage(sibling.id, { rotationDeg: source.rotationDeg, rotationSource: 'manual' });
    }
    if (verdicts.size > 0) verdictsStale = true;
    render();
  })();
});

$('confirm').addEventListener('click', () => {
  void patchSelected({ confirmed: true }).then(() => closeDetail());
});

$('detail-close').addEventListener('click', closeDetail);
detailEl.addEventListener('click', (e) => {
  if (e.target === detailEl) closeDetail();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !detailEl.hidden) closeDetail();
});

function closeDetail(): void {
  moveSettingsPanel(settingsMount);
  detailEl.hidden = true;
  selected = null;
  previewShape = null;
  render();
}
