import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { StorageBridge } from './storage.js';
import { BackupSchema } from './backup-schema.js';
import { BackgroundJobRunner, executeBackgroundJob } from './background-jobs.js';
import { createGeminiClient } from './gemini-client.js';
import { VersionManager } from './version-manager.js';
import { readingProgress, readingFeedback, firstAttemptSummary, createModalFocusManager, mountSettingsGroups } from './ui-runtime.js';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const escapeHTML = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const memoryStorage = () => {
  const values = new Map();
  globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) };
  return new StorageBridge();
};

test('malformed record JSON never replaces existing answers with an empty collection', () => {
  const storage = memoryStorage();
  storage.setItem('kanaReadingHistory', JSON.stringify([{ id: 'answer', correct: true }]));
  const before = storage.getItem('kanaReadingHistory');
  assert.throws(() => storage.setItem('kanaReadingHistory', '{broken'), /INVALID_RECORD_COLLECTION_JSON/);
  assert.throws(() => storage.setItem('kanaReadingHistory', '{}'), /INVALID_RECORD_COLLECTION/);
  assert.throws(() => storage.setItem('kanaReadingHistory', '[null]'), /INVALID_RECORD_COLLECTION/);
  assert.equal(storage.getItem('kanaReadingHistory'), before);
});

test('background backup preparation and parsing preserve every collection and checksum', () => {
  const prepared = executeBackgroundJob('prepare-backup', { collections: { words: [{ id: 'w', english: '時計' }], wordReadingHistory: [{ id: 'r', word: '時計', answer: 'tokei', correct: true }] }, metadata: { appVersion: 'V1.5.6' } });
  assert.equal(BackupSchema.validate(prepared.data).valid, true);
  assert.equal(executeBackgroundJob('parse-backup', { raw: '\uFEFF'+prepared.serialized }).words[0].english, '時計');
  assert.equal(prepared.data.wordReadingHistory[0].id, 'r');
  assert.throws(() => executeBackgroundJob('parse-backup', { raw: '{bad' }), /BACKUP_INVALID_JSON/);
  const damaged = JSON.parse(prepared.serialized); damaged.words[0].english = '改';
  assert.throws(() => executeBackgroundJob('parse-backup', { raw: JSON.stringify(damaged) }), /BACKUP_INVALID/);
  assert.equal(BackupSchema.maxBytes, 25 * 1024 * 1024);
});

test('background worker lifecycle terminates jobs and reports stages without credentials', async () => {
  let terminated = 0, sent;
  const worker = { terminate() { terminated++; }, postMessage(job) { sent = job; queueMicrotask(() => this.onmessage({ data: { ok:true, result: executeBackgroundJob(job.type, job.payload) } })); } };
  const runner = new BackgroundJobRunner({ workerFactory: () => worker });
  const stages = [];
  const result = await runner.run('prepare-backup', { collections: { words:[] }, metadata:{} }, { onStage: s => stages.push(s) });
  assert.equal(result.data.schemaVersion, 3); assert.equal(terminated,1); assert.equal(runner.busy,false);
  assert.ok(stages.length); assert.doesNotMatch(JSON.stringify(sent), /geminiApiKey|access_token|VAPID/);
});

test('background worker cancellation and timeout do not silently run expensive fallback', async () => {
  let terminated = 0;
  const factory = () => ({ terminate() { terminated++; }, postMessage() {} });
  const runner = new BackgroundJobRunner({ workerFactory:factory, timeoutMs:20 });
  const controller = new AbortController();
  const cancelled = runner.run('validate-backup', {}, { signal:controller.signal });
  setTimeout(() => controller.abort(),5);
  await assert.rejects(cancelled,/OPERATION_CANCELLED/);
  await assert.rejects(runner.run('validate-backup',{}),/BACKGROUND_JOB_TIMEOUT/);
  assert.equal(runner.busy,false); assert.equal(terminated,2);
});

test('reading progress distinguishes planned questions from additional retries', () => {
  const state = { items:Array(7), initialTotal:5, index:5 };
  assert.match(readingProgress('單詞讀音',state), /6 \/ 7.*原定 5 題.*補練 2 題/);
  assert.deepEqual(firstAttemptSummary([{correct:false},{correct:true},{correct:true}],2), { total:2,correct:1,accuracy:50 });
  const feedback = readingFeedback({ correct:false, answer:'<script>' }, 'し', 'shi', 1);
  assert.match(feedback,/上一題訂正/); assert.match(feedback,/&lt;script&gt;/); assert.doesNotMatch(feedback,/<script>/);
});

test('word database renders at most forty cards, filters locally and preserves selection across pages', () => {
  const words = Array.from({length:95},(_,i)=>({ id:String(i), english:i===0?'<unsafe>':'単語'+i, chinese:'中文'+i, createdAt:'2026/10/08', wrongCount:0 }));
  const list = { innerHTML:'', onclick:null, scrollIntoView() {} }, pager = { innerHTML:'', onclick:null }, badge = {};
  const container = { querySelector: s => ({ '#db-list':list,'#db-pagination':pager,'.word-count-badge':badge }[s] || null) };
  const ctx = { Views:{}, AppStorage:{ getItem:key => key === 'vocabWords' ? JSON.stringify(words) : null }, DB:{ getWords:()=>words, getBoostedWords:()=>[] }, escapeHTML, escapeAttr:escapeHTML, TTS:{ speakWhenReady() {} } };
  const start = app.indexOf('Views.database ='), end = app.indexOf('\nViews.essay =',start);
  vm.runInNewContext(app.slice(start,end),ctx);
  const view = ctx.Views.database; view.sortMode='alpha'; view.deleteMode=true; view.selectedIds=new Set(['0']);
  view._refreshWordList(container);
  assert.equal((list.innerHTML.match(/class="db-word-card /g)||[]).length,40);
  assert.doesNotMatch(list.innerHTML,/<unsafe>/); assert.match(list.innerHTML,/&lt;unsafe&gt;/);
  assert.match(pager.innerHTML,/第 1\/3 頁/);
  view._page=2; view._refreshWordList(container);
  assert.equal((list.innerHTML.match(/class="db-word-card /g)||[]).length,15);
  assert.equal(view.selectedIds.has('0'),true);
  view._search='中文42'; view._page=0; view._refreshWordList(container);
  assert.equal((list.innerHTML.match(/class="db-word-card /g)||[]).length,1);
  assert.match(list.innerHTML,/単語42/);
  view._search='沒有符合的關鍵字'; view._refreshWordList(container);
  assert.match(list.innerHTML,/查無符合的單字/);
  assert.equal(pager.innerHTML,''); assert.equal(pager.onclick,null);
  assert.equal(view.selectedIds.has('0'),true);
});

test('home history is bounded to ten records per page and groups dates', () => {
  const entries = Array.from({length:25},(_,i)=>({id:String(i), date:i<13?'2026/10/08':'2026/10/07', en:'この時計です。', reading:'このとけいです。', wordEn:'時計',wordReading:'とけい', zh:'這是鐘。'}));
  const log = { innerHTML:'', querySelector:()=>null };
  const ctx = { Views:{}, DB:{ getCombinedSentenceLog:()=>entries }, document:{ getElementById:()=>log }, escapeHTML, highlightJapaneseTarget:escapeHTML, highlightZh:escapeHTML };
  const start=app.indexOf('Views.home ='), end=app.indexOf('// PRACTICE MODE SELECTOR',start);
  vm.runInNewContext(app.slice(start,end),ctx);
  const home=ctx.Views.home; home.renderSentenceLog();
  assert.equal((log.innerHTML.match(/class="log-entry-card"/g)||[]).length,10);
  assert.equal((log.innerHTML.match(/history-date-heading/g)||[]).length,1);
  home._sentenceLogPage=1; home.renderSentenceLog();
  assert.equal((log.innerHTML.match(/history-date-heading/g)||[]).length,2);
  assert.match(log.innerHTML,/共 25 筆/);
});

test('discovered text models stay selected, image and audio endpoints are excluded', async () => {
  const originalFetch=globalThis.fetch, originalCrypto=globalThis.crypto;
  globalThis.crypto ||= webcrypto;
  globalThis.fetch=async()=>new Response(JSON.stringify({ models:['gemini-text-new','gemini-image-new','gemini-tts-new'].map(id=>({name:'models/'+id,supportedGenerationMethods:['generateContent']})) }));
  try {
    const client=createGeminiClient({getApiKey:()=> 'test-key',getModel:()=> 'gemini-text-new'});
    const catalog=await client.ensureModelCatalog();
    assert.deepEqual(catalog.map(m=>m.id),['gemini-text-new']);
    assert.equal(client._getModelList()[0],'gemini-text-new');
    assert.doesNotMatch(JSON.stringify(client._modelCatalog),/test-key/);
    client._modelCatalog.expiresAt=0; assert.ok(client._getModelList().includes('gemini-3.8-flash'));
  } finally { globalThis.fetch=originalFetch; if(!originalCrypto) delete globalThis.crypto; }
});

test('old API key responses and discovery cannot be committed after changing the key', async () => {
  const original=globalThis.fetch; let key='old-key';
  const client=createGeminiClient({getApiKey:()=>key,getModel:()=> 'gemini-text-new'});
  try {
    globalThis.fetch=async()=>{key='new-key';return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'old result'}]}}]}));};
    await assert.rejects(client._callModelDetailed('gemini-text-new','{}','old-key'),/API_KEY_CHANGED/);
    key='old-key';
    globalThis.fetch=async()=>{key='new-key';return new Response(JSON.stringify({models:[{name:'models/gemini-text-new',supportedGenerationMethods:['generateContent']}]}));};
    await assert.rejects(client.ensureModelCatalog(),/API_KEY_CHANGED/);
    assert.equal(client._modelCatalog,null);
  } finally { globalThis.fetch=original; }
});

test('version manager distinguishes old deployments, deliberate rollback and invalid metadata', async () => {
  const original=globalThis.fetch;
  const storage={setItem() {}};
  const manager=new VersionManager({currentVersion:'V1_5_6',currentBuild:2026100901,storage});
  try {
    globalThis.fetch=async()=>new Response(JSON.stringify({version:'V1_5_4'}));
    let result=await manager.check(); assert.equal(result.hasUpdate,false); assert.equal(result.direction,'older-deployment');
    globalThis.fetch=async()=>new Response(JSON.stringify({version:'V1_5_4',build:2026100902}));
    result=await manager.check(); assert.equal(result.hasUpdate,true); assert.equal(result.direction,'rollback');
    globalThis.fetch=async()=>new Response(JSON.stringify({version:'V1_5_6<script>'}));
    await assert.rejects(manager.check(),/VERSION_INVALID/);
  } finally { globalThis.fetch=original; }
});

test('modal traps focus, supports Escape, makes background inert and restores focus', () => {
  const oldDoc=globalThis.document, oldFrame=globalThis.requestAnimationFrame;
  const handlers=new Map(); let focused;
  const first={disabled:false,tabIndex:0,getClientRects:()=>[{}],focus(){focused=first;document.activeElement=first;}},last={...first,focus(){focused=last;document.activeElement=last;}};
  const previous={isConnected:true,focus(){focused=previous;}};
  const appNode={inert:false,setAttribute(){},removeAttribute(){}};
  const overlay={classList:{contains:()=>false},setAttribute(){},removeAttribute(){},contains:node=>[first,last].includes(node),focus(){}};
  const content={querySelector:()=>null,querySelectorAll:()=>[first,last]};
  globalThis.document={activeElement:previous,getElementById:()=>appNode,addEventListener:(key,fn)=>handlers.set(key,fn),removeEventListener:key=>handlers.delete(key)};
  globalThis.requestAnimationFrame=fn=>fn();
  try {
    const modal=createModalFocusManager();modal.open(overlay,content,()=>modal.close());
    assert.equal(appNode.inert,true);assert.equal(focused,first);
    document.activeElement=last;handlers.get('keydown')({key:'Tab',preventDefault(){}});assert.equal(focused,first);
    handlers.get('keydown')({key:'Escape',preventDefault(){}});assert.equal(appNode.inert,false);assert.equal(focused,previous);
  } finally { globalThis.document=oldDoc;globalThis.requestAnimationFrame=oldFrame; }
});

for (const outcome of ['success', 'cancelled', 'expired']) {
  test('backup upload keeps the settings DOM and scroll position: ' + outcome, async () => {
    const handlers = new Map(), messages = [];
    const makeNode = () => ({ hidden: false, disabled: false, isConnected: true, innerHTML: '原按鈕', textContent: '', attrs: {},
      classList: { states: new Map(), toggle(key, value) { this.states.set(key, value); } },
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(event, handler) { handlers.set(event + ':' + this.id, handler); }
    });
    const nodes = Object.fromEntries(['gd-upload-btn', 'gd-download-btn', 'gd-streak-sync-btn', 'gd-operation-status', 'gd-operation-text', 'gd-operation-percent', 'gd-transfer-cancel', 'gd-last-sync', 'gd-account-status', 'gd-account-dot'].map(id => { const node = makeNode(); node.id = id; return [id, node]; }));
    const settings = { scrollTop: 640, unsavedText: '保留未儲存的設定', cloudOpen: true };
    let renders = 0;
    const ctx = { document: { getElementById: id => nodes[id] || null }, showToast: value => messages.push(value), render() { renders++; settings.scrollTop = 0; },
      GDrive: { _transferController: null, isSignedIn: () => outcome !== 'expired', getUserEmail: () => 'test@example.test',
        cancelTransfer() { this.cancelled = true; },
        async upload({ onProgress }) {
          assert.equal(nodes['gd-download-btn'].disabled, true);
          assert.equal(nodes['gd-streak-sync-btn'].disabled, true);
          this._transferController = {};
          onProgress({ message: '上傳至 Google Drive…', percent: null });
          assert.equal(nodes['gd-transfer-cancel'].hidden, false);
          assert.equal(nodes['gd-transfer-cancel'].disabled, false);
          settings.scrollTop = 690; // The user may scroll during the upload; do not rewind them.
          if (outcome === 'cancelled') handlers.get('click:gd-transfer-cancel')();
          this._transferController = null;
          if (outcome === 'cancelled') throw new Error('OPERATION_CANCELLED');
          if (outcome === 'expired') throw new Error('TOKEN_EXPIRED');
          return '2026/10/9 下午3:45:00';
        }
      }
    };
    const commonStart = app.indexOf('    const setDriveOperation =');
    const commonEnd = app.indexOf('    mountSettingsGroups(container, AppStorage);', commonStart);
    vm.runInNewContext(app.slice(commonStart, commonEnd), ctx);
    const start = app.indexOf("    document.getElementById('gd-upload-btn')?.addEventListener");
    const end = app.indexOf('    // ── 還原備份', start);
    vm.runInNewContext(app.slice(start, end), ctx);
    await handlers.get('click:gd-upload-btn')();
    assert.equal(renders, 0); assert.equal(settings.scrollTop, 690);
    assert.equal(settings.unsavedText, '保留未儲存的設定'); assert.equal(settings.cloudOpen, true);
    assert.equal(nodes['gd-upload-btn'].disabled, false); assert.equal(nodes['gd-upload-btn'].innerHTML, '原按鈕');
    assert.equal(nodes['gd-download-btn'].disabled, false); assert.equal(nodes['gd-streak-sync-btn'].disabled, false);
    assert.equal(nodes['gd-transfer-cancel'].hidden, true); assert.equal(nodes['gd-operation-status'].attrs['aria-busy'], 'false');
    if (outcome === 'success') { assert.match(nodes['gd-last-sync'].textContent, /3:45:00/); assert.equal(nodes['gd-operation-status'].classList.states.get('is-done'), true); }
    if (outcome === 'cancelled') { assert.equal(ctx.GDrive.cancelled, true); assert.match(nodes['gd-operation-text'].textContent, /已取消/); assert.equal(nodes['gd-operation-status'].classList.states.get('has-error'), false); }
    if (outcome === 'expired') assert.match(nodes['gd-account-status'].textContent, /待授權/);
    assert.ok(messages.length);
  });
}

test('settings place cloud first, retain saved disclosure preferences and keep data saving last', () => {
  const oldDocument = globalThis.document;
  class Element {
    constructor(classes = '', text = '') { this.classes = classes.split(' '); this.textContent = text; this.children = []; this.dataset = {}; this.handlers = {}; }
    matches(selector) { return this.classes.includes(selector.slice(1)); }
    getAttribute() { return null; }
    append(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = this; this.children.push(node); }
    set innerHTML(value) { this.body = new Element('settings-category-body'); this.children = [this.body]; }
    querySelector() { return this.body; }
    addEventListener(event, handler) { this.handlers[event] = handler; }
  }
  try {
    globalThis.document = { createElement: () => new Element() };
    for (const savedCloud of [null, '0']) {
      const wrap = new Element();
      const label = new Element('settings-section-label', 'Google Drive 雲端同步');
      const cloudCard = new Element('settings-card');
      const learningLabel = new Element('settings-section-label', '學習設定');
      const learningCard = new Element('settings-card');
      const dataCard = new Element('storage-status-card');
      for (const node of [label, cloudCard, learningLabel, learningCard, dataCard]) wrap.append(node);
      const storage = { getItem: key => key === 'settingsCategory:cloud' ? savedCloud : null, setItem() {} };
      mountSettingsGroups({ querySelector: () => wrap, addEventListener() {} }, storage);
      assert.deepEqual(wrap.children.slice(0, 4).map(node => node.dataset.category), ['cloud', 'learning', 'ai', 'advanced']);
      assert.equal(wrap.children[0].open, savedCloud === null);
      assert.equal(wrap.children[0].body.children[1], cloudCard);
      assert.equal(wrap.children.at(-1), dataCard);
    }
  } finally { globalThis.document = oldDocument; }
});
