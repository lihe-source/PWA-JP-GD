const DB_NAME = 'pwa_japanese_v1';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const SNAPSHOT_STORE = 'snapshots';
const LOCAL_PREFIX = 'pwa_japanese:';
const LEGACY_ENGLISH_DB = 'pwa_vocabulary_v7';

const INDEXED_KEYS = new Set([
  'vocabWords',
  'practiceHistory',
  'readingQuizHistory',
  'essayHistory',
  'aiAskHistory',
  'handwritingHistory',
  'kanaReadingHistory',
  'studyActivityDays',
  'sentenceLog',
  'importedSentences',
  'boostedWords',
  'todaySentence',
  'geminiApiKey'
]);

export class StorageBridge {
  constructor() {
    this.cache = new Map();
    this.db = null;
    this.ready = false;
    this.pending = new Set();
    this.failures = new Map();
    this.revisions = new Map();
    this.deletedKeys = new Set();
    this.revision = 0;
    this.statusQueued = false;
    this.fallback = false;

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const storedKey = localStorage.key(i);
        if (storedKey?.startsWith(LOCAL_PREFIX)) {
          this.cache.set(storedKey.slice(LOCAL_PREFIX.length), localStorage.getItem(storedKey));
        }
      }
    } catch {
      this.fallback = true;
    }
  }

  async init() {
    if (this.ready) return this.getStatus();
    try {
      this.db = await this._open();
      for (const key of INDEXED_KEYS) {
        const record = await this._getRecord(key);
        const legacy = this._localGet(key);
        if (record && typeof record.value === 'string') {
          this.cache.set(key, record.value);
        } else if (legacy !== null) {
          this.cache.set(key, legacy);
          await this._putRecord(key, legacy);
        }
        if (this.cache.has(key)) this._localRemove(key);
      }
      await this._importCompatibleEnglishSettings();
      // Remove legacy OAuth access tokens left by V6.6. Account identity remains remembered.
      this._localRemove('gdriveToken');
      this._localRemove('gdriveExpiry');
      try { sessionStorage.removeItem('gdriveToken'); sessionStorage.removeItem('gdriveExpiry'); } catch {}
      this.setItem('storageSchemaVersion', '1');
      this.setItem('storageMigratedAt', new Date().toISOString());
      this.ready = true;
      return this.getStatus();
    } catch (error) {
      console.warn('[StorageBridge] IndexedDB unavailable; using localStorage fallback.', error);
      this.fallback = true;
      this.ready = true;
      return this.getStatus();
    }
  }

  getStatus() {
    return {
      ready: this.ready,
      mode: this.db && !this.fallback ? 'indexeddb' : 'localstorage-fallback',
      schemaVersion: 1,
      saveState: this.failures.size ? 'error' : this.pending.size ? 'saving' : 'saved',
      failedKeys: [...this.failures.keys()],
      pendingWrites: this.pending.size
    };
  }

  getItem(key) {
    if (this.deletedKeys.has(key)) return null;
    if (this.cache.has(key)) return this.cache.get(key);
    const value = this._localGet(key);
    if (value !== null) this.cache.set(key, value);
    return value;
  }

  setItem(key, value) {
    const stringValue = String(value);
    this.cache.set(key, stringValue);
    this.deletedKeys.delete(key);
    this._persist(key, stringValue);
  }

  removeItem(key) {
    this.cache.delete(key);
    this.deletedKeys.add(key);
    this._persist(key, null);
  }

  _persist(key, value) {
    const revision = ++this.revision;
    this.revisions.set(key, revision);
    if (INDEXED_KEYS.has(key) && this.db && !this.fallback) {
      const write = value === null ? this._deleteRecord(key) : this._putRecord(key, value);
      this._queue(write, key, revision, () => {
        if (value === null) localStorage.removeItem(LOCAL_PREFIX + key);
        else this._localRemove(key);
      });
    } else {
      try {
        if (value === null) localStorage.removeItem(LOCAL_PREFIX + key);
        else this._localSet(key, value);
        this.failures.delete(key);
      } catch (error) {
        this.failures.set(key, error);
      }
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
    while (this.pending.size) await Promise.all([...this.pending]);
    if (this.failures.size) {
      const error = new Error('資料尚未完整儲存，請重試或先匯出備份，暫勿關閉程式。');
      error.code = 'STORAGE_WRITE_FAILED';
      error.failedKeys = [...this.failures.keys()];
      throw error;
    }
  }

  async retryFailedWrites() {
    for (const key of [...this.failures.keys()]) {
      if (key === 'recoverySnapshots') continue;
      this._persist(key, this.deletedKeys.has(key) ? null : this.cache.get(key));
    }
    await this.flush();
    return this.getStatus();
  }

  async createRecoverySnapshot(payload, reason = 'manual') {
    if (!this.db || this.fallback) return null;
    const id = `${Date.now()}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    const record = {
      id,
      reason,
      createdAt: new Date().toISOString(),
      payload
    };
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(SNAPSHOT_STORE, 'readwrite');
      tx.objectStore(SNAPSHOT_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
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
    // Handle the rejection here so fire-and-forget callers never lose an error
    // or create an unhandled rejected .finally() promise. flush() reports it.
    const tracked = Promise.resolve(promise).then(() => {
      if (!current()) return;
      onSuccess?.();
      this.failures.delete(key);
    }).catch(error => {
      if (current()) this.failures.set(key, error);
    }).finally(() => {
      this.pending.delete(tracked);
      this._notifyStatus();
    });
    this.pending.add(tracked);
    this._notifyStatus();
  }

  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('INDEXEDDB_BLOCKED'));
    });
  }

  async _importCompatibleEnglishSettings() {
    if (this._localGet('compatibleSettingsChecked') === '1') return;
    const compatibleLocalKeys = ['geminiModel', 'gdriveClientId'];
    for (const key of compatibleLocalKeys) {
      if (this.getItem(key)) continue;
      try {
        const legacy = localStorage.getItem(key);
        if (legacy) this.setItem(key, legacy);
      } catch {}
    }

    if (!this.getItem('geminiApiKey')) {
      try {
        const key = await new Promise(resolve => {
          const request = indexedDB.open(LEGACY_ENGLISH_DB);
          request.onerror = () => resolve('');
          request.onupgradeneeded = () => resolve('');
          request.onsuccess = () => {
            const legacyDb = request.result;
            if (!legacyDb.objectStoreNames.contains(KV_STORE)) {
              legacyDb.close(); resolve(''); return;
            }
            const tx = legacyDb.transaction(KV_STORE, 'readonly');
            const get = tx.objectStore(KV_STORE).get('geminiApiKey');
            get.onsuccess = () => { const value = get.result?.value || ''; legacyDb.close(); resolve(value); };
            get.onerror = () => { legacyDb.close(); resolve(''); };
          };
        });
        if (key) this.setItem('geminiApiKey', key);
      } catch {}
    }
    this.setItem('compatibleSettingsChecked', '1');
  }

  _getRecord(key) {
    return new Promise(resolve => {
      const tx = this.db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  _putRecord(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).put({ key, value, updatedAt: new Date().toISOString() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  _deleteRecord(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async _trimSnapshots(limit) {
    const snapshots = await this.listRecoverySnapshots();
    const extras = snapshots.slice(limit);
    if (!extras.length) return;
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(SNAPSHOT_STORE, 'readwrite');
      const store = tx.objectStore(SNAPSHOT_STORE);
      extras.forEach(item => store.delete(item.id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  _localGet(key) {
    try { return localStorage.getItem(LOCAL_PREFIX + key); } catch { return null; }
  }

  _localSet(key, value) {
    localStorage.setItem(LOCAL_PREFIX + key, value);
  }

  _localRemove(key) {
    try { localStorage.removeItem(LOCAL_PREFIX + key); } catch {}
  }
}

export const AppStorage = new StorageBridge();
