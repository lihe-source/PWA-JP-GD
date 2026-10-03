// Google credentials never leave this Worker. Device sessions are opaque,
// hashed in D1, application-scoped and revocable. No third-party cookies.
const SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';
const DAY = 86400000;
const SESSION_TTL = 30 * DAY;
const SESSION_MAX = 180 * DAY;
const TRANSACTION_TTL = 5 * 60000;
const MAX_BODY = 26 * 1024 * 1024;
const encoder = new TextEncoder();
const keyCache = new Map();
const refreshTasks = new Map();

class AuthError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function b64(bytes) {
  let value = ''; for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new AuthError('AUTH_KEY_INVALID', 503);
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
function randomToken() { return b64(crypto.getRandomValues(new Uint8Array(32))); }
export async function authHash(value) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
function appOrigin(env) {
  try { const url = new URL(env.APP_URL); return url.protocol === 'https:' ? url.origin : ''; } catch { return ''; }
}
function allowed(request, env) { return !!appOrigin(env) && request.headers.get('Origin') === appOrigin(env); }
function cors(request, env) {
  const headers = { Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (allowed(request, env)) headers['Access-Control-Allow-Origin'] = appOrigin(env);
  return headers;
}
function json(request, env, payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { ...cors(request, env), 'Content-Type': 'application/json; charset=utf-8' } });
}
function configured(env) {
  return !!env.DB && /^[\w.-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID || '') &&
    !!env.GOOGLE_CLIENT_SECRET && /^[A-Za-z0-9_-]{43}$/.test(env.CREDENTIAL_ENCRYPTION_KEY || '') && !!appOrigin(env);
}
async function encryptionKey(env) {
  const raw = env.CREDENTIAL_ENCRYPTION_KEY || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new AuthError('AUTH_KEY_INVALID', 503);
  if (!keyCache.has(raw)) {
    if (keyCache.size > 2) keyCache.clear();
    keyCache.set(raw, crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return keyCache.get(raw);
}
export async function sealAuthValue(value, purpose, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, await encryptionKey(env), encoder.encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(new Uint8Array(data))}`;
}
export async function openAuthValue(value, purpose, env) {
  try {
    const [iv, data] = value.split('.');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: encoder.encode(purpose) }, await encryptionKey(env), unb64(data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new AuthError('AUTH_KEY_INVALID', 503); }
}
async function boundedJson(request, max = 4096) {
  const text = await readBounded(request.body, max);
  try { return JSON.parse(new TextDecoder().decode(text)); } catch { throw new AuthError('INVALID_REQUEST'); }
}
async function readBounded(stream, max) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) throw new AuthError('BODY_TOO_LARGE', 413);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function remoteJson(url, options = {}, fetcher = fetch) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher(url, { ...options, signal: controller.signal, redirect: 'error' });
    const body = await response.json();
    if (!response.ok) {
      const code = body.error === 'invalid_grant' ? 'REAUTH_REQUIRED' : response.status === 429 ? 'GOOGLE_RATE_LIMIT' : 'GOOGLE_AUTH_FAILED';
      throw new AuthError(code, code === 'REAUTH_REQUIRED' ? 401 : 502);
    }
    return body;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(error?.name === 'AbortError' ? 'AUTH_SERVICE_TIMEOUT' : 'AUTH_SERVICE_UNAVAILABLE', 503);
  } finally { clearTimeout(timer); }
}
async function rateLimit(request, env, route, limit) {
  const now = Date.now(); const bucket = Math.floor(now / 60000);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = await authHash(`${env.CREDENTIAL_ENCRYPTION_KEY}|${route}|${ip}|${bucket}`);
  const row = await env.DB.prepare(`INSERT INTO japanese_auth_limits (id, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET hits = hits + 1 RETURNING hits`).bind(key, now + 120000).first();
  if (row.hits > limit) throw new AuthError('AUTH_RATE_LIMIT', 429);
}
async function start(request, env) {
  await rateLimit(request, env, 'start', 10);
  const data = await boundedJson(request);
  if (!/^[A-Za-z0-9_-]{43}$/.test(data.challenge || '')) throw new AuthError('INVALID_CHALLENGE');
  const state = randomToken(); const verifier = randomToken(); const now = Date.now();
  const callback = new URL('/api/auth/callback', request.url).href;
  const sealed = await sealAuthValue({ verifier, callback }, `transaction:${state}`, env);
  await env.DB.prepare(`INSERT INTO japanese_auth_transactions
    (state, challenge, context_cipher, status, expires_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)`)
    .bind(state, data.challenge, sealed, now + TRANSACTION_TTL, now).run();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  const parameters = { client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callback, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent select_account', state, code_challenge: await authHash(verifier), code_challenge_method: 'S256' };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return json(request, env, { state, authorizationUrl: url.href, expiresAt: now + TRANSACTION_TTL });
}
function callbackPage(state, env, ok) {
  const nonce = randomToken();
  // Only the random transaction state crosses the popup boundary, never a token.
  const message = JSON.stringify({ type: 'JP_OAUTH_COMPLETE', state, ok });
  const origin = JSON.stringify(appOrigin(env));
  const html = `<!doctype html><html lang="zh-TW"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google 連結</title><body><p>${ok ? 'Google 已連結，請回到日文練習。此視窗可關閉。' : 'Google 連結未完成，請回到程式查看原因。'}</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${message},${origin});window.close();}</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`, 'X-Content-Type-Options': 'nosniff' } });
}
async function callback(request, env, fetcher) {
  const url = new URL(request.url); const state = url.searchParams.get('state') || ''; const now = Date.now();
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new AuthError('INVALID_STATE');
  // Claim once before exchanging. Replayed callbacks cannot rotate account credentials.
  const row = await env.DB.prepare(`UPDATE japanese_auth_transactions SET status = 'exchanging'
    WHERE state = ? AND status = 'pending' AND expires_at > ? RETURNING *`).bind(state, now).first();
  if (!row) throw new AuthError('AUTH_TRANSACTION_EXPIRED', 410);
  try {
    if (url.searchParams.has('error')) throw new AuthError('AUTH_DENIED');
    const code = url.searchParams.get('code') || '';
    if (!code || code.length > 2048) throw new AuthError('INVALID_CODE');
    const context = await openAuthValue(row.context_cipher, `transaction:${state}`, env);
    const tokens = await remoteJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: context.callback,
        code_verifier: context.verifier, grant_type: 'authorization_code' }) }, fetcher);
    if (!tokens.access_token || !String(tokens.scope || '').split(' ').includes('https://www.googleapis.com/auth/drive.file')) throw new AuthError('DRIVE_PERMISSION_MISSING');
    const user = await remoteJson('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } }, fetcher);
    if (!user.sub || !user.email || user.email_verified !== true) throw new AuthError('ACCOUNT_NOT_VERIFIED');
    const subject = String(user.sub); const existing = await env.DB.prepare('SELECT * FROM japanese_auth_accounts WHERE subject = ?').bind(subject).first();
    let old = null;
    if (existing && !tokens.refresh_token) old = await openAuthValue(existing.credentials_cipher, `account:${subject}`, env);
    const refreshToken = tokens.refresh_token || old?.refreshToken;
    if (!refreshToken) throw new AuthError('OFFLINE_ACCESS_MISSING');
    const credential = await sealAuthValue({ refreshToken, accessToken: tokens.access_token, expiresAt: now + Math.max(60, Number(tokens.expires_in) || 3600) * 1000 }, `account:${subject}`, env);
    const session = randomToken(); const tokenHash = await authHash(session);
    const result = await sealAuthValue({ token: session, email: String(user.email), expiresAt: now + SESSION_TTL }, `result:${state}`, env);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO japanese_auth_accounts (subject, email, credentials_cipher, revision, reauth_required, updated_at)
        VALUES (?, ?, ?, 1, 0, ?) ON CONFLICT(subject) DO UPDATE SET email = excluded.email,
        credentials_cipher = excluded.credentials_cipher, revision = revision + 1, reauth_required = 0, lock_id = NULL, lock_until = 0, updated_at = excluded.updated_at`)
        .bind(subject, String(user.email), credential, now),
      env.DB.prepare(`INSERT INTO japanese_auth_sessions (token_hash, subject, expires_at, absolute_expires_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)`).bind(tokenHash, subject, now + SESSION_TTL, now + SESSION_MAX, now),
      env.DB.prepare(`UPDATE japanese_auth_transactions SET status = 'complete', result_cipher = ?, context_cipher = '' WHERE state = ?`)
        .bind(result, state)
    ]);
    return callbackPage(state, env, true);
  } catch (error) {
    const safeCode = error instanceof AuthError ? error.code : 'GOOGLE_AUTH_FAILED';
    await env.DB.prepare(`UPDATE japanese_auth_transactions SET status = 'failed', error_code = ?, context_cipher = '' WHERE state = ?`).bind(safeCode, state).run();
    return callbackPage(state, env, false);
  }
}
async function result(request, env) {
  await rateLimit(request, env, 'result', 180);
  const { state, proof } = await boundedJson(request);
  if (!/^[A-Za-z0-9_-]{43}$/.test(state || '') || !/^[A-Za-z0-9_-]{43}$/.test(proof || '')) throw new AuthError('INVALID_PROOF');
  const row = await env.DB.prepare('SELECT * FROM japanese_auth_transactions WHERE state = ? AND expires_at > ?').bind(state, Date.now()).first();
  if (!row || row.challenge !== await authHash(proof)) throw new AuthError('AUTH_TRANSACTION_EXPIRED', 410);
  if (row.status === 'failed') throw new AuthError(row.error_code || 'AUTH_DENIED');
  if (row.status !== 'complete') return json(request, env, { pending: true }, 202);
  // Proof-bound retries return the same session so a lost HTTP response is recoverable.
  return json(request, env, { session: await openAuthValue(row.result_cipher, `result:${state}`, env) });
}
async function sessionFor(request, env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new AuthError('REAUTH_REQUIRED', 401);
  const now = Date.now(); const hash = await authHash(token);
  const row = await env.DB.prepare(`SELECT s.*, a.email, a.reauth_required FROM japanese_auth_sessions s
    JOIN japanese_auth_accounts a ON a.subject = s.subject WHERE s.token_hash = ? AND s.expires_at > ? AND s.absolute_expires_at > ?`)
    .bind(hash, now, now).first();
  if (!row || row.reauth_required) throw new AuthError('REAUTH_REQUIRED', 401);
  if (now - row.last_seen_at > DAY) {
    row.expires_at = Math.min(row.absolute_expires_at, now + SESSION_TTL);
    await env.DB.prepare('UPDATE japanese_auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
      .bind(now, row.expires_at, hash).run();
  }
  return row;
}
async function refreshAccount(subject, env, fetcher) {
  const now = Date.now(); const row = await env.DB.prepare('SELECT * FROM japanese_auth_accounts WHERE subject = ?').bind(subject).first();
  if (!row || row.reauth_required) throw new AuthError('REAUTH_REQUIRED', 401);
  const data = await openAuthValue(row.credentials_cipher, `account:${subject}`, env);
  if (data.expiresAt > now + 60000) return data.accessToken;
  const lock = randomToken();
  const claim = await env.DB.prepare(`UPDATE japanese_auth_accounts SET lock_id = ?, lock_until = ? WHERE subject = ?
    AND revision = ? AND reauth_required = 0 AND (lock_until IS NULL OR lock_until <= ?) RETURNING subject`)
    .bind(lock, now + 20000, subject, row.revision, now).first();
  if (!claim) {
    // Another isolate owns the refresh. No duplicate refresh-token request.
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const updated = await env.DB.prepare('SELECT * FROM japanese_auth_accounts WHERE subject = ?').bind(subject).first();
      if (!updated || updated.reauth_required) throw new AuthError('REAUTH_REQUIRED', 401);
      if (updated.revision !== row.revision) {
        const current = await openAuthValue(updated.credentials_cipher, `account:${subject}`, env);
        if (current.expiresAt > Date.now() + 30000) return current.accessToken;
      }
    }
    throw new AuthError('AUTH_REFRESH_BUSY', 503);
  }
  try {
    const tokens = await remoteJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: data.refreshToken, grant_type: 'refresh_token' }) }, fetcher);
    if (!tokens.access_token) throw new AuthError('GOOGLE_AUTH_FAILED', 502);
    const value = await sealAuthValue({ refreshToken: tokens.refresh_token || data.refreshToken, accessToken: tokens.access_token,
      expiresAt: Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000 }, `account:${subject}`, env);
    const changed = await env.DB.prepare(`UPDATE japanese_auth_accounts SET credentials_cipher = ?, revision = revision + 1,
      lock_id = NULL, lock_until = 0, updated_at = ? WHERE subject = ? AND revision = ? AND lock_id = ? AND reauth_required = 0 RETURNING subject`)
      .bind(value, Date.now(), subject, row.revision, lock).first();
    if (!changed) throw new AuthError('AUTH_CONTEXT_CHANGED', 409);
    return tokens.access_token;
  } catch (error) {
    if (error.code === 'REAUTH_REQUIRED') await env.DB.prepare(`UPDATE japanese_auth_accounts SET reauth_required = 1 WHERE subject = ? AND revision = ? AND lock_id = ?`)
      .bind(subject, row.revision, lock).run();
    throw error;
  } finally {
    await env.DB.prepare('UPDATE japanese_auth_accounts SET lock_id = NULL, lock_until = 0 WHERE subject = ? AND lock_id = ?').bind(subject, lock).run();
  }
}
async function accessToken(subject, env, fetcher) {
  // D1 lease also protects refreshes across independent Worker isolates.
  const key = `${env.GOOGLE_CLIENT_ID}|${subject}`;
  if (!refreshTasks.has(key)) refreshTasks.set(key, refreshAccount(subject, env, fetcher).finally(() => refreshTasks.delete(key)));
  return refreshTasks.get(key);
}
export function allowedDriveTarget(value, method) {
  let url; try { url = new URL(value); } catch { throw new AuthError('DRIVE_TARGET_DENIED', 403); }
  if (url.origin !== 'https://www.googleapis.com' || url.username || url.password || url.hash) throw new AuthError('DRIVE_TARGET_DENIED', 403);
  if (method === 'GET' && /^\/drive\/v3\/files(?:\/[A-Za-z0-9_-]{1,200})?$/.test(url.pathname)) return url;
  if (method === 'POST' && url.pathname === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'multipart') return url;
  if (method === 'PATCH' && /^\/upload\/drive\/v3\/files\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname) && url.searchParams.get('uploadType') === 'media') return url;
  throw new AuthError('DRIVE_TARGET_DENIED', 403);
}
function validName(name) { return /^japanese_(?:backup_[^/]+|learning_state(?:_[^/]+)?)\.json$/.test(String(name)); }
async function proxy(request, env, fetcher) {
  const session = await sessionFor(request, env);
  await rateLimit(request, env, 'drive', 120);
  const target = allowedDriveTarget(new URL(request.url).searchParams.get('target'), request.method);
  let token = await accessToken(session.subject, env, fetcher);
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  let body;
  if (request.method !== 'GET') {
    if (Number(request.headers.get('Content-Length')) > MAX_BODY) throw new AuthError('BODY_TOO_LARGE', 413);
    body = await readBounded(request.body, MAX_BODY);
    const type = request.headers.get('Content-Type') || '';
    if (request.method === 'POST') {
      if (!/^multipart\/related;\s*boundary=/.test(type)) throw new AuthError('INVALID_DRIVE_UPLOAD');
      const prefix = new TextDecoder().decode(body.subarray(0, 4096));
      const match = prefix.match(/\r\n\r\n(\{[^\r\n]+\})\r\n/);
      let meta; try { meta = JSON.parse(match?.[1] || ''); } catch { throw new AuthError('INVALID_DRIVE_UPLOAD'); }
      if (!validName(meta.name) || meta.mimeType !== 'application/json' || (meta.parents && (!Array.isArray(meta.parents) || meta.parents.length > 1))) throw new AuthError('DRIVE_TARGET_DENIED', 403);
    } else if (!/^application\/json(?:;|$)/.test(type)) throw new AuthError('INVALID_DRIVE_UPLOAD');
    headers.set('Content-Type', type);
  }
  if (target.pathname !== '/drive/v3/files' && target.pathname !== '/upload/drive/v3/files') {
    const id = target.pathname.split('/').pop();
    const meta = await remoteJson(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType`, { headers }, fetcher);
    if (!validName(meta.name) || meta.mimeType !== 'application/json') throw new AuthError('DRIVE_TARGET_DENIED', 403);
  } else if (request.method === 'GET') {
    const q = target.searchParams.get('q') || '';
    if (q.length > 4096) throw new AuthError('INVALID_DRIVE_QUERY');
    target.searchParams.set('q', `${q ? `(${q}) and ` : ''}trashed = false and mimeType = 'application/json' and (name contains 'japanese_backup_' or name contains 'japanese_learning_state')`);
    target.searchParams.set('pageSize', String(Math.min(1000, Math.max(1, Number(target.searchParams.get('pageSize')) || 100))));
  }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetcher(target.href, { method: request.method, headers, body, signal: controller.signal, redirect: 'error' });
    if (response.status === 401) {
      await response.body?.cancel();
      const account = await env.DB.prepare('SELECT * FROM japanese_auth_accounts WHERE subject = ?').bind(session.subject).first();
      if (!account || account.reauth_required) throw new AuthError('REAUTH_REQUIRED', 401);
      const credentials = await openAuthValue(account.credentials_cipher, `account:${session.subject}`, env);
      if (credentials.accessToken === token) {
        const expired = await sealAuthValue({ ...credentials, expiresAt: 0 }, `account:${session.subject}`, env);
        await env.DB.prepare('UPDATE japanese_auth_accounts SET credentials_cipher = ?, revision = revision + 1 WHERE subject = ? AND revision = ? AND (lock_until IS NULL OR lock_until <= ?)')
          .bind(expired, session.subject, account.revision, Date.now()).run();
      }
      token = await accessToken(session.subject, env, fetcher);
      headers.set('Authorization', `Bearer ${token}`);
      response = await fetcher(target.href, { method: request.method, headers, body, signal: controller.signal, redirect: 'error' });
      if (response.status === 401) {
        await response.body?.cancel();
        const latest = await env.DB.prepare('SELECT * FROM japanese_auth_accounts WHERE subject = ?').bind(session.subject).first();
        if (latest && (await openAuthValue(latest.credentials_cipher, `account:${session.subject}`, env)).accessToken === token) {
          await env.DB.prepare('UPDATE japanese_auth_accounts SET reauth_required = 1 WHERE subject = ? AND revision = ?').bind(session.subject, latest.revision).run();
        }
        throw new AuthError('REAUTH_REQUIRED', 401);
      }
    }
    if (!response.body) { clearTimeout(timer); return new Response(null, { status: response.status, headers: cors(request, env) }); }
    const reader = response.body.getReader();
    const stream = new ReadableStream({
      async pull(control) {
        try { const { value, done } = await reader.read(); if (done) { clearTimeout(timer); reader.releaseLock(); control.close(); } else control.enqueue(value); }
        catch (error) { clearTimeout(timer); control.error(error); }
      },
      cancel(reason) { clearTimeout(timer); controller.abort(); return reader.cancel(reason); }
    });
    const outgoing = { ...cors(request, env), 'Content-Type': response.headers.get('Content-Type') || 'application/json' };
    return new Response(stream, { status: response.status, headers: outgoing });
  } catch (error) { clearTimeout(timer); if (error instanceof AuthError) throw error; throw new AuthError('DRIVE_SERVICE_UNAVAILABLE', 503); }
}
async function revoke(request, env, fetcher) {
  const session = await sessionFor(request, env);
  const row = await env.DB.prepare('SELECT * FROM japanese_auth_accounts WHERE subject = ?').bind(session.subject).first();
  const credentials = await openAuthValue(row.credentials_cipher, `account:${session.subject}`, env);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: credentials.refreshToken }), signal: controller.signal });
    if (!response.ok && response.status !== 400) throw new AuthError('GOOGLE_AUTH_FAILED', 502);
  } finally { clearTimeout(timer); }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM japanese_auth_sessions WHERE subject = ?').bind(session.subject),
    env.DB.prepare('DELETE FROM japanese_auth_accounts WHERE subject = ?').bind(session.subject)
  ]);
  return json(request, env, { ok: true });
}
export async function cleanupAuth(env, now = Date.now()) {
  if (!configured(env)) return;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM japanese_auth_transactions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM japanese_auth_limits WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM japanese_auth_sessions WHERE expires_at <= ? OR absolute_expires_at <= ?').bind(now, now),
    env.DB.prepare(`DELETE FROM japanese_auth_accounts WHERE updated_at < ? AND NOT EXISTS
      (SELECT 1 FROM japanese_auth_sessions s WHERE s.subject = japanese_auth_accounts.subject)`).bind(now - SESSION_MAX)
  ]);
}
export async function handleAuthRequest(request, env, fetcher = fetch) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/auth/') && path !== '/api/drive') return null;
  try {
    if (path !== '/api/auth/callback' && !allowed(request, env)) throw new AuthError('ORIGIN_DENIED', 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(request, env),
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '3600' } });
    if (path === '/api/auth/status' && request.method === 'GET') {
      let databaseReady = false;
      if (env.DB && configured(env)) {
        try {
          for (const table of ['japanese_auth_transactions', 'japanese_auth_accounts', 'japanese_auth_sessions', 'japanese_auth_limits']) {
            await env.DB.prepare(`SELECT 1 FROM ${table} LIMIT 1`).first();
          }
          databaseReady = true;
        } catch {}
      }
      return json(request, env, { configured: configured(env) && databaseReady, databaseReady, clientId: env.GOOGLE_CLIENT_ID || '',
        callbackUrl: new URL('/api/auth/callback', request.url).href, serviceVersion: 'V1.6.0' });
    }
    if (!configured(env)) throw new AuthError('AUTH_NOT_CONFIGURED', 503);
    if (path === '/api/auth/start' && request.method === 'POST') return await start(request, env);
    if (path === '/api/auth/callback' && request.method === 'GET') return await callback(request, env, fetcher);
    if (path === '/api/auth/result' && request.method === 'POST') return await result(request, env);
    if (path === '/api/auth/session' && request.method === 'GET') {
      const session = await sessionFor(request, env);
      await accessToken(session.subject, env, fetcher);
      return json(request, env, { email: session.email, expiresAt: session.expires_at });
    }
    if (path === '/api/auth/logout' && request.method === 'POST') {
      const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (token) await env.DB.prepare('DELETE FROM japanese_auth_sessions WHERE token_hash = ?').bind(await authHash(token)).run();
      return json(request, env, { ok: true });
    }
    if (path === '/api/auth/revoke' && request.method === 'POST') return await revoke(request, env, fetcher);
    if (path === '/api/drive') return await proxy(request, env, fetcher);
    return json(request, env, { code: 'NOT_FOUND' }, 404);
  } catch (error) {
    const code = error instanceof AuthError ? error.code : 'AUTH_SERVICE_ERROR';
    // Never log Google responses, codes, tokens, email or credential ciphertext.
    return json(request, env, { code, error: code }, error instanceof AuthError ? error.status : 503);
  }
}
