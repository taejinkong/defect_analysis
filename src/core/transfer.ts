import type { AnnotationRecord, ImageRecord, PanelRecord, Repository } from './records';
import { LABELABLE_DEFECTS, type DefectId } from './settings';

export const EXPORT_VERSION = 1;

export interface ExportedImage {
  pattern: ImageRecord['pattern'];
  activeCx: number;
  activeCy: number;
  activeR: number;
  rotationDeg: number;
  rotationSource: ImageRecord['rotationSource'];
  confirmed: boolean;
  origWidth: number;
  origHeight: number;
  detectOk: boolean;
  fpcbStrength: number;
  annotations: Omit<AnnotationRecord, 'id' | 'imageId'>[];
}

export interface ExportedPanel {
  panelCode: string;
  lotId: string;
  model: string;
  processName: string;
  equipmentId: string;
  purpose: PanelRecord['purpose'];
  uploadedAt: string;
  uploadedBy: string;
  reviewStatus: PanelRecord['reviewStatus'];
  images: ExportedImage[];
}

export interface ExportFile {
  version: number;
  exportedAt: string;
  panels: ExportedPanel[];
}

/**
 * Serialize panels, geometry, and labels to JSON.
 *
 * Images are deliberately excluded. They are the bulk of the data, they are the
 * thing the customer's security policy will not let leave the machine, and a
 * label set is useful on its own for reviewing judgements or seeding a fresh
 * database on the same PC. The UI must state that this is not a full backup.
 */
export async function exportLabels(repo: Repository): Promise<ExportFile> {
  const [panels, images, annotations] = await Promise.all([
    repo.listPanels(),
    repo.listImages(),
    repo.listAnnotations(),
  ]);

  const annotationsByImage = new Map<number, AnnotationRecord[]>();
  for (const annotation of annotations) {
    const list = annotationsByImage.get(annotation.imageId) ?? [];
    list.push(annotation);
    annotationsByImage.set(annotation.imageId, list);
  }

  const imagesByPanel = new Map<number, ImageRecord[]>();
  for (const image of images) {
    const list = imagesByPanel.get(image.panelId) ?? [];
    list.push(image);
    imagesByPanel.set(image.panelId, list);
  }

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    panels: panels
      .filter((panel) => panel.deletedAt === null)
      .map((panel) => ({
        panelCode: panel.panelCode,
        lotId: panel.lotId,
        model: panel.model,
        processName: panel.processName,
        equipmentId: panel.equipmentId,
        purpose: panel.purpose,
        uploadedAt: panel.uploadedAt,
        uploadedBy: panel.uploadedBy,
        reviewStatus: panel.reviewStatus,
        images: (imagesByPanel.get(panel.id) ?? []).map((image) => ({
          pattern: image.pattern,
          activeCx: image.activeCx,
          activeCy: image.activeCy,
          activeR: image.activeR,
          rotationDeg: image.rotationDeg,
          rotationSource: image.rotationSource,
          confirmed: image.confirmed,
          origWidth: image.origWidth,
          origHeight: image.origHeight,
          detectOk: image.detectOk,
          fpcbStrength: image.fpcbStrength,
          annotations: (annotationsByImage.get(image.id) ?? []).map(({ id: _id, imageId: _imageId, ...rest }) => rest),
        })),
      })),
  };
}

export interface ImportResult {
  readonly panels: number;
  readonly images: number;
  readonly annotations: number;
  readonly warnings: string[];
}

const LABELABLE = new Set<DefectId>(LABELABLE_DEFECTS);

/**
 * Load an export back in.
 *
 * Imported panels carry no image blobs, so they cannot be re-analysed; they
 * exist to carry labels and geometry. Rows that fail validation are skipped with
 * a warning rather than aborting the whole file: a single bad annotation should
 * not cost the user the other thousand.
 */
export async function importLabels(repo: Repository, raw: unknown): Promise<ImportResult> {
  const file = raw as Partial<ExportFile> | null;
  if (!file || typeof file !== 'object' || !Array.isArray(file.panels)) {
    throw new Error('내보내기 파일 형식이 아닙니다.');
  }
  if (file.version !== EXPORT_VERSION) {
    throw new Error(`지원하지 않는 버전입니다: ${String(file.version)} (기대값 ${EXPORT_VERSION})`);
  }

  const warnings: string[] = [];
  let panelCount = 0;
  let imageCount = 0;
  let annotationCount = 0;

  for (const panel of file.panels) {
    if (!panel?.lotId || !panel?.panelCode) {
      warnings.push('lotId 또는 panelCode가 없는 패널을 건너뛰었습니다.');
      continue;
    }
    const panelId = await repo.addPanel({
      panelCode: panel.panelCode,
      lotId: panel.lotId,
      model: panel.model ?? '',
      processName: panel.processName ?? '',
      equipmentId: panel.equipmentId ?? '',
      purpose: panel.purpose === 'analysis' ? 'analysis' : 'training',
      uploadedAt: panel.uploadedAt ?? new Date().toISOString(),
      uploadedBy: panel.uploadedBy ?? '',
      reviewStatus: panel.reviewStatus ?? 'pending',
      deletedAt: null,
    });
    panelCount++;

    for (const image of panel.images ?? []) {
      const imageId = await repo.addImage({
        panelId,
        pattern: image.pattern,
        // No pixels came with the export. An empty blob keeps the record shape
        // honest and makes "this panel cannot be re-analysed" checkable.
        originalBlob: new Blob([], { type: 'application/octet-stream' }),
        origWidth: image.origWidth ?? 0,
        origHeight: image.origHeight ?? 0,
        activeCx: image.activeCx ?? 0,
        activeCy: image.activeCy ?? 0,
        activeR: image.activeR ?? 0,
        rotationDeg: image.rotationDeg ?? 0,
        rotationSource: image.rotationSource === 'manual' ? 'manual' : 'auto',
        confirmed: Boolean(image.confirmed),
        detectOk: Boolean(image.detectOk),
        detectMessage: '',
        fpcbStrength: image.fpcbStrength ?? 0,
      });
      imageCount++;

      for (const annotation of image.annotations ?? []) {
        if (!LABELABLE.has(annotation.defectId)) {
          warnings.push(`라벨링 대상이 아닌 불량 ${annotation.defectId}를 건너뛰었습니다.`);
          continue;
        }
        await repo.addAnnotation({ ...annotation, imageId });
        annotationCount++;
      }
    }
  }

  return { panels: panelCount, images: imageCount, annotations: annotationCount, warnings };
}

/** An imported panel has no pixels; analysis must skip it. */
export function hasPixels(image: ImageRecord): boolean {
  return image.originalBlob.size > 0;
}
