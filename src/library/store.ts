/**
 * Where the player's tracks live: the original file plus its TrackMeta, on this device only.
 * An IndexedDB implementation for the game and an in-memory one for tests (and for private
 * browsing, where IndexedDB is missing or refuses to store anything).
 */
import type { TrackMeta } from '../core/types';

export interface StoredEnvelope {
  /** frames per second */
  rate: number;
  data: Float32Array;
}

/** Everything known about a user track, apart from the file itself. */
export interface TrackRecord {
  id: string;
  meta: TrackMeta;
  /** Date.now() at import; the list shows the newest first */
  addedAt: number;
  fileName: string;
  fileSize: number;
  fileType: string;
  /** loudness envelope from the analysis: the sections can be re-estimated for a new grid */
  envelope: StoredEnvelope | null;
}

export interface TrackStore {
  readonly kind: 'indexeddb' | 'memory';
  /** every stored record */
  list(): Promise<TrackRecord[]>;
  /** store a new track (record + file) in one go; rejects when there is no room */
  add(record: TrackRecord, file: Blob): Promise<void>;
  /** update a record (grid fix) */
  update(record: TrackRecord): Promise<void>;
  /** the original file, or undefined when it is gone */
  getFile(id: string): Promise<Blob | undefined>;
  remove(id: string): Promise<void>;
}

export function createMemoryStore(): TrackStore {
  const records = new Map<string, TrackRecord>();
  const files = new Map<string, Blob>();
  return {
    kind: 'memory',
    async list() {
      return [...records.values()].map((r) => structuredCloneRecord(r));
    },
    async add(record, file) {
      records.set(record.id, structuredCloneRecord(record));
      files.set(record.id, file);
    },
    async update(record) {
      if (records.has(record.id)) records.set(record.id, structuredCloneRecord(record));
    },
    async getFile(id) {
      return files.get(id);
    },
    async remove(id) {
      records.delete(id);
      files.delete(id);
    },
  };
}

/** A copy, so the store never shares objects with the library (like IndexedDB). */
function structuredCloneRecord(r: TrackRecord): TrackRecord {
  return {
    ...r,
    meta: { ...r.meta, grid: { ...r.meta.grid }, sections: r.meta.sections.map((s) => ({ ...s })), art: { ...r.meta.art } },
    envelope: r.envelope ? { rate: r.envelope.rate, data: r.envelope.data.slice() } : null,
  };
}

// ───────────────────────────── IndexedDB ─────────────────────────────

const DB_NAME = 'djhermann-library';
const DB_VERSION = 1;
const RECORDS = 'tracks';
const FILES = 'files';

interface FileRow {
  /** the file's bytes: an ArrayBuffer rather than a Blob, which older WebKit stored unreliably */
  data: ArrayBuffer;
  type: string;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

/**
 * The IndexedDB store, or a rejection when IndexedDB is missing or refuses to open (some private
 * browsing modes). Opening is given a few seconds: a hung open must not hang the library.
 */
export async function openIdbStore(timeoutMs = 4000): Promise<TrackStore> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
  const db = await Promise.race([
    openDb(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('IndexedDB open timed out')), timeoutMs)),
  ]);
  db.onversionchange = () => db.close();

  return {
    kind: 'indexeddb',
    async list() {
      const tx = db.transaction(RECORDS, 'readonly');
      return request(tx.objectStore(RECORDS).getAll() as IDBRequest<TrackRecord[]>);
    },
    async add(record, file) {
      // read the file before opening the transaction: a transaction closes when it sits idle
      const row: FileRow = { data: await file.arrayBuffer(), type: file.type };
      const tx = db.transaction([RECORDS, FILES], 'readwrite');
      const finished = done(tx);
      tx.objectStore(FILES).put(row, record.id);
      tx.objectStore(RECORDS).put(record);
      await finished;
    },
    async update(record) {
      const tx = db.transaction(RECORDS, 'readwrite');
      const finished = done(tx);
      tx.objectStore(RECORDS).put(record);
      await finished;
    },
    async getFile(id) {
      const tx = db.transaction(FILES, 'readonly');
      const row = await request(tx.objectStore(FILES).get(id) as IDBRequest<FileRow | undefined>);
      return row ? new Blob([row.data], { type: row.type }) : undefined;
    },
    async remove(id) {
      const tx = db.transaction([RECORDS, FILES], 'readwrite');
      const finished = done(tx);
      tx.objectStore(RECORDS).delete(id);
      tx.objectStore(FILES).delete(id);
      await finished;
    },
  };
}
