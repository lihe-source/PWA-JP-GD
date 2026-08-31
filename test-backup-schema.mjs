import test from 'node:test';
import assert from 'node:assert/strict';
import { BackupSchema } from './backup-schema.js';

const collections = {
  words: [{ english: '食べる', reading: 'たべる', chinese: '吃' }],
  history: [{ date: '2026/08/18', total: 5 }],
  sentences: [], imported: [], boosted: [], readingQuizHistory: [], essayHistory: [], aiAskHistory: [],
  studyDays: [{ date: '2026-08-18', activities: ['kana_handwriting'], eventIds: ['e1'], sessionCount: 1 }],
  handwritingHistory: [{ id: 'h1', character: 'あ', score: 88 }],
  kanaReadingHistory: [{ id: 'kr1', character: 'あ', romaji: 'a', answer: 'a', correct: true }],
  kanaProgress: [{ key: 'hiragana:あ', bestScore: 88 }],
  preferences: [{
    jlptLevel: 'N5',
    practice: {
      lastPracticeMode: 'kana',
      wordPractice: { count: 15, order: 'newest' },
      kanaPractice: { script: 'both', rows: ['a', 'ka'], mode: 'copy', count: 20, repeat: 5, weakOnly: true, layout: 'auto' }
    }
  }]
};

const stableStringify = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};
const hashString = text => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
};

test('Japanese backup includes streak, handwriting, kana reading and preferences', () => {
  const payload = BackupSchema.attach(collections, { appVersion: 'V1.0.0', deviceId: 'test' });
  assert.equal(payload.product, 'pwa-japanese-gd');
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.collectionCounts.studyDays, 1);
  assert.equal(payload.collectionCounts.handwriting, 1);
  assert.equal(payload.collectionCounts.kanaReading, 1);
  assert.equal(payload.collectionCounts.preferences, 1);
  assert.deepEqual(payload.preferences[0].practice.kanaPractice.rows, ['a', 'ka']);
  assert.equal(payload.preferences[0].practice.kanaPractice.repeat, 5);
  assert.equal(BackupSchema.validate(payload).valid, true);
});

test('checksum detects modified handwriting data', () => {
  const payload = BackupSchema.attach(collections, { appVersion: 'V1.0.0' });
  payload.handwritingHistory[0].score = 1;
  assert.equal(BackupSchema.validate(payload).reason, 'CHECKSUM_MISMATCH');
});

test('English-product backups cannot overwrite the Japanese data store', () => {
  const payload = BackupSchema.attach(collections);
  payload.product = 'pwa-vocabulary-gd';
  assert.equal(BackupSchema.validate(payload).reason, 'WRONG_PRODUCT');
});

test('identical Japanese payloads compare as the same', () => {
  const first = BackupSchema.attach(collections);
  const second = BackupSchema.attach(collections);
  assert.equal(BackupSchema.compare(first, second).same, true);
});

test('schema 1 backups remain valid after kana reading was added', () => {
  const legacyKeys = [
    'words', 'history', 'sentences', 'imported', 'boosted', 'readingQuizHistory',
    'essayHistory', 'aiAskHistory', 'studyDays', 'handwritingHistory', 'kanaProgress', 'preferences'
  ];
  const legacy = Object.fromEntries(legacyKeys.map(key => [key, collections[key] || []]));
  const payload = {
    ...legacy,
    product: 'pwa-japanese-gd',
    schemaVersion: 1,
    payloadChecksum: hashString(stableStringify(legacy))
  };
  const validation = BackupSchema.validate(payload);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.collections.kanaReadingHistory, []);
});
