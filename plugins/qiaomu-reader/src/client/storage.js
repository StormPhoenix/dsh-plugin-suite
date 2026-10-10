/**
 * 客户端持久化：IndexedDB 优先，localStorage 兜底。
 *
 * 为什么客户端也要存一份：宿主半可能不可用（服务未提供、跨版本、离线打开），
 * 这时阅读进度与划线仍必须能保存，否则用户一刷新就丢。两边的数据以
 * 「宿主为准、客户端缓存兜底」的顺序读取，写入则同时尝试两边。
 */

const DB_NAME = 'qiaomu-reader';
const DB_VERSION = 2;
const STORE_LIBRARY = 'library';
const STORE_STATE = 'state';
const STORE_BYTES = 'bytes';
const LS_PREFIX = 'qmr:';

/** 打开 IndexedDB；不支持或被禁用时返回 null。 */
function openDatabase() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_LIBRARY)) db.createObjectStore(STORE_LIBRARY);
        if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
        if (!db.objectStoreNames.contains(STORE_BYTES)) db.createObjectStore(STORE_BYTES);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

let databasePromise = null;

/** 惰性获取数据库句柄。 */
function database() {
  if (databasePromise === null) databasePromise = openDatabase();
  return databasePromise;
}

/** 一次 IndexedDB 事务。 */
async function withStore(storeName, mode, run) {
  const db = await database();
  if (db === null) return undefined;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = run(store);
      let result;
      if (request !== undefined) {
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => resolve(undefined);
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => resolve(undefined);
      transaction.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** localStorage 读写兜底（同样容错）。 */
function localGet(key) {
  try {
    const raw = globalThis.localStorage?.getItem(`${LS_PREFIX}${key}`);
    return raw === null || raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function localSet(key, value) {
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

let libraryRevision = 0;
const cachedIndex = (value) => ({ revision: value?.cacheRevision || 0, library: value });

/** Read the newest committed index across both caches; accept legacy raw indexes. */
export async function loadLocalLibrary() {
  const fromDb = cachedIndex(await withStore(STORE_LIBRARY, 'readonly', (store) => store.get('index')));
  const fromLocal = cachedIndex(localGet('library'));
  libraryRevision = Math.max(libraryRevision, fromDb.revision || 0, fromLocal.revision || 0);
  const selected = fromLocal.library && (!fromDb.library || fromLocal.revision > fromDb.revision) ? fromLocal : fromDb;
  return selected.library;
}

/** An additive revision orders partial backend saves while retaining the raw index fields. */
export async function saveLocalLibrary(library) {
  const envelope = { ...library, cacheRevision: libraryRevision = Math.max(Date.now(), libraryRevision + 1) };
  const saved = await withStore(STORE_LIBRARY, 'readwrite', (store) => store.put(envelope, 'index'));
  const fallback = localSet('library', envelope);
  return saved !== undefined || fallback;
}

/** 读取某本书的阅读状态。 */
export async function loadLocalState(bookId) {
  const fromDb = await withStore(STORE_STATE, 'readonly', (store) => store.get(bookId));
  if (fromDb !== undefined && fromDb !== null) return fromDb;
  return localGet(`state:${bookId}`);
}

/** 写入某本书的阅读状态。 */
export async function saveLocalState(bookId, state) {
  await withStore(STORE_STATE, 'readwrite', (store) => store.put(state, bookId));
  localSet(`state:${bookId}`, state);
}

/** 删除某本书的阅读状态。 */
export async function removeLocalState(bookId) {
  await withStore(STORE_STATE, 'readwrite', (store) => store.delete(bookId));
  try {
    globalThis.localStorage?.removeItem(`${LS_PREFIX}state:${bookId}`);
  } catch {
    /* 忽略 */
  }
}

/** 清空全部客户端缓存（设置里的「清空本地缓存」用）。 */
export async function clearLocalData() {
  await withStore(STORE_LIBRARY, 'readwrite', (store) => store.clear());
  await withStore(STORE_STATE, 'readwrite', (store) => store.clear());
  await withStore(STORE_BYTES, 'readwrite', (store) => store.clear());
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined) return;
    const doomed = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (typeof key === 'string' && key.startsWith(LS_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 书籍字节缓存
 *
 * 用户导入的书必须在本机可用：宿主半不可用时（服务未提供、跨版本、离线），
 * 正文仍然要能重新打开，否则「导入」就成了一次性操作。
 * IndexedDB 以结构化克隆保存 Uint8Array，单本几 MB 完全没问题；
 * localStorage 兜底只用于极小文件（它没有二进制通道，转成 base64 存）。
 * ------------------------------------------------------------------ */

/** 保存书籍字节。 */
export async function saveBookBytes(bookId, bytes) {
  const saved = await withStore(STORE_BYTES, 'readwrite', (store) => store.put(bytes, bookId));
  if (saved !== undefined) return true;
  // IndexedDB 不可用：只在小文件上退化为 localStorage。
  if (bytes.byteLength <= 2 * 1024 * 1024) {
    try {
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return localSet(`bytes:${bookId}`, btoa(binary));
    } catch {
      return false;
    }
  }
  return false;
}

/** 读取书籍字节；没有则返回 undefined。 */
export async function loadBookBytes(bookId) {
  const fromDb = await withStore(STORE_BYTES, 'readonly', (store) => store.get(bookId));
  if (fromDb instanceof Uint8Array) return fromDb;
  if (fromDb instanceof ArrayBuffer) return new Uint8Array(fromDb);
  const encoded = localGet(`bytes:${bookId}`);
  if (typeof encoded !== 'string') return undefined;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/** 删除书籍字节缓存。 */
export async function removeBookBytes(bookId) {
  await withStore(STORE_BYTES, 'readwrite', (store) => store.delete(bookId));
  try {
    globalThis.localStorage?.removeItem(`${LS_PREFIX}bytes:${bookId}`);
  } catch {
    /* 忽略 */
  }
}