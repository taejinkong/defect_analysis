import './styles.css';

import type { Circle, Pattern, Rgba } from './core/types';
import { FRAME_CENTER, FRAME_RADIUS, PATTERNS } from './core/types';
import { parseFilename } from './core/filename';
import { detectActiveCircle } from './core/preprocess';
import { normalizeFrame, normalizeLineFrame } from './core/normalize';
import { formatClock, normalizeAngle } from './core/geometry';
import { addBrightDot, addDarkDot, addLine, blankPanel, polarToSource, renderSyntheticPanel } from './core/synthetic';
import { detectDefects, type ImageDetection } from './core/defects';
import { judgePanel, type PanelVerdict } from './core/verdict';
import { combinePanelFeature, fromBytes, toBytes, FEATURE_VERSION, PANEL_FEATURE_DIM } from './core/features';
import { knnSearch, type KnnOutcome, type SearchEntry } from './core/knn';
import { fuseVerdict, type FusedVerdict } from './core/fusion';
import {
  DEFECT,
  DEFECT_NAME,
  LABELABLE_DEFECTS,
  isDarkDotDefect,
  type DefectId,
  type Settings,
} from './core/settings';
import type {
  AnnotationRecord,
  GeomType,
  ImageRecord,
  NewDetectionResult,
  DetectionResultRecord,
  PanelDecisionRecord,
  PanelRecord,
  PreprocessingResultRecord,
  Purpose,
  Repository,
  ReviewRecord,
  UserRole,
} from './core/records';
import { IndexedDbRepository } from './core/db';
import {
  buildAnnotation,
  describeAnnotation,
  encodeMaskRle,
  judgeFromLabels,
  manualDarkGrade,
  type ManualDarkGrade,
  type Shape,
} from './core/annotations';
import { exportLabels, hasPixels, importLabels } from './core/transfer';
import { fileToRgba, paintRgba, rgbaToBlob } from './browser/decode';
import { drawDetections, drawFrameOverlay, drawSourceOverlay } from './browser/overlay';
import { attachLabeling, drawAnnotations, drawPreview } from './browser/labeling';
import { createSettingsPanel, loadThresholdConfig } from './browser/settingsPanel';
import { createInspectionProfilePanel, loadInspectionProfile } from './browser/inspectionProfilePanel';
import { renderDashboard } from './browser/dashboardView';
import type { DashboardPanel, DashboardPoint } from './core/dashboard';
import { thresholdConfigToSettings } from './core/thresholdConfig';
import {
  evaluatePreprocessingQuality,
  type PreprocessingQuality,
} from './core/preprocessingQuality';
import { DETECTOR_VERSION } from './core/detectors';
import { REVIEW_REASON_NAME } from './core/review';
import {
  profileReadyForAutomaticNoDisplay,
  profileWarnings,
  type InspectionProfile,
} from './core/inspectionProfile';

// ---------------------------------------------------------------- state

let repo: Repository;
let panels: PanelRecord[] = [];
let images: ImageRecord[] = [];
let annotations: AnnotationRecord[] = [];
let preprocessingResults: PreprocessingResultRecord[] = [];
let panelDecisions: PanelDecisionRecord[] = [];
let detectionResults: DetectionResultRecord[] = [];
let reviews: ReviewRecord[] = [];

/** Decoded pixels, keyed by image id. Blobs are decoded once and kept. */
const pixels = new Map<number, Rgba>();

interface PanelAnalysis {
  readonly rule: PanelVerdict;
  readonly fused: FusedVerdict;
  readonly images: ImageDetection[];
  readonly qualityByImage: ReadonlyMap<number, PreprocessingQuality>;
}
const verdicts = new Map<number, PanelAnalysis>();

const initialThresholdConfig = loadThresholdConfig();
let inspectionProfile: InspectionProfile = loadInspectionProfile();
let settings: Settings = thresholdConfigToSettings(initialThresholdConfig);
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
const darkResidualCanvas = $<HTMLCanvasElement>('dark-residual-canvas');
const brightResidualCanvas = $<HTMLCanvasElement>('bright-residual-canvas');
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
const roleSelect = $<HTMLSelectElement>('user-role');
const mapPattern = $<HTMLSelectElement>('map-pattern');
const mapPanel = $<HTMLSelectElement>('map-panel');

let currentRole = (localStorage.getItem('defect-analysis.role') as UserRole | null) ?? 'admin';
if (!['admin', 'reviewer', 'viewer'].includes(currentRole)) currentRole = 'admin';
roleSelect.value = currentRole;

// ---------------------------------------------------------------- routing

/**
 * Hash-routed screens, one per sidebar tab (jejutrip 참고 앱과 같은 방식).
 *
 * Each functional area is its own full screen instead of a section on one long
 * scrolling page, and the URL (#/panels …) survives reload and back/forward.
 */
const VIEWS = ['intake', 'status', 'panels', 'review', 'dashboard', 'settings'] as const;
type View = (typeof VIEWS)[number];

function parseRoute(): View {
  const token = location.hash.replace(/^#\/?/, '');
  return (VIEWS as readonly string[]).includes(token) ? (token as View) : 'intake';
}

function showView(view: View): void {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const n of document.querySelectorAll<HTMLButtonElement>('.app-nav-item[data-view]')) {
    n.classList.toggle('on', n.dataset.view === view);
  }
  // The dashboard aggregates whatever verdicts exist right now, so rebuild it
  // on every entry rather than caching a stale render.
  if (view === 'dashboard') refreshDashboard();
  if (view === 'review') renderReviewQueue();
  if (view === 'settings') {
    const details = settingsMount.querySelector('details');
    if (details) details.open = true;
  }
}

function navigate(view: View): void {
  if (parseRoute() === view) showView(view);
  else location.hash = `#/${view}`;
}

for (const item of document.querySelectorAll<HTMLButtonElement>('.app-nav-item[data-view]')) {
  item.addEventListener('click', () => navigate(item.dataset.view as View));
}
window.addEventListener('hashchange', () => showView(parseRoute()));

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
  onCommit: () => {
    renderAnalyzeNote();
    if (repo) void syncAllManualDarkGrades();
    if (repo) void persistActiveThresholdConfig();
  },
}, initialThresholdConfig);
const inspectionProfilePanel = createInspectionProfilePanel(inspectionProfile, (next) => {
  inspectionProfile = next;
  if (verdicts.size > 0) verdictsStale = true;
  renderAnalyzeNote();
});
settingsMount.append(inspectionProfilePanel.element, settingsPanel.element);

roleSelect.addEventListener('change', () => {
  currentRole = roleSelect.value as UserRole;
  localStorage.setItem('defect-analysis.role', currentRole);
  applyRolePermissions();
  render();
  if (parseRoute() === 'review') renderReviewQueue();
});

function applyRolePermissions(): void {
  const viewer = currentRole === 'viewer';
  const admin = currentRole === 'admin';
  for (const id of ['pick', 'sample', 'analyze', 'approve-all', 'wipe', 'import']) {
    $<HTMLButtonElement>(id).disabled = viewer || (id === 'wipe' && !admin);
  }
  defectSelect.disabled = viewer;
  toolSelect.disabled = viewer;
  mapPattern.disabled = viewer;
  mapPanel.disabled = viewer;
  $<HTMLButtonElement>('apply-mapping').disabled = viewer;
  $<HTMLButtonElement>('undo-mapping').disabled = viewer;
  const settingsNav = document.querySelector<HTMLButtonElement>('.app-nav-item[data-view="settings"]');
  if (settingsNav) settingsNav.hidden = !admin;
  settingsPanel.element.toggleAttribute('hidden', !admin);
  inspectionProfilePanel.element.toggleAttribute('hidden', !admin);
  if (!admin && parseRoute() === 'settings') navigate('panels');
}

applyRolePermissions();

// Initial route, after the settings panel exists so a #/settings deep link
// lands with the panel expanded.
showView(parseRoute());

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
  const [allPanels, allImages, allAnnotations, allPreprocessing, allDetections, allDecisions, allReviews] = await Promise.all([
    repo.listPanels(),
    repo.listImages(),
    repo.listAnnotations(),
    repo.listPreprocessingResults(),
    repo.listDetectionResults(),
    repo.listPanelDecisions(),
    repo.listReviews(),
  ]);
  panels = allPanels.filter((p) => p.deletedAt === null);
  images = allImages;
  annotations = allAnnotations;
  preprocessingResults = allPreprocessing;
  detectionResults = allDetections;
  panelDecisions = allDecisions;
  reviews = allReviews;

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
    await persistActiveThresholdConfig();
    // Migrate box labels made by older builds, where the operator manually
    // selected 小/中/大, to the grade derived from their combined selected area.
    await syncAllManualDarkGrades();
    // Feature v2 uses the new physical Black/White signals. Rebuild approved
    // training embeddings from the locally stored pixels so existing learning
    // data keeps working without asking the operator to approve it again.
    await rebuildStaleEmbeddings();
  } catch (err) {
    console.error(err);
    alert(`저장소를 열 수 없습니다: ${String(err)}`);
  }
})();

// ---------------------------------------------------------------- intake

/**
 * 학습용/분석용 upload tabs. The choice tags every panel created from the
 * current upload; training panels feed only the kNN candidate pool and never
 * appear in 분석 현황 or 분석정리.
 */
let intakePurpose: Purpose = 'analysis';

const PURPOSE_NOTES: Record<Purpose, string> = {
  analysis: '분석용 — 불량 분석 결과가 분석 현황과 분석정리에 집계됩니다.',
  training: '학습용 — 라벨링 후 승인하면 kNN 학습 데이터가 됩니다. 분석 현황·분석정리에는 포함되지 않습니다.',
};

function renderIntakePurpose(): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.intake-tab[data-purpose]')) {
    tab.classList.toggle('on', tab.dataset.purpose === intakePurpose);
  }
  $('intake-purpose-note').textContent = PURPOSE_NOTES[intakePurpose];
}

for (const tab of document.querySelectorAll<HTMLButtonElement>('.intake-tab[data-purpose]')) {
  tab.addEventListener('click', () => {
    intakePurpose = tab.dataset.purpose as Purpose;
    renderIntakePurpose();
  });
}
renderIntakePurpose();

interface Metadata {
  purpose: Purpose;
  model: string;
  processName: string;
  equipmentId: string;
  user: string;
  captureProfileVersion: string;
  goldenProfileVersion: string;
}

function metadata(): Metadata {
  return {
    purpose: intakePurpose,
    model: $<HTMLInputElement>('meta-model').value.trim(),
    processName: $<HTMLInputElement>('meta-process').value.trim(),
    equipmentId: $<HTMLInputElement>('meta-equipment').value.trim(),
    user: $<HTMLInputElement>('meta-user').value.trim(),
    captureProfileVersion: inspectionProfile.capture.version,
    goldenProfileVersion: inspectionProfile.golden.version,
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
  // Land on the panels screen, on the tab of what was just uploaded.
  panelsPurpose = intakePurpose;
  await reload();
  navigate('panels');
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
      captureProfileVersion: meta.captureProfileVersion,
      goldenProfileVersion: meta.goldenProfileVersion,
      inspectionMode: inspectionProfile.mode,
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
    originalFilename: name,
    sourceType: source ? 'upload' : 'synthetic',
    synthetic: !source,
    captureProfileVersion: meta.captureProfileVersion,
    goldenProfileVersion: meta.goldenProfileVersion,
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
    originalFilename: name,
    sourceType: source ? 'upload' : 'synthetic',
    synthetic: !source,
    captureProfileVersion: meta.captureProfileVersion,
    goldenProfileVersion: meta.goldenProfileVersion,
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
    panelsPurpose = intakePurpose;
    await reload();
    navigate('panels');
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
  patternCompleteness: number,
  usedReferenceGeometry: boolean,
): AnalyzedImage | null {
  const rgba = pixels.get(image.id);
  if (!rgba) return null;
  const frame = normalizeFrame(rgba, circle, rotationDeg);
  const panel = panelOf(image);
  const synthetic = image.synthetic === true;
  const recordedProfileMatches =
    image.captureProfileVersion === inspectionProfile.capture.version &&
    image.goldenProfileVersion === inspectionProfile.golden.version;
  const profileReady = synthetic || (
    recordedProfileMatches && profileReadyForAutomaticNoDisplay(inspectionProfile, panel?.model ?? '')
  );
  const goldenRange = inspectionProfile.golden.ranges[image.pattern];
  const useHighResolutionLine = circle.r * 2 >= settings['line.native_min_diameter_px'];
  const lineFrame = useHighResolutionLine ? normalizeLineFrame(rgba, circle, rotationDeg) : undefined;
  const rawDetection = detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, image.pattern, settings, {
    withFeature,
    ...(lineFrame ? { highResolutionLineFrame: lineFrame } : {}),
    inspection: {
      validatedCaptureAndGolden: profileReady,
      expectedMinMean: goldenRange.minMean,
      expectedMaxMean: goldenRange.maxMean,
      maxBackgroundSaturationRatio: goldenRange.maxBackgroundSaturationRatio,
    },
  });
  const setupWarnings = synthetic
    ? []
    : [
      ...profileWarnings(inspectionProfile, panel?.model ?? ''),
      ...(recordedProfileMatches ? [] : ['업로드 당시 검사 프로파일과 현재 활성 버전이 다릅니다.']),
    ];
  const detection: ImageDetection = setupWarnings.length === 0
    ? rawDetection
    : { ...rawDetection, qualityWarnings: [...new Set([...rawDetection.qualityWarnings, ...setupWarnings])] };
  const detect = detectActiveCircle(rgba);
  const quality = evaluatePreprocessingQuality({
    source: rgba,
    frame,
    detect,
    circle,
    rotationDeg,
    patternCompleteness,
    usedReferenceGeometry,
    backgroundSaturationRatio: detection.backgroundSaturationPct / 100,
    localDefectSaturationRatio: detection.localDefectSaturationPct / 100,
    captureProfileValidated: synthetic || inspectionProfile.capture.validated,
    goldenReferenceValidated: synthetic || profileReady,
    expectedMeanRange: [goldenRange.minMean, goldenRange.maxMean],
  }, settings);
  return { image, detection, quality };
}

interface AnalyzedImage {
  readonly image: ImageRecord;
  readonly detection: ImageDetection;
  readonly quality: PreprocessingQuality;
}

/**
 * Detect every pattern of a panel once, returning both the per-image detections
 * (for the Rule verdict) and the combined feature vector (for kNN). One pass, so
 * the expensive background fit is not repeated.
 */
function analyzePanel(panelId: number): {
  detections: ImageDetection[];
  analyzedImages: AnalyzedImage[];
  feature: Float32Array | null;
  skipped: number;
} {
  const panelImages = imagesOf(panelId);
  const patternCompleteness = new Set(panelImages.map((image) => image.pattern)).size / PATTERNS.length;
  // An unlit image has no circle of its own, which is exactly the image where
  // 미점등 must be found. Borrow geometry from a sibling of the same capture.
  const reference = panelImages.find((i) => i.detectOk && pixels.has(i.id));
  if (!reference) {
    const failed = panelImages.flatMap((image) => {
      const analyzed = analyzeImage(
        image,
        circleOf(image),
        image.rotationDeg,
        false,
        patternCompleteness,
        false,
      );
      return analyzed ? [analyzed] : [];
    });
    return {
      detections: [],
      analyzedImages: failed,
      feature: null,
      skipped: panelImages.length,
    };
  }

  const detections: ImageDetection[] = [];
  const analyzedImages: AnalyzedImage[] = [];
  const byPattern: Partial<Record<Pattern, Float32Array>> = {};
  let skipped = 0;
  for (const image of panelImages) {
    const source = image.detectOk ? image : reference;
    const analyzed = analyzeImage(
      image,
      circleOf(source),
      source.rotationDeg,
      true,
      patternCompleteness,
      source.id !== image.id,
    );
    if (analyzed) {
      analyzedImages.push(analyzed);
      detections.push(analyzed.detection);
      if (analyzed.detection.feature) byPattern[image.pattern] = analyzed.detection.feature;
    } else {
      skipped++;
    }
  }
  const feature = detections.length > 0 ? combinePanelFeature(byPattern) : null;
  return { detections, analyzedImages, feature, skipped };
}

/** Approved training panels, loaded as kNN search candidates. */
async function loadSearchCandidates(): Promise<SearchEntry[]> {
  const embeddings = await repo.listEmbeddings();
  return embeddings
    .filter((e) => e.isSearchable && e.featureVersion === FEATURE_VERSION && e.dim === PANEL_FEATURE_DIM)
    .map((e) => {
      const panel = panels.find((candidate) => candidate.id === e.panelId);
      return {
        panelId: e.panelId,
        labelDefectId: e.labelDefectId,
        vector: fromBytes(e.vector),
        ...(panel ? { lotId: panel.lotId, panelCode: panel.panelCode, equipmentId: panel.equipmentId } : {}),
      };
    });
}

$('analyze').addEventListener('click', () => {
  void (async () => {
    verdicts.clear();
    const candidates = await loadSearchCandidates();
    const started = performance.now();
    let skipped = 0;

    for (const panel of panels) {
      const panelStarted = performance.now();
      const { detections, analyzedImages, feature, skipped: panelSkipped } = analyzePanel(panel.id);
      skipped += panelSkipped;
      if (detections.length === 0 || analyzedImages.some((analyzed) => analyzed.quality.status === 'FAIL')) {
        await persistPreprocessingEvidence(analyzedImages);
        continue;
      }

      const rule = judgePanel(detections, settings);
      // A panel cannot match itself: exclude its own training embedding from the
      // candidate set, or an already-approved panel would trivially vote for its
      // own label at similarity 1.
      const others = candidates.filter((c) =>
        c.panelId !== panel.id &&
        !(c.lotId === panel.lotId && c.panelCode === panel.panelCode),
      );
      const knn = feature ? knnSearch(feature, others, settings) : { status: 'insufficient-data' as const, candidateCount: others.length };
      const preprocessingReasons = [
        ...new Set(analyzedImages.flatMap((analyzed) => analyzed.quality.reviewReasons)),
      ];
      const fused = fuseVerdict(rule, knn, preprocessingReasons);
      verdicts.set(panel.id, {
        rule,
        fused,
        images: detections,
        qualityByImage: new Map(analyzedImages.map((analyzed) => [analyzed.image.id, analyzed.quality])),
      });
      await persistAnalysisEvidence(
        panel,
        analyzedImages,
        rule,
        fused,
        knn,
        performance.now() - panelStarted,
      );
    }

    verdictsStale = false;
    const analyzedTraining = panels.filter((p) => p.purpose === 'training' && verdicts.has(p.id)).length;
    lastRunNote = `${verdicts.size - analyzedTraining}개 분석용 패널 분석 완료`;
    if (analyzedTraining > 0) lastRunNote += ` (학습용 ${analyzedTraining}개는 집계 제외)`;
    lastRunNote += ` · ${(performance.now() - started).toFixed(0)}ms · 학습 ${candidates.length}개`;
    if (skipped > 0) lastRunNote += ` · ${skipped}장 제외 (원 검출 실패 또는 이미지 없음)`;
    [preprocessingResults, panelDecisions] = await Promise.all([
      repo.listPreprocessingResults(),
      repo.listPanelDecisions(),
    ]);
    render();
    if (parseRoute() === 'review') renderReviewQueue();
  })();
});

async function persistActiveThresholdConfig(): Promise<void> {
  const config = settingsPanel.getConfig();
  await repo.putThresholdConfig({
    schemaVersion: 3,
    version: config.version,
    active: true,
    config,
    createdAt: config.updatedAt,
    updatedAt: config.updatedAt,
  });
}

async function persistAnalysisEvidence(
  panel: PanelRecord,
  analyzedImages: readonly AnalyzedImage[],
  rule: PanelVerdict,
  fused: FusedVerdict,
  knn: KnnOutcome,
  processingMs: number,
): Promise<void> {
  const now = new Date().toISOString();
  const thresholdVersion = settingsPanel.getConfig().version;
  await persistPreprocessingEvidence(analyzedImages, now);

  const similarityResult = knn.status === 'ok' ? knn.result.verdictId : null;
  const evidence: NewDetectionResult[] = [];
  for (const analyzed of analyzedImages) {
    for (const detection of analyzed.detection.detections) {
      const labeled = rule.labeled.find(
        (item) =>
          item.pattern === analyzed.image.pattern &&
          item.kind === detection.kind &&
          Math.hypot(item.x - detection.x, item.y - detection.y) < 1,
      );
      const threshold = detection.kind.startsWith('dark')
        ? analyzed.detection.darkThreshold
        : analyzed.detection.brightThreshold;
      evidence.push({
        panelId: panel.id,
        imageId: analyzed.image.id,
        detectorId: detection.detectorId,
        detectorName: detection.detectorName,
        detectorVersion: detection.detectorVersion,
        thresholdVersion,
        sourcePattern: analyzed.image.pattern,
        kind: detection.kind,
        x: detection.x,
        y: detection.y,
        xRatio: (detection.x - FRAME_CENTER) / FRAME_RADIUS,
        yRatio: (detection.y - FRAME_CENTER) / FRAME_RADIUS,
        rRatio: detection.rRatio,
        angleDeg: detection.angleDeg,
        region: detection.region,
        bbox: detection.bbox,
        centroid: [detection.x, detection.y],
        maskAreaPx: detection.areaPx,
        defectAreaRatio: analyzed.detection.activeAreaPx > 0
          ? detection.areaPx / analyzed.detection.activeAreaPx
          : 0,
        meanContrast: detection.meanContrast,
        peakContrast: detection.peakContrast,
        confidence: Math.max(0, Math.min(1, detection.meanContrast / Math.max(1, threshold))),
        ruleResult: labeled?.defectId ?? DEFECT.GOOD,
        similarityResult,
        finalSuggestedLabel: labeled?.counted ? labeled.defectId : DEFECT.GOOD,
        reviewStatus: panel.reviewStatus,
        reviewReasons: fused.reviewReasons,
        ...(detection.continuity === undefined ? {} : { continuity: detection.continuity }),
        ...(detection.gapRatio === undefined ? {} : { gapRatio: detection.gapRatio }),
        ...(detection.edgeContact === undefined ? {} : { edgeContact: detection.edgeContact }),
        ...(detection.analysisScale === undefined ? {} : { analysisScale: detection.analysisScale }),
        schemaVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  await repo.replaceDetectionResults(panel.id, evidence);

  const neighbors = knn.status === 'ok' ? knn.result.neighbors : knn.status === 'no-match' ? knn.neighbors : [];
  const knnSimilarityScore = neighbors.length > 0 ? Math.max(...neighbors.map((neighbor) => neighbor.similarity)) : null;
  await repo.putPanelDecision({
    panelId: panel.id,
    thresholdVersion,
    detectorVersion: DETECTOR_VERSION,
    ruleResult: rule.finalJudgementId,
    ruleConfidence: rule.confidence,
    knnResult: similarityResult,
    knnSimilarityScore,
    agreementStatus: fused.agreementStatus,
    finalSuggestedLabel: fused.finalJudgementId,
    finalConfidence: fused.confidence,
    reviewStatus: fused.needsReview ? 'pending' : panel.reviewStatus,
    reviewReasons: fused.reviewReasons,
    processingMs,
    sortingDisposition: fused.sortingDisposition,
    captureProfileVersion: inspectionProfile.capture.version,
    goldenProfileVersion: inspectionProfile.golden.version,
    schemaVersion: 3,
    createdAt: now,
    updatedAt: now,
  });
}

async function persistPreprocessingEvidence(
  analyzedImages: readonly AnalyzedImage[],
  timestamp = new Date().toISOString(),
): Promise<void> {
  const thresholdVersion = settingsPanel.getConfig().version;
  await Promise.all(
    analyzedImages.map((analyzed) =>
      repo.putPreprocessingResult({
        ...analyzed.quality,
        imageId: analyzed.image.id,
        thresholdVersion,
        captureProfileVersion: analyzed.image.captureProfileVersion ?? inspectionProfile.capture.version,
        goldenProfileVersion: analyzed.image.goldenProfileVersion ?? inspectionProfile.golden.version,
        schemaVersion: 3,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
  );
}

// ---------------------------------------------------------------- transfer

// ---------------------------------------------------------------- dashboard

function renderReviewQueue(): void {
  const root = $('review-list');
  root.replaceChildren();
  const items = panels.flatMap((panel) => {
    const analysis = verdicts.get(panel.id);
    const decision = panelDecisions.find((item) => item.panelId === panel.id);
    const reviewed = reviews.find((item) => item.panelId === panel.id);
    const reasons = analysis?.fused.reviewReasons ?? decision?.reviewReasons ?? [];
    if (reviewed || reasons.length === 0) return [];
    return [{ panel, analysis, decision, reasons }];
  });
  $('review-count').textContent = `${items.length}건`;

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'view-empty';
    empty.textContent = panelDecisions.length === 0
      ? '저장된 분석 결과가 없습니다. 먼저 불량 분석을 실행하세요.'
      : '현재 미검수 항목이 없습니다.';
    root.append(empty);
    return;
  }

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'review-item';
    const head = document.createElement('div');
    head.className = 'review-item-head';
    const title = document.createElement('strong');
    title.textContent = `${item.panel.lotId} / ${item.panel.panelCode}`;
    const suggested = item.analysis?.fused.finalJudgementId ?? item.decision?.finalSuggestedLabel ?? DEFECT.GOOD;
    head.append(title, badge(`자동 제안: ${DEFECT_NAME[suggested]}`, 'warn'));
    card.append(head);

    const reason = document.createElement('p');
    reason.textContent = item.reasons.map((value) => REVIEW_REASON_NAME[value]).join(' · ');
    card.append(reason);

    const patterns = document.createElement('div');
    patterns.className = 'review-patterns';
    for (const image of imagesOf(item.panel.id)) {
      const quality = item.analysis?.qualityByImage.get(image.id)
        ?? preprocessingResults.find((result) => result.imageId === image.id);
      const detection = item.analysis?.images.find((result) => result.pattern === image.pattern);
      const storedCount = detectionResults.filter((result) => result.imageId === image.id).length;
      patterns.append(badge(
        `${image.pattern}: ${quality?.status ?? '미분석'} · ${detection?.detections.length ?? storedCount}개`,
        quality?.status === 'FAIL' ? 'danger' : quality?.status === 'REVIEW' ? 'warn' : 'info',
      ));
    }
    card.append(patterns);

    const actions = document.createElement('div');
    actions.className = 'review-item-actions';
    const label = document.createElement('select');
    for (const defectId of Object.keys(DEFECT_NAME) as DefectId[]) {
      label.append(new Option(DEFECT_NAME[defectId], defectId));
    }
    label.value = suggested;
    label.disabled = currentRole === 'viewer';
    const notes = document.createElement('input');
    notes.type = 'text';
    notes.placeholder = '검수 메모 (선택)';
    notes.disabled = currentRole === 'viewer';
    const detail = document.createElement('button');
    detail.type = 'button';
    detail.className = 'ghost small';
    detail.textContent = '상세 검수';
    detail.addEventListener('click', () => {
      const first = imagesOf(item.panel.id)[0];
      if (first) openDetail(first);
    });
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'small';
    approve.textContent = '판정 승인';
    approve.disabled = currentRole === 'viewer';
    approve.addEventListener('click', () => {
      void saveEngineerReview(item.panel, item.decision, label.value as DefectId, notes.value, 'approved');
    });
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'ghost small';
    reject.textContent = '반려';
    reject.disabled = currentRole === 'viewer';
    reject.addEventListener('click', () => {
      void saveEngineerReview(item.panel, item.decision, label.value as DefectId, notes.value, 'rejected');
    });
    actions.append(label, notes, detail, reject, approve);
    card.append(actions);
    root.append(card);
  }
}

async function saveEngineerReview(
  panel: PanelRecord,
  decision: PanelDecisionRecord | undefined,
  finalLabel: DefectId,
  notes: string,
  status: 'approved' | 'rejected',
): Promise<void> {
  if (currentRole === 'viewer') return;
  const now = new Date().toISOString();
  const reasons = verdicts.get(panel.id)?.fused.reviewReasons ?? decision?.reviewReasons ?? [];
  await repo.putReview({
    panelId: panel.id,
    originalDecisionId: decision?.id ?? null,
    reviewerFinalLabel: finalLabel,
    reviewer: $<HTMLInputElement>('meta-user').value.trim() || currentRole,
    notes: notes.trim(),
    reviewDate: now,
    status,
    reviewReasons: reasons,
    schemaVersion: 4,
    createdAt: now,
    updatedAt: now,
  });
  if (status === 'approved') await setPanelApproval(panel, true);
  else await repo.updatePanel(panel.id, { reviewStatus: 'rejected' });
  await reload();
  renderReviewQueue();
}

/**
 * Turn analyzed panels into the dashboard's input.
 *
 * The location points come from the Rule engine's confirmed detections
 * (`labeled`, counted only), not the manual annotations: the dashboard reports
 * what the AND analysis found across the batch. Manual labels drive training;
 * analysis output drives the dashboard.
 */
function buildDashboardPanels(): DashboardPanel[] {
  const out: DashboardPanel[] = [];
  for (const panel of panels) {
    // Training panels exist to teach kNN; the dashboard reports production
    // analysis only, so they are excluded even when they carry a verdict.
    if (panel.purpose === 'training') continue;
    const analysis = verdicts.get(panel.id);
    const decision = panelDecisions.find((item) => item.panelId === panel.id);
    if (!analysis && !decision) continue;
    const persistedDetections = detectionResults.filter(
      (item) => item.panelId === panel.id && item.finalSuggestedLabel !== DEFECT.GOOD,
    );
    const points: DashboardPoint[] = analysis
      ? analysis.rule.labeled
          .filter((item) => item.counted)
          .map((item) => ({
            panelId: panel.id,
            defectId: item.defectId,
            pattern: item.pattern,
            rRatio: item.rRatio,
            angleDeg: item.angleDeg,
            region: item.region,
            areaPx: item.areaPx,
          }))
      : persistedDetections.map((item) => ({
          panelId: panel.id,
          defectId: item.finalSuggestedLabel,
          pattern: item.sourcePattern,
          rRatio: item.rRatio,
          angleDeg: item.angleDeg,
          region: item.region,
          areaPx: item.maskAreaPx,
        }));
    const panelImages = imagesOf(panel.id);
    const reviewed = reviews.find((item) => item.panelId === panel.id && item.status === 'approved');
    const automaticJudgement = analysis?.fused.finalJudgementId ?? decision!.finalSuggestedLabel;
    const detectedDefectIds = analysis?.rule.detectedDefectIds
      ?? [...new Set(persistedDetections.map((item) => item.finalSuggestedLabel))];
    const imageIds = new Set(panelImages.map((image) => image.id));
    out.push({
      panelId: panel.id,
      lotId: panel.lotId,
      model: panel.model,
      processName: panel.processName,
      equipmentId: panel.equipmentId,
      reviewStatus: panel.reviewStatus,
      finalJudgementId: reviewed?.reviewerFinalLabel ?? automaticJudgement,
      detectedDefectIds,
      confidence: analysis?.fused.confidence ?? decision!.finalConfidence ?? decision!.ruleConfidence,
      needsReview: !reviewed && (analysis?.fused.needsReview ?? decision!.reviewReasons.length > 0),
      points,
      imageCount: panelImages.length,
      preprocessingFailed: analysis
        ? [...analysis.qualityByImage.values()].some((quality) => quality.status === 'FAIL')
        : preprocessingResults.some((quality) => imageIds.has(quality.imageId) && quality.status === 'FAIL'),
      synthetic: panelImages.length > 0 && panelImages.every((image) => image.synthetic === true),
      reviewerAgreement: reviewed ? reviewed.reviewerFinalLabel === automaticJudgement : null,
      automaticJudgementId: automaticJudgement,
      reviewerJudgementId: reviewed?.reviewerFinalLabel ?? null,
      capturedAt: panel.uploadedAt,
    });
  }
  return out;
}

interface DashFilters {
  lotId: string;
  equipmentId: string;
  processName: string;
  approvedOnly: boolean;
}
const dashFilters: DashFilters = { lotId: '', equipmentId: '', processName: '', approvedOnly: false };

function applyDashFilters(all: DashboardPanel[]): DashboardPanel[] {
  return all.filter(
    (p) =>
      (!dashFilters.lotId || p.lotId === dashFilters.lotId) &&
      (!dashFilters.equipmentId || p.equipmentId === dashFilters.equipmentId) &&
      (!dashFilters.processName || p.processName === dashFilters.processName) &&
      (!dashFilters.approvedOnly || p.reviewStatus === 'approved'),
  );
}

function renderDashFilters(all: DashboardPanel[]): void {
  const root = $('dash-filters');
  root.replaceChildren();

  const distinct = (field: 'lotId' | 'equipmentId' | 'processName'): string[] =>
    [...new Set(all.map((p) => p[field]).filter(Boolean))].sort();

  const addSelect = (label: string, key: 'lotId' | 'equipmentId' | 'processName'): void => {
    const values = distinct(key);
    if (values.length <= 1) return;
    const wrap = document.createElement('label');
    wrap.className = 'dash-filter';
    wrap.textContent = label;
    const sel = document.createElement('select');
    sel.append(new Option('전체', ''));
    for (const v of values) sel.append(new Option(v, v));
    sel.value = dashFilters[key];
    sel.addEventListener('change', () => {
      dashFilters[key] = sel.value;
      refreshDashboard();
    });
    wrap.append(sel);
    root.append(wrap);
  };

  addSelect('Lot', 'lotId');
  addSelect('설비', 'equipmentId');
  addSelect('공정', 'processName');

  const approved = document.createElement('label');
  approved.className = 'dash-filter dash-check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = dashFilters.approvedOnly;
  cb.addEventListener('change', () => {
    dashFilters.approvedOnly = cb.checked;
    refreshDashboard();
  });
  approved.append(cb, document.createTextNode('검수 완료만'));
  root.append(approved);

  const count = document.createElement('span');
  count.className = 'dash-count';
  count.textContent = `${applyDashFilters(all).length} / ${all.length} panels`;
  root.append(count);
}

function refreshDashboard(): void {
  const all = buildDashboardPanels();
  renderDashFilters(all);
  renderDashboard($('dashboard-body'), $('dash-nav'), applyDashFilters(all), settings);
}

$('dashboard').addEventListener('click', () => {
  const hasAnalysisVerdict = panels.some((p) => p.purpose === 'analysis' && verdicts.has(p.id));
  if (!hasAnalysisVerdict) {
    alert(
      verdicts.size > 0
        ? '분석용 패널이 없습니다. 학습용 패널은 분석정리에 집계되지 않습니다.'
        : '먼저 불량 분석을 실행하세요.',
    );
    return;
  }
  navigate('dashboard');
});

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

$('export-diagnostics').addEventListener('click', () => {
  if (verdicts.size === 0 || verdictsStale) {
    alert(verdictsStale ? '임계값 변경 후 불량 분석을 다시 실행하세요.' : '먼저 불량 분석을 실행하세요.');
    return;
  }

  const diagnostic = {
    format: 'watch-defect-diagnostics-v1',
    exportedAt: new Date().toISOString(),
    featureVersion: FEATURE_VERSION,
    settings,
    // Deliberately excludes originalBlob, RGBA pixels and thumbnails. This file
    // is safe to share for threshold tuning without exposing company images.
    panels: panels.flatMap((panel, panelIndex) => {
      const analysis = verdicts.get(panel.id);
      if (!analysis) return [];
      return [{
        panel: {
          index: panelIndex + 1,
          purpose: panel.purpose,
          reviewStatus: panel.reviewStatus,
        },
        verdict: {
          finalJudgementId: analysis.fused.finalJudgementId,
          ruleJudgementId: analysis.rule.finalJudgementId,
          knnJudgementId: analysis.fused.knnVerdictId,
          confidence: analysis.fused.confidence,
          needsReview: analysis.fused.needsReview,
          detectedDefectIds: analysis.rule.detectedDefectIds,
          suppressed: analysis.rule.suppressed,
          darkAreaPct: analysis.rule.darkAreaPct,
          decisionReason: analysis.fused.decisionReason,
          qualityWarnings: analysis.rule.qualityWarnings,
        },
        images: analysis.images.map((image) => ({
          pattern: image.pattern,
          activeAreaPx: image.activeAreaPx,
          meanLuma: image.meanLuma,
          blackBackgroundMean: image.blackBackgroundMean,
          whiteBackgroundMean: image.whiteBackgroundMean,
          darkThreshold: image.darkThreshold,
          brightThreshold: image.brightThreshold,
          whiteSaturationPct: image.whiteSaturationPct,
          qualityWarnings: image.qualityWarnings,
          darkAreaPct: image.darkAreaPct,
          noDisplay: image.noDisplay,
          drivingFlag: image.drivingFlag,
          detections: image.detections,
        })),
      }];
    }),
  };
  downloadJson(diagnostic, `defect-diagnostics-${new Date().toISOString().slice(0, 10)}.json`);
});

function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

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

$('approve-all').addEventListener('click', () => {
  // Scoped to the visible tab: approving 분석용 must not silently push the
  // training pool's pending panels through as well.
  const tabName = panelsPurpose === 'training' ? '학습용' : '분석용';
  const pending = panels.filter((p) => p.purpose === panelsPurpose && p.reviewStatus !== 'approved');
  if (pending.length === 0) {
    alert(`승인할 ${tabName} 패널이 없습니다. 현재 탭의 패널이 모두 승인되었습니다.`);
    return;
  }
  if (
    !confirm(
      `${tabName} 패널 ${pending.length}개를 일괄 승인합니다.\n\n` +
        '승인된 패널은 kNN 학습 데이터가 됩니다. 라벨을 찍지 않은 패널은 양품 예제로 저장되므로, ' +
        '학습 정확도가 중요하면 먼저 라벨링한 뒤 승인하세요.\n\n계속할까요?',
    )
  ) {
    return;
  }

  const btn = $<HTMLButtonElement>('approve-all');
  void (async () => {
    // Storing an embedding runs a full detection pass per panel, so this can
    // take a few seconds for a large batch. Show progress and lock the button.
    btn.disabled = true;
    const original = btn.textContent;
    let done = 0;
    for (const panel of pending) {
      await setPanelApproval(panel, true);
      done++;
      btn.textContent = `승인 중… ${done}/${pending.length}`;
    }
    if (verdicts.size > 0) verdictsStale = true;
    btn.textContent = original;
    btn.disabled = false;
    await reload();
    alert(`${pending.length}개 패널을 승인했습니다.`);
  })();
});

$('wipe').addEventListener('click', () => {
  if (!confirm('저장된 패널, 이미지, 라벨을 모두 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
  void (async () => {
    await repo.clear();
    await persistActiveThresholdConfig();
    pixels.clear();
    invalidateVerdicts();
    await reload();
  })();
});

// ---------------------------------------------------------------- rendering

/** Which purpose the 패널 목록 tab is showing, mirroring the intake tabs. */
let panelsPurpose: Purpose = 'analysis';

for (const tab of document.querySelectorAll<HTMLButtonElement>('.intake-tab[data-panels-purpose]')) {
  tab.addEventListener('click', () => {
    panelsPurpose = tab.dataset.panelsPurpose as Purpose;
    render();
  });
}

const PANELS_EMPTY_NOTES: Record<Purpose, string> = {
  analysis: '분석용 패널이 없습니다. 이미지 등록 탭의 분석용에서 이미지를 올리거나 샘플을 생성하세요.',
  training: '학습용 패널이 없습니다. 이미지 등록 탭의 학습용에서 불량 예제를 올려 라벨링·승인하면 kNN 학습 데이터가 됩니다.',
};

function render(): void {
  renderSummary();
  renderAnalyzeNote();

  const shown = panels.filter((p) => p.purpose === panelsPurpose);
  const trainingCount = panels.filter((p) => p.purpose === 'training').length;

  $('panels-tab-analysis').textContent = `분석용 ${panels.length - trainingCount}`;
  $('panels-tab-training').textContent = `학습용 ${trainingCount}`;
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.intake-tab[data-panels-purpose]')) {
    tab.classList.toggle('on', tab.dataset.panelsPurpose === panelsPurpose);
  }

  toolbar.hidden = shown.length === 0;
  const emptyEl = $('panels-empty');
  emptyEl.hidden = shown.length > 0;
  emptyEl.textContent = PANELS_EMPTY_NOTES[panelsPurpose];

  panelsEl.replaceChildren();
  const sorted = [...shown].sort(
    (a, b) => a.lotId.localeCompare(b.lotId) || a.panelCode.localeCompare(b.panelCode),
  );
  for (const panel of sorted) panelsEl.append(renderPanel(panel));
}

/**
 * 분석 현황 aggregates the analysis-purpose panels only. Training uploads are
 * for building the kNN pool and must not distort the production counts.
 */
function renderSummary(): void {
  const analysisPanels = panels.filter((p) => p.purpose === 'analysis');
  const trainingCount = panels.length - analysisPanels.length;

  $('status-empty').hidden = analysisPanels.length > 0;
  $('status-note').hidden = !(analysisPanels.length > 0 && trainingCount > 0);
  if (analysisPanels.length === 0) {
    summaryEl.hidden = true;
    return;
  }
  summaryEl.hidden = false;

  const panelIds = new Set(analysisPanels.map((p) => p.id));
  const analysisImages = images.filter((i) => panelIds.has(i.panelId));
  const imageIds = new Set(analysisImages.map((i) => i.id));
  const labels = annotations.filter((a) => imageIds.has(a.imageId)).length;

  const approved = analysisPanels.filter((p) => p.reviewStatus === 'approved').length;
  const failed = analysisImages.filter((i) => !i.detectOk).length;
  const confirmed = analysisImages.filter((i) => i.confirmed).length;

  summaryEl.replaceChildren(
    stat(String(analysisPanels.length), '분석용 패널'),
    stat(String(analysisImages.length), '이미지'),
    stat(String(labels), '수동 라벨'),
    stat(`${approved}/${analysisPanels.length}`, '검수 완료', approved < analysisPanels.length),
    stat(`${confirmed}/${analysisImages.length}`, 'FPCB 위치확정', confirmed < analysisImages.length),
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
    unconfirmed > 0 ? `FPCB 위치 미확정 ${unconfirmed}건 — 자동 추정값으로 분석됩니다.` : '';
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
  if (panelImages.length > 0 && panelImages.every((i) => i.confirmed)) head.append(badge('FPCB 위치확정', 'ok'));
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
  if (analysis) el.append(renderVerdict(analysis), renderPatternCorrelation(analysis));
  return el;
}

function renderPatternCorrelation(analysis: PanelAnalysis): HTMLElement {
  const box = document.createElement('div');
  box.className = 'verdict';
  const line = document.createElement('div');
  line.className = 'verdict-line';
  const caption = document.createElement('span');
  caption.className = 'label-caption';
  caption.textContent = 'R/G/B/W 상관';
  line.append(caption);
  for (const pattern of PATTERNS) {
    const image = analysis.images.find((item) => item.pattern === pattern);
    if (!image) {
      line.append(badge(`${pattern}: 결손`, 'danger'));
      continue;
    }
    const counted = analysis.rule.labeled.filter((item) => item.pattern === pattern && item.counted).length;
    const pending = image.detections.length - counted;
    line.append(badge(
      `${pattern}: 확인 ${counted} / 후보 ${image.detections.length}`,
      pending > 0 ? 'warn' : 'info',
    ));
  }
  box.append(line);
  return box;
}

function spacer(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'spacer';
  return el;
}

/**
 * Approve or un-approve one panel, in the DB only. Callers reload afterward.
 *
 * Approving a panel approves its labels and stores its search embedding — that
 * is what "승인된 라벨만 학습 DB에 반영" in docs/PRD.md means in practice.
 * Un-approving pulls it back out of the kNN search set.
 */
async function setPanelApproval(panel: PanelRecord, approved: boolean): Promise<void> {
  // Dark-area labels carry one panel grade derived from their combined area.
  // Recalculate immediately before learning so kNN never stores a stale manual
  // 小/中/大 choice from an older build or threshold setting.
  await syncPanelDarkGrade(panel.id);
  const next = approved ? 'approved' : 'pending';
  await repo.updatePanel(panel.id, { reviewStatus: next });
  for (const image of imagesOf(panel.id)) {
    for (const annotation of annotationsOf(image.id)) {
      await repo.updateAnnotation(annotation.id, { reviewStatus: next });
    }
  }
  if (approved) await storeEmbedding(panel.id);
  else await repo.deleteEmbeddingsByPanel(panel.id);
}

function approveButton(panel: PanelRecord): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost small';
  btn.textContent = panel.reviewStatus === 'approved' ? '승인 취소' : '승인';
  btn.disabled = currentRole === 'viewer';
  btn.addEventListener('click', () => {
    void (async () => {
      await setPanelApproval(panel, panel.reviewStatus !== 'approved');
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

async function rebuildStaleEmbeddings(): Promise<void> {
  const embeddings = await repo.listEmbeddings();
  const current = new Set(
    embeddings
      .filter((embedding) => embedding.featureVersion === FEATURE_VERSION && embedding.dim === PANEL_FEATURE_DIM)
      .map((embedding) => embedding.panelId),
  );
  for (const panel of panels) {
    if (
      panel.purpose !== 'training' ||
      panel.reviewStatus !== 'approved' ||
      current.has(panel.id) ||
      !imagesOf(panel.id).some(hasPixels)
    ) continue;
    await storeEmbedding(panel.id);
  }
}

interface SyncedManualDarkGrade extends ManualDarkGrade {
  readonly changed: boolean;
}

async function syncPanelDarkGrade(panelId: number): Promise<SyncedManualDarkGrade> {
  const imageIds = new Set(imagesOf(panelId).map((image) => image.id));
  const labels = annotations.filter((annotation) => imageIds.has(annotation.imageId));
  const result = manualDarkGrade(labels, settings);
  if (!result.defectId) return { ...result, changed: false };

  let changed = false;
  for (const annotation of labels) {
    if (!isDarkDotDefect(annotation.defectId) || annotation.defectId === result.defectId) continue;
    await repo.updateAnnotation(annotation.id, { defectId: result.defectId });
    annotation.defectId = result.defectId;
    changed = true;
  }
  return { ...result, changed };
}

async function syncAllManualDarkGrades(): Promise<void> {
  for (const panel of panels) {
    const result = await syncPanelDarkGrade(panel.id);
    if (result.changed && panel.reviewStatus === 'approved' && panel.purpose === 'training') {
      await storeEmbedding(panel.id);
    }
  }
  render();
  if (selected) renderLabelList();
}

function deleteButton(panel: PanelRecord): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost small';
  btn.textContent = '삭제';
  btn.disabled = currentRole !== 'admin';
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

  const dark = manualDarkGrade(labels, settings);
  const darkCount = labels.filter((label) => isDarkDotDefect(label.defectId) && (label.geomType === 'box' || label.geomType === 'mask')).length;
  if (dark.defectId && darkCount > 0) {
    line.append(badge(`암점 영역 ${darkCount}개 · 합산 ${dark.areaPct.toFixed(2)}% → ${DEFECT_NAME[dark.defectId]}`, 'info'));
  }

  const counts = new Map<DefectId, number>();
  for (const label of labels) {
    if (isDarkDotDefect(label.defectId)) continue;
    counts.set(label.defectId, (counts.get(label.defectId) ?? 0) + 1);
  }
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
  line.append(badge(`임계값 v${settingsPanel.getConfig().version}`, 'info'));
  line.append(badge(`촬영 ${inspectionProfile.capture.version}`, 'info'));
  line.append(badge(`Golden ${inspectionProfile.golden.version}`, 'info'));
  line.append(badge(
    `Sorting ${fused.sortingDisposition}`,
    fused.sortingDisposition === 'OK' ? 'ok' : fused.sortingDisposition === 'NG' ? 'danger' : 'warn',
  ));
  line.append(badge(`신뢰도 ${fused.confidence.toFixed(2)}`, fused.confidence < 0.6 ? 'warn' : 'ok'));
  const qualities = [...analysis.qualityByImage.values()];
  if (qualities.some((quality) => quality.status === 'FAIL')) line.append(badge('전처리 실패', 'danger'));
  else if (qualities.some((quality) => quality.status === 'REVIEW')) line.append(badge('전처리 검수', 'warn'));
  if (fused.needsReview) line.append(badge('검수 필요', 'danger'));
  if (rule.suppressed.length > 0 || rule.labeled.some((item) => !item.counted)) {
    line.append(badge('패턴 확인 미충족', 'warn'));
  }
  if (rule.drivingFlag) line.append(badge('구동불량 의심', 'warn'));
  if (rule.qualityWarnings.length > 0) line.append(badge('촬영/품질 경고', 'danger'));
  if (fused.neighbors.length > 0) line.append(badge(`kNN 이웃 ${fused.neighbors.length}`, 'info'));
  box.append(line);

  const reason = document.createElement('p');
  reason.className = 'reason';
  reason.textContent = fused.decisionReason;
  box.append(reason);
  if (fused.reviewReasons.length > 0) {
    const review = document.createElement('p');
    review.className = 'reason';
    review.textContent = `검수 사유: ${fused.reviewReasons.map((item) => REVIEW_REASON_NAME[item]).join(' · ')}`;
    box.append(review);
  }
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

const DARK_AREA_VALUE = 'dark-area';
const darkAreaOption = document.createElement('option');
darkAreaOption.value = DARK_AREA_VALUE;
darkAreaOption.textContent = '암점 영역 (합산 면적 자동 등급)';
defectSelect.append(darkAreaOption);

for (const defectId of LABELABLE_DEFECTS.filter((id) => !isDarkDotDefect(id))) {
  const option = document.createElement('option');
  option.value = defectId;
  option.textContent = `${DEFECT_NAME[defectId]} (${defectId})`;
  defectSelect.append(option);
}

function syncLabelTool(): void {
  const selectingDarkArea = defectSelect.value === DARK_AREA_VALUE;
  if (selectingDarkArea) toolSelect.value = 'box';
  toolSelect.disabled = selectingDarkArea;
  toolSelect.title = selectingDarkArea ? '암점은 선택 영역의 합계가 필요하므로 박스 도구를 사용합니다.' : '';
}

defectSelect.addEventListener('change', syncLabelTool);
syncLabelTool();

/**
 * Snapshot of the frame canvas with everything except the drag preview.
 *
 * Redrawing the preview through redrawDetail would rerun the full detection
 * pass (~70ms) on every pointermove; the drag then lags the cursor and shapes
 * appear to land somewhere other than where the operator pointed. Blitting the
 * cached base and stroking only the preview keeps the drag glued to the cursor.
 */
let frameBase: HTMLCanvasElement | null = null;
let previewBlitPending = false;

function blitPreview(): void {
  if (!frameBase) {
    redrawDetail();
    return;
  }
  const ctx = frameCanvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(frameBase, 0, 0);
  if (previewShape) drawPreview(ctx, previewShape);
}

const labelHint = document.querySelector<HTMLElement>('.label-hint');
const LABEL_HINT_DEFAULT = labelHint?.textContent ?? '';
let labelHintTimer: ReturnType<typeof setTimeout> | undefined;

/** Explain a swallowed gesture where the operator is already looking. */
function flashLabelHint(message: string): void {
  if (!labelHint) return;
  clearTimeout(labelHintTimer);
  labelHint.textContent = message;
  labelHint.classList.add('warn');
  labelHintTimer = setTimeout(() => {
    labelHint.textContent = LABEL_HINT_DEFAULT;
    labelHint.classList.remove('warn');
  }, 2500);
}

attachLabeling(frameCanvas, {
  getTool: () => toolSelect.value as GeomType,
  onPreview: (shape) => {
    previewShape = shape;
    if (previewBlitPending) return;
    previewBlitPending = true;
    requestAnimationFrame(() => {
      previewBlitPending = false;
      blitPreview();
    });
  },
  onReject: (reason) => {
    flashLabelHint(
      reason === 'outside'
        ? 'Active 영역 밖입니다 — 라벨의 중심이 원 안에 오도록 그리세요.'
        : '너무 짧습니다 — 선/박스는 드래그로 그리세요. 한 지점 표시는 점 도구를 쓰세요.',
    );
  },
  onShape: (shape) => {
    if (!selected) return;
    const selectingDarkArea = defectSelect.value === DARK_AREA_VALUE;
    if (selectingDarkArea && shape.geomType !== 'box') {
      flashLabelHint('암점은 면적 합산을 위해 박스 도구로 영역을 선택해야 합니다.');
      syncLabelTool();
      return;
    }
    const image = selected;
    void (async () => {
      const defectId = selectingDarkArea ? DEFECT.DARK_DOT_SMALL : (defectSelect.value as DefectId);
      const maskRle = selectingDarkArea ? darkMaskInsideSelection(image, shape) : '';
      const storedShape: Shape = maskRle ? { ...shape, geomType: 'mask' } : shape;
      await repo.addAnnotation(buildAnnotation(storedShape, defectId, image.id, new Date(), settings, maskRle || undefined));
      annotations = await repo.listAnnotations();
      const dark = await syncPanelDarkGrade(image.panelId);
      const panel = panels.find((candidate) => candidate.id === image.panelId);
      if (panel?.reviewStatus === 'approved' && panel.purpose === 'training') await storeEmbedding(panel.id);
      if (selectingDarkArea && dark.defectId) {
        flashLabelHint(`암점 ${maskRle ? '분할 마스크' : '박스'} 합계 ${dark.areaPct.toFixed(2)}% → ${DEFECT_NAME[dark.defectId]}`);
      }
      renderLabelList();
      redrawDetail();
      render();
    })();
  },
});

/** Refine a dark-area drag to residual pixels, falling back to its box if no signal exists. */
function darkMaskInsideSelection(image: ImageRecord, shape: Shape): string {
  if (shape.x2 === undefined || shape.y2 === undefined) return '';
  const rgba = pixels.get(image.id);
  if (!rgba) return '';
  const reference = image.detectOk ? image : (imagesOf(image.panelId).find((candidate) => candidate.detectOk) ?? image);
  const frame = normalizeFrame(rgba, circleOf(reference), reference.rotationDeg);
  const detection = detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, image.pattern, settings, {
    withResiduals: true,
  });
  if (!detection.darkResidual) return '';
  const minX = Math.max(0, Math.floor(Math.min(shape.x, shape.x2)));
  const maxX = Math.min(frame.image.width - 1, Math.ceil(Math.max(shape.x, shape.x2)));
  const minY = Math.max(0, Math.floor(Math.min(shape.y, shape.y2)));
  const maxY = Math.min(frame.image.height - 1, Math.ceil(Math.max(shape.y, shape.y2)));
  const indices: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const index = y * frame.image.width + x;
      if (frame.activeMask.data[index] === 1 && detection.darkResidual[index]! < -detection.darkThreshold) indices.push(index);
    }
  }
  return encodeMaskRle(indices);
}

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
    remove.disabled = currentRole === 'viewer';
    const panelId = selected.panelId;
    remove.addEventListener('click', () => {
      void (async () => {
        await repo.deleteAnnotation(annotation.id);
        annotations = await repo.listAnnotations();
        await syncPanelDarkGrade(panelId);
        const panel = panels.find((candidate) => candidate.id === panelId);
        if (panel?.reviewStatus === 'approved' && panel.purpose === 'training') await storeEmbedding(panel.id);
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
  mapPattern.value = image.pattern;
  mapPanel.replaceChildren();
  const currentPanel = panelOf(image);
  for (const panel of panels.filter((candidate) => candidate.purpose === currentPanel?.purpose)) {
    mapPanel.append(new Option(`${panel.lotId} / ${panel.panelCode}`, String(panel.id)));
  }
  mapPanel.value = String(image.panelId);
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
    frameBase = null; // a stale base must not resurface via blitPreview
    for (const canvas of [srcCanvas, frameCanvas, darkResidualCanvas, brightResidualCanvas]) {
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

  const detection = detectDefects(frame.image, frame.activeMask, frame.activeAreaPx, image.pattern, settings, {
    withResiduals: true,
  });
  if (detection.darkResidual) {
    paintResidual(darkResidualCanvas, detection.darkResidual, frame.image.width, frame.image.height, 'dark');
  }
  if (detection.brightResidual) {
    paintResidual(brightResidualCanvas, detection.brightResidual, frame.image.width, frame.image.height, 'bright');
  }
  const analysis = verdictsStale ? undefined : verdicts.get(image.panelId);
  drawDetections(
    ctx,
    detection.detections.map((d) => {
      const analyzed = analysis?.rule.labeled.find(
        (item) =>
          item.pattern === image.pattern &&
          item.kind === d.kind &&
          Math.hypot(item.x - d.x, item.y - d.y) < 1,
      );
      const fallback = !(analysis?.rule.suppressed.includes(d.kind) ?? false);
      return { x: d.x, y: d.y, bbox: d.bbox, counted: analyzed?.counted ?? fallback };
    }),
  );

  drawAnnotations(ctx, annotationsOf(image.id));

  // Cache the fully-composed frame (minus the drag preview) so pointermove can
  // repaint without rerunning detection. See blitPreview.
  frameBase ??= document.createElement('canvas');
  frameBase.width = frameCanvas.width;
  frameBase.height = frameCanvas.height;
  frameBase.getContext('2d')?.drawImage(frameCanvas, 0, 0);

  if (previewShape) drawPreview(ctx, previewShape);

  detailDetections.textContent = describeDetection(detection, analysis?.qualityByImage.get(image.id));
}

function paintResidual(
  canvas: HTMLCanvasElement,
  residual: Int16Array,
  width: number,
  height: number,
  polarity: 'dark' | 'bright',
): void {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(width, height);
  for (let i = 0, p = 0; i < residual.length; i++, p += 4) {
    const strength = Math.max(0, Math.min(255, polarity === 'dark' ? -residual[i]! * 3 : residual[i]! * 3));
    if (polarity === 'dark') {
      image.data[p] = strength;
      image.data[p + 1] = strength * 0.18;
      image.data[p + 2] = strength * 0.12;
    } else {
      image.data[p] = strength;
      image.data[p + 1] = strength;
      image.data[p + 2] = strength * 0.35;
    }
    image.data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function describeDetection(detection: ImageDetection, quality?: PreprocessingQuality): string {
  const qualityParts = quality
    ? [
        `전처리 ${quality.status}`,
        `원 신뢰 ${quality.radiusConfidence.toFixed(2)}`,
        `FPCB ${quality.fpcbAlignmentConfidence.toFixed(1)}σ`,
        `선명도 ${quality.blurScore.toFixed(1)}`,
      ]
    : [];
  const signal = [
    `Black 배경 ${detection.blackBackgroundMean.toFixed(1)}`,
    `White 배경 ${detection.whiteBackgroundMean.toFixed(1)}`,
    `암/명 기준 ${detection.darkThreshold}/${detection.brightThreshold}`,
  ];
  if (detection.noDisplay !== 'none') {
    const label = detection.noDisplay === 'full'
      ? '전체 미점등'
      : detection.noDisplay === 'partial'
        ? '부분 미점등'
        : '저휘도 검수(HOLD)';
    return [...qualityParts, label, `평균 휘도 ${detection.meanLuma.toFixed(1)}`, ...signal, ...detection.qualityWarnings].join(' · ');
  }
  const counts = new Map<string, number>();
  for (const d of detection.detections) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);

  const parts = [...qualityParts, `암점 합산 면적비 ${detection.darkAreaPct.toFixed(2)}%`];
  parts.push(...signal);
  if (detection.pattern === 'W') {
    parts.push(
      `W 포화 전체/배경/결함 ${detection.whiteSaturationPct.toFixed(1)}/${detection.backgroundSaturationPct.toFixed(1)}/${detection.localDefectSaturationPct.toFixed(1)}%`,
    );
  }
  const highResolutionLines = detection.detections.filter((item) => item.analysisScale === 'high-resolution-projection').length;
  if (highResolutionLines > 0) parts.push(`원본 고해상도 Line 보조검출 ${highResolutionLines}건`);
  if (detection.detections.length > 0) {
    const meanContrast =
      detection.detections.reduce((sum, item) => sum + item.meanContrast, 0) / detection.detections.length;
    const peakContrast = Math.max(...detection.detections.map((item) => item.peakContrast));
    parts.push(`검출 대비 평균/최대 ${meanContrast.toFixed(1)}/${peakContrast.toFixed(0)}`);
  }
  parts.push(counts.size > 0 ? [...counts].map(([k, n]) => `${k} ×${n}`).join(', ') : '검출 없음');
  if (detection.drivingFlag) parts.push('구동불량 의심');
  parts.push(...detection.qualityWarnings);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- geometry edits

$('apply-mapping').addEventListener('click', () => {
  if (!selected || currentRole === 'viewer') return;
  void (async () => {
    const image = selected!;
    const targetPanelId = Number(mapPanel.value);
    const pattern = mapPattern.value as Pattern;
    const duplicate = images.find(
      (candidate) =>
        candidate.id !== image.id &&
        candidate.panelId === targetPanelId &&
        candidate.pattern === pattern,
    );
    if (duplicate) {
      alert(`대상 패널에 ${pattern} 패턴이 이미 있습니다.`);
      return;
    }
    const oldPanelId = image.panelId;
    const sourcePanel = panels.find((panel) => panel.id === oldPanelId);
    const targetPanel = panels.find((panel) => panel.id === targetPanelId);
    if (!targetPanel) {
      alert('대상 패널을 찾을 수 없습니다.');
      return;
    }
    const crossLot = sourcePanel && sourcePanel.lotId !== targetPanel.lotId;
    const crossModel = sourcePanel && sourcePanel.model && targetPanel.model && sourcePanel.model !== targetPanel.model;
    if (crossLot || crossModel) {
      const mismatch = [crossLot ? `Lot ${sourcePanel?.lotId} → ${targetPanel.lotId}` : '', crossModel ? `Model ${sourcePanel?.model} → ${targetPanel.model}` : '']
        .filter(Boolean)
        .join('\n');
      if (!confirm(`서로 다른 Lot/Model 매핑입니다.\n${mismatch}\n\n감사 이력을 남기고 계속할까요?`)) return;
    }
    try {
      const history = [...(image.mappingHistory ?? []), {
        at: new Date().toISOString(),
        fromPanelId: oldPanelId,
        fromPattern: image.pattern,
        toPanelId: targetPanelId,
        toPattern: pattern,
      }];
      await repo.updateImage(image.id, {
        panelId: targetPanelId,
        pattern,
        originalMapping: image.originalMapping ?? { panelId: oldPanelId, pattern: image.pattern },
        mappingHistory: history,
      });
      invalidateVerdicts();
      closeDetail();
      await reload();
    } catch (err) {
      alert(`패턴 매핑 실패: ${String(err)}`);
    }
  })();
});

$('undo-mapping').addEventListener('click', () => {
  if (!selected || currentRole === 'viewer') return;
  void (async () => {
    const image = selected!;
    const history = [...(image.mappingHistory ?? [])];
    const last = history.pop();
    if (!last) {
      alert('되돌릴 매핑 이력이 없습니다.');
      return;
    }
    const duplicate = images.find((candidate) =>
      candidate.id !== image.id && candidate.panelId === last.fromPanelId && candidate.pattern === last.fromPattern,
    );
    if (duplicate) {
      alert(`이전 패널에 ${last.fromPattern} 패턴이 이미 있어 되돌릴 수 없습니다.`);
      return;
    }
    await repo.updateImage(image.id, {
      panelId: last.fromPanelId,
      pattern: last.fromPattern,
      mappingHistory: history,
    });
    invalidateVerdicts();
    closeDetail();
    await reload();
  })();
});

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
