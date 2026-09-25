import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { localDateKey, shouldSkipReminder } from './worker.js';
import {
  DAILY_LEARNING_SOURCES,
  normalizeDailyLearningPreferences,
  parseDailyVocabularyResponse,
  parseGeneratedSentenceResponse,
  selectedLearningRows,
  validateGeneratedSentence
} from './daily-learning.js';

const text = name => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

async function loadGeminiWithFetch(fetchImpl, selectedModel = 'gemini-2.5-pro') {
  const app = await text('app.js');
  const start = app.indexOf('const Gemini = {');
  const end = app.indexOf('\n// ===== GOOGLE DRIVE SYNC =====', start);
  assert.ok(start >= 0 && end > start, 'Gemini client block must be discoverable');
  const context = {
    AbortController, Date, Error, JSON, Math, Promise, String,
    URLSearchParams, TextEncoder, Uint8Array, crypto: webcrypto,
    clearTimeout, setTimeout,
    fetch: fetchImpl,
    DB: {
      getApiKey: () => 'unit-test-key',
      getModel: () => selectedModel,
      getJlptLevel: () => 'N5'
    },
    DAILY_LEARNING_SOURCES,
    normalizeDailyLearningPreferences,
    parseDailyVocabularyResponse,
    parseGeneratedSentenceResponse,
    selectedLearningRows,
    validateGeneratedSentence
  };
  vm.runInNewContext(`${app.slice(start, end)}\nthis.__Gemini = Gemini;`, context);
  return context.__Gemini;
}

const mockResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return payload; }
});

async function loadHomeViewContext(overrides = {}) {
  const app = await text('app.js');
  const start = app.indexOf('Views.home = {');
  const end = app.indexOf('\n\n// ===========================\n// PRACTICE MODE SELECTOR', start);
  assert.ok(start >= 0 && end > start, 'home view block must be discoverable');
  const context = {
    Views: {}, Map, Date, Promise, String, Array, JSON,
    crypto: { randomUUID: () => 'generation-test-1' },
    document: { getElementById: () => null, querySelector: () => null },
    DB: {}, Gemini: {}, AppStorage: { flush: async () => {} },
    DAILY_LEARNING_SOURCES: { LEVEL: 'level' },
    dailyLearningSignature: () => '2026-09-19|level|N5|a',
    todayStr: () => '2026-09-19',
    normalizeJapaneseAnswer: value => String(value || ''),
    validateGeneratedSentence: value => ({ ok: true, value: { en: value.en, reading: value.reading, zh: value.zh } }),
    escapeHTML: value => String(value || ''),
    ...overrides
  };
  vm.runInNewContext(`${app.slice(start, end)}\nthis.__home = Views.home;`, context);
  return { context, home: context.__home };
}

test('Gemini recommendation uses structured JSON and falls back from an unavailable selected model', async () => {
  const requests = [];
  const gemini = await loadGeminiWithFetch(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (requests.length === 1) {
      return mockResponse(404, { error: { status: 'NOT_FOUND', message: 'model is not found' } });
    }
    return mockResponse(200, {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[{"word":"傘","reading":"かさ","romaji":"kasa","partOfSpeech":"名詞","meaning":"雨傘","level":"N5"}]' }] } }]
    });
  });
  const result = await gemini.generateDailyVocabulary({ level: 'N5', rows: ['ka', 'sa'], count: 1 });
  assert.equal(result[0].word, '傘');
  assert.match(requests[0].url, /gemini-2\.5-pro/);
  assert.match(requests[1].url, /gemini-3\.8-flash/);
  assert.equal(requests[1].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(requests[1].body.generationConfig.responseSchema.type, 'ARRAY');
  assert.ok(requests[1].body.generationConfig.maxOutputTokens >= 1000);
});

test('Gemini rejects a word whose reading crosses into an unselected kana row', async () => {
  let requestCount = 0;
  const gemini = await loadGeminiWithFetch(async () => {
    requestCount++;
    const text = requestCount === 1
      ? '[{"word":"食べる","reading":"たべる","romaji":"taberu","partOfSpeech":"動詞","meaning":"吃","level":"N5"}]'
      : '[{"word":"手","reading":"て","romaji":"te","partOfSpeech":"名詞","meaning":"手","level":"N5"}]';
    return mockResponse(200, {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }]
    });
  });
  const result = await gemini.generateDailyVocabulary({
    level: 'N5', rows: ['a', 'ka', 'sa', 'ta', 'na', 'ha'], count: 1
  });
  assert.equal(requestCount, 2);
  assert.equal(result[0].word, '手');
  assert.equal(result[0].reading, 'て');
});

test('Gemini connection test uses real sentence validation and retries schema-incompatible endpoints', async () => {
  const requests = [];
  const gemini = await loadGeminiWithFetch(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return mockResponse(400, { error: { status: 'INVALID_ARGUMENT', message: 'responseSchema is not supported' } });
    }
    return mockResponse(200, {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ja":"猫がいます。","kana":"ねこがいます。","zh":"有一隻貓。"}' }] } }]
    });
  }, 'gemini-3.8-flash');
  const result = await gemini.testConnection();
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.equal(result.validated, 'sentence');
  assert.equal(result.saved, false);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].generationConfig.responseMimeType, 'application/json');
  assert.equal(requests[1].generationConfig.responseMimeType, undefined);
});

test('Gemini model discovery follows pages and excludes models without generateContent', async () => {
  const requests = [];
  const gemini = await loadGeminiWithFetch(async (url, options) => {
    requests.push({ url, header: options.headers['x-goog-api-key'] });
    if (requests.length === 1) return mockResponse(200, {
      models: [
        { name: 'models/gemini-image-only', supportedGenerationMethods: ['generateImage'] },
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] }
      ], nextPageToken: 'second'
    });
    return mockResponse(200, { models: [
      { name: 'models/gemini-3-flash-preview', supportedGenerationMethods: ['generateContent'] }
    ] });
  }, 'gemini-3.8-flash');
  const models = await gemini.discoverModels();
  assert.equal(models.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1].url).searchParams.get('pageToken'), 'second');
  assert.equal(requests[0].header, 'unit-test-key');
  assert.equal(JSON.stringify(gemini._modelCatalog).includes('unit-test-key'), false);
  assert.equal(gemini._getModelList()[0], 'gemini-2.5-flash');
  await gemini.discoverModels();
  assert.equal(requests.length, 2);
});

test('home recommendation single-flights refreshes and keeps request state on the home view', async () => {
  let resolveWords;
  let generateCalls = 0;
  const hero = { innerHTML: '' };
  const { home } = await loadHomeViewContext({
    document: { getElementById: id => id === 'hero-content' ? hero : null, querySelector: () => null },
    DB: {
      getTodayDailyVocabulary: () => null,
      getApiKey: () => 'unit-test-key',
      getDailyLearningPreferences: () => ({ source: 'level', level: 'N5', rows: ['a'] }),
      saveTodayDailyVocabulary: words => ({ date: '2026-09-19', signature: '2026-09-19|level|N5|a', level: 'N5', rows: ['a'], words })
    },
    Gemini: {
      generateDailyVocabulary: () => {
        generateCalls++;
        return new Promise(resolve => { resolveWords = resolve; });
      },
      describeError: () => 'unexpected failure'
    }
  });
  let displayed = null;
  home.displayDailyVocabulary = data => { displayed = data; };
  home.ensureDailyVocabularySentence = async () => null;
  const first = home.loadDailyVocabulary(true);
  const second = home.loadDailyVocabulary(true);
  assert.equal(generateCalls, 1);
  assert.ok(home._dailySentenceRequests instanceof Map);
  resolveWords([{ word: '犬', reading: 'いぬ', romaji: 'inu', meaning: '狗', partOfSpeech: '名詞', level: 'N5' }]);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.words[0].word, '犬');
  assert.equal(secondResult.words[0].word, '犬');
  assert.equal(displayed.words[0].word, '犬');
  assert.equal(home._dailyVocabularyRequest, null);
});

test('saved recommendation can generate and store its sentence without replacing the word card', async () => {
  const data = {
    date: '2026-09-19', signature: '2026-09-19|level|N5|a', level: 'N5', rows: ['a'],
    words: [{ word: '犬', reading: 'いぬ', romaji: 'inu', meaning: '狗', partOfSpeech: '名詞' }]
  };
  let stored = null;
  const { home } = await loadHomeViewContext({
    DB: {
      getSentenceLog: () => [],
      getTodayDailyVocabulary: () => data,
      getDailyLearningPreferences: () => ({ source: 'level', level: 'N5', rows: ['a'] }),
      getJlptLevel: () => 'N5',
      saveGeneratedSentence: async entry => { stored = entry; return entry; }
    },
    Gemini: {
      generateSentence: async () => ({
        en: '犬が好きです。', reading: 'いぬがすきです。', zh: '我喜歡狗。',
        generation: { model: 'gemini-3.6-flash' }
      })
    }
  });
  home.renderSentenceLog = () => {};
  home.displayRecommendedSentence = () => {};
  const result = await home.ensureDailyVocabularySentence(data);
  assert.equal(result.wordEn, '犬');
  assert.equal(stored.en, '犬が好きです。');
  assert.equal(home._dailySentenceRequests.size, 0);
});

test('a database sentence is saved after leaving home, without trying to repaint the missing card', async () => {
  let finishGeneration;
  let visible = true;
  let stored = null;
  const hero = { innerHTML: '' };
  const { home } = await loadHomeViewContext({
    document: { getElementById: id => id === 'hero-content' && visible ? hero : null },
    DB: {
      getApiKey: () => 'test-key',
      getWords: () => [{ english: '時計', chinese: '鐘錶', phonetic: 'とけい' }],
      getDailyLearningPreferences: () => ({ source: 'database' }),
      saveGeneratedSentence: async entry => { stored = entry; return entry; }
    },
    Gemini: { generateSentence: () => new Promise(resolve => { finishGeneration = resolve; }) }
  });
  const pending = home.loadSentence(true);
  visible = false;
  finishGeneration({ en: 'この時計は新しい。', reading: 'このとけいはあたらしい。', zh: '這只鐘很新。' });
  await pending;
  assert.equal(stored.wordReading, 'とけい');
  assert.equal(stored.en, 'この時計は新しい。');
});

test('sentence CSV roundtrip preserves repeated words, identifiers, reading, quotes and line breaks', async () => {
  const app = await text('app.js');
  const start = app.indexOf('const DB = {');
  const end = app.indexOf('\nfunction getOrCreateJapaneseDeviceId()', start);
  const values = new Map();
  const context = {
    STUDY_DAYS_CSV_HEADER: 'date,type',
    AppStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    }
  };
  vm.runInNewContext(`${app.slice(start, end)}\nthis.__db = DB;`, context);
  const db = context.__db;
  const first = { id: 'one', generationId: 'one', date: '2026-09-25', wordEn: '時計', wordReading: 'とけい', wordRomaji: 'tokei', en: 'この時計は新しい。', reading: 'このとけいはあたらしい。', zh: '這只鐘很新。' };
  const second = { ...first, id: 'two', generationId: 'two', en: '「時計」を\n見ました。', reading: '「とけい」を\nみました。' };
  db.saveSentenceToLog(first);
  db.saveSentenceToLog(second);
  const csv = db.exportSentencesCSV();
  values.clear();
  assert.equal(db.detectCSVType(csv), 'sentences');
  assert.equal(db.importSentencesCSV(csv).added, 2);
  const imported = db.getImportedSentences();
  assert.deepEqual(Array.from(imported, item => item.id).sort(), ['one', 'two']);
  assert.equal(imported.find(item => item.id === 'two').en, second.en);
  assert.equal(imported.find(item => item.id === 'one').wordReading, 'とけい');
  assert.equal(db.importSentencesCSV(csv).added, 0);
});

test('reading questions omit script and row hints but keep setup and handwriting labels', async () => {
  const [app, style] = await Promise.all([text('app.js'), text('style.css')]);
  assert.doesNotMatch(app, /kana-reading-script-badge|kana-reading-row-label/);
  assert.match(app, /id="kana-reading-row-summary"/);
  assert.match(app, /class="kana-script-label"/);
  assert.match(app, /id="kana-reading-character"/);
  assert.match(app, /id="kana-reading-progress-text"/);
  assert.match(style, /\.kana-reading-session > \.kana-session-header \{ grid-template-columns: 44px minmax\(0,1fr\); \}/);
});

test('English-style bottom navigation reserves its full height above practice content', async () => {
  const style = await text('style.css');
  const design = style.slice(style.indexOf('/* ===== V1.5.1 藍墨'));
  assert.match(design, /#app \{[^}]*height: 100%;[^}]*padding-bottom: calc\(var\(--nav-height\) \+ var\(--safe-bottom\)\)/);
  assert.match(design, /html \{ height: 100%; \}/);
  assert.match(design, /--nav-height: 64px/);
  assert.doesNotMatch(design, /#app \{[^}]*position: fixed/);
  const nav = design.match(/#bottom-nav\s*\{([^}]+)\}/)[1];
  assert.match(nav, /position: fixed; inset: auto 0 0/);
  assert.match(nav, /height: calc\(var\(--nav-height\) \+ var\(--safe-bottom\)\)/);
  assert.equal((nav.match(/var\(--safe-bottom\)/g) || []).length, 1);
  assert.match(design, /#view-container \{ min-height: 0; padding-bottom: 16px/);
  assert.match(design, /@media \(min-width: 900px\)[\s\S]*#app \{[^}]*padding-bottom: 0/);
  assert.match(design, /@media \(min-width: 900px\)[\s\S]*#bottom-nav \{ position: absolute/);
});

test('blue ink home uses real history, recommendation and both kana shortcuts', async () => {
  const [app, html] = await Promise.all([text('app.js'), text('index.html')]);
  assert.match(app, /StudyStreak\.getDayKeys\(\)/);
  assert.match(app, /practiced\.has\(key\)/);
  assert.match(app, /data-nav="kanaReadingPractice"/);
  assert.match(app, /data-nav="kanaPractice"/);
  assert.match(app, /preview\.dataset\.word !== entry\.wordEn/);
  assert.match(app, /this\.displayRecommendedSentence\(existing\)/);
  assert.match(app, /this\.displayRecommendedSentence\(savedEntry\)/);
  assert.match(app, /currentView === 'kanaReadingPractice'[\s\S]{0,120}cleanup/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
  assert.doesNotMatch(html, /viewport-fit=cover/);
  assert.doesNotMatch(html, /user-scalable=no/);
});

test('all public app surfaces use Japanese V1.5.1', async () => {
  const [app, html, sw, version, manifest, pkg] = await Promise.all([
    text('app.js'), text('index.html'), text('sw.js'), text('version.json'), text('manifest.json'), text('package.json')
  ]);
  assert.match(app, /APP_VERSION = 'V1_5_1'/);
  assert.match(html, /app\.js\?v=V1_5_1/);
  assert.match(sw, /Japanese-PWA-V1_5_1/);
  for (const module of ['japanese-learning', 'kana-data', 'kana-strokes', 'handwriting-engine']) assert.match(sw, new RegExp(module));
  assert.equal(JSON.parse(version).schemaVersion, 1);
  assert.match(JSON.parse(manifest).name, /V1\.5\.1/);
  assert.equal(JSON.parse(pkg).version, '1.5.1');
});

test('kana reading keeps one input focused and uses audible iOS playback feedback', async () => {
  const [app, style] = await Promise.all([text('app.js'), text('style.css')]);
  const kanaBlock = app.slice(app.indexOf('Views.kanaReadingPractice'), app.indexOf('// READING QUIZ VIEW'));
  assert.match(app, /_focusAnswerInput\(input\)[\s\S]{0,700}focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /id="kana-reading-answer"[^>]*inputmode="text"[^>]*autofocus/);
  assert.match(app, /navigator\.audioSession\.type = 'playback'/);
  assert.match(app, /#quiz-ghost-input, #kana-reading-answer/);
  assert.match(kanaBlock, /event\.key !== 'Enter'[\s\S]{0,180}form\?\.requestSubmit\(\)/);
  assert.match(kanaBlock, /this\._submitCurrentAnswer\(container\);\s*this\._focusAnswerInput\(input\)/);
  assert.match(kanaBlock, /if \(this\.state\.transitioning\) event\.preventDefault\(\)/);
  assert.match(kanaBlock, /checked\.correct \? Sound\.playCorrect\(\) : Sound\.playWrong\(\)/);
  assert.match(kanaBlock, /setTimeout\(\(\) => \{ void Sound\.playResult\(score\); \}, 150\)/);
  assert.match(kanaBlock, /Keep the same input element focused/);
  assert.match(kanaBlock, /this\._paintCurrentQuestion\(\);[\s\S]{0,100}this\._focusAnswerInput\(input\)/);
  assert.doesNotMatch(kanaBlock, /input\.disabled = true/);
  assert.match(style, /\.kana-reading-question-card:focus-within/);
});

test('all six practice modes share the compact setup layout', async () => {
  const [app, style] = await Promise.all([text('app.js'), text('style.css')]);
  for (const className of [
    'word-practice-page', 'kana-setup-page', 'kana-reading-page',
    'essay-practice-page', 'reading-practice-page', 'aiask-practice-page'
  ]) assert.match(app, new RegExp(className));
  assert.match(app, /word-practice-setup-card/);
  assert.match(app, /kana-reading-setup-card kana-setup-card kana-setup-compact practice-compact-card/);
  assert.match(app, /reading-rule-grid practice-summary-strip/);
  assert.match(app, /settings-card practice-compact-card aiask-practice-card/);
  assert.match(style, /\.practice-compact-page/);
  assert.match(style, /\.practice-summary-strip/);
  assert.match(style, /@media \(max-width: 700px\)[\s\S]*?\.practice-compact-page > \.practice-page-header \{ display: none/);
  assert.match(style, /\.practice-six-grid \{ grid-template-columns: repeat\(6/);
  assert.match(style, /\.reading-practice-page \.reading-rule-grid \{ grid-template-columns: repeat\(4/);
});

test('V1.5.1 keeps Apple subscription repair and provider errors', async () => {
  const [manager, worker] = await Promise.all([text('reminder-manager.js'), text('worker.js')]);
  assert.match(manager, /forceRenew/);
  assert.match(manager, /SUBSCRIPTION_INVALID/);
  assert.match(manager, /_renewAndRegister/);
  assert.match(worker, /BadDeviceToken/);
  assert.match(worker, /providerReason/);
  assert.match(worker, /contentEncoding: 'aes128gcm'/);
  assert.doesNotMatch(worker, /topic: isTest/);
});

test('completed practice suppresses only the same local day before its reminder time', () => {
  const scheduledAt = Date.parse('2026-09-10T12:00:00.000Z'); // Asia/Taipei 20:00
  const row = { time_zone: 'Asia/Taipei', next_fire_at: scheduledAt };
  assert.equal(localDateKey(scheduledAt, row.time_zone), '2026-09-10');
  assert.equal(shouldSkipReminder(row, {
    practice_date: '2026-09-10', completed_at: Date.parse('2026-09-10T11:59:59.000Z')
  }), true);
  assert.equal(shouldSkipReminder(row, {
    practice_date: '2026-09-10', completed_at: Date.parse('2026-09-10T12:00:01.000Z')
  }), false);
  assert.equal(shouldSkipReminder(row, {
    practice_date: '2026-09-09', completed_at: Date.parse('2026-09-09T11:00:00.000Z')
  }), false);
  const retryRow = { ...row, next_fire_at: Date.parse('2026-09-10T12:05:00.000Z') };
  assert.equal(shouldSkipReminder(retryRow, {
    practice_date: '2026-09-10', completed_at: Date.parse('2026-09-10T12:02:00.000Z')
  }, scheduledAt), false, 'a retry must retain the original configured-time boundary');
});

test('all completed practice paths report reminder activity and Worker checks it before push', async () => {
  const [app, manager, worker, schema] = await Promise.all([
    text('app.js'), text('reminder-manager.js'), text('worker.js'), text('schema.sql')
  ]);
  assert.match(app, /DailyReminder\.recordPracticeCompletion/);
  assert.match(app, /syncDailyReminderFromStudyDays/);
  assert.match(manager, /\/api\/reminders\/activity/);
  assert.match(manager, /scopeHash\(`device:/);
  assert.match(worker, /if \(shouldSkipReminder\(row, practice, scheduledFor\)\)/);
  assert.match(worker, /scheduled_for/);
  assert.match(worker, /Daily reminder skipped after completed practice/);
  assert.match(schema, /PRIMARY KEY \(scope_key, practice_date\)/);
});

test('Google Drive startup and backup operations are non-blocking and observable', async () => {
  const [app, html, style] = await Promise.all([text('app.js'), text('index.html'), text('style.css')]);
  assert.match(html, /accounts\.google\.com\/gsi\/client/);
  assert.match(app, /GDrive\.preload\(\)/);
  assert.match(app, /setTimeout\(\(\) => \{ void runCloudStartup\(\); \}, 350\)/);
  assert.match(app, /this\.scheduleStudyStreakSync\(250\)/);
  assert.doesNotMatch(app, /async upload[\s\S]{0,180}await this\.syncStudyStreak/);
  assert.match(app, /DRIVE_TIMEOUT/);
  assert.match(style, /\.drive-operation-status/);
});

test('remembered Google account restores without account chooser before home', async () => {
  const app = await text('app.js');
  assert.match(app, /promptMode !== undefined/);
  assert.match(app, /req\.prompt = promptMode/);
  assert.match(app, /promptMode: 'none', accountHint: this\.getUserEmail\(\)/);
  assert.match(app, /promptMode: this\.getUserEmail\(\) \? '' : 'consent select_account'/);
  assert.match(app, /void AppUpdater\.register\(\)/);
  assert.doesNotMatch(app, /await AppUpdater\.register\(\)/);
  assert.match(app, /Router\._doNavigate\('home'\);[\s\S]{0,120}GDrive\.preload\(\)/);
  assert.doesNotMatch(app, /await runCloudStartup\(\)/);
});

test('V1.1 remembers practice choices and provides multi-row layout controls', async () => {
  const [app, style, kanaData] = await Promise.all([text('app.js'), text('style.css'), text('kana-data.js')]);
  assert.match(app, /lastPracticeMode/);
  assert.match(app, /wordPracticePreferencesV1/);
  assert.match(app, /kanaPracticePreferencesV1/);
  assert.match(app, /data-kana-row=/);
  assert.match(app, /data-kana-layout=/);
  assert.match(app, /practice: DB\.getPracticePreferenceBundle\(\)/);
  assert.match(kanaData, /rows = null/);
  assert.match(style, /\.kana-session-actions\s*\{[\s\S]*?position:\s*sticky/);
  assert.match(style, /bottom:\s*calc\(var\(--nav-height\) \+ var\(--safe-bottom\)/);
  assert.match(style, /html\.kana-view-active #global-back-top/);
  assert.match(style, /\.kana-session\[data-layout="phone"\]/);
  assert.match(style, /\.kana-session\[data-layout="tablet"\]/);
});

test('kana setup supports saved repetitions and a compact one-page layout', async () => {
  const [app, style, kanaData] = await Promise.all([text('app.js'), text('style.css'), text('kana-data.js')]);
  assert.match(kanaData, /KANA_REPEAT_OPTIONS/);
  assert.match(kanaData, /buildRepeatedKanaPractice/);
  assert.match(kanaData, /group\.key !== previousKey/);
  assert.match(app, /data-kana-repeat=/);
  assert.match(app, /repeat: KANA_REPEAT_OPTIONS\.includes/);
  assert.match(app, /buildRepeatedKanaPractice\(pool, this\.state\.repeat\)/);
  assert.match(app, /<details class="kana-advanced-settings">/);
  assert.match(style, /\.kana-setup-grid/);
  assert.match(style, /\.kana-repeat-grid/);
  assert.match(style, /\.kana-setup-compact \.kana-row-grid \{ grid-template-columns: repeat\(4/);
});

test('every handwriting question automatically speaks its kana with replay support', async () => {
  const app = await text('app.js');
  assert.match(app, /autoSpeak: saved\.autoSpeak !== false/);
  assert.match(app, /id="kana-auto-speak"/);
  assert.match(app, /speakKana\(text, rate = 0\.62/);
  assert.match(app, /if \(this\.state\.autoSpeak\) TTS\.speakKana\(kana\.character, 0\.62, \{ immediate: true \}\)/);
  assert.match(app, /TTS\.speakKana\(this\.state\.items\[this\.state\.index\]\.character\)/);
  assert.match(app, /cleanup\(\) \{[\s\S]{0,120}TTS\.stop\(\)/);
});

test('iPhone action has its own reserved row before and after scoring', async () => {
  const [app, style] = await Promise.all([text('app.js'), text('style.css')]);
  const design = style.slice(style.indexOf('/* ===== V1.5.1 藍墨'));
  assert.match(design, /\.kana-session-body\s*\{[^}]*min-height: 0;[^}]*overflow: auto/);
  assert.match(design, /\.kana-session\[data-layout="phone"\] \.kana-session-actions\.is-scored\s*\{\s*position: static; flex: 0 0 auto/);
  assert.doesNotMatch(design, /position:\s*sticky/);
  assert.match(app, /class="kana-session-body"/);
  assert.match(design, /#bottom-nav\s*\{\s*position: fixed/);
  assert.match(style, /\.kana-session\[data-layout="phone"\] \.kana-score-panel/);
  const scoring = app.slice(app.indexOf('  scoreCurrent(container, kana, button)'), app.indexOf('Views.kanaReadingPractice ='));
  assert.match(scoring, /classList\.add\('is-scored'\)/);
  assert.doesNotMatch(scoring, /scrollIntoView/);
});

test('blue Japanese theme and iPad handwriting layout are present', async () => {
  const [app, style, manifest] = await Promise.all([text('app.js'), text('style.css'), text('manifest.json')]);
  assert.equal(JSON.parse(manifest).theme_color, '#f3f7fc');
  assert.equal(JSON.parse(manifest).orientation, 'any');
  assert.match(style, /--primary:\s*#2463d5/);
  assert.match(style, /container-type: size/);
  assert.match(style, /width: min\(100cqw, 100cqh\); height: min\(100cqw, 100cqh\)/);
  assert.match(style, /\.kana-writing-canvas/);
  assert.match(style, /pointer:\s*coarse/);
  assert.match(app, /new HandwritingEngine/);
  assert.match(app, /Apple Pencil/);
});

test('handwriting keeps rendering and Drive synchronization off the critical input path', async () => {
  const [app, engine] = await Promise.all([text('app.js'), text('handwriting-engine.js')]);
  assert.match(engine, /addEventListener\('pointermove',[\s\S]{0,80}passive: true/);
  assert.match(engine, /_drawStrokeRange\(context, stroke, startIndex\)/);
  assert.match(engine, /drawnPointIndex/);
  assert.doesNotMatch(engine, /pendingSegments/);
  assert.match(engine, /resizePending/);
  assert.match(app, /document\.querySelector\('\.kana-writing-canvas, #kana-reading-answer'\)/);
  assert.match(app, /setTimeout\(runWhenPracticeIsIdle, 2500\)/);
  const handwritingBlock = app.slice(app.indexOf('Views.kanaPractice ='), app.indexOf('Views.kanaReadingPractice ='));
  assert.doesNotMatch(handwritingBlock, /recordStudyActivity[\s\S]{0,180}scheduleStudyStreakSync\(350\)/);
  assert.match(handwritingBlock, /if \(isLast\) GDrive\.scheduleStudyStreakSync\(900\)/);
});

test('all six completed practice paths qualify as study activity', async () => {
  const app = await text('app.js');
  for (const activity of ['WORD_QUIZ', 'KANA_HANDWRITING', 'KANA_READING', 'READING_QUIZ', 'ESSAY_REVIEW', 'AI_ASK']) {
    assert.match(app, new RegExp(`recordStudyActivity\\(STUDY_ACTIVITY_TYPES\\.${activity}`));
  }
});

test('V1.5.1 adds kana-to-romaji practice under handwriting with statistics', async () => {
  const [app, style, module, backup] = await Promise.all([
    text('app.js'), text('style.css'), text('kana-reading.js'), text('backup-schema.js')
  ]);
  assert.match(app, /<option value="kana"[\s\S]{0,180}<option value="kanaReading"/);
  assert.match(app, /data-reading-script="hiragana"/);
  assert.match(app, /data-reading-script="katakana"/);
  assert.match(app, /data-reading-row="all"/);
  assert.match(app, /renderKanaReadingStats/);
  assert.match(app, /KanaReadingProgress\.recordAttempt/);
  assert.match(module, /checkKanaReadingAnswer/);
  assert.match(module, /KanaReadingProgressManager/);
  assert.match(style, /\.kana-reading-question-card/);
  assert.match(backup, /kanaReadingHistory/);
});

test('V1.5.1 recommends one daily word and stores its sentence practice', async () => {
  const [app, style, module, sw] = await Promise.all([
    text('app.js'), text('style.css'), text('daily-learning.js'), text('sw.js')
  ]);
  assert.match(app, /daily-learning\.js\?v=V1_5_1/);
  assert.match(app, /id="daily-learning-source-select"/);
  assert.match(app, /data-learning-row=/);
  assert.match(app, /generateDailyVocabulary/);
  assert.match(app, /count = 1/);
  assert.match(app, /normalizeDailyVocabulary\(words/);
  assert.match(app, /normalizeDailyVocabulary\(saved\.words/);
  assert.match(module, /EVERY pronounced kana|每一個/);
  assert.match(app, /ensureDailyVocabularySentence/);
  assert.match(app, /source: 'daily-recommendation'/);
  assert.match(app, /DB\.saveGeneratedSentence\(entry,/);
  assert.match(app, /responseMimeType: 'application\/json'/);
  assert.match(app, /responseSchema/);
  assert.match(app, /_dailySentenceRequests/);
  assert.match(app, /_dailySentenceContextIsCurrent/);
  assert.match(app, /validationStatus: 'valid'/);
  assert.match(app, /dailyLearning: this\.getDailyLearningPreferences\(\)/);
  assert.match(module, /kanaToRomaji/);
  assert.match(module, /readingMatchesRows/);
  assert.match(module, /parseGeneratedSentenceResponse/);
  assert.match(module, /validateGeneratedSentence/);
  assert.match(module, /TARGET_NOT_USED/);
  assert.doesNotMatch(app, /Fallback: accept either two lines/);
  assert.match(style, /\.daily-vocab-grid/);
  assert.match(sw, /daily-learning\.js\?v=V1_5_1/);
});

test('same-day generated examples append and target spellings are highlighted precisely', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const style = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(app, /item\?\.id && item\.id === record\.id/);
  assert.doesNotMatch(app, /log\[index\]\?\.date === entry\.date && log\[index\]\?\.source === 'daily-recommendation'/);
  assert.match(app, /ensureDailyVocabularySentence\(saved, \{ forceNew \}\)/);
  assert.match(app, /highlightJapaneseTarget\(entry\.en, entry\.wordEn\)/);
  assert.match(app, /highlightJapaneseTarget\(entry\.reading, entry\.wordReading\)/);
  assert.match(style, /\.hl-ja-target\s*\{/);
});

test('V1.5.1 rejects thought-only output and quarantines invalid AI sentence caches', async () => {
  const app = await text('app.js');
  const extractor = app.slice(app.indexOf('_extractResponse(data)'), app.indexOf('async _callModelDetailed'));
  assert.match(extractor, /!part\?\.thought/);
  assert.doesNotMatch(extractor, /filter\(p => typeof p\.text/);
  assert.match(app, /quarantineInvalidSentence/);
  assert.match(app, /daily-recommendation-invalid/);
  assert.match(app, /validationStatus !== 'invalid'/);
  assert.match(app, /AppStorage\.atomicUpdate\(commit\)/);
});

test('data save controls are the final settings section', async () => {
  const app = await text('app.js');
  const settingsStart = app.indexOf('Views.settings = {');
  const settingsEnd = app.indexOf('// ===========================\n// INIT', settingsStart);
  const settings = app.slice(settingsStart, settingsEnd);
  const storage = settings.indexOf('<!-- 資料保存（設定頁最下方） -->');
  const sound = settings.indexOf('<!-- 8. 音效測試 -->');
  const closingSpacer = settings.indexOf('<div style="height:12px"></div>', storage);
  assert.ok(storage > sound, '資料保存應位於音效測試之後');
  assert.ok(closingSpacer > storage, '資料保存後只能保留底部安全間距');
  assert.equal((settings.match(/aria-label="資料保存狀態"/g) || []).length, 1);
});

test('backup and Drive sync include study days, handwriting and practice choices', async () => {
  const app = await text('app.js');
  assert.match(app, /studyDays: StudyStreak\.getDays\(\)/);
  assert.match(app, /handwritingHistory: KanaProgress\.getHistory\(\)/);
  assert.match(app, /kanaReadingHistory: KanaReadingProgress\.getHistory\(\)/);
  assert.match(app, /kana_handwriting_\$\{dateTag\}\.csv/);
  assert.match(app, /japanese_learning_state\.json/);
  assert.match(app, /applyPracticePreferenceBundle/);
});

test('V1.5.1 reserves inline scores and never changes geometry after grading', async () => {
  const [app, style] = await Promise.all([text('app.js'), text('style.css')]);
  assert.match(app, /class="kana-inline-metrics"/);
  assert.doesNotMatch(app, /id="kana-review-toggle"/);
  assert.match(app, /session\?\.classList\.add\('is-scored'\)/);
  const writerStart = app.indexOf('\n  renderWriter(container) {');
  const writer = app.slice(writerStart, app.indexOf('\n  _resetWriterQuestion(container) {', writerStart));
  assert.ok(writer.indexOf('kana-canvas-card') < writer.indexOf('kana-score-panel'));
  const score = app.slice(app.indexOf('\n  scoreCurrent(container, kana, button)'), app.indexOf('\n  _finishWriterSession(container)'));
  assert.doesNotMatch(score, /scrollTop|scrollIntoView|\.resize\(|innerHTML|renderWriter\(|renderResult\(|Router\.navigate/);
  assert.doesNotMatch(style, /\.kana-session\.is-scored[^{}]*\{[^}]*(?:display:|width:|height:|padding:|margin:)/s);
  assert.match(style, /\.kana-inline-metrics \{[^}]*repeat\(3,minmax\(0,1fr\)\)/s);
  assert.match(style, /\.kana-inline-feedback \{[^}]*height: 3em;[^}]*overflow: auto/s);
  assert.match(style, /\.kana-session \.kana-session-actions[^}]*position: static/s);
});

test('V1.5.1 keeps the last score inline and restores the completed-session summary', async () => {
  const [app, style] = await Promise.all([text('app.js'), text('style.css')]);
  const handwritingStart = app.indexOf('Views.kanaPractice =');
  const handwriting = app.slice(handwritingStart, app.indexOf('Views.kanaReadingPractice =', handwritingStart));
  assert.match(handwriting, /completion\.average/);
  assert.match(handwriting, /五十音手寫完成/);
  assert.match(handwriting, /查看練習總結/);
  assert.match(handwriting, /_finishWriterSession\(container\)/);
  assert.match(handwriting, /renderResult\(container\)/);
  assert.match(handwriting, /kana-result-view kana-handwriting-result/);
  assert.match(handwriting, /kana-result-retry/);
  assert.match(handwriting, /kana-result-back/);
  assert.match(style, /\.kana-inline-feedback \{/);
  assert.match(style, /\.kana-handwriting-result-list \{/);
  assert.match(style, /max-height: min\(34dvh, 300px\)/);
});
