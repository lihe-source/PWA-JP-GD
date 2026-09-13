import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = name => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('all public app surfaces use the V7.4.2 cache/version', async () => {
  const [app, html, sw, version, manifest] = await Promise.all([
    text('app.js'), text('index.html'), text('sw.js'), text('version.json'), text('manifest.json')
  ]);
  assert.match(app, /APP_VERSION = 'V7_4_2'/);
  assert.match(html, /app\.js\?v=V7_4_2/);
  assert.match(sw, /Voc-PWA-V7_4_2/);
  assert.match(sw, /study-streak\.js\?v=V7_4_2/);
  assert.match(sw, /backup-worker\.js\?v=V7_4_2/);
  assert.match(sw, /task-manager\.js\?v=V7_4_2/);
  assert.equal(JSON.parse(version).schemaVersion, 8);
  assert.match(JSON.parse(manifest).name, /V7\.4\.2/);
});

test('study streak UI uses the green theme and a stable mobile settings layout', async () => {
  const [app, style] = await Promise.all([text('app.js'), text('style.css')]);
  const streakSection = style.split('/* ===== V7.4.2 Study streak')[1]
    ?.split('/* ===== V7.1.0')[0] || '';

  assert.match(streakSection, /margin:\s*12px/);
  assert.match(streakSection, /var\(--primary\)/);
  assert.doesNotMatch(streakSection, /#(?:f59e0b|fff7df|d97706|b45309|e25b28)/i);
  assert.match(streakSection, /\.study-streak-sync-row\s*\{[^}]*display:\s*grid/s);
  assert.match(streakSection, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(streakSection, /\.study-streak-sync-row button\s*\{[^}]*width:\s*100%\s*!important/s);
  assert.match(streakSection, /min-height:\s*44px/);
  assert.match(app, /class="study-streak-icon"[^>]*>[\s\S]*?<svg/);
  assert.doesNotMatch(app, /class="study-streak-icon"[^>]*>\s*🔥/);
});

test('all four completed practice paths record a qualifying activity', async () => {
  const app = await text('app.js');
  for (const activity of ['WORD_QUIZ', 'READING_QUIZ', 'ESSAY_REVIEW', 'AI_ASK']) {
    assert.match(app, new RegExp(`recordStudyActivity\\(STUDY_ACTIVITY_TYPES\\.${activity}`));
  }
});

test('settings backup and Google Drive payload include study days', async () => {
  const app = await text('app.js');
  assert.match(app, /studyDays: StudyStreak\.getDays\(\)/);
  assert.match(app, /study_days_\$\{compactDateTag\}\.csv/);
  assert.match(app, /vocab_study_streak\.json/);
  assert.match(app, /gd-streak-sync-btn/);
});


test('Google Drive startup and backup work stay off the first-paint critical path', async () => {
  const app = await text('app.js');
  const homeRender = app.indexOf("Router._doNavigate('home')");
  const backgroundBootstrap = app.indexOf('bootstrapGDriveInBackground');
  assert.ok(homeRender >= 0 && backgroundBootstrap > homeRender);

  const uploadStart = app.indexOf('async upload(options = {})');
  const uploadEnd = app.indexOf('async listBackups(options = {})', uploadStart);
  const uploadBody = app.slice(uploadStart, uploadEnd);
  assert.doesNotMatch(uploadBody, /await\s+this\.syncStudyStreak/);
  assert.match(uploadBody, /scheduleStudyStreakSync/);
  assert.match(app, /preloadGIS\(\)/);
});

test('restore uses batched IndexedDB writes and visible UI yielding', async () => {
  const [app, storage] = await Promise.all([text('app.js'), text('storage.js')]);
  assert.match(app, /await AppStorage\.setItemsBatch\(writes, \{ expectedRevision \}\)/);
  assert.match(app, /yieldForUI/);
  assert.match(storage, /async setItemsBatch\(entries, \{expectedRevision\} = \{\}\)/);
  assert.match(storage, /await this\._putRecords\(pairs\.map/);
});
