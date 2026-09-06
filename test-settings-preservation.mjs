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
  assert.match(worker, /SERVICE_VERSION = 'V1\.3\.3'/);
  assert.match(worker, /Japanese Daily Reminder/);
  assert.match(worker, /SELECT 1 FROM japanese_reminders/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS japanese_reminders/);
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS reminders\s*\(/);
});

test('the GitHub release directory is completely flat', async () => {
  const entries = await readdir(new URL('.', import.meta.url), { withFileTypes: true });
  assert.deepEqual(entries.filter(entry => entry.isDirectory()).map(entry => entry.name), []);
  assert.equal(entries.length, 46, 'review deployment inventory before adding a file');
  for (const doc of ['README.md', 'ARCHITECTURE.md', 'CHANGELOG.md']) assert.ok(entries.some(entry => entry.name === doc));
  assert.ok(!entries.some(entry => /^(ARCHITECTURE_V|CHANGELOG_V|QA_V|UPDATE_V|icon-source|indexl\.html)/.test(entry.name)));
});

test('new install icons are opaque square PNGs and versioned in the manifest', async () => {
  const manifest = JSON.parse(await text('manifest.json'));
  for (const size of [192, 512]) {
    const png = await readFile(new URL(`./icon-${size}.png`, import.meta.url));
    assert.equal(png.subarray(1,4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.ok(manifest.icons.some(icon => icon.src === `icon-${size}.png?v=V1_3_3`));
  }
  assert.match(await text('THIRD_PARTY_NOTICES.md'), /icons.*add a blue|icons add a blue/);
});

test('Japanese data uses an isolated IndexedDB and storage prefix', async () => {
  const storage = await text('storage.js');
  assert.match(storage, /DB_NAME = 'pwa_japanese_v1'/);
  assert.match(storage, /LOCAL_PREFIX = 'pwa_japanese:'/);
  assert.match(storage, /LEGACY_ENGLISH_DB = 'pwa_vocabulary_v7'/);
  assert.doesNotMatch(storage, /indexedDB\.deleteDatabase/);
});

test('every frontend module dependency uses this release and is precached for offline launch', async () => {
  const version = JSON.parse(await text('version.json'));
  const shellSource = (await text('sw.js')).match(/const APP_SHELL = \[([\s\S]*?)\];/)[1];
  const shell = new Set([...shellSource.matchAll(/'([^']+)'/g)].map(match => match[1]));
  const entries = await readdir(new URL('.', import.meta.url));
  for (const entry of entries.filter(name => name.endsWith('.js'))) {
    const source = await text(entry);
    for (const match of source.matchAll(/\b(?:from\s*|import\s*)['"](\.\/[^'"\n]+)['"]/g)) {
      const reference = match[1];
      const url = new URL(reference, 'https://example.test/PWA-JP-GD/');
      assert.equal(url.searchParams.get('v'), version.version, `${entry}: outdated module ${reference}`);
      assert.ok(shell.has(reference), `${entry}: missing offline cache entry ${reference}`);
    }
  }
  for (const reference of shell) {
    if (reference === './') continue;
    assert.ok(entries.includes(reference.replace(/^\.\//, '').split('?')[0]), `missing cached file ${reference}`);
  }
});
