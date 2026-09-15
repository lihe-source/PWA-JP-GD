const PRODUCT_ID = 'pwa-japanese-gd';
const V1_COLLECTION_KEYS = Object.freeze([
  'words', 'history', 'sentences', 'imported', 'boosted',
  'readingQuizHistory', 'essayHistory', 'aiAskHistory', 'studyDays',
  'handwritingHistory', 'kanaProgress', 'preferences'
]);
const COLLECTION_KEYS = Object.freeze([...V1_COLLECTION_KEYS, 'kanaReadingHistory']);
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2]);
const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
const MAX_COLLECTION_ITEMS = 100000;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashString(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
}

function safeArray(value) { return Array.isArray(value) ? value : []; }

export const BackupSchema = {
  product: PRODUCT_ID,
  schemaVersion: 2,
  collectionKeys: COLLECTION_KEYS,

  normalize(data = {}) {
    const source = data.collections && typeof data.collections === 'object' ? data.collections : data;
    return Object.fromEntries(COLLECTION_KEYS.map(key => [key, safeArray(source[key])]));
  },

  counts(data = {}) {
    const collections = this.normalize(data);
    const reading = collections.readingQuizHistory.reduce((sum, group) => sum + safeArray(group?.sessions).length, 0);
    const essay = collections.essayHistory.reduce((sum, group) => sum + safeArray(group?.sessions).length, 0);
    const counts = {
      words: collections.words.length,
      examples: collections.sentences.length + collections.imported.length,
      practice: collections.history.length,
      boosted: collections.boosted.length,
      reading,
      essay,
      aiAsk: collections.aiAskHistory.length,
      studyDays: collections.studyDays.length,
      handwriting: collections.handwritingHistory.length,
      kanaReading: collections.kanaReadingHistory.length,
      kanaProgress: collections.kanaProgress.length,
      preferences: collections.preferences.length
    };
    counts.total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    return counts;
  },

  hashes(data = {}) {
    const collections = this.normalize(data);
    return Object.fromEntries(COLLECTION_KEYS.map(key => [key, hashString(stableStringify(collections[key]))]));
  },

  checksum(data = {}) { return hashString(stableStringify(this.normalize(data))); },

  validate(data) {
    if (!data || typeof data !== 'object') return { valid: false, reason: 'INVALID_OBJECT' };
    if (data.product !== PRODUCT_ID) return { valid: false, reason: 'WRONG_PRODUCT' };
    const sourceSchemaVersion = Number(data.schemaVersion) || 1;
    if (!SUPPORTED_SCHEMA_VERSIONS.has(sourceSchemaVersion)) {
      return { valid: false, reason: sourceSchemaVersion > this.schemaVersion ? 'UNSUPPORTED_FUTURE_SCHEMA' : 'UNSUPPORTED_SCHEMA' };
    }
    try {
      const serialized = JSON.stringify(data);
      const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(serialized).byteLength : serialized.length * 2;
      if (bytes > MAX_BACKUP_BYTES) return { valid: false, reason: 'BACKUP_TOO_LARGE' };
    } catch { return { valid: false, reason: 'INVALID_SERIALIZATION' }; }
    const source = data.collections || data;
    if (!COLLECTION_KEYS.some(key => Array.isArray(source[key]))) return { valid: false, reason: 'NO_COLLECTIONS' };
    if (COLLECTION_KEYS.some(key => source[key] !== undefined && !Array.isArray(source[key]))) {
      return { valid: false, reason: 'INVALID_COLLECTION_TYPE' };
    }
    const collections = this.normalize(data);
    if (COLLECTION_KEYS.some(key => collections[key].length > MAX_COLLECTION_ITEMS)) {
      return { valid: false, reason: 'COLLECTION_TOO_LARGE' };
    }
    if (sourceSchemaVersion >= 2 && !data.payloadChecksum) return { valid: false, reason: 'CHECKSUM_REQUIRED' };
    if (data.payloadChecksum && data.payloadChecksum !== this.checksum(collections)) {
      const legacyCollections = Object.fromEntries(V1_COLLECTION_KEYS.map(key => [key, safeArray(source[key])]));
      const legacyChecksum = hashString(stableStringify(legacyCollections));
      if (sourceSchemaVersion > 1 || data.payloadChecksum !== legacyChecksum) {
        return { valid: false, reason: 'CHECKSUM_MISMATCH', actual: this.checksum(collections) };
      }
    }
    if (data.collectionCounts && typeof data.collectionCounts === 'object') {
      const actualCounts = this.counts(collections);
      const mismatched = Object.keys(data.collectionCounts).some(key =>
        key in actualCounts && Number(data.collectionCounts[key]) !== Number(actualCounts[key]));
      if (mismatched) return { valid: false, reason: 'COUNT_MISMATCH' };
    }
    return { valid: true, collections, legacy: sourceSchemaVersion === 1, sourceSchemaVersion };
  },

  attach(collections, { appVersion, deviceId, revision } = {}) {
    const normalized = this.normalize(collections);
    const now = new Date().toISOString();
    return {
      ...normalized,
      product: PRODUCT_ID,
      schemaVersion: 2,
      backupId: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      deviceId: deviceId || 'unknown-device',
      revision: revision || Date.now(),
      createdAt: now,
      updatedAt: now,
      appVersion: appVersion || '',
      collectionCounts: this.counts(normalized),
      collectionHashes: this.hashes(normalized),
      payloadChecksum: this.checksum(normalized)
    };
  },

  compare(localData, cloudData) {
    const localCounts = this.counts(localData);
    const cloudCounts = this.counts(cloudData);
    const keys = Object.keys(localCounts).filter(key => key !== 'total');
    const cloudLess = keys.some(key => (cloudCounts[key] || 0) < (localCounts[key] || 0));
    const cloudMore = keys.some(key => (cloudCounts[key] || 0) > (localCounts[key] || 0));
    const sameCounts = keys.every(key => (cloudCounts[key] || 0) === (localCounts[key] || 0));
    const localHash = this.checksum(localData);
    const cloudHash = this.checksum(cloudData);
    return {
      localCounts,
      cloudCounts,
      localHash,
      cloudHash,
      same: sameCounts && localHash === cloudHash,
      conflict: (cloudLess && cloudMore) || (sameCounts && localHash !== cloudHash),
      cloudIsStrictSuperset: cloudMore && !cloudLess
    };
  }
};
