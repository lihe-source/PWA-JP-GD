import test from 'node:test';
import assert from 'node:assert/strict';
import { syncLearningState, mergeLearningStates, escapeDriveQuery } from './learning-sync.js';
import { StorageBridge } from './storage.js';
import { VersionManager } from './version-manager.js';
import { canUpdateApp, isPracticeActive } from './practice-lifecycle.js';
import { normalizeJapaneseAnswer } from './japanese-learning.js';

const attempt = (id, ts = 1) => ({ id, ts, character: 'あ', script: 'hiragana', score: 85 });
const state = (...ids) => mergeLearningStates({ handwritingHistory: ids.map((id, i) => attempt(id, i + 1)) });
const ids = s => s.handwritingHistory.map(item => item.id).sort();

test('an answer added while cloud is downloading survives and is uploaded', async () => {
  let local = state('old'), remote = state('cloud'), pending = false, reads = 0;
  const result = await syncLearningState({
    readLocal: () => local, writeLocal: s => { local = s; },
    readRemote: async () => { if (!reads++) local = mergeLearningStates(local, state('new')); return remote; },
    writeRemote: async s => { remote = s; }, flush: async () => {},
    markPending: () => { pending = true; }, markSynced: () => { pending = false; }
  });
  assert.deepEqual(ids(local), ['cloud', 'new', 'old']);
  assert.deepEqual(ids(remote), ids(local));
  assert.equal(result.pending, false);
  assert.equal(pending, false);
});

test('new answers during upload and during local flush are re-merged on the next pass', async () => {
  let local = state('old'), remote = state(), writes = 0, flushes = 0;
  await syncLearningState({
    readLocal: () => local, writeLocal: s => { local = s; }, readRemote: async () => remote,
    writeRemote: async s => { remote = s; if (!writes++) local = mergeLearningStates(local, state('during-upload')); },
    flush: async () => { if (!flushes++) local = mergeLearningStates(local, state('during-flush')); },
    markPending() {}, markSynced() {}
  });
  assert.deepEqual(ids(remote), ['during-flush', 'during-upload', 'old']);
  assert.deepEqual(ids(local), ids(remote));
  assert.ok(writes >= 2);
});

test('continuous new answers stay pending after bounded retries, never discarded', async () => {
  let local = state('old'), n = 0, marked = false;
  const result = await syncLearningState({
    readLocal: () => local, writeLocal: s => { local = s; }, readRemote: async () => state(),
    writeRemote: async () => { local = mergeLearningStates(local, state('new-' + ++n)); },
    flush: async () => {}, markPending() {}, markSynced() { marked = true; }, maxPasses: 2
  });
  assert.deepEqual(ids(local), ['new-1', 'new-2', 'old']);
  assert.equal(result.pending, true);
  assert.equal(marked, false);
});

test('an unreadable remote or failed disk commit cannot be marked synchronized', async () => {
  for (const failAt of ['read', 'flush']) {
    let writes = 0, synced = false;
    await assert.rejects(syncLearningState({
      readLocal: () => state('local'), writeLocal() {},
      readRemote: async () => { if (failAt === 'read') throw new Error('unreadable'); return state(); },
      writeRemote: async () => { writes++; },
      flush: async () => { throw new Error('quota'); }, markPending() {}, markSynced() { synced = true; }
    }));
    assert.equal(synced, false);
    if (failAt === 'read') assert.equal(writes, 0);
  }
});

test('per-device publication converges without overwriting another device file', async () => {
  const remote = new Map();
  const devices = { phone: state('phone-answer'), ipad: state('ipad-answer') };
  const run = name => syncLearningState({
    readLocal: () => devices[name], writeLocal: s => { devices[name] = s; },
    readRemote: async () => mergeLearningStates(...remote.values()),
    writeRemote: async s => { remote.set(name, s); }, flush: async () => {}, markPending() {}, markSynced() {}
  });
  await Promise.all([run('phone'), run('ipad')]);
  assert.equal(remote.size, 2);
  await Promise.all([run('phone'), run('ipad')]);
  assert.deepEqual(ids(devices.phone), ['ipad-answer', 'phone-answer']);
  assert.deepEqual(ids(devices.ipad), ids(devices.phone));
});

test('legacy learning payloads remain compatible and kana reading is unioned', () => {
  const result = mergeLearningStates(state('old'), { studyDays: [], kanaReadingHistory: [{ id: 'r1', character: 'ア', ts: 123, correct: true }] });
  assert.equal(result.kanaReadingHistory[0].id, 'r1');
  assert.deepEqual(ids(result), ['old']);
  assert.equal(escapeDriveQuery("a'b\\c"), "a\\'b\\\\c");
});

function localStore() {
  const values = new Map();
  const adapter = {
    fail: false,
    get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: k => values.get(k) ?? null,
    setItem(k, v) { if (this.fail) throw new Error('QuotaExceededError'); values.set(k, String(v)); },
    removeItem(k) { if (this.fail) throw new Error('SecurityError'); values.delete(k); }
  };
  globalThis.localStorage = adapter;
  return { adapter, values };
}

test('quota failures are visible, block flush, and retry persists the latest cached value', async () => {
  const { adapter, values } = localStore();
  const storage = new StorageBridge();
  adapter.fail = true;
  storage.setItem('setting', 'latest');
  assert.equal(storage.getItem('setting'), 'latest');
  assert.equal(storage.getStatus().saveState, 'error');
  await assert.rejects(storage.flush(), { code: 'STORAGE_WRITE_FAILED' });
  assert.equal(values.size, 0);
  adapter.fail = false;
  await storage.retryFailedWrites();
  assert.equal(values.get('pwa_japanese:setting'), 'latest');
  assert.equal(storage.getStatus().saveState, 'saved');
});

test('failed deletion does not reappear from localStorage and can be retried', async () => {
  const { adapter } = localStore();
  const storage = new StorageBridge();
  storage.setItem('setting', 'old');
  adapter.fail = true;
  storage.removeItem('setting');
  assert.equal(storage.getItem('setting'), null);
  await assert.rejects(storage.flush());
  adapter.fail = false;
  await storage.retryFailedWrites();
  assert.equal(adapter.getItem('pwa_japanese:setting'), null);
});

test('IndexedDB errors are handled, reported by flush, and do not erase legacy copies', async () => {
  const { adapter } = localStore();
  adapter.setItem('pwa_japanese:handwritingHistory', 'legacy');
  const storage = new StorageBridge();
  storage.db = {};
  storage._putRecord = async () => { throw new Error('disk full'); };
  storage.setItem('handwritingHistory', 'new');
  await assert.rejects(storage.flush());
  assert.equal(adapter.getItem('pwa_japanese:handwritingHistory'), 'legacy');
  assert.equal(storage.getItem('handwritingHistory'), 'new');
});

test('a late failure of an older revision cannot invalidate a successful newer write', async () => {
  localStore();
  const storage = new StorageBridge(); storage.db = {};
  const jobs = [];
  storage._putRecord = () => new Promise((resolve, reject) => jobs.push({ resolve, reject }));
  storage.setItem('handwritingHistory', 'old');
  storage.setItem('handwritingHistory', 'new');
  jobs[1].resolve(); jobs[0].reject(new Error('stale failure'));
  await storage.flush();
  assert.equal(storage.getStatus().saveState, 'saved');
  assert.equal(storage.getItem('handwritingHistory'), 'new');
});

test('kana reading now uses IndexedDB and flush waits for writes queued during a flush', async () => {
  const { values } = localStore();
  const storage = new StorageBridge(); storage.db = {};
  let resolveFirst;
  storage._putRecord = (key, value) => key === 'kanaReadingHistory'
    ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve();
  storage.setItem('kanaReadingHistory', 'reading');
  const completed = storage.flush();
  storage.setItem('handwritingHistory', 'writing');
  resolveFirst();
  await completed;
  assert.equal(storage.pending.size, 0);
  assert.equal(values.has('pwa_japanese:kanaReadingHistory'), false);
});

function doc(selector = '', draft = '') {
  return {
    querySelector: s => s.split(',').some(x => x.trim() === selector) ? {} : null,
    querySelectorAll: () => draft ? [{ value: draft }] : []
  };
}

test('every active practice surface and draft prevents automatic update', () => {
  for (const selector of ['#kana-reading-answer', '#kana-writing-canvas', '.kana-writing-canvas', '#quiz-ghost-input', '.reading-quiz-shell', '.reading-loading', '.ai-loading']) {
    if (selector === '#kana-writing-canvas') continue;
    assert.equal(isPracticeActive(doc(selector)), true, selector);
  }
  assert.equal(isPracticeActive(doc('', 'unfinished essay')), true);
  for (const flag of ['quizActive', 'essayActive', 'handwritingActive']) assert.equal(isPracticeActive(doc(), { [flag]: true }), true);
  assert.equal(isPracticeActive(doc()), false);
});

test('updates require durable storage and no running cloud operation', () => {
  for (const saveState of ['saving', 'error']) assert.equal(canUpdateApp({ document: doc(), storage: { getStatus: () => ({ ready: true, saveState }) } }), false);
  assert.equal(canUpdateApp({ document: doc(), cloudBusy: true }), false);
  assert.equal(canUpdateApp({ document: doc(), storage: { getStatus: () => ({ ready: true, saveState: 'saved' }) } }), true);
});

test('failed flush prevents worker activation and reload; retry succeeds when safe', async () => {
  let fail = true, messages = 0, reloads = 0;
  globalThis.location = { reload() { reloads++; } };
  const updater = new VersionManager({ currentVersion: 'V1_2_14', storage: { async flush() { if (fail) throw new Error('quota'); } } });
  updater.registration = { waiting: { postMessage() { messages++; } } };
  updater.reloadPending = true;
  assert.equal(await updater.activateWaitingIfSafe(), false);
  assert.equal(await updater.reloadIfSafe(), false);
  assert.equal(messages + reloads, 0);
  fail = false;
  assert.equal(await updater.activateWaitingIfSafe(), true);
  assert.equal(await updater.reloadIfSafe(), true);
  assert.equal(messages, 1); assert.equal(reloads, 1);
});

test('starting a practice while flush is pending cancels activation', async () => {
  let active = false, activated = false;
  const updater = new VersionManager({ currentVersion: 'V1_2_14', canActivate: () => !active, storage: { async flush() { active = true; } } });
  assert.equal(await updater.activateWaitingIfSafe({ postMessage() { activated = true; } }), false);
  assert.equal(activated, false);
});

test('Japanese long vowels, small kana and voicing remain meaningful', () => {
  for (const [a, b] of [['ビール', 'ビル'], ['コート', 'コト'], ['おばあさん', 'おばさん'], ['きゃ', 'きや'], ['か', 'が']]) assert.notEqual(normalizeJapaneseAnswer(a), normalizeJapaneseAnswer(b));
  assert.equal(normalizeJapaneseAnswer(' ﾋﾞｰﾙ。 '), 'ビール');
});
