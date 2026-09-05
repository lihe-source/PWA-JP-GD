import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { mergeLearningStates, escapeDriveQuery } from './learning-sync.js';
import { normalizeJapaneseWord } from './japanese-learning.js';

const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const objectSource = app.slice(app.indexOf('const GDrive = {'), app.indexOf('// ===== UTILITIES ====='))
  .replace('const GDrive =', 'globalThis.drive =');

function makeDrive() {
  const writes = [];
  const ctx = {
    URLSearchParams, Response, mergeLearningStates, escapeDriveQuery, normalizeJapaneseWord,
    APP_DISPLAY_VERSION: 'V1.2.13', isPracticeActive: () => false, document: {}, Router: {},
    resumeAppUpdateWhenSafe() {}, refreshStudyStreakUI() {},
    DB: { getGDriveFolderId: () => "folder'one", setGDriveLastSync(value) { writes.push(['synced', value]); } },
    StudyStreak: { replace(value) { writes.push(['days', value]); } },
    AppStorage: {
      async createRecoverySnapshot() { return { id: 'snapshot' }; },
      setItem(key, value) { writes.push([key, value]); }, async flush() {}
    },
    BackupSchema: { validate(data) { return data.invalid ? { valid: false, reason: 'TEST' } : { valid: true, collections: data }; } }
  };
  vm.runInNewContext(objectSource, ctx);
  const drive = ctx.drive;
  drive._buildPayload = () => ({ words: [{ english: 'old' }] });
  drive._buildCollections = () => ({ words: [{ english: 'old' }] });
  drive.scheduleStudyStreakSync = () => {};
  drive._getDeviceId = () => 'test-phone';
  return { drive, ctx, writes };
}

test('actual Drive listing is folder-scoped, escaped and paginated', async () => {
  const { drive } = makeDrive(); const urls = [];
  drive._fetch = async url => {
    urls.push(new URL(url));
    return new Response(JSON.stringify(urls.length === 1
      ? { files: [{ id: 'a' }], nextPageToken: 'next' } : { files: [{ id: 'b' }] }));
  };
  const files = await drive._listStudyStreakFiles();
  assert.equal(files.length, 2);
  assert.match(urls[0].searchParams.get('q'), /'folder\\'one' in parents/);
  assert.match(urls[0].searchParams.get('q'), /japanese_learning_state\.json/);
  assert.equal(urls[1].searchParams.get('pageToken'), 'next');
});

test('actual Drive creation writes a device-owned file, not the legacy shared file', async () => {
  const { drive } = makeDrive(); let body;
  drive._fetch = async (url, options) => { body = options.body; return new Response('{"id":"new"}'); };
  await drive._createStudyStreakFile({ studyDays: [] });
  assert.match(body, /"name":"japanese_learning_state_test-phone\.json"/);
  assert.doesNotMatch(body, /"name":"japanese_learning_state\.json"/);
});

test('one unreadable cloud file prevents a partial union from being written back', async () => {
  const { drive } = makeDrive();
  drive._downloadStudyStreakFile = async id => { if (id === 'broken') throw new Error('timeout'); return { studyDays: [] }; };
  await assert.rejects(drive._readStudyStreakFiles([{ id: 'ok' }, { id: 'broken' }]), /已保留原資料/);
});

test('restore waits for recovery snapshot, and snapshot failure leaves data untouched', async () => {
  const { drive, ctx, writes } = makeDrive();
  ctx.AppStorage.createRecoverySnapshot = async () => { throw new Error('snapshot quota'); };
  await assert.rejects(drive.applyDownload({ words: [{ english: 'new' }] }, 'overwrite'), /snapshot quota/);
  assert.equal(writes.length, 0);
  assert.equal(drive._restoreInProgress, false);
});

test('a local change while snapshot is being created cancels automatic overwrite', async () => {
  const { drive, ctx, writes } = makeDrive();
  const expectedCollections = JSON.stringify(drive._buildCollections());
  ctx.AppStorage.createRecoverySnapshot = async () => {
    drive._buildCollections = () => ({ words: [{ english: 'new-local-answer' }] });
    return { id: 'snapshot' };
  };
  await assert.rejects(drive.applyDownload({ words: [{ english: 'cloud' }] }, 'overwrite', { expectedCollections }), /本機資料已變更/);
  assert.equal(writes.length, 0);
});

test('disk failure during restore is reported and no success timestamp is written', async () => {
  const { drive, ctx, writes } = makeDrive();
  ctx.AppStorage.flush = async () => { throw new Error('disk full'); };
  await assert.rejects(drive.applyDownload({ words: [{ english: 'cloud' }] }, 'overwrite'), /disk full/);
  assert.equal(writes.some(([key]) => key === 'synced'), false);
  assert.equal(drive._restoreInProgress, false);
});

test('active sync, active practice, and invalid backups cannot overwrite local records', async () => {
  const { drive, ctx, writes } = makeDrive();
  drive._streakSyncPromise = Promise.resolve();
  await assert.rejects(drive.applyDownload({}, 'overwrite'), /正在同步/);
  drive._streakSyncPromise = null;
  await assert.rejects(drive.applyDownload({ invalid: true }, 'overwrite'), /BACKUP_INVALID/);
  ctx.isPracticeActive = () => true;
  await assert.rejects(drive.applyDownload({}, 'overwrite'), /完成練習/);
  assert.equal(writes.length, 0);
});

test('successful restore returns only after the local flush completes', async () => {
  const { drive, ctx, writes } = makeDrive(); let flushCount = 0;
  ctx.AppStorage.flush = async () => { flushCount++; };
  await drive.applyDownload({ words: [{ english: 'cloud' }] }, 'overwrite');
  assert.equal(flushCount, 2);
  assert.equal(writes.some(([key]) => key === 'synced'), true);
});
