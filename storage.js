const DB_NAME = 'pwa_vocabulary_v7';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const SNAPSHOT_STORE = 'snapshots';

const INDEXED_KEYS = new Set([
  'vocabWords',
  'practiceHistory',
  'readingQuizHistory',
  'essayHistory',
  'aiAskHistory',
  'studyActivityDays',
  'sentenceLog',
  'importedSentences',
  'boostedWords',
  'todaySentence',
  'geminiApiKey',
  'vocabularyDrafts'
]);

const EMPTY_INDEXED_VALUES = {
  geminiApiKey: '',
  vocabularyDrafts: '{}',
  todaySentence: 'null'
};

export class StorageBridge {
  constructor() {
    this.cache = new Map();
    this.committed = new Map();
    this.keyVersions = new Map();
    this.db = null;
    this.ready = false;
    this.pending = new Set();
    this.fallback = false;
    this.revision = 0;
    this.diskRevision = '';
    this.errors = new Map();
    this.tail = Promise.resolve();
    this.batchActive = false;

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          const value = localStorage.getItem(key);
          this.cache.set(key, value);
          this.committed.set(key, value);
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

      // V7.2.2: load all IndexedDB values in one readonly transaction instead of
      // opening a separate transaction for every key. This is noticeably faster
      // on iOS/PWA startup, especially after the OS has suspended the app.
      const records = await this._getAllRecords();
      const recordMap = new Map(records.map(record => [record.key, record]));
      this.diskRevision = recordMap.get('_revision')?.value || '';
      const migrations = [];

      for (const key of INDEXED_KEYS) {
        const record = recordMap.get(key);
        const legacy = this._localGet(key);
        if (record && typeof record.value === 'string') {
          this.cache.set(key, record.value);
        } else if (legacy !== null) {
          this.cache.set(key, legacy);
          migrations.push([key, legacy]);
        }
      }

      for (const key of INDEXED_KEYS) {
        if (this.cache.has(key)) this.committed.set(key, this.cache.get(key));
        else this.committed.delete(key);
      }

      if (migrations.length) await this._putRecords(migrations);
      for (const key of INDEXED_KEYS) {
        if (this.cache.has(key)) this._localRemove(key);
      }

      // Remove legacy OAuth access tokens left by V6.6. Account identity remains remembered.
      this._localRemove('gdriveToken');
      this._localRemove('gdriveExpiry');
      // Session tokens belong to the active login. Never delete them during migration.
      this._localSet('storageSchemaVersion', '8');
      this._localSet('storageMigratedAt', new Date().toISOString());
      this.ready = true;
      if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
        this.channel = new BroadcastChannel('vocabulary-v7-storage');
        this.channel.onmessage = () => { void this.refreshFromDisk().catch(error => this._failure('refresh', error)); };
        window.addEventListener('storage', event => { if (event.key && !INDEXED_KEYS.has(event.key)) this.cache.delete(event.key); });
      }
      return this.getStatus();
    } catch (error) {
      console.warn('[StorageBridge] IndexedDB unavailable; using localStorage fallback.', error);
      this.db = null;
      this.fallback = true;
      this.ready = true;
      return this.getStatus();
    }
  }

  getStatus() {
    return {
      ready: this.ready,
      mode: this.db && !this.fallback ? 'indexeddb' : 'localstorage-fallback',
      schemaVersion: 8,
      pending: this.pending.size,
      failed: this.errors.size,
      revision: this.revision
    };
  }

  getItem(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const value = this._localGet(key);
    if (value !== null) this.cache.set(key, value);
    return value;
  }

  _emit() {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vocabulary-storage', {detail:this.getStatus()}));
  }

  _failure(key, error, retry) { this.errors.set(key, {error,retry}); this._emit(); }

  setItem(key, value) {
    if (this.batchActive && INDEXED_KEYS.has(key)) throw new Error('TASK_ALREADY_RUNNING');
    const stringValue = String(value);
    const previous = this.getItem(key);
    if (previous === stringValue) return;
    this.revision++;
    if (INDEXED_KEYS.has(key) && this.db && !this.fallback) {
      const writeVersion = (this.keyVersions.get(key) || 0) + 1;
      this.keyVersions.set(key, writeVersion);
      // Synchronous callers see a pending value; a failed commit restores it.
      this.cache.set(key, stringValue);
      const run = async () => {
        try {
          await this._putRecords([[key,stringValue]]);
          this.committed.set(key, stringValue);
          this.errors.delete(key);
          this._localRemove(key);
        }
        catch (error) {
          if (this.keyVersions.get(key) === writeVersion) {
            if (this.committed.has(key)) this.cache.set(key, this.committed.get(key));
            else this.cache.delete(key);
          }
          this._failure(key,error,()=>this.setItem(key,stringValue));
          throw error;
        } finally { this._emit(); }
      };
      const pending = this.tail.then(run);
      this.tail = pending.catch(()=>{});
      this._queue(pending);
      return;
    }
    try { localStorage.setItem(key,stringValue); this.cache.set(key,stringValue); this.committed.set(key,stringValue); this.errors.delete(key); }
    catch(error) { this._failure(key,error,()=>this.setItem(key,stringValue)); throw error; }
  }

  removeItem(key) {
    if (INDEXED_KEYS.has(key)) {
      // An empty stored value is represented consistently in both stores.
      this.setItem(key, EMPTY_INDEXED_VALUES[key] ?? '[]');
      return;
    }
    localStorage.removeItem(key);this.cache.delete(key);this.revision++;
  }

  async clear() {
    await this.flush();
    if (this.db && !this.fallback) await new Promise((resolve,reject)=>{
      const tx=this.db.transaction([KV_STORE,SNAPSHOT_STORE],'readwrite');
      tx.objectStore(KV_STORE).clear();tx.objectStore(SNAPSHOT_STORE).clear();
      tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);
    });
    this.cache.clear();this.committed.clear();this.keyVersions.clear();localStorage.clear();this.diskRevision='';this.revision++;
    this.channel?.postMessage('changed');
  }

  async flush() {
    while(this.pending.size) await Promise.allSettled([...this.pending]);
    if(this.errors.size) throw this.errors.values().next().value.error;
  }

  async retryFailed() {
    const failed=[...this.errors.entries()];
    for (const [key, item] of failed) if(item.retry) { this.errors.delete(key);item.retry(); }
    await this.flush();
  }

  async refreshFromDisk() {
    if(this.pending.size || this.batchActive || this.errors.size || !this.db) return false;
    const localRevision = this.revision;
    const records=await this._getAllRecords();
    if (localRevision !== this.revision || this.pending.size || this.batchActive) return false;
    const revision=records.find(x=>x.key==='_revision')?.value || '';
    if(revision===this.diskRevision) return false;
    for(const key of INDEXED_KEYS) { this.cache.delete(key);this.committed.delete(key); }
    for(const record of records) if(INDEXED_KEYS.has(record.key)) {this.cache.set(record.key,record.value);this.committed.set(record.key,record.value);}
    this.diskRevision=revision;this.revision++;this._emit();return true;
  }

  async setItemsBatch(entries, {expectedRevision} = {}) {
    if(this.batchActive) throw new Error('TASK_ALREADY_RUNNING');
    await this.flush();
    if(expectedRevision !== undefined && expectedRevision !== this.revision) throw new Error('LOCAL_DATA_CHANGED');
    const pairs = Array.isArray(entries) ? entries : Object.entries(entries || {});
    if (!pairs.length) return;
    // Restore transactions must use IndexedDB, including study days.
    if (!this.db || this.fallback) throw new Error('SNAPSHOT_UNAVAILABLE');
    if (pairs.some(([key])=>!INDEXED_KEYS.has(key))) throw new Error('BATCH_KEY_NOT_INDEXED');
    this.batchActive=true;
    try {
      await this._putRecords(pairs.map(([key,value])=>[key,String(value)]));
      for(const [key,value] of pairs) {
        const stringValue=String(value);
        this.cache.set(key,stringValue);this.committed.set(key,stringValue);this._localRemove(key);
        this.keyVersions.set(key,(this.keyVersions.get(key)||0)+1);
      }
      this.revision++;this._emit();
    } finally {this.batchActive=false;}
  }

  async createRecoverySnapshot(payload, reason = 'manual') {
    if (!this.db || this.fallback) throw new Error('SNAPSHOT_UNAVAILABLE');
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

  _queue(promise) {
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
  }

  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => { req.result.onversionchange=()=>{req.result.close();this.db=null;this.fallback=true;this._emit();}; resolve(req.result); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('INDEXEDDB_BLOCKED'));
    });
  }

  _getRecord(key) {
    return new Promise(resolve => {
      const tx = this.db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  _getAllRecords() {
    return new Promise((resolve,reject) => {
      const tx = this.db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  _putRecords(entries) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(KV_STORE, 'readwrite');
      const store = tx.objectStore(KV_STORE);
      const updatedAt = new Date().toISOString();
      const revision = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      let conflict=false;
      const req=store.get('_revision');
      req.onsuccess=()=>{
        if ((req.result?.value || '') !== this.diskRevision) { conflict=true;tx.abort();return; }
        for (const [key, value] of entries) store.put({ key, value, updatedAt });
        store.put({key:'_revision',value:revision,updatedAt});
      };
      tx.oncomplete = () => {this.diskRevision=revision;this.channel?.postMessage('changed');resolve();};
      tx.onerror = tx.onabort = () => reject(conflict ? new Error('STORAGE_CONFLICT') : tx.error || new Error('STORAGE_WRITE_FAILED'));
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
    try { return localStorage.getItem(key); } catch { return null; }
  }

  _localSet(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }

  _localRemove(key) {
    try { localStorage.removeItem(key); } catch {}
  }
}

export const AppStorage = new StorageBridge();
