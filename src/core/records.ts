import type { Pattern } from './types';
import type { DefectId } from './settings';
import type { Region } from './geometry';

export type Purpose = 'training' | 'analysis';
export type LabelSource = 'manual' | 'ai' | 'corrected';
export type GeomType = 'point' | 'line' | 'box' | 'mask';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/** Records mirror docs/database_schema.md so the shape survives a move to a server DB. */

export interface PanelRecord {
  id: number;
  panelCode: string;
  lotId: string;
  model: string;
  processName: string;
  equipmentId: string;
  purpose: Purpose;
  uploadedAt: string;
  uploadedBy: string;
  reviewStatus: ReviewStatus;
  deletedAt: string | null;
}

export interface ImageRecord {
  id: number;
  panelId: number;
  pattern: Pattern;
  originalBlob: Blob;
  origWidth: number;
  origHeight: number;
  activeCx: number;
  activeCy: number;
  activeR: number;
  rotationDeg: number;
  rotationSource: 'auto' | 'manual';
  /** True once the user has signed off on the circle and rotation. */
  confirmed: boolean;
  /** Cached so reopening the app does not re-run circle detection on every image. */
  detectOk: boolean;
  detectMessage: string;
  /** Robust-sigma score of the FPCB estimate. Below ~3 it is not trustworthy. */
  fpcbStrength: number;
}

export interface AnnotationRecord {
  id: number;
  imageId: number;
  defectId: DefectId;
  labelSource: LabelSource;
  geomType: GeomType;
  /** Representative point, always populated, in normalized frame coordinates. */
  x: number;
  y: number;
  x2: number | null;
  y2: number | null;
  areaPx: number;
  areaRatio: number;
  rRatio: number;
  angleDeg: number;
  region: Region;
  confidence: number;
  reviewStatus: ReviewStatus;
  createdAt: string;
}

export interface EmbeddingRecord {
  id: number;
  panelId: number;
  /** float32 L2-normalized descriptor, raw bytes. */
  vector: ArrayBuffer;
  dim: number;
  /** The panel's representative label, the class this vector votes for. */
  labelDefectId: DefectId;
  /** Only approved training panels are searched. */
  isSearchable: boolean;
  featureVersion: string;
  createdAt: string;
}

export type NewPanel = Omit<PanelRecord, 'id'>;
export type NewImage = Omit<ImageRecord, 'id'>;
export type NewAnnotation = Omit<AnnotationRecord, 'id'>;
export type NewEmbedding = Omit<EmbeddingRecord, 'id'>;

/**
 * Storage seam.
 *
 * The app talks only to this interface, so the IndexedDB implementation can be
 * replaced by a REST client when the tool moves to a shared server without
 * touching anything above it. See docs/PRD.md section 12.5.
 */
export interface Repository {
  addPanel(panel: NewPanel): Promise<number>;
  updatePanel(id: number, patch: Partial<NewPanel>): Promise<void>;
  listPanels(): Promise<PanelRecord[]>;
  deletePanel(id: number): Promise<void>;

  addImage(image: NewImage): Promise<number>;
  updateImage(id: number, patch: Partial<NewImage>): Promise<void>;
  listImages(panelId?: number): Promise<ImageRecord[]>;

  addAnnotation(annotation: NewAnnotation): Promise<number>;
  updateAnnotation(id: number, patch: Partial<NewAnnotation>): Promise<void>;
  deleteAnnotation(id: number): Promise<void>;
  listAnnotations(imageId?: number): Promise<AnnotationRecord[]>;

  putEmbedding(embedding: NewEmbedding): Promise<number>;
  listEmbeddings(): Promise<EmbeddingRecord[]>;
  deleteEmbeddingsByPanel(panelId: number): Promise<void>;

  clear(): Promise<void>;
}
