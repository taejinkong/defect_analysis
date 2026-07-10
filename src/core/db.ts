import type {
  AnnotationRecord,
  EmbeddingRecord,
  ImageRecord,
  NewAnnotation,
  NewEmbedding,
  NewImage,
  NewPanel,
  PanelRecord,
  Repository,
} from './records';

const DB_NAME = 'defect_analysis';
const DB_VERSION = 2;

const PANELS = 'panels';
const IMAGES = 'images';
const ANNOTATIONS = 'annotations';
const EMBEDDINGS = 'embeddings';

/**
 * IndexedDB-backed repository.
 *
 * Images live here as Blobs rather than data URLs: a base64 string costs a third
 * more space and forces a decode on every read. Nothing is ever sent anywhere;
 * this is the whole persistence layer of the app.
 *
 * Clearing site data destroys it. The JSON export is the only durable backup,
 * and the UI says so.
 */
export class IndexedDbRepository implements Repository {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = DB_NAME): Promise<IndexedDbRepository> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, DB_VERSION);
      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB를 열 수 없습니다.'));
      request.onblocked = () => reject(new Error('다른 탭이 이 앱을 열고 있어 DB를 갱신할 수 없습니다.'));
    });
    return new IndexedDbRepository(db);
  }

  /** Best-effort request for storage the browser will not evict on its own. */
  static async requestPersistence(): Promise<boolean> {
    if (!navigator.storage?.persist) return false;
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  addPanel = (panel: NewPanel): Promise<number> => this.add(PANELS, panel);
  updatePanel = (id: number, patch: Partial<NewPanel>): Promise<void> => this.patch(PANELS, id, patch);
  listPanels = (): Promise<PanelRecord[]> => this.all<PanelRecord>(PANELS);

  addImage = (image: NewImage): Promise<number> => this.add(IMAGES, image);
  updateImage = (id: number, patch: Partial<NewImage>): Promise<void> => this.patch(IMAGES, id, patch);

  addAnnotation = (annotation: NewAnnotation): Promise<number> => this.add(ANNOTATIONS, annotation);
  updateAnnotation = (id: number, patch: Partial<NewAnnotation>): Promise<void> =>
    this.patch(ANNOTATIONS, id, patch);

  async listImages(panelId?: number): Promise<ImageRecord[]> {
    if (panelId === undefined) return this.all<ImageRecord>(IMAGES);
    return this.byIndex<ImageRecord>(IMAGES, 'panelId', panelId);
  }

  async listAnnotations(imageId?: number): Promise<AnnotationRecord[]> {
    if (imageId === undefined) return this.all<AnnotationRecord>(ANNOTATIONS);
    return this.byIndex<AnnotationRecord>(ANNOTATIONS, 'imageId', imageId);
  }

  async deleteAnnotation(id: number): Promise<void> {
    await this.run(ANNOTATIONS, 'readwrite', (store) => store.delete(id));
  }

  /** One embedding per panel: replace any existing row rather than accumulate. */
  async putEmbedding(embedding: NewEmbedding): Promise<number> {
    const tx = this.db.transaction(EMBEDDINGS, 'readwrite');
    const store = tx.objectStore(EMBEDDINGS);
    const existing = await request<EmbeddingRecord[]>(store.index('panelId').getAll(embedding.panelId));
    for (const row of existing) store.delete(row.id);
    const key = await request<IDBValidKey>(store.add(embedding as object));
    await done(tx);
    return key as number;
  }

  listEmbeddings = (): Promise<EmbeddingRecord[]> => this.all<EmbeddingRecord>(EMBEDDINGS);

  async deleteEmbeddingsByPanel(panelId: number): Promise<void> {
    const tx = this.db.transaction(EMBEDDINGS, 'readwrite');
    const store = tx.objectStore(EMBEDDINGS);
    const rows = await request<EmbeddingRecord[]>(store.index('panelId').getAll(panelId));
    for (const row of rows) store.delete(row.id);
    await done(tx);
  }

  /**
   * Remove a panel and everything hanging off it.
   *
   * One transaction across all three stores, so a crash mid-delete cannot leave
   * annotations pointing at an image that no longer exists.
   */
  async deletePanel(id: number): Promise<void> {
    const tx = this.db.transaction([PANELS, IMAGES, ANNOTATIONS, EMBEDDINGS], 'readwrite');
    const images = await request<ImageRecord[]>(tx.objectStore(IMAGES).index('panelId').getAll(id));
    for (const image of images) {
      const annotations = await request<AnnotationRecord[]>(
        tx.objectStore(ANNOTATIONS).index('imageId').getAll(image.id),
      );
      for (const annotation of annotations) tx.objectStore(ANNOTATIONS).delete(annotation.id);
      tx.objectStore(IMAGES).delete(image.id);
    }
    const embeddings = await request<EmbeddingRecord[]>(tx.objectStore(EMBEDDINGS).index('panelId').getAll(id));
    for (const embedding of embeddings) tx.objectStore(EMBEDDINGS).delete(embedding.id);
    tx.objectStore(PANELS).delete(id);
    await done(tx);
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([PANELS, IMAGES, ANNOTATIONS, EMBEDDINGS], 'readwrite');
    for (const name of [PANELS, IMAGES, ANNOTATIONS, EMBEDDINGS]) tx.objectStore(name).clear();
    await done(tx);
  }

  private async add<T>(storeName: string, value: T): Promise<number> {
    const tx = this.db.transaction(storeName, 'readwrite');
    const key = await request<IDBValidKey>(tx.objectStore(storeName).add(value as object));
    await done(tx);
    return key as number;
  }

  private async patch<T>(storeName: string, id: number, values: Partial<T>): Promise<void> {
    const tx = this.db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const existing = await request<T & { id: number }>(store.get(id));
    if (!existing) throw new Error(`${storeName}#${id} 레코드를 찾을 수 없습니다.`);
    store.put({ ...existing, ...values });
    await done(tx);
  }

  private async all<T>(storeName: string): Promise<T[]> {
    const tx = this.db.transaction(storeName, 'readonly');
    const rows = await request<T[]>(tx.objectStore(storeName).getAll());
    await done(tx);
    return rows;
  }

  private async byIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T[]> {
    const tx = this.db.transaction(storeName, 'readonly');
    const rows = await request<T[]>(tx.objectStore(storeName).index(indexName).getAll(key));
    await done(tx);
    return rows;
  }

  private async run(
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest,
  ): Promise<void> {
    const tx = this.db.transaction(storeName, mode);
    fn(tx.objectStore(storeName));
    await done(tx);
  }
}

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(PANELS)) {
    const panels = db.createObjectStore(PANELS, { keyPath: 'id', autoIncrement: true });
    panels.createIndex('lotId', 'lotId');
    panels.createIndex('purpose', 'purpose');
    // Not unique: the same panel may be uploaded once for training and once for
    // analysis, and re-uploading after a delete must not collide with a tombstone.
    panels.createIndex('panelKey', ['lotId', 'panelCode', 'purpose']);
  }
  if (!db.objectStoreNames.contains(IMAGES)) {
    const images = db.createObjectStore(IMAGES, { keyPath: 'id', autoIncrement: true });
    images.createIndex('panelId', 'panelId');
    images.createIndex('panelPattern', ['panelId', 'pattern'], { unique: true });
  }
  if (!db.objectStoreNames.contains(ANNOTATIONS)) {
    const annotations = db.createObjectStore(ANNOTATIONS, { keyPath: 'id', autoIncrement: true });
    annotations.createIndex('imageId', 'imageId');
    annotations.createIndex('defectId', 'defectId');
    annotations.createIndex('reviewStatus', 'reviewStatus');
  }
  // Added in v2. createObjectStore inside onupgradeneeded runs for a v1 -> v2
  // bump too, so existing databases gain the store without losing their data.
  if (!db.objectStoreNames.contains(EMBEDDINGS)) {
    // No index on isSearchable: IndexedDB cannot key on a boolean. The set of
    // searchable panels is small, so listEmbeddings loads all and filters in JS.
    const embeddings = db.createObjectStore(EMBEDDINGS, { keyPath: 'id', autoIncrement: true });
    embeddings.createIndex('panelId', 'panelId');
  }
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 요청이 실패했습니다.'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 트랜잭션이 실패했습니다.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 트랜잭션이 중단되었습니다.'));
  });
}
