// Локальное хранилище: состояние и PDF-файлы в IndexedDB браузера.
const DB_NAME = 'pamyatki-osp';
const DB_VER = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
export const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));

// Файлы храним как ArrayBuffer
export async function fileGet(key) {
  const v = await tx('files', 'readonly', (s) => s.get(key));
  return v ? new Uint8Array(v) : null;
}
export const filePut = (key, bytes) => tx('files', 'readwrite', (s) => s.put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), key));
export const fileDel = (key) => tx('files', 'readwrite', (s) => s.delete(key));
export const fileKeys = () => tx('files', 'readonly', (s) => s.getAllKeys());

export async function storageInfo() {
  try {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usage: est.usage, quota: est.quota, persisted };
  } catch (e) {
    return null;
  }
}

export async function requestPersist() {
  try { return await navigator.storage.persist(); } catch (e) { return false; }
}
