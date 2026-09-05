import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = name => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('all public app surfaces use Japanese V1.2.14', async () => {
  const [app, html, sw, version, manifest, pkg] = await Promise.all([
    text('app.js'), text('index.html'), text('sw.js'), text('version.json'), text('manifest.json'), text('package.json')
  ]);
  assert.match(app, /APP_VERSION = 'V1_2_14'/);
  assert.match(html, /app\.js\?v=V1_2_14/);
  assert.match(sw, /Japanese-PWA-V1_2_14/);
  for (const module of ['japanese-learning', 'kana-data', 'kana-strokes', 'handwriting-engine']) assert.match(sw, new RegExp(module));
  assert.equal(JSON.parse(version).schemaVersion, 1);
  assert.match(JSON.parse(manifest).name, /V1\.2\.14/);
  assert.equal(JSON.parse(pkg).version, '1.2.14');
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

test('V1.2.14 keeps Apple subscription repair and provider errors', async () => {
  const [manager, worker] = await Promise.all([text('reminder-manager.js'), text('worker.js')]);
  assert.match(manager, /forceRenew/);
  assert.match(manager, /SUBSCRIPTION_INVALID/);
  assert.match(manager, /_renewAndRegister/);
  assert.match(worker, /BadDeviceToken/);
  assert.match(worker, /providerReason/);
  assert.match(worker, /contentEncoding: 'aes128gcm'/);
  assert.doesNotMatch(worker, /topic: isTest/);
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
  assert.match(app, /id="kana-listen-btn"[\s\S]{0,6500}TTS\.speakKana\(kana\.character\)/);
  assert.match(app, /cleanup\(\) \{[\s\S]{0,120}TTS\.stop\(\)/);
});

test('iPhone score action docks before scoring and returns to flow after scoring', async () => {
  const [app, style] = await Promise.all([text('app.js'), text('style.css')]);
  assert.match(style, /\.kana-session\[data-layout="phone"\] \.kana-session-actions:not\(\.is-scored\)\s*\{[\s\S]*?position:\s*sticky/);
  assert.match(style, /\.kana-session\[data-layout="phone"\] \.kana-session-actions\.is-scored\s*\{[\s\S]*?position:\s*static/);
  assert.match(style, /\.kana-session\[data-layout="phone"\] \.kana-score-panel/);
  assert.match(app, /actions\?\.classList\.add\('is-scored'\)/);
  assert.match(app, /session\?\.dataset\.layout === 'phone'/);
  assert.match(app, /panel\?\.scrollIntoView\?\.\(\{ behavior: 'smooth', block: 'center' \}\)/);
});

test('blue Japanese theme and iPad handwriting layout are present', async () => {
  const [app, style, manifest] = await Promise.all([text('app.js'), text('style.css'), text('manifest.json')]);
  assert.equal(JSON.parse(manifest).theme_color, '#1565c0');
  assert.equal(JSON.parse(manifest).orientation, 'any');
  assert.match(style, /--primary:\s*#1565c0/);
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
  assert.match(handwritingBlock, /renderResult\(container\)[\s\S]{0,2600}scheduleStudyStreakSync\(900\)/);
});

test('all six completed practice paths qualify as study activity', async () => {
  const app = await text('app.js');
  for (const activity of ['WORD_QUIZ', 'KANA_HANDWRITING', 'KANA_READING', 'READING_QUIZ', 'ESSAY_REVIEW', 'AI_ASK']) {
    assert.match(app, new RegExp(`recordStudyActivity\\(STUDY_ACTIVITY_TYPES\\.${activity}`));
  }
});

test('V1.2.14 adds kana-to-romaji practice under handwriting with statistics', async () => {
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

test('V1.2.14 recommends one daily word and stores its sentence practice', async () => {
  const [app, style, module, sw] = await Promise.all([
    text('app.js'), text('style.css'), text('daily-learning.js'), text('sw.js')
  ]);
  assert.match(app, /daily-learning\.js\?v=V1_2_14/);
  assert.match(app, /id="daily-learning-source-select"/);
  assert.match(app, /data-learning-row=/);
  assert.match(app, /generateDailyVocabulary/);
  assert.match(app, /count = 1/);
  assert.match(app, /words\.slice\(0, 1\)/);
  assert.match(app, /ensureDailyVocabularySentence/);
  assert.match(app, /source: 'daily-recommendation'/);
  assert.match(app, /DB\.saveSentenceToLog\(entry\)/);
  assert.match(app, /dailyLearning: this\.getDailyLearningPreferences\(\)/);
  assert.match(module, /kanaToRomaji/);
  assert.match(module, /readingMatchesRows/);
  assert.match(style, /\.daily-vocab-grid/);
  assert.match(sw, /daily-learning\.js\?v=V1_2_14/);
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
