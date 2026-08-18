import test from 'node:test';
import assert from 'node:assert/strict';
import { BackupSchema } from './backup-schema.js';

const collections = {
  words: [{ english: '食べる', reading: 'たべる', chinese: '吃' }],
  history: [{ date: '2026/08/18', total: 5 }],
  sentences: [], imported: [], boosted: [], readingQuizHistory: [], essayHistory: [], aiAskHistory: [],
  studyDays: [{ date: '2026-08-18', activities: ['kana_handwriting'], eventIds: ['e1'], sessionCount: 1 }],
  handwritingHistory: [{ id: 'h1', character: 'あ', score: 88 }],
  kanaProgress: [{ key: 'hiragana:あ', bestScore: 88 }],
  preferences: [{ jlptLevel: 'N5' }]
};

test('Japanese V1 backup includes streak, handwriting and preferences', () => {
  const payload = BackupSchema.attach(collections, { appVersion: 'V1.0.0', deviceId: 'test' });
  assert.equal(payload.product, 'pwa-japanese-gd');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.collectionCounts.studyDays, 1);
  assert.equal(payload.collectionCounts.handwriting, 1);
  assert.equal(payload.collectionCounts.preferences, 1);
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
