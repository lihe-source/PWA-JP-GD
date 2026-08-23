import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = name => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('all public app surfaces use Japanese V1.2.4', async () => {
  const [app, html, sw, version, manifest, pkg] = await Promise.all([
    text('app.js'), text('index.html'), text('sw.js'), text('version.json'), text('manifest.json'), text('package.json')
  ]);
  assert.match(app, /APP_VERSION = 'V1_2_4'/);
  assert.match(html, /app\.js\?v=V1_2_4/);
  assert.match(sw, /Japanese-PWA-V1_2_4/);
  for (const module of ['japanese-learning', 'kana-data', 'kana-strokes', 'handwriting-engine']) assert.match(sw, new RegExp(module));
  assert.equal(JSON.parse(version).schemaVersion, 1);
  assert.match(JSON.parse(manifest).name, /V1\.2\.4/);
  assert.equal(JSON.parse(pkg).version, '1.2.4');
});

test('V1.2.4 keeps Apple subscription repair and provider errors', async () => {
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

test('all five completed practice paths qualify as study activity', async () => {
  const app = await text('app.js');
  for (const activity of ['WORD_QUIZ', 'KANA_HANDWRITING', 'READING_QUIZ', 'ESSAY_REVIEW', 'AI_ASK']) {
    assert.match(app, new RegExp(`recordStudyActivity\\(STUDY_ACTIVITY_TYPES\\.${activity}`));
  }
});

test('backup and Drive sync include study days, handwriting and practice choices', async () => {
  const app = await text('app.js');
  assert.match(app, /studyDays: StudyStreak\.getDays\(\)/);
  assert.match(app, /handwritingHistory: KanaProgress\.getHistory\(\)/);
  assert.match(app, /kana_handwriting_\$\{dateTag\}\.csv/);
  assert.match(app, /japanese_learning_state\.json/);
  assert.match(app, /applyPracticePreferenceBundle/);
});
