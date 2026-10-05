import type { Guide } from './ai/guide';
import type { TrailFile } from './trail';

/** Guides written on this device, with the trail data needed to show them again offline. */
export interface Saved {
  id: string;
  name: string;
  region?: string;
  savedAt: string;
  file: TrailFile;
  dem: Float32Array;
  guide: Guide;
}

const DB = 'waymark';
const STORE = 'guides';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export const saveGuide = (s: Saved) => tx('readwrite', (st) => st.put(s));
export const getSaved = (id: string) => tx<Saved | undefined>('readonly', (st) => st.get(id) as IDBRequest<Saved | undefined>);
export const listSaved = () => tx<Saved[]>('readonly', (st) => st.getAll() as IDBRequest<Saved[]>);
export const deleteSaved = (id: string) => tx('readwrite', (st) => st.delete(id));
