import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const text = name => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('Japanese defaults and separate push deployment are packaged', async () => {
  const [defaults, pushConfig, wrangler, worker, schema] = await Promise.all([
    text('japanese-learning.js'), text('push-config.js'), text('wrangler.toml'), text('worker.js'), text('schema.sql')
  ]);
  assert.match(defaults, /171837667604-mtcf91qudt6ff79u382v37rjqpp7l51q\.apps\.googleusercontent\.com/);
  assert.match(defaults, /1kAtVOK2qqhK0BY9vmp8Sm4NhQaWMJYeb/);
  assert.match(pushConfig, /japanese-daily-reminder\.rexchre\.workers\.dev/);
  assert.match(wrangler, /name = "japanese-daily-reminder"/);
  assert.match(wrangler, /PWA-JP-GD/);
  assert.match(wrangler, /crons = \["\* \* \* \* \*"\]/);
  assert.match(worker, /SERVICE_VERSION = 'V1\.2\.8'/);
  assert.match(worker, /Japanese Daily Reminder/);
  assert.match(worker, /SELECT 1 FROM japanese_reminders/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS japanese_reminders/);
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS reminders\s*\(/);
});

test('the GitHub release directory is completely flat', async () => {
  const entries = await readdir(new URL('.', import.meta.url), { withFileTypes: true });
  assert.deepEqual(entries.filter(entry => entry.isDirectory()).map(entry => entry.name), []);
});

test('Japanese data uses an isolated IndexedDB and storage prefix', async () => {
  const storage = await text('storage.js');
  assert.match(storage, /DB_NAME = 'pwa_japanese_v1'/);
  assert.match(storage, /LOCAL_PREFIX = 'pwa_japanese:'/);
  assert.match(storage, /LEGACY_ENGLISH_DB = 'pwa_vocabulary_v7'/);
  assert.doesNotMatch(storage, /indexedDB\.deleteDatabase/);
});
