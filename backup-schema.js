const PRODUCT_ID = 'pwa-japanese-gd';
const COLLECTION_KEYS = Object.freeze([
  'words', 'history', 'sentences', 'imported', 'boosted',
  'readingQuizHistory', 'essayHistory', 'aiAskHistory', 'studyDays',
  'handwritingHistory', 'kanaProgress', 'preferences'
]);

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
  schemaVersion: 1,
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
    const source = data.collections || data;
    if (!COLLECTION_KEYS.some(key => Array.isArray(source[key]))) return { valid: false, reason: 'NO_COLLECTIONS' };
    const collections = this.normalize(data);
    if (data.payloadChecksum && data.payloadChecksum !== this.checksum(collections)) {
      return { valid: false, reason: 'CHECKSUM_MISMATCH', actual: this.checksum(collections) };
    }
    return { valid: true, collections, legacy: false, sourceSchemaVersion: Number(data.schemaVersion) || 1 };
  },

  attach(collections, { appVersion, deviceId, revision } = {}) {
    const normalized = this.normalize(collections);
    const now = new Date().toISOString();
    return {
      ...normalized,
      product: PRODUCT_ID,
      schemaVersion: 1,
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
