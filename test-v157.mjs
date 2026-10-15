import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ViewWorkManager, createToastController, readArray } from './interaction-runtime.js';
import { StorageBridge } from './storage.js';
import { checkWordReadingAnswer, WordReadingProgressManager } from './word-reading.js';
import { createGeminiClient } from './gemini-client.js';
import { normalizeJapaneseWord, normalizeJapaneseAnswer } from './japanese-learning.js';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function memory() {
  const data = new Map();
  globalThis.localStorage = { get length() { return data.size; }, key: i => [...data.keys()][i], getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,String(v)), removeItem: k => data.delete(k) };
  return new StorageBridge();
}

test('a detached or replaced AI job cannot update a later page, including reused containers', () => {
  const jobs = new ViewWorkManager(); const anchor = {};
  const container = { isConnected: true, contains: node => node === anchor };
  const old = jobs.start(container, anchor); assert.equal(old.current(), true);
  const next = jobs.start(container, anchor);
  assert.equal(old.current(), false); assert.equal(old.owns(), false); assert.equal(next.current(), true);
  container.isConnected = false; assert.equal(next.current(), false);
  jobs.cancel(); assert.equal(jobs.busy, false);
});

test('old toast timers and slow storage confirmations cannot hide or replace a newer message', async () => {
  const timers = []; let visible = ''; let resolve;
  const toast = createToastController({ show: text => { visible = text; }, hide: () => { visible = ''; }, setTimer: fn => (timers.push(fn), timers.length), clearTimer() {} });
  await toast.publish('first', 10); await toast.publish('second', 20);
  timers[0](); assert.equal(visible, 'second');
  const slow = toast.publish('saved', 30, () => new Promise(done => { resolve = done; }));
  await toast.publish('latest', 40); resolve('saved'); await slow;
  assert.equal(visible, 'latest'); timers.at(-1)(); assert.equal(visible, '');
});

test('malformed vocabulary cannot be replaced by a generated word or an empty collection', async () => {
  const storage = memory(); storage.cache.set('vocabWords', '[{broken-json');
  const source = app.slice(app.indexOf('const DB = {'), app.indexOf('\nfunction getOrCreateJapaneseDeviceId()'));
  const context = { AppStorage: storage, readArray, normalizeJapaneseWord, normalizeJapaneseAnswer, STUDY_DAYS_CSV_HEADER: 'date,type' };
  vm.runInNewContext(source + '\nthis.db = DB', context);
  assert.throws(() => context.db.upsertDailyVocabularyWord({ source: 'daily-recommendation', wordEn: '時計', wordReading: 'とけい', wordZh: '鐘錶' }), /格式異常/);
  assert.throws(() => storage.setItem('vocabWords', '[]'), /格式異常/);
  assert.equal(storage.getItem('vocabWords'), '[{broken-json');
  assert.equal(storage.getStatus().saveState, 'error');
  await assert.rejects(storage.retryFailedWrites());
  assert.equal(storage.getItem('vocabWords'), '[{broken-json');
  assert.equal(storage.getStatus().saveState, 'error');
});

test('raw recovery preserves damaged learning data without API keys or account secrets', () => {
  const storage = memory(); storage.cache.set('vocabWords', '{bad'); storage.cache.set('geminiApiKey', 'DO-NOT-EXPORT'); storage.cache.set('gdriveToken', 'PRIVATE-TOKEN');
  const recovery = storage.exportRawRecovery();
  assert.equal(recovery.raw.vocabWords, '{bad'); assert.equal(recovery.recoveryOnly, true);
  assert.doesNotMatch(JSON.stringify(recovery), /DO-NOT-EXPORT|PRIVATE-TOKEN/);
  assert.deepEqual(readArray({ getItem: () => null }, 'missing'), []);
  assert.throws(() => readArray({ getItem: () => '{}' }, 'words'), /格式異常/);
});

test('romaji aliases may be mixed independently, without accepting wrong syllables', () => {
  const question = { romaji: 'shitsumon' };
  for (const spelling of ['shitsumon','situmon','sitsumon','shitumon','ＳＨＩＴＳＵＭＯＮ']) assert.equal(checkWordReadingAnswer(question, spelling).correct, true, spelling);
  for (const spelling of ['shitsumo','shisumon','satsumon','shitsumonn','']) assert.equal(checkWordReadingAnswer(question, spelling).correct, false, spelling);
});

test('summary cache invalidates on append, replacement, and atomic restore', async () => {
  const storage = memory(); const manager = new WordReadingProgressManager(storage);
  let calls = 0; const compute = manager._computeSummary.bind(manager); manager._computeSummary = () => { calls++; return compute(); };
  assert.equal(manager.getSummary().attempts, 0); manager.getSummary(); assert.equal(calls, 1);
  storage.appendRecord('wordReadingHistory', { id:'one', ts:1, word:'時計', reading:'とけい', romaji:'tokei', correct:true });
  assert.equal(manager.getSummary().attempts, 1); assert.equal(calls, 2);
  const copy = manager.getSummary(); copy.attempts = 100; assert.equal(manager.getSummary().attempts, 1);
  storage.replaceRecordCollection('wordReadingHistory', []); assert.equal(manager.getSummary().attempts, 0);
  // Fake only persistence: exercise the real atomic publish / cache invalidation.
  storage.db = { objectStoreNames: { contains: () => true } }; storage._commitAtomicStage = async () => {};
  await storage.atomicUpdate(() => storage.replaceRecordCollection('wordReadingHistory', [{ id:'two', ts:2, word:'傘', reading:'かさ', romaji:'kasa', correct:false }]));
  assert.equal(manager.getSummary().attempts, 1); assert.equal(manager.getSummary().wrong, 1);
});

test('long AI tasks share at most three requests across fallback models', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({error:{message:'model not found'}}), {status:404}); };
  const client = createGeminiClient({ getApiKey: () => 'mock-key', getModel: () => 'one' });
  client.ensureModelCatalog = async () => []; client._getModelList = () => ['one','two','three','four','five'];
  await assert.rejects(client.reviewEssayFree('私は日本語を勉強します。', '勉強'), /model not found/);
  assert.equal(calls, 3);
});

test('AI cancellation aborts fetch and rejects a response even if transport ignores abort', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  const controller = new AbortController(); let networkSignal;
  globalThis.fetch = async (_, options) => { networkSignal = options.signal; controller.abort(); return new Response('{"candidates":[{"content":{"parts":[{"text":"late"}]}}]}'); };
  const client = createGeminiClient({ getApiKey: () => 'mock-key' });
  await assert.rejects(client._callModelDetailed('mock', '{}', 'mock-key', 0, true, client._taskBudget({signal:controller.signal})), /OPERATION_CANCELLED/);
  assert.equal(networkSignal.aborted, true);
});

test('an expired AI task never starts another network request', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; }); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected'); };
  const client = createGeminiClient({ getApiKey: () => 'mock' });
  await assert.rejects(client._callModelDetailed('mock','{}','mock',0,true,{deadline:Date.now()-1,requests:0,maxRequests:3}), /API_TIMEOUT/);
  assert.equal(calls, 0);
});

test('backup preparation yields before collection reads and cancellation prevents worker upload', async () => {
  let reads = 0, jobs = 0;
  const controller = new AbortController();
  const source = app.slice(app.indexOf('const GDrive = {'), app.indexOf('// ===== UTILITIES ====='));
  const context = { DB: { getWords: () => { reads++; return []; } }, AppStorage: { flush: async () => {}, collectionVersions: new Map() }, setTimeout, clearTimeout, BackgroundJobs: {run: () => { jobs++; } } };
  vm.runInNewContext(source + '\nthis.drive = GDrive', context);
  context.drive._progress = () => controller.abort();
  await assert.rejects(context.drive._prepareBackup({signal:controller.signal}), /OPERATION_CANCELLED/);
  assert.equal(reads, 0); assert.equal(jobs, 0);
});
