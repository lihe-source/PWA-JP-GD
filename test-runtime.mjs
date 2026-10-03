import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { SpeechManager } from './audio-manager.js';
import { BackupTaskRunner, runBackupJob } from './backup-tasks.js';
import { compareWordsNewest, wordCreatedAt, choosePracticeWords } from './japanese-learning.js';
import { StorageBridge } from './storage.js';

function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null };
}
function speech(storage = memoryStorage()) {
  const utterances = []; const listeners = new Map();
  const synth = { voices: [], cancel() {}, getVoices() { return this.voices; }, speak(utter) { utterances.push(utter); },
    addEventListener(type, fn) { listeners.set(type, fn); } };
  class Utterance { constructor(text) { this.text = text; } }
  const events = [];
  const manager = new SpeechManager({ storage, synth, Utterance, onStatus: status => events.push(status) });
  return { manager, storage, synth, utterances, listeners, events };
}

test('speech preferences are read after IndexedDB hydration and do not reset a stored off switch', () => {
  const setup = speech();
  assert.equal(setup.manager.enabled, true);
  setup.storage.setItem('ttsEnabled', 'false'); setup.manager.init();
  assert.equal(setup.manager.enabled, false);
  assert.equal(setup.manager.speak('単語'), false);
  assert.equal(setup.utterances.length, 0);
  setup.manager.enabled = true;
  assert.equal(setup.storage.getItem('ttsEnabled'), 'true');
  setup.manager.stop();
});

test('kana starts synchronously on an empty voice list and remains independent of spelling TTS', () => {
  const setup = speech(); setup.storage.setItem('ttsEnabled', 'false'); setup.manager.init();
  assert.equal(setup.manager.speakKana('あ'), true);
  assert.equal(setup.utterances.length, 1); assert.equal(setup.utterances[0].text, 'あ');
  assert.equal(setup.utterances[0].lang, 'ja-JP'); assert.equal(setup.utterances[0].rate, .62);
  setup.synth.voices = [{ lang: 'ja-JP', name: 'Kyoko' }]; setup.listeners.get('voiceschanged')();
  assert.equal(setup.utterances.length, 1, 'voice readiness must not replay the same question');
  setup.manager.stop();
});

test('stale speech callbacks do not affect the next question and manual replay works after a failure', () => {
  const setup = speech(); setup.manager.init(); setup.manager.speakKana('あ');
  const first = setup.utterances[0]; const oldFailure = first.onerror;
  setup.manager.speakKana('い'); const current = setup.utterances[1];
  oldFailure({ error: 'not-allowed' }); assert.equal(setup.manager.lastError, '');
  current.onerror({ error: 'not-allowed' }); assert.match(setup.manager.lastError, /發音未播放/);
  assert.equal(setup.manager.speakKana('い'), true); assert.equal(setup.utterances.length, 3);
  setup.utterances[2].onstart(); assert.equal(setup.manager.state, 'speaking');
  setup.utterances[2].onend(); assert.equal(setup.manager.state, 'idle'); assert.equal(setup.manager._utter, null);
  setup.manager.stop();
});

test('latest-word ordering supports numeric, daily, ISO-date and old imported words', () => {
  const first = new Date(2026, 9, 3, 12, 0).getTime(); const second = first + 5000;
  const words = [{ id: String(first), createdAt: '2026/10/03' }, { id: `daily-${second}-abc`, createdAt: '2026/10/03' },
    { id: 'legacy-uuid', createdAt: '2026-10-02' }, { id: `daily-${second}-old`, createdAt: '2025/01/01' }];
  assert.equal(wordCreatedAt(words[1]), second);
  assert.deepEqual([...words].sort(compareWordsNewest).map(word => word.id), [words[1].id, words[0].id, 'legacy-uuid', words[3].id]);
  assert.equal(wordCreatedAt({ id: 'old-uuid', createdAt: '2026-09-30T12:00:00Z' }), Date.parse('2026-09-30T12:00:00Z'));
});

test('weighted word selection cannot allocate an array proportional to frequency weights or duplicate words', () => {
  const words = Array.from({ length: 1000 }, (_, i) => ({ id: `daily-${1700000000000 + i}-x`, frequencyWeight: i ? 1 : Number.MAX_SAFE_INTEGER }));
  const selected = choosePracticeWords(words, { count: 30, boostedIds: [words[0].id], random: () => .5 });
  assert.equal(selected.length, 30); assert.equal(new Set(selected.map(word => word.id)).size, 30);
  assert.equal(selected[0].id, words[0].id);
  const newest = choosePracticeWords(words, { count: 5, mode: 'newest', random: () => .5 });
  assert.ok(newest.every(word => Number(word.id.split('-')[1]) >= 1700000000970));
  assert.deepEqual(choosePracticeWords(words, { count: 0 }), []);
});

function makeRecordStorage(legacy = [], { migrationError = false } = {}) {
  globalThis.localStorage = memoryStorage(); globalThis.sessionStorage = memoryStorage();
  const storage = new StorageBridge(); const rowWrites = []; const deletes = [];
  const kv = new Map([['sentenceLog', JSON.stringify(legacy)]]);
  storage._open = async () => ({ objectStoreNames: { contains: () => true }, transaction() {}, close() {} });
  storage._getAllKvRecords = async () => [...kv].map(([key, value]) => ({ key, value }));
  storage._getAllCollectionRows = async () => [];
  storage._putManyRecords = async records => records.forEach(record => kv.set(record.key, record.value));
  storage._putRecord = async (key, value) => kv.set(key, value);
  storage._deleteRecord = async key => { deletes.push(key); kv.delete(key); };
  storage._replaceCollectionRows = async (key, records) => { if (migrationError) throw new Error('quota'); rowWrites.push([key, records]); };
  storage._putCollectionRow = async (key, record) => rowWrites.push([key, record]);
  storage._importCompatibleEnglishSettings = async () => {};
  return { storage, rowWrites, deletes, kv };
}

test('all historical same-day sentences migrate to stable record ids without dropping duplicates', async () => {
  const old = [{ date: '2026/10/02', en: '昨日。' }, { date: '2026/10/03', en: '今日。' }, { date: '2026/10/03', en: '今日。' }];
  const first = makeRecordStorage(old); await first.storage.init(); await first.storage.flush();
  const records = first.storage.getRecordCollection('sentenceLog');
  assert.equal(records.length, 3); assert.equal(new Set(records.map(record => record.id)).size, 3);
  assert.equal(records[0].date, '2026/10/03'); assert.ok(first.deletes.includes('sentenceLog'));
  const second = makeRecordStorage([old[1], old[0], old[2]]); await second.storage.init();
  assert.deepEqual(second.storage.getRecordCollection('sentenceLog').map(record => record.id).sort(), records.map(record => record.id).sort());
});

test('writing a new sentence performs one record upsert and preserves every previous example', async () => {
  const setup = makeRecordStorage([{ id: 'old', en: '旧。', generatedAt: '2026-10-02T00:00:00Z' }]);
  await setup.storage.init(); await setup.storage.flush(); setup.rowWrites.length = 0;
  setup.storage.appendRecord('sentenceLog', { id: 'new', en: '新。', generatedAt: '2026-10-03T00:00:00Z' });
  await setup.storage.flush(); assert.equal(setup.rowWrites.length, 1);
  assert.deepEqual(setup.storage.getRecordCollection('sentenceLog').map(record => record.id), ['new', 'old']);
  setup.storage.appendRecord('sentenceLog', { id: 'new', en: '新しい。', generatedAt: '2026-10-03T00:00:00Z' });
  await setup.storage.flush(); assert.equal(setup.storage.getRecordCollection('sentenceLog').length, 2);
  assert.equal(setup.storage.getRecordCollection('sentenceLog')[0].en, '新しい。');
});

test('failed sentence migration retains the complete legacy source and blocks destructive writes', async () => {
  const old = [{ en: '一。' }, { en: '二。' }]; const setup = makeRecordStorage(old, { migrationError: true });
  await setup.storage.init(); assert.equal(setup.storage.getStatus().readOnly, true);
  assert.equal(setup.storage.getRecordCollection('sentenceLog').length, 2);
  assert.equal(setup.kv.get('sentenceLog'), JSON.stringify(old)); assert.equal(setup.deletes.includes('sentenceLog'), false);
  assert.throws(() => setup.storage.appendRecord('sentenceLog', { id: 'new' }), /STORAGE_READ_ONLY/);
});

class BrowserWorkerAdapter {
  constructor(url) {
    const source = `import { parentPort } from 'node:worker_threads'; import { runBackupJob } from ${JSON.stringify(url.href)};
      parentPort.on('message', ({ id, type, payload }) => { try { parentPort.postMessage({ id, result: runBackupJob(type, payload) }); }
      catch (error) { parentPort.postMessage({ id, error: error.message }); } });`;
    this.thread = new NodeWorker(new URL('data:text/javascript,' + encodeURIComponent(source)));
    this.thread.on('message', data => this.onmessage?.({ data })); this.thread.on('error', error => this.onerror?.(error));
  }
  postMessage(message) { this.thread.postMessage(message); }
  terminate() { void this.thread.terminate(); }
}

test('large backup hashing, serialization and parse run in a worker while UI timers continue', async () => {
  const runner = new BackupTaskRunner({ WorkerClass: BrowserWorkerAdapter });
  const sentences = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), en: 'この時計は新しいです。', reading: 'このとけいはあたらしいです。', zh: '這個時鐘很新。' }));
  let heartbeat = 0; const interval = setInterval(() => heartbeat++, 1);
  try {
    const built = await runner.run('build', { collections: { sentences }, metadata: { appVersion: 'V1.6.0' } });
    assert.equal(built.counts.examples, 10000); assert.ok(heartbeat > 0);
    const parsed = await runner.run('parse', built.text); assert.equal(parsed.sentences.length, 10000);
    const comparison = await runner.run('compare', { local: parsed, remote: parsed }); assert.equal(comparison.same, true);
    const corrupt = { ...parsed, sentences: [] };
    assert.equal((await runner.run('validate', corrupt)).valid, false);
    await assert.rejects(runner.run('parse', '{broken json'), /JSON|position|property/);
  } finally { clearInterval(interval); runner._fail(new Error('test cleanup')); }
});

test('backup schema remains compatible and never includes authentication credentials', () => {
  const built = runBackupJob('build', { collections: { words: [{ id: 'old', english: '犬' }], cloudDeviceSessionV1: [{ token: 'private' }], GOOGLE_CLIENT_SECRET: 'private' }, metadata: { appVersion: 'V1.6.0' } });
  assert.equal(runBackupJob('validate', built.data).valid, true); assert.equal(built.data.schemaVersion, 3);
  assert.doesNotMatch(built.text, /cloudDeviceSession|CLIENT_SECRET|private/);
});

test('startup restores preferences after storage initialization and update activation guards all active practice', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const init = app.slice(app.indexOf("document.addEventListener('DOMContentLoaded'"));
  assert.match(init, /await AppStorage\.init\(\);[\s\S]{0,100}TTS\.init\(\)/);
  assert.match(init, /Views\.database\.sortMode = \['createdAt', 'alpha', 'wrongCount'\]/);
  assert.match(init, /const checkForStartupUpdate = async \(\) => \{\s*if \(isPracticeActive\(document, Router\)\) return/);
  assert.ok(init.indexOf("Router._doNavigate('home')") < init.indexOf('setTimeout(() => { void runCloudStartup(); }, 350)'));
});
