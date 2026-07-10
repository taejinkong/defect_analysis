import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbRepository } from './db';
import type { NewAnnotation, NewImage, NewPanel, Repository } from './records';
import { exportLabels, hasPixels, importLabels } from './transfer';

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
    await repo.clear();

    expect(await repo.listPanels()).toHaveLength(0);
    expect(await repo.listImages()).toHaveLength(0);
    expect(await repo.listAnnotations()).toHaveLength(0);
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
