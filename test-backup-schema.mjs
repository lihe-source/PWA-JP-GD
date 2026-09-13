import test from 'node:test';
import assert from 'node:assert/strict';
import { BackupSchema } from './backup-schema.js';

const baseCollections = {
  words: [{ english: 'hello' }],
  history: [{ date: '2026/08/09', total: 5 }],
  sentences: [],
  imported: [],
  boosted: [],
  readingQuizHistory: [],
  essayHistory: [],
  aiAskHistory: [],
  studyDays: [{ date: '2026-08-09', activities: ['word_quiz'], eventIds: ['e1'], sessionCount: 1 }]
};

test('V8 backup includes study days and validates its checksum', () => {
  const payload = BackupSchema.attach(baseCollections, { appVersion: 'V7.2.1', deviceId: 'test' });
  assert.equal(payload.schemaVersion, 8);
  assert.equal(payload.collectionCounts.studyDays, 1);
  assert.equal(BackupSchema.validate(payload).valid, true);

  payload.studyDays[0].sessionCount = 99;
  assert.equal(BackupSchema.validate(payload).reason, 'CHECKSUM_MISMATCH');
});

test('V7 backup checksum remains accepted and is marked for migration', () => {
  const legacy = { ...baseCollections };
  delete legacy.studyDays;
  legacy.schemaVersion = 7;
  legacy.payloadChecksum = BackupSchema.legacyChecksum(legacy);
  const validation = BackupSchema.validate(legacy);
  assert.equal(validation.valid, true);
  assert.equal(validation.legacy, true);
  assert.deepEqual(validation.collections.studyDays, []);
});

test('V7/V8 comparisons ignore the missing V7 study-days collection', () => {
  const legacy = { ...baseCollections, schemaVersion: 7 };
  delete legacy.studyDays;
  const current = { ...baseCollections, schemaVersion: 8 };
  assert.equal(BackupSchema.compare(current, legacy).same, true);
});
