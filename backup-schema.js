const PRODUCT_ID = 'pwa-japanese-gd';
const V1_COLLECTION_KEYS = Object.freeze([
  'words', 'history', 'sentences', 'imported', 'boosted',
  'readingQuizHistory', 'essayHistory', 'aiAskHistory', 'studyDays',
  'handwritingHistory', 'kanaProgress', 'preferences'
]);
const V2_COLLECTION_KEYS = Object.freeze([...V1_COLLECTION_KEYS, 'kanaReadingHistory']);
const COLLECTION_KEYS = Object.freeze([...V2_COLLECTION_KEYS, 'wordReadingHistory']);
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3]);
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

// A count cannot establish that a backup contains the local data. Compare every
// complete record, including duplicates in legacy arrays, before auto-restore.
function containsAllRecords(container, subset) {
  const available = new Map();
  container.forEach(item => {
    const fingerprint = stableStringify(item);
    available.set(fingerprint, (available.get(fingerprint) || 0) + 1);
  });
  return subset.every(item => {
    const fingerprint = stableStringify(item);
    const remaining = available.get(fingerprint) || 0;
    if (!remaining) return false;
    available.set(fingerprint, remaining - 1);
    return true;
  });
}

export function mergePracticeHistory(...sources) {
  const groups = new Map();
  sources.flat().forEach(row => {
    if (!row?.date) return;
    const group = groups.get(row.date) || { date: row.date, sessions: new Map(), legacy: new Map() };
    const sessions = safeArray(row.sessions);
    sessions.forEach(session => {
      if (!session || typeof session !== 'object') return;
      const content = stableStringify(session);
      const id = String(session.id || `legacy-session:${content}`);
      const existing = group.sessions.get(id);
      if (existing && stableStringify(existing) !== content) group.sessions.set(`${id}:${content}`, session);
      else group.sessions.set(id, session);
    });
    let legacy = safeArray(row.legacyAggregates);
    if (!legacy.length) {
      const sessionTotal = sessions.reduce((sum, item) => sum + (Number(item?.total) || 0), 0);
      const residual = Math.max(0, (Number(row.total) || 0) - sessionTotal);
      if (residual || !sessions.length) {
        legacy = [{
          total: residual,
          correct: Math.max(0, (Number(row.correct) || 0) - sessions.reduce((sum, item) => sum + (Number(item?.correct) || 0), 0)),
          wrong: Math.max(0, (Number(row.wrong) || 0) - sessions.reduce((sum, item) => sum + (Number(item?.wrong) || 0), 0)),
          wrongWordDetails: safeArray(row.wrongWordDetails)
        }];
      }
    }
    legacy.forEach(item => {
      const id = item.id || `legacy:${stableStringify(item)}`;
      group.legacy.set(id, { ...item, id });
    });
    groups.set(row.date, group);
  });
  return [...groups.values()].map(group => {
    const sessions = [...group.sessions.values()];
    const legacyAggregates = [...group.legacy.values()];
    const largestLegacy = legacyAggregates.reduce((best, item) => (Number(item.total) || 0) > (Number(best.total) || 0) ? item : best, { total: 0, correct: 0, wrong: 0 });
    const total = (Number(largestLegacy.total) || 0) + sessions.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
    const correct = (Number(largestLegacy.correct) || 0) + sessions.reduce((sum, item) => sum + (Number(item.correct) || 0), 0);
    const wrong = (Number(largestLegacy.wrong) || 0) + sessions.reduce((sum, item) => sum + (Number(item.wrong) || 0), 0);
    const wrongWords = new Map();
    [...legacyAggregates, ...sessions].forEach(item => safeArray(item.wrongWordDetails).forEach(word => {
      if (word?.english) wrongWords.set(String(word.english), word);
    }));
    return { date: group.date, total, correct, wrong, wrongWordDetails: [...wrongWords.values()], sessions, legacyAggregates };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export const BackupSchema = {
  product: PRODUCT_ID,
  schemaVersion: 3,
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
      wordReading: collections.wordReadingHistory.length,
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
    const invalidRecord = COLLECTION_KEYS.find(key => collections[key].some(item =>
      key === 'boosted'
        ? !(typeof item === 'string' || typeof item === 'number')
        : !item || typeof item !== 'object' || Array.isArray(item)
    ));
    if (invalidRecord) return { valid: false, reason: `INVALID_RECORD_${invalidRecord}` };
    if (sourceSchemaVersion >= 2 && !data.payloadChecksum) return { valid: false, reason: 'CHECKSUM_REQUIRED' };
    if (data.payloadChecksum && data.payloadChecksum !== this.checksum(collections)) {
      const legacyKeys = sourceSchemaVersion === 1 ? V1_COLLECTION_KEYS : V2_COLLECTION_KEYS;
      const legacyCollections = Object.fromEntries(legacyKeys.map(key => [key, safeArray(source[key])]));
      const legacyChecksum = hashString(stableStringify(legacyCollections));
      if (sourceSchemaVersion >= 3 || data.payloadChecksum !== legacyChecksum) {
        return { valid: false, reason: 'CHECKSUM_MISMATCH', actual: this.checksum(collections) };
      }
    }
    if (data.collectionCounts && typeof data.collectionCounts === 'object') {
      const actualCounts = this.counts(collections);
      const mismatched = Object.keys(data.collectionCounts).some(key =>
        key in actualCounts && Number(data.collectionCounts[key]) !== Number(actualCounts[key]));
      if (mismatched) return { valid: false, reason: 'COUNT_MISMATCH' };
    }
    return {
      valid: true, collections, legacy: sourceSchemaVersion === 1, sourceSchemaVersion,
      presentCollections: COLLECTION_KEYS.filter(key => Object.hasOwn(source, key))
    };
  },

  attach(collections, { appVersion, deviceId, revision } = {}) {
    const normalized = this.normalize(collections);
    const now = new Date().toISOString();
    return {
      ...normalized,
      product: PRODUCT_ID,
      schemaVersion: 3,
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
    const local = this.normalize(localData);
    const cloud = this.normalize(cloudData);
    const missingLocally = COLLECTION_KEYS.filter(key => !containsAllRecords(local[key], cloud[key]));
    const missingInCloud = COLLECTION_KEYS.filter(key => !containsAllRecords(cloud[key], local[key]));
    const cloudContainsLocal = missingInCloud.length === 0;
    const localContainsCloud = missingLocally.length === 0;
    const localHash = this.checksum(localData);
    const cloudHash = this.checksum(cloudData);
    return {
      localCounts,
      cloudCounts,
      localHash,
      cloudHash,
      missingInCloud,
      missingLocally,
      same: cloudContainsLocal && localContainsCloud,
      conflict: !cloudContainsLocal && !localContainsCloud,
      cloudIsStrictSuperset: cloudContainsLocal && !localContainsCloud
    };
  }
};
