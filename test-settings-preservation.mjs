import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const text = name => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('current Worker, Pages, cron and D1 settings are retained', async () => {
  const [pushConfig, wrangler, worker] = await Promise.all([
    text('push-config.js'), text('wrangler.toml'), text('worker.js')
  ]);
  assert.match(pushConfig, /https:\/\/vocabulary-daily-reminder\.rexchre\.workers\.dev/);
  assert.match(pushConfig, /defaultTime: '22:00'/);
  assert.match(wrangler, /name = "vocabulary-daily-reminder"/);
  assert.match(wrangler, /crons = \["\* \* \* \* \*"\]/);
  assert.match(wrangler, /APP_URL = "https:\/\/lihe-source\.github\.io\/PWA-Vocabulary-GD\/"/);
  assert.match(wrangler, /ALLOWED_ORIGINS = "https:\/\/lihe-source\.github\.io"/);
  assert.match(wrangler, /database_id = "8886068d-480d-45ca-af8b-2c679d0fc150"/);
  assert.match(worker, /SERVICE_VERSION = 'V7\.4\.2'/);
});

test('the release directory is completely flat', async () => {
  const entries = await readdir(new URL('.', import.meta.url), { withFileTypes: true });
  assert.deepEqual(entries.filter(entry => entry.isDirectory()).map(entry => entry.name), []);
});

test('V7.2 keeps the existing IndexedDB identity', async () => {
  const storage = await text('storage.js');
  assert.match(storage, /DB_NAME = 'pwa_vocabulary_v7'/);
  assert.match(storage, /DB_VERSION = 1/);
  assert.doesNotMatch(storage, /indexedDB\.deleteDatabase/);
});
