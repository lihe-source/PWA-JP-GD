import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { handleAuthRequest, authHash, sealAuthValue, openAuthValue, allowedDriveTarget, cleanupAuth } from './auth-service.js';
import { CloudAuthClient } from './auth-client.js';

const sqlite = await import('node:sqlite').catch(() => null);
const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const origin = 'https://lihe-source.github.io';
const service = 'https://reminder.example.workers.dev';
const token = value => Buffer.from(value).toString('base64url');
const opaque = () => token(webcrypto.getRandomValues(new Uint8Array(32)));
let fixtureId = 0;

class D1Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.database, this.sql, values); }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: result.changes } }; }
}
function database() {
  const db = new sqlite.DatabaseSync(':memory:'); db.exec(schema);
  return { raw: db, prepare: sql => new D1Statement(db, sql), async batch(statements) {
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}
function mockGoogle(subject) {
  const calls = [];
  const mock = { calls, failRefresh: false, rejectDriveOnce: false, refreshDelay: 0, refreshCount: 0 };
  mock.fetch = async (value, options = {}) => {
    const url = new URL(value); calls.push({ url: url.href, options });
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const parameters = new URLSearchParams(options.body);
      if (parameters.get('grant_type') === 'authorization_code') {
        assert.match(parameters.get('code_verifier'), /^[\w-]{43}$/);
        assert.equal(parameters.get('redirect_uri'), service + '/api/auth/callback');
        return Response.json({ access_token: 'google-access-original', refresh_token: 'google-refresh-private', expires_in: 3600,
          scope: 'openid email https://www.googleapis.com/auth/drive.file' });
      }
      mock.refreshCount++;
      if (mock.refreshDelay) await new Promise(resolve => setTimeout(resolve, mock.refreshDelay));
      assert.equal(parameters.get('refresh_token'), 'google-refresh-private');
      return mock.failRefresh ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({ access_token: 'google-access-renewed', expires_in: 3600 });
    }
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: subject, email: 'student@example.test', email_verified: true });
    if (url.href === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
    if (url.origin === 'https://www.googleapis.com') {
      if (mock.rejectDriveOnce) { mock.rejectDriveOnce = false; return Response.json({ error: 'expired' }, { status: 401 }); }
      if (url.searchParams.get('fields') === 'id,name,mimeType') return Response.json({ id: 'backup', name: 'japanese_backup_old.json', mimeType: 'application/json' });
      return Response.json(url.pathname === '/drive/v3/files' ? { files: [] } : { id: 'new-backup' });
    }
    throw new Error('Unexpected network request: ' + value);
  };
  return mock;
}
function fixture() {
  const id = ++fixtureId; const db = database();
  const env = { DB: db, APP_URL: origin + '/PWA-JP-GD/', GOOGLE_CLIENT_ID: `client-${id}.apps.googleusercontent.com`,
    GOOGLE_CLIENT_SECRET: 'test-secret', CREDENTIAL_ENCRYPTION_KEY: opaque() };
  const google = mockGoogle('student-' + id);
  const call = async (path, { method = 'GET', json, bearer, requestOrigin = origin } = {}) => {
    const headers = { ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) };
    const response = await handleAuthRequest(new Request(service + path, { method, headers, body: json ? JSON.stringify(json) : undefined }), env, google.fetch);
    return { response, data: await response.clone().json().catch(() => null) };
  };
  return { db, env, google, call };
}
async function link(f) {
  const proof = opaque(); const started = await f.call('/api/auth/start', { method: 'POST', json: { challenge: await authHash(proof) } });
  assert.equal(started.response.status, 200);
  const state = started.data.state;
  const authorization = new URL(started.data.authorizationUrl);
  assert.equal(authorization.searchParams.get('access_type'), 'offline');
  const callback = await f.call('/api/auth/callback?state=' + state + '&code=one-time-code', { requestOrigin: '' });
  assert.equal(callback.response.status, 200);
  assert.doesNotMatch(await callback.response.text(), /google-access-original|google-refresh-private|test-secret/);
  const result = await f.call('/api/auth/result', { method: 'POST', json: { state, proof } });
  assert.equal(result.response.status, 200);
  assert.match(result.data.session.token, /^[\w-]{43}$/);
  return { ...result.data.session, state, proof };
}
const backend = (name, callback) => test(name, { skip: !sqlite && 'Node 22.13+ is required for SQLite backend integration tests' }, callback);

backend('OAuth callback stores encrypted credentials and returns only an opaque, proof-bound device session', async () => {
  const f = fixture(); const session = await link(f);
  const account = f.db.raw.prepare('SELECT * FROM japanese_auth_accounts').get();
  assert.doesNotMatch(account.credentials_cipher, /google-refresh|google-access/);
  const credentials = await openAuthValue(account.credentials_cipher, 'account:' + account.subject, f.env);
  assert.equal(credentials.refreshToken, 'google-refresh-private');
  assert.equal(f.db.raw.prepare('SELECT token_hash FROM japanese_auth_sessions').get().token_hash, await authHash(session.token));
  const stored = f.db.raw.prepare('SELECT * FROM japanese_auth_transactions').get();
  assert.equal(stored.context_cipher, '');
  assert.doesNotMatch(stored.result_cipher, new RegExp(session.token));
  const wrong = await f.call('/api/auth/result', { method: 'POST', json: { state: session.state, proof: opaque() } });
  assert.equal(wrong.response.status, 410);
  const retry = await f.call('/api/auth/result', { method: 'POST', json: { state: session.state, proof: session.proof } });
  assert.equal(retry.data.session.token, session.token);
  const replay = await f.call('/api/auth/callback?state=' + session.state + '&code=another-code', { requestOrigin: '' });
  assert.equal(replay.response.status, 410);
  f.db.raw.close();
});

backend('origin, state, preflight and configuration are validated before authentication', async () => {
  const f = fixture();
  const denied = await f.call('/api/auth/start', { method: 'POST', json: { challenge: opaque() }, requestOrigin: 'https://attacker.test' });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.response.headers.get('Access-Control-Allow-Origin'), null);
  const preflight = await f.call('/api/auth/session', { method: 'OPTIONS' });
  assert.equal(preflight.response.status, 204);
  assert.equal(preflight.response.headers.get('Access-Control-Allow-Origin'), origin);
  const status = await f.call('/api/auth/status'); assert.equal(status.data.configured, true);
  f.db.raw.exec('DROP TABLE japanese_auth_accounts');
  assert.equal((await f.call('/api/auth/status')).data.configured, false);
  assert.equal((await f.call('/api/auth/callback?state=invalid', { requestOrigin: '' })).response.status, 400);
  f.db.raw.close();
});

backend('concurrent device restores refresh an expired Google token exactly once', async () => {
  const f = fixture(); const session = await link(f);
  const account = f.db.raw.prepare('SELECT * FROM japanese_auth_accounts').get();
  const credentials = await openAuthValue(account.credentials_cipher, 'account:' + account.subject, f.env);
  const encrypted = await sealAuthValue({ ...credentials, expiresAt: 0 }, 'account:' + account.subject, f.env);
  f.db.raw.prepare('UPDATE japanese_auth_accounts SET credentials_cipher = ?').run(encrypted);
  f.google.refreshDelay = 20;
  const results = await Promise.all(Array.from({ length: 8 }, () => f.call('/api/auth/session', { bearer: session.token })));
  assert.ok(results.every(result => result.response.status === 200));
  assert.equal(f.google.refreshCount, 1);
  assert.ok(results.every(result => !JSON.stringify(result.data).includes('google-access')));
  f.db.raw.close();
});

backend('invalid_grant keeps the device identity but requires explicit reconnection', async () => {
  const f = fixture(); const session = await link(f);
  const account = f.db.raw.prepare('SELECT * FROM japanese_auth_accounts').get();
  const credentials = await openAuthValue(account.credentials_cipher, 'account:' + account.subject, f.env);
  f.db.raw.prepare('UPDATE japanese_auth_accounts SET credentials_cipher = ?').run(await sealAuthValue({ ...credentials, expiresAt: 0 }, 'account:' + account.subject, f.env));
  f.google.failRefresh = true;
  const result = await f.call('/api/auth/session', { bearer: session.token });
  assert.equal(result.response.status, 401); assert.equal(result.data.code, 'REAUTH_REQUIRED');
  assert.equal(f.db.raw.prepare('SELECT COUNT(*) AS count FROM japanese_auth_sessions').get().count, 1);
  f.db.raw.close();
});

backend('Drive proxy adds app-file filtering, forwards Google auth server-side and retries a stale access token once', async () => {
  const f = fixture(); const session = await link(f); f.google.rejectDriveOnce = true;
  const target = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent("name contains 'japanese_backup_'");
  const result = await f.call('/api/drive?target=' + encodeURIComponent(target), { bearer: session.token });
  assert.equal(result.response.status, 200);
  const calls = f.google.calls.filter(call => call.url.startsWith('https://www.googleapis.com'));
  assert.equal(calls.length, 2);
  assert.match(new URL(calls[1].url).searchParams.get('q'), /mimeType = 'application\/json'/);
  assert.equal(calls[1].options.headers.get('Authorization'), 'Bearer google-access-renewed');
  assert.equal(f.google.refreshCount, 1);
  const denied = await f.call('/api/drive?target=' + encodeURIComponent('https://attacker.test/secrets'), { bearer: session.token });
  assert.equal(denied.response.status, 403);
  f.db.raw.close();
});

backend('logout invalidates only this device; account revoke and expiry cleanup invalidate remaining sessions', async () => {
  const f = fixture(); const first = await link(f); const second = await link(f);
  assert.equal((await f.call('/api/auth/logout', { method: 'POST', bearer: first.token })).response.status, 200);
  assert.equal((await f.call('/api/auth/session', { bearer: first.token })).response.status, 401);
  assert.equal((await f.call('/api/auth/session', { bearer: second.token })).response.status, 200);
  assert.equal((await f.call('/api/auth/revoke', { method: 'POST', bearer: second.token })).response.status, 200);
  assert.equal((await f.call('/api/auth/session', { bearer: second.token })).response.status, 401);
  f.db.raw.exec('UPDATE japanese_auth_transactions SET expires_at = 0; UPDATE japanese_auth_limits SET expires_at = 0;');
  await cleanupAuth(f.env);
  assert.equal(f.db.raw.prepare('SELECT COUNT(*) AS count FROM japanese_auth_transactions').get().count, 0);
  f.db.raw.close();
});

test('Drive destinations cannot bypass the restricted Google file paths', () => {
  for (const [url, method] of [
    ['https://www.googleapis.com.attacker.test/drive/v3/files', 'GET'],
    ['https://www.googleapis.com/drive/v3/permissions', 'GET'],
    ['https://www.googleapis.com/drive/v3/files/file', 'DELETE'],
    ['https://user@www.googleapis.com/drive/v3/files', 'GET'],
    ['https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', 'POST']
  ]) assert.throws(() => allowedDriveTarget(url, method), /DRIVE_TARGET_DENIED/);
});

function clientStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), async flush() {} };
}
function storedClient(fetchImpl) {
  const storage = clientStorage(); const device = { token: opaque(), email: 'student@example.test', expiresAt: Date.now() + 3600000, url: service };
  storage.setItem('cloudDeviceSessionV1', JSON.stringify(device));
  const client = new CloudAuthClient({ storage, defaultUrl: service, fetchImpl }); client.init();
  return { client, storage, device };
}

test('reopening a remembered device restores in background without calling window.open or GIS', async () => {
  let calls = 0; globalThis.window = { open() { throw new Error('Unexpected popup'); } };
  const { client, device } = storedClient(async (url, options) => {
    calls++; assert.equal(url, service + '/api/auth/session'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer ' + device.token);
    return Response.json({ email: device.email, expiresAt: device.expiresAt });
  });
  const results = await Promise.all([client.restore(), client.restore(), client.restore()]);
  assert.deepEqual(results, [true, true, true]); assert.equal(calls, 1); assert.equal(client.active, true);
});

test('offline and revoked restores never erase the remembered account or open a popup', async () => {
  const { client, storage, device } = storedClient(async () => { throw new Error('network'); });
  assert.equal(await client.restore(), false); assert.equal(client.state, 'offline');
  assert.equal(JSON.parse(storage.getItem('cloudDeviceSessionV1')).token, device.token);
  client.fetchImpl = async () => Response.json({ code: 'REAUTH_REQUIRED' }, { status: 401 });
  assert.equal(await client.restore(), false); assert.equal(client.state, 'reauth'); assert.equal(client.remembered, true);
});

test('a late restore after local logout cannot restore the old account', async () => {
  let finish;
  const { client, storage, device } = storedClient((url) => url.endsWith('/logout') ? Promise.resolve(Response.json({ ok: true }))
    : new Promise(resolve => { finish = resolve; }));
  const restoring = client.restore(); await client.logout();
  finish(Response.json({ email: device.email, expiresAt: device.expiresAt }));
  assert.equal(await restoring, false); assert.equal(client.active, false);
  assert.equal(storage.getItem('cloudDeviceSessionV1'), null);
});

test('explicit first link opens the authorization window before its first asynchronous task', async () => {
  const events = [];
  const popup = { closed: false, document: { body: {} }, location: { replace() { events.push('navigate'); } }, close() { this.closed = true; } };
  globalThis.window = { open() { events.push('open'); return popup; }, addEventListener() {}, removeEventListener() {} };
  globalThis.sessionStorage = clientStorage();
  const storage = clientStorage(); const state = opaque();
  const client = new CloudAuthClient({ storage, defaultUrl: service, fetchImpl: async url => {
    events.push('fetch');
    return Response.json(url.endsWith('/start')
      ? { state, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state }
      : { session: { token: opaque(), email: 'student@example.test', expiresAt: Date.now() + 3600000 } });
  } });
  const pending = client.connect(); assert.deepEqual(events, ['open']);
  assert.equal(await pending, true); assert.equal(client.active, true);
  assert.deepEqual(events.slice(0, 3), ['open', 'fetch', 'navigate']); assert.equal(popup.closed, true);
});
