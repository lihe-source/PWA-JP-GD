import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = name => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('all public app surfaces use Japanese V1.1.1', async () => {
  const [app, html, sw, version, manifest, pkg] = await Promise.all([
    text('app.js'), text('index.html'), text('sw.js'), text('version.json'), text('manifest.json'), text('package.json')
  ]);
  assert.match(app, /APP_VERSION = 'V1_1_1'/);
  assert.match(html, /app\.js\?v=V1_1_1/);
  assert.match(sw, /Japanese-PWA-V1_1_1/);
  for (const module of ['japanese-learning', 'kana-data', 'kana-strokes', 'handwriting-engine']) assert.match(sw, new RegExp(module));
  assert.equal(JSON.parse(version).schemaVersion, 1);
  assert.match(JSON.parse(manifest).name, /V1\.1\.1/);
  assert.equal(JSON.parse(pkg).version, '1.1.1');
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

test('iPhone score action stays in document flow and cannot cover score details', async () => {
  const [app, style] = await Promise.all([text('app.js'), text('style.css')]);
  assert.match(style, /\.kana-session\[data-layout="phone"\] \.kana-session-actions\s*\{[\s\S]*?position:\s*static/);
  assert.match(style, /\.kana-session\[data-layout="phone"\] \.kana-score-panel/);
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
