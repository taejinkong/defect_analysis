import type { Pattern } from './types';
import type { DefectId } from './settings';
import type { Region } from './geometry';
import type { BlobKind } from './detectors';
import type { PreprocessingQuality } from './preprocessingQuality';
import type { AgreementStatus, ReviewReason } from './review';
import type { ThresholdConfig } from './thresholdConfig';

export type Purpose = 'training' | 'analysis';
export type LabelSource = 'manual' | 'ai' | 'corrected';
export type GeomType = 'point' | 'line' | 'box' | 'mask';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type UserRole = 'admin' | 'reviewer' | 'viewer';

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
  captureProfileVersion?: string;
  goldenProfileVersion?: string;
  inspectionMode?: 'DECISION_SUPPORT' | 'SORTING_EXPORT';
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
  /** Added in schema v3. Missing on legacy rows and treated as an uploaded real image. */
  originalFilename?: string;
  sourceType?: 'upload' | 'synthetic' | 'imported';
  synthetic?: boolean;
  captureProfileVersion?: string;
  goldenProfileVersion?: string;
  originalMapping?: { readonly panelId: number; readonly pattern: Pattern };
  mappingHistory?: readonly {
    readonly at: string;
    readonly fromPanelId: number;
    readonly fromPattern: Pattern;
    readonly toPanelId: number;
    readonly toPattern: Pattern;
  }[];
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
  /** Optional run-length encoded 512×512 segmentation mask for area-accurate manual correction. */
  maskRle?: string;
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

export interface EvidenceBase {
  id: number;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PreprocessingResultRecord extends EvidenceBase, PreprocessingQuality {
  imageId: number;
  thresholdVersion: string;
  captureProfileVersion?: string;
  goldenProfileVersion?: string;
}

export interface DetectionResultRecord extends EvidenceBase {
  panelId: number;
  imageId: number;
  detectorId: string;
  detectorName: string;
  detectorVersion: string;
  thresholdVersion: string;
  sourcePattern: Pattern;
  kind: BlobKind;
  x: number;
  y: number;
  xRatio: number;
  yRatio: number;
  rRatio: number;
  angleDeg: number;
  region: Region;
  bbox: readonly [number, number, number, number];
  centroid: readonly [number, number];
  maskAreaPx: number;
  defectAreaRatio: number;
  meanContrast: number;
  peakContrast: number;
  confidence: number;
  ruleResult: DefectId;
  similarityResult: DefectId | null;
  finalSuggestedLabel: DefectId;
  reviewStatus: ReviewStatus;
  reviewReasons: ReviewReason[];
  continuity?: number;
  gapRatio?: number;
  edgeContact?: boolean;
  analysisScale?: 'normalized-component' | 'high-resolution-projection';
}

export interface PanelDecisionRecord extends EvidenceBase {
  panelId: number;
  thresholdVersion: string;
  detectorVersion: string;
  ruleResult: DefectId;
  ruleConfidence: number;
  knnResult: DefectId | null;
  knnSimilarityScore: number | null;
  agreementStatus: AgreementStatus;
  finalSuggestedLabel: DefectId;
  finalConfidence?: number;
  reviewStatus: ReviewStatus;
  reviewReasons: ReviewReason[];
  processingMs: number;
  sortingDisposition?: 'OK' | 'NG' | 'HOLD';
  captureProfileVersion?: string;
  goldenProfileVersion?: string;
}

export interface ThresholdConfigRecord extends EvidenceBase {
  version: string;
  active: boolean;
  config: ThresholdConfig;
}

export interface ReviewRecord extends EvidenceBase {
  panelId: number;
  originalDecisionId: number | null;
  reviewerFinalLabel: DefectId;
  reviewer: string;
  notes: string;
  reviewDate: string;
  status: Extract<ReviewStatus, 'approved' | 'rejected'>;
  reviewReasons: ReviewReason[];
}

export type NewPanel = Omit<PanelRecord, 'id'>;
export type NewImage = Omit<ImageRecord, 'id'>;
export type NewAnnotation = Omit<AnnotationRecord, 'id'>;
export type NewEmbedding = Omit<EmbeddingRecord, 'id'>;
export type NewPreprocessingResult = Omit<PreprocessingResultRecord, 'id'>;
export type NewDetectionResult = Omit<DetectionResultRecord, 'id'>;
export type NewPanelDecision = Omit<PanelDecisionRecord, 'id'>;
export type NewThresholdConfig = Omit<ThresholdConfigRecord, 'id'>;
export type NewReview = Omit<ReviewRecord, 'id'>;

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

  putPreprocessingResult(result: NewPreprocessingResult): Promise<number>;
  listPreprocessingResults(imageId?: number): Promise<PreprocessingResultRecord[]>;
  replaceDetectionResults(panelId: number, results: NewDetectionResult[]): Promise<void>;
  listDetectionResults(panelId?: number): Promise<DetectionResultRecord[]>;
  putPanelDecision(decision: NewPanelDecision): Promise<number>;
  listPanelDecisions(panelId?: number): Promise<PanelDecisionRecord[]>;
  putThresholdConfig(config: NewThresholdConfig): Promise<number>;
  listThresholdConfigs(): Promise<ThresholdConfigRecord[]>;
  putReview(review: NewReview): Promise<number>;
  listReviews(panelId?: number): Promise<ReviewRecord[]>;

  clear(): Promise<void>;
}
