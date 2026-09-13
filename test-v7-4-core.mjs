import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BackupSchema } from './backup-schema.js';
import { request } from './network.js';

const emptyCollections = () => ({
  words: [], history: [], sentences: [], imported: [], boosted: [],
  readingQuizHistory: [], essayHistory: [], aiAskHistory: [], studyDays: []
});

test('V8 validation rejects malformed and future backups before restore', () => {
  const malformed = BackupSchema.attach(emptyCollections(), { appVersion: 'V7.4.2' });
  malformed.words = null;
  assert.equal(BackupSchema.validate(malformed).reason, 'INVALID_COLLECTION_WORDS');

  const future = BackupSchema.attach(emptyCollections(), { appVersion: 'V9.0.0' });
  future.schemaVersion = 99;
  assert.equal(BackupSchema.validate(future).reason, 'UNSUPPORTED_VERSION');
});

test('cloud auto restore requires content containment, not larger counts alone', () => {
  const local = BackupSchema.attach({ ...emptyCollections(), words: [{ english: 'apple' }, { english: 'banana' }] });
  const unrelated = BackupSchema.attach({ ...emptyCollections(), words: [{ english: 'apple' }, { english: 'cat' }, { english: 'dog' }] });
  const safeSuperset = BackupSchema.attach({ ...emptyCollections(), words: [{ english: 'apple' }, { english: 'banana' }, { english: 'cat' }] });

  const conflict = BackupSchema.compare(local, unrelated);
  assert.equal(conflict.cloudIsStrictSuperset, false);
  assert.equal(conflict.conflict, true);

  const safe = BackupSchema.compare(local, safeSuperset);
  assert.equal(safe.cloudIsStrictSuperset, true);
  assert.equal(safe.conflict, false);
});

test('network layer never retries a potentially completed upload', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  };
  try {
    await assert.rejects(
      request('https://example.test/upload', { method: 'POST' }, { retries: 3, timeout: 1000 }),
      /HTTP_503/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('storage startup preserves session-only Google credentials', async () => {
  const storage = await readFile(new URL('./storage.js', import.meta.url), 'utf8');
  assert.doesNotMatch(storage, /sessionStorage\.removeItem\(['"]gdriveToken/);
  assert.match(storage, /Session tokens belong to the active login/);
});

test('push token recovery verifies both Web Push subscription keys', async () => {
  const worker = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(worker, /row\.p256dh !== subscription\.p256dh/);
  assert.match(worker, /row\.auth !== subscription\.auth/);
  assert.match(worker, /SUBSCRIPTION_MISMATCH/);
});
