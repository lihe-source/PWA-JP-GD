const LEGACY_COLLECTION_KEYS = [
  'words', 'history', 'sentences', 'imported', 'boosted',
  'readingQuizHistory', 'essayHistory', 'aiAskHistory'
];
const COLLECTION_KEYS = [...LEGACY_COLLECTION_KEYS, 'studyDays'];

function updateHash(hash, text) {
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

function walkStable(value, emit) {
  if (value === null || typeof value !== 'object') {
    emit(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    emit('[');
    value.forEach((item, index) => {
      if (index) emit(',');
      walkStable(item, emit);
    });
    emit(']');
    return;
  }
  const keys = Object.keys(value).sort();
  emit('{');
  keys.forEach((key, index) => {
    if (index) emit(',');
    emit(JSON.stringify(key));
    emit(':');
    walkStable(value[key], emit);
  });
  emit('}');
}

function hashStable(value) {
  let hash = 0x811c9dc5;
  walkStable(value, chunk => { hash = updateHash(hash, chunk); });
  return (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
}

function stable(value) {
  let result = '';
  walkStable(value, chunk => { result += chunk; });
  return result;
}

function keyOf(value, fallback = '') {
  if (value === null || typeof value !== 'object') return String(value);
  return String(value.id ?? value.ts ?? value.backupId ?? fallback);
}

function includesByKey(local, cloud, key, compatible = (a, b) => stable(a) === stable(b)) {
  const index = new Map(cloud.map((item, i) => [key(item, i), item]));
  return local.every((item, i) => {
    const cloudItem = index.get(key(item, i));
    return cloudItem !== undefined && compatible(item, cloudItem);
  });
}

function containsCollections(local, cloud) {
  const wordKey = word => String(word?.english || word?.wordEn || '').trim().toLowerCase();
  const words = includesByKey(local.words, cloud.words, wordKey);
  const history = includesByKey(local.history, cloud.history, item => String(item?.date || ''), (a, b) =>
    Number(b?.total || 0) >= Number(a?.total || 0) &&
    Number(b?.correct || 0) >= Number(a?.correct || 0) &&
    Number(b?.wrong || 0) >= Number(a?.wrong || 0) &&
    safeArray(a?.wrongWordDetails).every(localWrong => safeArray(b?.wrongWordDetails)
      .some(cloudWrong => String(cloudWrong?.english || '').toLowerCase() === String(localWrong?.english || '').toLowerCase()))
  );
  const sessionsContained = (localGroups, cloudGroups) => includesByKey(localGroups, cloudGroups,
    group => String(group?.date || ''), (a, b) => includesByKey(safeArray(a?.sessions), safeArray(b?.sessions),
      (session, i) => keyOf(session, `${stable(session).slice(0, 160)}:${i}`),
      (localSession, cloudSession) => stable(localSession) === stable(cloudSession)));
  const studyDays = includesByKey(local.studyDays, cloud.studyDays, day => String(day?.date || ''), (a, b) =>
    safeArray(a?.eventIds).every(id => safeArray(b?.eventIds).includes(id)) &&
    safeArray(a?.activities).every(type => safeArray(b?.activities).includes(type)) &&
    Number(b?.sessionCount || 0) >= Number(a?.sessionCount || 0)
  );
  return words &&
    history &&
    includesByKey(local.sentences, cloud.sentences, (item, i) => keyOf(item, `${item?.word || ''}|${item?.date || ''}|${i}`)) &&
    includesByKey(local.imported, cloud.imported, (item, i) => keyOf(item, `${item?.word || ''}|${item?.english || ''}|${i}`)) &&
    local.boosted.every(id => cloud.boosted.includes(id)) &&
    sessionsContained(local.readingQuizHistory, cloud.readingQuizHistory) &&
    sessionsContained(local.essayHistory, cloud.essayHistory) &&
    includesByKey(local.aiAskHistory, cloud.aiAskHistory, (item, i) => keyOf(item, i)) &&
    studyDays;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

const SORTED_COLLECTION_KEYS = [...COLLECTION_KEYS].sort();



export const BackupSchema = {
  schemaVersion: 8,
  collectionKeys: COLLECTION_KEYS,

  normalize(data = {}) {
    const source = data.collections && typeof data.collections === 'object' ? data.collections : data;
    return {
      words: safeArray(source.words),
      history: safeArray(source.history),
      sentences: safeArray(source.sentences),
      imported: safeArray(source.imported),
      boosted: safeArray(source.boosted),
      readingQuizHistory: safeArray(source.readingQuizHistory),
      essayHistory: safeArray(source.essayHistory),
      aiAskHistory: safeArray(source.aiAskHistory),
      studyDays: safeArray(source.studyDays)
    };
  },

  counts(data = {}) {
    const c = this.normalize(data);
    const reading = c.readingQuizHistory.reduce((sum, h) => sum + safeArray(h?.sessions).length, 0);
    const essay = c.essayHistory.reduce((sum, h) => sum + safeArray(h?.sessions).length, 0);
    const counts = {
      words: c.words.length,
      examples: c.sentences.length + c.imported.length,
      practice: c.history.length,
      boosted: c.boosted.length,
      reading,
      essay,
      aiAsk: c.aiAskHistory.length,
      studyDays: c.studyDays.length
    };
    counts.total = Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0);
    return counts;
  },

  hashes(data = {}) {
    const collections = this.normalize(data);
    return Object.fromEntries(COLLECTION_KEYS.map(key => [key, hashStable(collections[key])]));
  },

  checksum(data = {}) {
    return hashStable(this.normalize(data));
  },

  legacyChecksum(data = {}) {
    const normalized = this.normalize(data);
    const legacy = Object.fromEntries(LEGACY_COLLECTION_KEYS.map(key => [key, normalized[key]]));
    return hashStable(legacy);
  },

  validate(data) {
    if (!data || typeof data !== 'object') return { valid: false, reason: 'INVALID_OBJECT' };
    if (Array.isArray(data)) return { valid: false, reason: 'INVALID_OBJECT' };
    const source = data.collections && typeof data.collections === 'object' ? data.collections : data;
    const schemaVersion = Number(data.schemaVersion) || 0;
    if (schemaVersion > this.schemaVersion) return { valid: false, reason: 'UNSUPPORTED_VERSION' };
    if (schemaVersion >= 8) {
      const malformed = COLLECTION_KEYS.find(key => !Array.isArray(source[key]));
      if (malformed) return { valid: false, reason: `INVALID_COLLECTION_${malformed.toUpperCase()}` };
      if (!data.payloadChecksum) return { valid: false, reason: 'CHECKSUM_MISSING' };
    }
    const collections = this.normalize(data);
    const hasRecognizedCollection = COLLECTION_KEYS.some(key => Array.isArray(source[key]));
    if (!hasRecognizedCollection) return { valid: false, reason: 'NO_COLLECTIONS' };
    if (schemaVersion >= 7 && data.payloadChecksum) {
      const actual = schemaVersion >= 8 ? this.checksum(collections) : this.legacyChecksum(collections);
      if (actual !== data.payloadChecksum) return { valid: false, reason: 'CHECKSUM_MISMATCH', actual };
    }
    return { valid: true, collections, legacy: schemaVersion < 8, sourceSchemaVersion: schemaVersion };
  },

  attach(collections, { appVersion, deviceId, revision } = {}) {
    const normalized = this.normalize(collections);
    const now = new Date().toISOString();
    const backupId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // V7.2.2: compute the whole backup checksum and per-collection hashes
    // in the same traversal. This avoids repeatedly materializing huge canonical
    // strings on the Safari main thread.
    let payloadHashState = 0x811c9dc5;
    const hashByKey = {};
    payloadHashState = updateHash(payloadHashState, '{');
    SORTED_COLLECTION_KEYS.forEach((key, index) => {
      if (index) payloadHashState = updateHash(payloadHashState, ',');
      payloadHashState = updateHash(payloadHashState, JSON.stringify(key));
      payloadHashState = updateHash(payloadHashState, ':');
      let collectionHashState = 0x811c9dc5;
      walkStable(normalized[key], chunk => {
        payloadHashState = updateHash(payloadHashState, chunk);
        collectionHashState = updateHash(collectionHashState, chunk);
      });
      hashByKey[key] = (`00000000${(collectionHashState >>> 0).toString(16)}`).slice(-8);
    });
    payloadHashState = updateHash(payloadHashState, '}');
    const collectionHashes = Object.fromEntries(COLLECTION_KEYS.map(key => [key, hashByKey[key]]));
    const payloadChecksum = (`00000000${(payloadHashState >>> 0).toString(16)}`).slice(-8);
    const metadata = {
      schemaVersion: 8,
      backupId,
      deviceId: deviceId || 'unknown-device',
      revision: revision || Date.now(),
      createdAt: now,
      updatedAt: now,
      appVersion: appVersion || '',
      collectionCounts: this.counts(normalized),
      collectionHashes,
      payloadChecksum
    };
    // Keep collections at the top level for V6 restore compatibility without duplicating the payload.
    return { ...normalized, ...metadata };
  },

  compare(localData, cloudData) {
    const localCounts = this.counts(localData);
    const cloudCounts = this.counts(cloudData);
    const keys = ['words', 'examples', 'practice', 'boosted', 'reading', 'essay', 'aiAsk'];
    if ((Number(localData?.schemaVersion) || 0) >= 8 && (Number(cloudData?.schemaVersion) || 0) >= 8) {
      keys.push('studyDays');
    }
    const cloudLess = keys.some(key => (cloudCounts[key] || 0) < (localCounts[key] || 0));
    const cloudMore = keys.some(key => (cloudCounts[key] || 0) > (localCounts[key] || 0));
    const sameCounts = keys.every(key => (cloudCounts[key] || 0) === (localCounts[key] || 0));
    const compareLegacy = (Number(localData?.schemaVersion) || 0) < 8 || (Number(cloudData?.schemaVersion) || 0) < 8;
    const localHash = compareLegacy
      ? this.legacyChecksum(localData)
      : (localData?.payloadChecksum || this.checksum(localData));
    const cloudHash = compareLegacy
      ? this.legacyChecksum(cloudData)
      : (cloudData?.payloadChecksum || this.checksum(cloudData));
    const localCollections = this.normalize(localData);
    const cloudCollections = this.normalize(cloudData);
    const cloudContainsLocal = containsCollections(localCollections, cloudCollections);
    return {
      localCounts,
      cloudCounts,
      localHash,
      cloudHash,
      same: sameCounts && localHash === cloudHash,
      cloudContainsLocal,
      conflict: !cloudContainsLocal && localHash !== cloudHash,
      cloudIsStrictSuperset: cloudContainsLocal && cloudMore && !cloudLess
    };
  }
};
