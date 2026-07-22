import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbRepository } from './db';
import type { NewAnnotation, NewImage, NewPanel, Repository } from './records';
import { exportLabels, hasPixels, importLabels } from './transfer';
import { createThresholdConfig } from './thresholdConfig';

let dbSeq = 0;

async function freshRepo(): Promise<Repository> {
  // A new database per test: fake-indexeddb persists across tests in a file.
  return IndexedDbRepository.open(`test_${dbSeq++}`);
}

function panel(overrides: Partial<NewPanel> = {}): NewPanel {
  return {
    panelCode: 'P001',
    lotId: 'LOT1',
    model: 'W1',
    processName: 'Cell',
    equipmentId: 'EQ-01',
    purpose: 'training',
    uploadedAt: '2026-07-09T00:00:00.000Z',
    uploadedBy: 'tester',
    reviewStatus: 'pending',
    deletedAt: null,
    ...overrides,
  };
}

function image(panelId: number, overrides: Partial<NewImage> = {}): NewImage {
  return {
    panelId,
    pattern: 'R',
    originalBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    origWidth: 640,
    origHeight: 640,
    activeCx: 320,
    activeCy: 320,
    activeR: 240,
    rotationDeg: 12.5,
    rotationSource: 'manual',
    confirmed: true,
    detectOk: true,
    detectMessage: '',
    fpcbStrength: 12,
    ...overrides,
  };
}

function annotation(imageId: number, overrides: Partial<NewAnnotation> = {}): NewAnnotation {
  return {
    imageId,
    defectId: 'D004',
    labelSource: 'manual',
    geomType: 'point',
    x: 300,
    y: 200,
    x2: null,
    y2: null,
    areaPx: 0,
    areaRatio: 0,
    rRatio: 0.3,
    angleDeg: 120,
    region: 'center',
    confidence: 1,
    reviewStatus: 'pending',
    createdAt: '2026-07-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('IndexedDbRepository', () => {
  let repo: Repository;
  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('round-trips a panel', async () => {
    const id = await repo.addPanel(panel());
    const [stored] = await repo.listPanels();
    expect(stored!.id).toBe(id);
    expect(stored!.lotId).toBe('LOT1');
  });

  it('preserves a Blob through storage', async () => {
    // Blobs are structured-cloned, not stringified. If this ever regresses to
    // base64 the size check catches it.
    const panelId = await repo.addPanel(panel());
    await repo.addImage(image(panelId));
    const [stored] = await repo.listImages(panelId);
    expect(stored!.originalBlob).toBeInstanceOf(Blob);
    expect(stored!.originalBlob.size).toBe(3);
    expect(await stored!.originalBlob.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  it('filters images by panel', async () => {
    const a = await repo.addPanel(panel({ panelCode: 'A' }));
    const b = await repo.addPanel(panel({ panelCode: 'B' }));
    await repo.addImage(image(a, { pattern: 'R' }));
    await repo.addImage(image(a, { pattern: 'G' }));
    await repo.addImage(image(b, { pattern: 'R' }));

    expect(await repo.listImages(a)).toHaveLength(2);
    expect(await repo.listImages(b)).toHaveLength(1);
    expect(await repo.listImages()).toHaveLength(3);
  });

  it('rejects a duplicate pattern within one panel', async () => {
    const panelId = await repo.addPanel(panel());
    await repo.addImage(image(panelId, { pattern: 'R' }));
    await expect(repo.addImage(image(panelId, { pattern: 'R' }))).rejects.toThrow();
  });

  it('allows the same pattern in different panels', async () => {
    const a = await repo.addPanel(panel({ panelCode: 'A' }));
    const b = await repo.addPanel(panel({ panelCode: 'B' }));
    await repo.addImage(image(a, { pattern: 'W' }));
    await expect(repo.addImage(image(b, { pattern: 'W' }))).resolves.toBeTypeOf('number');
  });

  it('patches a record without dropping untouched fields', async () => {
    const panelId = await repo.addPanel(panel());
    const imageId = await repo.addImage(image(panelId));
    await repo.updateImage(imageId, { rotationDeg: 90 });

    const [stored] = await repo.listImages(panelId);
    expect(stored!.rotationDeg).toBe(90);
    expect(stored!.originalBlob.size).toBe(3);
    expect(stored!.activeR).toBe(240);
  });

  it('throws when patching a missing record', async () => {
    await expect(repo.updateImage(9999, { rotationDeg: 1 })).rejects.toThrow('찾을 수 없습니다');
  });

  it('adds, lists and deletes annotations', async () => {
    const panelId = await repo.addPanel(panel());
    const imageId = await repo.addImage(image(panelId));
    const first = await repo.addAnnotation(annotation(imageId));
    await repo.addAnnotation(annotation(imageId, { defectId: 'D001' }));

    expect(await repo.listAnnotations(imageId)).toHaveLength(2);
    await repo.deleteAnnotation(first);
    const rest = await repo.listAnnotations(imageId);
    expect(rest).toHaveLength(1);
    expect(rest[0]!.defectId).toBe('D001');
  });

  it('cascades a panel delete to its images and annotations', async () => {
    const panelId = await repo.addPanel(panel());
    const imageId = await repo.addImage(image(panelId));
    await repo.addAnnotation(annotation(imageId));

    const other = await repo.addPanel(panel({ panelCode: 'KEEP' }));
    const otherImage = await repo.addImage(image(other));
    await repo.addAnnotation(annotation(otherImage));

    await repo.deletePanel(panelId);

    expect(await repo.listPanels()).toHaveLength(1);
    expect(await repo.listImages()).toHaveLength(1);
    // The orphan check that matters: no annotation may survive its image.
    expect(await repo.listAnnotations()).toHaveLength(1);
    expect((await repo.listAnnotations())[0]!.imageId).toBe(otherImage);
  });

  it('clears everything', async () => {
    const panelId = await repo.addPanel(panel());
    const imageId = await repo.addImage(image(panelId));
    await repo.addAnnotation(annotation(imageId));
    await repo.putEmbedding(embedding(panelId));
    await repo.clear();

    expect(await repo.listPanels()).toHaveLength(0);
    expect(await repo.listImages()).toHaveLength(0);
    expect(await repo.listAnnotations()).toHaveLength(0);
    expect(await repo.listEmbeddings()).toHaveLength(0);
    expect(await repo.listPreprocessingResults()).toHaveLength(0);
    expect(await repo.listDetectionResults()).toHaveLength(0);
    expect(await repo.listPanelDecisions()).toHaveLength(0);
    expect(await repo.listThresholdConfigs()).toHaveLength(0);
    expect(await repo.listReviews()).toHaveLength(0);
  });
});

describe('schema v3 evidence and migration', () => {
  it('stores replaceable preprocessing, detection, decision and threshold evidence', async () => {
    const repo = await freshRepo();
    const panelId = await repo.addPanel(panel());
    const imageId = await repo.addImage(image(panelId));
    const now = '2026-07-22T00:00:00.000Z';

    await repo.putPreprocessingResult({
      imageId,
      thresholdVersion: '1.0.0',
      schemaVersion: 3,
      createdAt: now,
      updatedAt: now,
      status: 'PASS',
      reviewReasons: [],
      metricsVersion: '1.0.0',
      activeAreaDetected: true,
      centerX: 320,
      centerY: 320,
      radius: 240,
      centerOffsetRatio: 0,
      radiusConfidence: 0.9,
      circularity: 0.99,
      fpcbAlignmentConfidence: 10,
      rotationDeg: 0,
      clippingRatio: 0,
      blurScore: 30,
      meanLuminance: 190,
      luminanceStdDev: 4,
      saturationRatio: 0,
      activePixelCoverage: 0.96,
      patternCompleteness: 1,
    });
    await repo.replaceDetectionResults(panelId, [{
      panelId,
      imageId,
      detectorId: 'bright-dot',
      detectorName: 'Bright Dot Detector',
      detectorVersion: '2.0.0',
      thresholdVersion: '1.0.0',
      sourcePattern: 'R',
      kind: 'bright-dot',
      x: 256,
      y: 256,
      xRatio: 0,
      yRatio: 0,
      rRatio: 0,
      angleDeg: 0,
      region: 'center',
      bbox: [250, 250, 262, 262],
      centroid: [256, 256],
      maskAreaPx: 20,
      defectAreaRatio: 0.001,
      meanContrast: 40,
      peakContrast: 60,
      confidence: 0.9,
      ruleResult: 'D004',
      similarityResult: null,
      finalSuggestedLabel: 'D004',
      reviewStatus: 'pending',
      reviewReasons: [],
      schemaVersion: 3,
      createdAt: now,
      updatedAt: now,
    }]);
    await repo.putPanelDecision({
      panelId,
      thresholdVersion: '1.0.0',
      detectorVersion: '2.0.0',
      ruleResult: 'D004',
      ruleConfidence: 0.6,
      knnResult: null,
      knnSimilarityScore: null,
      agreementStatus: 'NOT_AVAILABLE',
      finalSuggestedLabel: 'D004',
      finalConfidence: 0.6,
      reviewStatus: 'pending',
      reviewReasons: [],
      processingMs: 12,
      schemaVersion: 3,
      createdAt: now,
      updatedAt: now,
    });
    await repo.putReview({
      panelId,
      originalDecisionId: null,
      reviewerFinalLabel: 'D004',
      reviewer: 'reviewer',
      notes: 'confirmed',
      reviewDate: now,
      status: 'approved',
      reviewReasons: [],
      schemaVersion: 4,
      createdAt: now,
      updatedAt: now,
    });
    const config = createThresholdConfig(undefined, '1.0.0', 'admin', now);
    await repo.putThresholdConfig({
      version: config.version,
      active: true,
      config,
      schemaVersion: 3,
      createdAt: now,
      updatedAt: now,
    });

    expect(await repo.listPreprocessingResults(imageId)).toHaveLength(1);
    expect(await repo.listDetectionResults(panelId)).toHaveLength(1);
    expect(await repo.listPanelDecisions(panelId)).toHaveLength(1);
    expect((await repo.listReviews(panelId))[0]!.notes).toBe('confirmed');
    expect((await repo.listThresholdConfigs())[0]!.active).toBe(true);
  });

  it('upgrades an old v2 database without deleting its panel rows', async () => {
    const name = `migration_${dbSeq++}`;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 2);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('panels', { keyPath: 'id', autoIncrement: true });
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('panels', 'readwrite');
        tx.objectStore('panels').add(panel({ panelCode: 'LEGACY' }));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });

    const migrated = await IndexedDbRepository.open(name);
    expect((await migrated.listPanels())[0]!.panelCode).toBe('LEGACY');
    expect(await migrated.listPreprocessingResults()).toEqual([]);
    expect(await migrated.listDetectionResults()).toEqual([]);
    expect(await migrated.listPanelDecisions()).toEqual([]);
    expect(await migrated.listThresholdConfigs()).toEqual([]);
  });
});

function embedding(panelId: number) {
  return {
    panelId,
    vector: new Float32Array([1, 0, 0]).buffer,
    dim: 3,
    labelDefectId: 'D004' as const,
    isSearchable: true,
    featureVersion: 'v1',
    createdAt: '2026-07-09T00:00:00.000Z',
  };
}

describe('embeddings', () => {
  let repo: Repository;
  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('stores and lists an embedding', async () => {
    const panelId = await repo.addPanel(panel());
    await repo.putEmbedding(embedding(panelId));
    const [stored] = await repo.listEmbeddings();
    expect(stored!.panelId).toBe(panelId);
    expect(new Float32Array(stored!.vector)).toEqual(new Float32Array([1, 0, 0]));
  });

  it('replaces rather than accumulates per panel', async () => {
    const panelId = await repo.addPanel(panel());
    await repo.putEmbedding(embedding(panelId));
    await repo.putEmbedding({ ...embedding(panelId), labelDefectId: 'D001' });
    const rows = await repo.listEmbeddings();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.labelDefectId).toBe('D001');
  });

  it('deletes by panel', async () => {
    const a = await repo.addPanel(panel({ panelCode: 'A' }));
    const b = await repo.addPanel(panel({ panelCode: 'B' }));
    await repo.putEmbedding(embedding(a));
    await repo.putEmbedding(embedding(b));
    await repo.deleteEmbeddingsByPanel(a);
    const rows = await repo.listEmbeddings();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.panelId).toBe(b);
  });

  it('is removed when its panel is deleted', async () => {
    const panelId = await repo.addPanel(panel());
    await repo.putEmbedding(embedding(panelId));
    await repo.deletePanel(panelId);
    expect(await repo.listEmbeddings()).toHaveLength(0);
  });
});

describe('export and import', () => {
  it('round-trips panels, geometry and labels', async () => {
    const source = await freshRepo();
    const panelId = await source.addPanel(panel({ reviewStatus: 'approved' }));
    const imageId = await source.addImage(image(panelId));
    await source.addAnnotation(annotation(imageId, { defectId: 'D005', reviewStatus: 'approved' }));

    const file = await exportLabels(source);
    expect(file.panels).toHaveLength(1);
    expect(file.panels[0]!.images[0]!.annotations[0]!.defectId).toBe('D005');
    // JSON must survive a serialize/parse cycle unchanged.
    const wire = JSON.parse(JSON.stringify(file));

    const target = await freshRepo();
    const result = await importLabels(target, wire);
    expect(result).toMatchObject({ panels: 1, images: 1, annotations: 1 });

    const [restoredPanel] = await target.listPanels();
    expect(restoredPanel!.reviewStatus).toBe('approved');
    const [restoredImage] = await target.listImages();
    expect(restoredImage!.rotationDeg).toBe(12.5);
    const [restoredAnnotation] = await target.listAnnotations();
    expect(restoredAnnotation!.defectId).toBe('D005');
    expect(restoredAnnotation!.imageId).toBe(restoredImage!.id);
  });

  it('marks imported images as having no pixels', async () => {
    const source = await freshRepo();
    const panelId = await source.addPanel(panel());
    await source.addImage(image(panelId));

    const target = await freshRepo();
    await importLabels(target, JSON.parse(JSON.stringify(await exportLabels(source))));

    const [imported] = await target.listImages();
    // Images are not exported, so an imported panel cannot be re-analysed.
    // Anything that tries must be able to tell.
    expect(hasPixels(imported!)).toBe(false);
    const [original] = await source.listImages();
    expect(hasPixels(original!)).toBe(true);
  });

  it('omits soft-deleted panels', async () => {
    const repo = await freshRepo();
    const kept = await repo.addPanel(panel({ panelCode: 'KEEP' }));
    const gone = await repo.addPanel(panel({ panelCode: 'GONE' }));
    await repo.updatePanel(gone, { deletedAt: new Date().toISOString() });
    void kept;

    const file = await exportLabels(repo);
    expect(file.panels.map((p) => p.panelCode)).toEqual(['KEEP']);
  });

  it('skips non-labelable defect ids with a warning', async () => {
    const target = await freshRepo();
    const result = await importLabels(target, {
      version: 1,
      exportedAt: '2026-07-09T00:00:00.000Z',
      panels: [
        {
          ...panel(),
          images: [
            {
              pattern: 'R',
              activeCx: 1,
              activeCy: 1,
              activeR: 1,
              rotationDeg: 0,
              rotationSource: 'auto',
              confirmed: false,
              origWidth: 1,
              origHeight: 1,
              // 복수불량 is a derived judgement, never a label.
              annotations: [annotation(0, { defectId: 'D011' }), annotation(0, { defectId: 'D004' })],
            },
          ],
        },
      ],
    });

    expect(result.annotations).toBe(1);
    expect(result.warnings.join(' ')).toContain('D011');
  });

  it('rejects a foreign or future file', async () => {
    const repo = await freshRepo();
    await expect(importLabels(repo, { hello: 'world' })).rejects.toThrow('형식이 아닙니다');
    await expect(importLabels(repo, { version: 99, panels: [] })).rejects.toThrow('지원하지 않는 버전');
  });

  it('skips a panel missing its identifiers but keeps the rest', async () => {
    const repo = await freshRepo();
    const result = await importLabels(repo, {
      version: 1,
      exportedAt: '2026-07-09T00:00:00.000Z',
      panels: [{ ...panel(), lotId: '', images: [] }, { ...panel(), images: [] }],
    });
    expect(result.panels).toBe(1);
    expect(result.warnings).toHaveLength(1);
  });
});
