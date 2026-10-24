/**
 * core/storage.js · 跨平台存储适配器
 *
 * 统一的键值存储接口，双端各自注入实现：
 *   桌面端：localStorage（同步，够用）
 *   Android：IndexedDB（异步，大容量；歌单/设置/analysis 缓存均入此）
 *
 * 业务层（playlists-core 等）只依赖本接口，不感知平台。
 */

const MEMORY_FALLBACK = new Map();

/** localStorage 后端（桌面端 / 移动端小数据） */
export function createLocalStorageBackend(namespace = 'aurora') {
  const key = (k) => `${namespace}:${k}`;
  return {
    name: 'localStorage',
    async get(k) {
      try {
        const raw = localStorage.getItem(key(k));
        return raw === null ? undefined : JSON.parse(raw);
      } catch (_) { return undefined; }
    },
    async set(k, v) {
      try { localStorage.setItem(key(k), JSON.stringify(v)); } catch (_) {}
    },
    async del(k) {
      try { localStorage.removeItem(key(k)); } catch (_) {}
    }
  };
}

/** IndexedDB 后端（Android 主存储） */
export function createIndexedDBBackend(namespace = 'aurora', dbName = 'aurora-db', storeName = 'kv') {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let request;
      try { request = fn(store); } catch (err) { reject(err); return; }
      t.oncomplete = () => {
        // request 是 IDBRequest：取它的 result（键不存在时正确得到 undefined）
        const value = (request && typeof request.result !== 'undefined' && 'result' in request)
          ? request.result
          : request;
        resolve(value);
      };
      t.onerror = () => reject(t.error);
    });
  }

  const key = (k) => `${namespace}:${k}`;
  return {
    name: 'indexedDB',
    async get(k) {
      try {
        const v = await tx('readonly', (s) => s.get(key(k)));
        return v === undefined ? undefined : v;
      } catch (_) { return undefined; }
    },
    async set(k, v) {
      try { await tx('readwrite', (s) => s.put(v, key(k))); } catch (_) {}
    },
    async del(k) {
      try { await tx('readwrite', (s) => s.delete(key(k))); } catch (_) {}
    }
  };
}

/** 环境自动选择（无 indexedDB 时退回内存，保证永不抛错） */
export function createDefaultBackend(namespace) {
  if (typeof indexedDB !== 'undefined') return createIndexedDBBackend(namespace);
  if (typeof localStorage !== 'undefined') return createLocalStorageBackend(namespace);
  return {
    name: 'memory',
    async get(k) { return MEMORY_FALLBACK.get(namespace + ':' + k); },
    async set(k, v) { MEMORY_FALLBACK.set(namespace + ':' + k, v); },
    async del(k) { MEMORY_FALLBACK.delete(namespace + ':' + k); }
  };
}
