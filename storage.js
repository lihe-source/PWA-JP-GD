const DB_NAME = 'pwa_japanese_v1';
const DB_VERSION = 2;
const KV_STORE = 'kv';
const SNAPSHOT_STORE = 'snapshots';
const RECORD_STORE = 'records';
const LOCAL_PREFIX = 'pwa_japanese:';
const LEGACY_ENGLISH_DB = 'pwa_vocabulary_v7';

const RECORD_COLLECTIONS = new Set(['handwritingHistory', 'kanaReadingHistory']);
const INDEXED_KEYS = new Set([
  'vocabWords', 'practiceHistory', 'readingQuizHistory', 'essayHistory', 'aiAskHistory',
  ...RECORD_COLLECTIONS, 'studyActivityDays', 'sentenceLog', 'importedSentences',
  'boostedWords', 'todaySentence', 'geminiApiKey'
]);

function cloneRecord(value) { return value && typeof value === 'object' ? { ...value } : value; }
function normalizeRecordList(records = []) {
  const byId = new Map();
  (Array.isArray(records) ? records : []).forEach((record, index) => {
    if (!record || typeof record !== 'object') return;
    const id = String(record.id || `legacy-${Number(record.ts) || Date.now()}-${index}`);
    byId.set(id, { ...record, id });
  });
  return byId;
}

export class StorageBridge {
  constructor() {
    this.cache = new Map();
    this.recordCache = new Map([...RECORD_COLLECTIONS].map(key => [key, new Map()]));
    this.recordSortedCache = new Map();
    this.db = null;
    this.ready = false;
    this.pending = new Set();
    this.failures = new Map();
    this.revisions = new Map();
    this.deletedKeys = new Set();
    this.revision = 0;
    this.statusQueued = false;
    this.fallback = false;
    this.readOnly = false;
    this.atomicStage = null;
    this.atomicLock = false;
    this.atomicCompletion = null;
    this.deferredWrites = [];

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const storedKey = localStorage.key(i);
        if (storedKey?.startsWith(LOCAL_PREFIX)) {
          this.cache.set(storedKey.slice(LOCAL_PREFIX.length), localStorage.getItem(storedKey));
        }
      }
    } catch { this.fallback = true; }
  }

  async init() {
    if (this.ready) return this.getStatus();
    try {
      this.db = await this._open();
      this.db.onversionchange = () => {
        this.db?.close();
        this.db = null;
        this.readOnly = true;
        this.failures.set('databaseVersion', new Error('DATABASE_VERSION_CHANGED'));
        this._notifyStatus();
      };
      const [kvRecords, collectionRows] = await Promise.all([this._getAllKvRecords(), this._getAllCollectionRows()]);
      const kv = new Map(kvRecords.map(record => [record.key, record.value]));
      kvRecords.forEach(record => {
        if (!RECORD_COLLECTIONS.has(record.key) && typeof record.value === 'string') this.cache.set(record.key, record.value);
      });

      // V1.4.0 keeps all AppStorage values in one database so backup restore can
      // commit data and preferences as a single transaction. Migrate remaining
      // prefixed localStorage settings in one write transaction.
      const localMigrations = [];
      this.cache.forEach((value, key) => {
        if (!kv.has(key) && !RECORD_COLLECTIONS.has(key) && typeof value === 'string') localMigrations.push({ key, value });
      });
      if (localMigrations.length) await this._putManyRecords(localMigrations);
      localMigrations.forEach(({ key }) => this._localRemove(key));

      collectionRows.forEach(row => {
        if (!RECORD_COLLECTIONS.has(row.collection) || !row.value) return;
        this.recordCache.get(row.collection).set(String(row.id), { ...row.value, id: String(row.id) });
      });

      for (const key of INDEXED_KEYS) {
        const legacy = kv.has(key) ? kv.get(key) : this._localGet(key);
        if (RECORD_COLLECTIONS.has(key)) {
          if (typeof legacy === 'string') {
            try {
              const parsed = JSON.parse(legacy);
              if (!Array.isArray(parsed)) throw new Error('INVALID_LEGACY_COLLECTION');
              const combined = normalizeRecordList(parsed);
              this.recordCache.get(key).forEach((record, id) => combined.set(id, record));
              if (combined.size !== this.recordCache.get(key).size) {
                await this._replaceCollectionRows(key, [...combined.values()]);
                this.recordCache.set(key, combined);
                this.recordSortedCache.delete(key);
              }
            } catch (error) {
              this.cache.set(key, legacy);
              this.failures.set(`migration:${key}`, error);
              throw error;
            }
          }
          if (kv.has(key)) await this._deleteRecord(key);
          this.cache.delete(key);
          this._localRemove(key);
          continue;
        }
        if (typeof kv.get(key) === 'string') this.cache.set(key, kv.get(key));
        else if (legacy !== null) {
          this.cache.set(key, legacy);
          await this._putRecord(key, legacy);
        }
        if (this.cache.has(key)) this._localRemove(key);
      }

      await this._importCompatibleEnglishSettings();
      this._localRemove('gdriveToken');
      this._localRemove('gdriveExpiry');
      try { sessionStorage.removeItem('gdriveToken'); sessionStorage.removeItem('gdriveExpiry'); } catch {}
      this.setItem('storageSchemaVersion', '2');
      this.setItem('storageMigratedAt', new Date().toISOString());
      this.ready = true;
      return this.getStatus();
    } catch (error) {
      console.warn('[StorageBridge] IndexedDB unavailable; using localStorage fallback.', error);
      if (this.db) {
        this.readOnly = true;
        this.failures.set('databaseRead', error);
      }
      this.fallback = true;
      this.ready = true;
      return this.getStatus();
    }
  }

  getStatus() {
    return {
      ready: this.ready,
      mode: this.readOnly ? 'read-only' : this.db && !this.fallback ? 'indexeddb' : 'localstorage-fallback',
      readOnly: this.readOnly,
      schemaVersion: 2,
      saveState: this.failures.size ? 'error' : this.pending.size || this.atomicLock ? 'saving' : 'saved',
      failedKeys: [...this.failures.keys()],
      pendingWrites: this.pending.size + Number(this.atomicLock) + this.deferredWrites.length,
      recordCounts: Object.fromEntries([...RECORD_COLLECTIONS].map(key => [key, this.recordCache.get(key)?.size || 0]))
    };
  }

  getItem(key) {
    if (RECORD_COLLECTIONS.has(key) && (this._recordStoreAvailable() || this.readOnly)) return JSON.stringify(this.getRecordCollection(key));
    if (this.atomicStage) {
      if (this.atomicStage.kv.has(key)) return this.atomicStage.kv.get(key);
      if (this.atomicStage.baseCache.has(key)) return this.atomicStage.baseCache.get(key);
      return this._localGet(key);
    }
    if (this.deletedKeys.has(key)) return null;
    if (this.cache.has(key)) return this.cache.get(key);
    const value = this._localGet(key);
    if (value !== null) this.cache.set(key, value);
    return value;
  }

  setItem(key, value) {
    if (this.readOnly) throw new Error('STORAGE_READ_ONLY');
    if (RECORD_COLLECTIONS.has(key) && this._recordStoreAvailable()) {
      try { this.replaceRecordCollection(key, JSON.parse(String(value))); }
      catch { this.replaceRecordCollection(key, []); }
      return;
    }
    const stringValue = String(value);
    if (this.atomicStage) { this.atomicStage.kv.set(key, stringValue); return; }
    this.cache.set(key, stringValue);
    this.deletedKeys.delete(key);
    if (this.atomicLock) { this.deferredWrites.push(() => this.setItem(key, stringValue)); this._notifyStatus(); return; }
    this._persist(key, stringValue);
  }

  removeItem(key) {
    if (this.readOnly) throw new Error('STORAGE_READ_ONLY');
    if (RECORD_COLLECTIONS.has(key) && this._recordStoreAvailable()) { this.replaceRecordCollection(key, []); return; }
    if (this.atomicStage) { this.atomicStage.kv.set(key, null); return; }
    this.cache.delete(key);
    this.deletedKeys.add(key);
    if (this.atomicLock) { this.deferredWrites.push(() => this.removeItem(key)); this._notifyStatus(); return; }
    this._persist(key, null);
  }

  getRecordCollection(collection) {
    if (!RECORD_COLLECTIONS.has(collection)) return [];
    if (this.readOnly && !this.atomicStage) {
      let legacy = [];
      try { legacy = JSON.parse(this.cache.get(collection) || '[]'); } catch {}
      const merged = normalizeRecordList(legacy);
      this.recordCache.get(collection)?.forEach((record, id) => merged.set(id, record));
      return [...merged.values()].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    }
    if (!this._recordStoreAvailable() && !this.readOnly) {
      try { return JSON.parse(this.getItem(collection) || '[]'); } catch { return []; }
    }
    const staged = this.atomicStage?.collections.get(collection);
    const map = staged || this.atomicStage?.baseRecords.get(collection) || this.recordCache.get(collection) || new Map();
    if (!this.atomicStage && this.recordSortedCache.has(collection)) return this.recordSortedCache.get(collection).map(cloneRecord);
    const sorted = [...map.values()].map(cloneRecord).sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    if (!this.atomicStage) this.recordSortedCache.set(collection, sorted);
    return sorted.map(cloneRecord);
  }

  appendRecord(collection, record) {
    if (this.readOnly) throw new Error('STORAGE_READ_ONLY');
    if (!RECORD_COLLECTIONS.has(collection) || !record || typeof record !== 'object') return;
    if (!this._recordStoreAvailable()) {
      const list = this.getRecordCollection(collection);
      const raw = JSON.stringify([{ ...record }, ...list]);
      this.cache.set(collection, raw);
      this._persist(collection, raw);
      return;
    }
    const id = String(record.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const normalized = { ...record, id };
    if (this.atomicStage) { this._stageCollection(collection).set(id, normalized); return; }
    this.recordCache.get(collection).set(id, normalized);
    this.recordSortedCache.delete(collection);
    if (this.atomicLock) { this.deferredWrites.push(() => this.appendRecord(collection, normalized)); this._notifyStatus(); return; }
    const revision = ++this.revision;
    const key = `records:${collection}:${id}`;
    this.revisions.set(key, revision);
    this._queue(this._putCollectionRow(collection, normalized), key, revision);
  }

  replaceRecordCollection(collection, records) {
    if (this.readOnly) throw new Error('STORAGE_READ_ONLY');
    if (!RECORD_COLLECTIONS.has(collection)) return;
    const map = normalizeRecordList(records);
    if (!this._recordStoreAvailable()) {
      const raw = JSON.stringify([...map.values()]);
      this.cache.set(collection, raw);
      this._persist(collection, raw);
      return;
    }
    if (this.atomicStage) { this.atomicStage.collections.set(collection, map); return; }
    this.recordCache.set(collection, map);
    this.recordSortedCache.delete(collection);
    if (this.atomicLock) { this.deferredWrites.push(() => this.replaceRecordCollection(collection, [...map.values()])); this._notifyStatus(); return; }
    const revision = ++this.revision;
    const key = `records:${collection}:replace`;
    this.revisions.set(key, revision);
    const earlierFailures = [...this.failures.entries()].filter(([failedKey]) => failedKey.startsWith(`records:${collection}:`));
    this._queue(this._replaceCollectionRows(collection, [...map.values()]), key, revision, () => {
      earlierFailures.forEach(([failedKey, error]) => {
        if (this.failures.get(failedKey) === error) this.failures.delete(failedKey);
      });
    });
  }

  _stageCollection(collection) {
    if (!this.atomicStage.collections.has(collection)) {
      this.atomicStage.collections.set(collection, new Map(this.atomicStage.baseRecords.get(collection) || []));
    }
    return this.atomicStage.collections.get(collection);
  }

  _recordStoreAvailable() {
    if (!this.db || this.fallback || typeof this.db.transaction !== 'function') return false;
    try { return this.db.objectStoreNames?.contains?.(RECORD_STORE) !== false; }
    catch { return false; }
  }

  async atomicUpdate(mutator) {
    if (!this.db || this.fallback || this.readOnly) {
      const error = new Error('此裝置目前無法使用安全交易式還原，請先重新開啟 App 後再試。');
      error.code = 'ATOMIC_STORAGE_REQUIRED';
      throw error;
    }
    if (this.atomicLock) throw new Error('ATOMIC_UPDATE_IN_PROGRESS');
    const baseCache = new Map(this.cache);
    const baseRecords = new Map([...this.recordCache].map(([key, records]) => [key, new Map(records)]));
    let complete;
    this.atomicCompletion = new Promise(resolve => { complete = resolve; });
    this.atomicLock = true;
    this.failures.delete('atomicUpdate');
    this._notifyStatus();
    let commitStarted = false;
    try {
      await this._flushPending();
      const stage = {
        kv: new Map(), collections: new Map(), baseCache, baseRecords
      };
      this.atomicStage = stage;
      let result;
      try {
        result = mutator();
        if (result && typeof result.then === 'function') throw new Error('ATOMIC_UPDATE_MUST_BE_SYNCHRONOUS');
      } finally { this.atomicStage = null; }
      commitStarted = true;
      await this._commitAtomicStage(stage);
      stage.kv.forEach((value, key) => {
        if (value === null) { this.cache.delete(key); this.deletedKeys.add(key); }
        else { this.cache.set(key, value); this.deletedKeys.delete(key); }
        this._localRemove(key);
      });
      stage.collections.forEach((map, key) => { this.recordCache.set(key, map); this.recordSortedCache.delete(key); this._localRemove(key); });
      this.failures.delete('atomicUpdate');
      this._notifyStatus();
      return result;
    } catch (error) {
      if (commitStarted) this.failures.set('atomicUpdate', error);
      throw error;
    } finally {
      this.atomicStage = null;
      this.atomicLock = false;
      const deferred = this.deferredWrites.splice(0);
      deferred.forEach(write => {
        try { write(); } catch (error) { this.failures.set('deferredWrite', error); }
      });
      this.atomicCompletion = null;
      complete();
      this._notifyStatus();
    }
  }

  _persist(key, value) {
    const revision = ++this.revision;
    this.revisions.set(key, revision);
    if (this.db && !this.fallback) {
      const write = value === null ? this._deleteRecord(key) : this._putRecord(key, value);
      this._queue(write, key, revision, () => this._localRemove(key));
    } else {
      try {
        if (value === null) localStorage.removeItem(LOCAL_PREFIX + key); else this._localSet(key, value);
        this.failures.delete(key);
      } catch (error) { this.failures.set(key, error); }
      this._notifyStatus();
    }
  }

  _notifyStatus() {
    if (this.statusQueued) return;
    this.statusQueued = true;
    queueMicrotask(() => {
      this.statusQueued = false;
      if (typeof globalThis.window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('app-storage-status', { detail: this.getStatus() }));
      }
    });
  }

  clear() {
    const keys = new Set([...this.cache.keys(), ...INDEXED_KEYS]);
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(LOCAL_PREFIX)) keys.add(key.slice(LOCAL_PREFIX.length));
      }
    } catch {}
    keys.forEach(key => this.removeItem(key));
    if (this.db && !this.fallback) {
      this._queue(new Promise((resolve, reject) => {
        const tx = this.db.transaction(SNAPSHOT_STORE, 'readwrite');
        tx.objectStore(SNAPSHOT_STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error);
      }), 'recoverySnapshots', 0);
    }
  }

  async flush() {
    while (this.atomicCompletion || this.pending.size) {
      if (this.atomicCompletion) await this.atomicCompletion;
      if (this.pending.size) await Promise.all([...this.pending]);
    }
    this._throwIfFailed();
  }

  async _flushPending() {
    while (this.pending.size) await Promise.all([...this.pending]);
    this._throwIfFailed();
  }

  _throwIfFailed() {
    if (this.failures.size) {
      const error = new Error('資料尚未完整儲存，請重試或先匯出備份，暫勿關閉程式。');
      error.code = 'STORAGE_WRITE_FAILED';
      error.failedKeys = [...this.failures.keys()];
      throw error;
    }
  }

  async retryFailedWrites() {
    for (const key of [...this.failures.keys()]) {
      if (key === 'recoverySnapshots' || key === 'atomicUpdate' || key === 'deferredWrite' || key === 'databaseRead' || key === 'databaseVersion' || key.startsWith('migration:') || key.startsWith('records:')) continue;
      this._persist(key, this.deletedKeys.has(key) ? null : this.cache.get(key));
    }
    for (const collection of RECORD_COLLECTIONS) {
      if (this.failures.has(`records:${collection}:replace`)) {
        this.replaceRecordCollection(collection, this.getRecordCollection(collection));
        continue;
      }
      for (const key of [...this.failures.keys()]) {
        if (!key.startsWith(`records:${collection}:`)) continue;
        const id = key.slice(`records:${collection}:`.length);
        const record = this.recordCache.get(collection)?.get(id);
        if (record) this.appendRecord(collection, record);
      }
    }
    await this.flush();
    return this.getStatus();
  }

  async createRecoverySnapshot(payload, reason = 'manual') {
    if (!this.db || this.fallback) return null;
    const id = `${Date.now()}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    const record = { id, reason, createdAt: new Date().toISOString(), payload };
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(SNAPSHOT_STORE, 'readwrite');
      tx.objectStore(SNAPSHOT_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    await this._trimSnapshots(5);
    return record;
  }

  async listRecoverySnapshots() {
    if (!this.db || this.fallback) return [];
    return new Promise(resolve => {
      const tx = this.db.transaction(SNAPSHOT_STORE, 'readonly');
      const req = tx.objectStore(SNAPSHOT_STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      req.onerror = () => resolve([]);
    });
  }

  _queue(promise, key, revision, onSuccess) {
    const current = () => key === 'recoverySnapshots' || this.revisions.get(key) === revision;
    const tracked = Promise.resolve(promise).then(() => {
      if (!current()) return;
      onSuccess?.(); this.failures.delete(key);
    }).catch(error => { if (current()) this.failures.set(key, error); }).finally(() => {
      this.pending.delete(tracked); this._notifyStatus();
    });
    this.pending.add(tracked); this._notifyStatus();
  }

  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(RECORD_STORE)) {
          const store = db.createObjectStore(RECORD_STORE, { keyPath: ['collection', 'id'] });
          store.createIndex('collection', 'collection', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('INDEXEDDB_BLOCKED'));
    });
  }

  async _importCompatibleEnglishSettings() {
    if (this.getItem('compatibleSettingsChecked') === '1') return;
    for (const key of ['geminiModel', 'gdriveClientId']) {
      if (this.getItem(key)) continue;
      try { const legacy = localStorage.getItem(key); if (legacy) this.setItem(key, legacy); } catch {}
    }
    if (!this.getItem('geminiApiKey')) {
      try {
        const key = await new Promise(resolve => {
          const request = indexedDB.open(LEGACY_ENGLISH_DB);
          request.onerror = request.onupgradeneeded = () => resolve('');
          request.onsuccess = () => {
            const legacyDb = request.result;
            if (!legacyDb.objectStoreNames.contains(KV_STORE)) { legacyDb.close(); resolve(''); return; }
            const get = legacyDb.transaction(KV_STORE, 'readonly').objectStore(KV_STORE).get('geminiApiKey');
            get.onsuccess = () => { const value = get.result?.value || ''; legacyDb.close(); resolve(value); };
            get.onerror = () => { legacyDb.close(); resolve(''); };
          };
        });
        if (key) this.setItem('geminiApiKey', key);
      } catch {}
    }
    this.setItem('compatibleSettingsChecked', '1');
  }

  _getAllKvRecords() { return this._getAll(KV_STORE); }
  _getAllCollectionRows() { return this._getAll(RECORD_STORE); }
  _getAll(storeName) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('STORAGE_READ_FAILED'));
    });
  }

  _putRecord(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).put({ key, value, updatedAt: new Date().toISOString() });
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  _putManyRecords(records) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(KV_STORE, 'readwrite');
      const store = tx.objectStore(KV_STORE);
      const updatedAt = new Date().toISOString();
      records.forEach(({ key, value }) => store.put({ key, value, updatedAt }));
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  _deleteRecord(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).delete(key);
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  _putCollectionRow(collection, record) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(RECORD_STORE, 'readwrite');
      tx.objectStore(RECORD_STORE).put({ collection, id: String(record.id), ts: Number(record.ts) || 0, value: record });
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  _replaceCollectionRows(collection, records) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(RECORD_STORE, 'readwrite');
      const store = tx.objectStore(RECORD_STORE);
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) { if (item.value?.collection === collection) item.delete(); item.continue(); return; }
        normalizeRecordList(records).forEach((record, id) => store.put({ collection, id, ts: Number(record.ts) || 0, value: record }));
      };
      cursor.onerror = () => reject(cursor.error);
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  _commitAtomicStage(stage) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([KV_STORE, RECORD_STORE], 'readwrite');
      const kv = tx.objectStore(KV_STORE);
      stage.kv.forEach((value, key) => value === null
        ? kv.delete(key)
        : kv.put({ key, value, updatedAt: new Date().toISOString() }));
      const store = tx.objectStore(RECORD_STORE);
      const collections = [...stage.collections.entries()];
      const replaceNext = index => {
        if (index >= collections.length) return;
        const [collection, map] = collections[index];
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) { if (item.value?.collection === collection) item.delete(); item.continue(); return; }
          map.forEach(record => store.put({ collection, id: String(record.id), ts: Number(record.ts) || 0, value: record }));
          replaceNext(index + 1);
        };
      };
      replaceNext(0);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('ATOMIC_UPDATE_FAILED'));
    });
  }

  async _trimSnapshots(limit) {
    const extras = (await this.listRecoverySnapshots()).slice(limit);
    if (!extras.length) return;
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(SNAPSHOT_STORE, 'readwrite');
      const store = tx.objectStore(SNAPSHOT_STORE);
      extras.forEach(item => store.delete(item.id));
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }

  _localGet(key) { try { return localStorage.getItem(LOCAL_PREFIX + key); } catch { return null; } }
  _localSet(key, value) { localStorage.setItem(LOCAL_PREFIX + key, value); }
  _localRemove(key) { try { localStorage.removeItem(LOCAL_PREFIX + key); } catch {} }
}

export const AppStorage = new StorageBridge();
