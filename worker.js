import webpush from 'web-push';

const SERVICE_VERSION = 'V1.0.0';
const MAX_DUE_PER_RUN = 25;
const formatterCache = new Map();

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function requestOrigin(request) {
  return String(request.headers.get('Origin') || '').replace(/\/+$/, '');
}

function isAllowedRequest(request, env) {
  const origin = requestOrigin(request);
  return !!origin && allowedOrigins(env).includes(origin);
}

function corsHeaders(request, env) {
  const origin = requestOrigin(request);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (origin && allowedOrigins(env).includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(request, env, payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env)
    }
  });
}

function cleanAppUrl(value) {
  if (/YOUR_GITHUB_USERNAME|YOUR_REPOSITORY|REPLACE[_-]?WITH/i.test(String(value || ''))) return '';
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return '';
    return url.href.endsWith('/') ? url.href : `${url.href}/`;
  } catch {
    return '';
  }
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return typeof value === 'string' && value.length <= 80;
  } catch {
    return false;
  }
}

function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
  }
  return formatterCache.get(timeZone);
}

function zonedParts(timestamp, timeZone) {
  const values = {};
  for (const part of getFormatter(timeZone).formatToParts(new Date(timestamp))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}

function plusLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localDateTimeToUtc(dateParts, hour, minute, timeZone) {
  const targetAsUtc = Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute, 0);
  let guess = targetAsUtc;
  for (let attempt = 0; attempt < 5; attempt++) {
    const displayed = zonedParts(guess, timeZone);
    const displayedAsUtc = Date.UTC(
      displayed.year, displayed.month - 1, displayed.day,
      displayed.hour, displayed.minute, displayed.second
    );
    const adjustment = targetAsUtc - displayedAsUtc;
    guess += adjustment;
    if (Math.abs(adjustment) < 1000) break;
  }
  return guess;
}

export function computeNextFireAt(now, reminderTime, timeZone) {
  if (!isValidTime(reminderTime) || !isValidTimeZone(timeZone)) throw new Error('INVALID_SCHEDULE');
  const [hour, minute] = reminderTime.split(':').map(Number);
  const localNow = zonedParts(now, timeZone);
  let targetDate = { year: localNow.year, month: localNow.month, day: localNow.day };
  let candidate = localDateTimeToUtc(targetDate, hour, minute, timeZone);
  if (candidate <= now + 30000) {
    targetDate = plusLocalDays(targetDate, 1);
    candidate = localDateTimeToUtc(targetDate, hour, minute, timeZone);
  }
  return candidate;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  return match ? match[1].trim() : '';
}

function validateSubscription(value) {
  const endpoint = String(value?.endpoint || '').trim();
  const p256dh = String(value?.keys?.p256dh || '').trim();
  const auth = String(value?.keys?.auth || '').trim();
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  if (!endpoint || endpoint.length > 2048 || !p256dh || p256dh.length > 256 || !auth || auth.length > 128) return null;
  return { endpoint, p256dh, auth };
}

async function parseJson(request) {
  try { return await request.json(); }
  catch { return null; }
}

async function findByToken(request, env) {
  const token = bearerToken(request);
  if (!token || token.length > 256) return null;
  const hash = await tokenHash(token);
  return env.DB.prepare('SELECT * FROM japanese_reminders WHERE token_hash = ? LIMIT 1').bind(hash).first();
}

function configureWebPush(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) throw new Error('VAPID_NOT_CONFIGURED');
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

function notificationPayload(row, env, isTest = false) {
  const appUrl = cleanAppUrl(env.APP_URL);
  const icon = appUrl ? new URL('icon-192.png', appUrl).href : undefined;
  return JSON.stringify({
    title: isTest ? '測試通知成功' : row.title,
    options: {
      body: isTest ? `每日 ${row.reminder_time} 的日文練習提醒已設定完成。` : row.body,
      icon,
      badge: icon,
      tag: isTest ? 'japanese-reminder-test' : 'japanese-daily-reminder',
      renotify: true,
      data: { url: appUrl, source: isTest ? 'test' : 'daily-reminder' }
    }
  });
}

async function sendPush(row, env, isTest = false) {
  configureWebPush(env);
  const subscription = {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth }
  };
  return webpush.sendNotification(subscription, notificationPayload(row, env, isTest), {
    TTL: isTest ? 300 : 3600,
    urgency: isTest ? 'high' : 'normal',
    topic: isTest ? 'japanese-test' : 'japanese-daily'
  });
}

async function handleRegister(request, env) {
  const input = await parseJson(request);
  const subscription = validateSubscription(input?.subscription);
  const reminderTime = String(input?.reminderTime || '');
  const timeZone = String(input?.timeZone || '');
  const title = String(input?.title || '日本語練習時間到了').trim().slice(0, 80);
  const body = String(input?.body || '每天複習一點點，保持日文學習節奏！').trim().slice(0, 180);

  if (!subscription) return jsonResponse(request, env, { error: '推播訂閱資料不完整', code: 'INVALID_SUBSCRIPTION' }, 400);
  if (!isValidTime(reminderTime)) return jsonResponse(request, env, { error: '提醒時間格式錯誤', code: 'INVALID_TIME' }, 400);
  if (!isValidTimeZone(timeZone)) return jsonResponse(request, env, { error: '時區格式錯誤', code: 'INVALID_TIME_ZONE' }, 400);
  if (!title || !body) return jsonResponse(request, env, { error: '提醒文字不可為空', code: 'INVALID_MESSAGE' }, 400);

  const now = Date.now();
  const nextFireAt = computeNextFireAt(now, reminderTime, timeZone);
  const presentedToken = bearerToken(request);
  let managementToken = '';
  let row = null;

  if (presentedToken) {
    row = await findByToken(request, env);
    if (!row) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  } else {
    row = await env.DB.prepare('SELECT * FROM japanese_reminders WHERE endpoint = ? LIMIT 1').bind(subscription.endpoint).first();
    managementToken = randomToken();
  }

  if (row) {
    const nextHash = managementToken ? await tokenHash(managementToken) : row.token_hash;
    await env.DB.prepare('DELETE FROM japanese_reminders WHERE endpoint = ? AND id <> ?')
      .bind(subscription.endpoint, row.id).run();
    await env.DB.prepare(`
      UPDATE japanese_reminders
      SET token_hash = ?, endpoint = ?, p256dh = ?, auth = ?, reminder_time = ?, time_zone = ?,
          title = ?, body = ?, enabled = 1, next_fire_at = ?, failure_count = 0,
          last_error = NULL, updated_at = ?
      WHERE id = ?
    `).bind(
      nextHash, subscription.endpoint, subscription.p256dh, subscription.auth,
      reminderTime, timeZone, title, body, nextFireAt, now, row.id
    ).run();
  } else {
    managementToken = randomToken();
    const hash = await tokenHash(managementToken);
    await env.DB.prepare(`
      INSERT INTO japanese_reminders (
        id, token_hash, endpoint, p256dh, auth, reminder_time, time_zone, title, body,
        enabled, next_fire_at, failure_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
    `).bind(
      crypto.randomUUID(), hash, subscription.endpoint, subscription.p256dh, subscription.auth,
      reminderTime, timeZone, title, body, nextFireAt, now, now
    ).run();
  }

  return jsonResponse(request, env, {
    ok: true,
    enabled: true,
    reminderTime,
    timeZone,
    nextFireAt,
    ...(managementToken ? { managementToken } : {})
  });
}

async function handleDisable(request, env) {
  const row = await findByToken(request, env);
  if (!row) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  await env.DB.prepare('UPDATE japanese_reminders SET enabled = 0, updated_at = ? WHERE id = ?')
    .bind(Date.now(), row.id).run();
  return jsonResponse(request, env, { ok: true, enabled: false });
}

async function handleStatus(request, env) {
  const row = await findByToken(request, env);
  if (!row) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  return jsonResponse(request, env, {
    ok: true,
    enabled: row.enabled === 1,
    reminderTime: row.reminder_time,
    timeZone: row.time_zone,
    nextFireAt: row.next_fire_at,
    lastSentAt: row.last_sent_at || null
  });
}

async function handleTest(request, env) {
  const row = await findByToken(request, env);
  if (!row) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  try {
    await sendPush(row, env, true);
    return jsonResponse(request, env, { ok: true });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status === 404 || status === 410) {
      await env.DB.prepare('DELETE FROM japanese_reminders WHERE id = ?').bind(row.id).run();
      return jsonResponse(request, env, { error: '裝置訂閱已失效，請重新啟用提醒', code: 'AUTH_EXPIRED' }, 410);
    }
    console.error('[WebPush] Test failed:', status, error?.message || error);
    return jsonResponse(request, env, { error: '測試通知傳送失敗', code: 'PUSH_FAILED' }, 502);
  }
}

async function handleDelete(request, env) {
  const row = await findByToken(request, env);
  if (!row) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  await env.DB.prepare('DELETE FROM japanese_reminders WHERE id = ?').bind(row.id).run();
  return jsonResponse(request, env, { ok: true });
}

async function processDueReminders(env, scheduledTime = Date.now()) {
  const now = Number(scheduledTime) || Date.now();
  const due = await env.DB.prepare(`
    SELECT * FROM japanese_reminders
    WHERE enabled = 1 AND next_fire_at <= ?
    ORDER BY next_fire_at ASC
    LIMIT ?
  `).bind(now, MAX_DUE_PER_RUN).all();

  for (const row of due.results || []) {
    const retryLock = now + 5 * 60 * 1000;
    const claim = await env.DB.prepare(`
      UPDATE japanese_reminders SET next_fire_at = ?, updated_at = ?
      WHERE id = ? AND enabled = 1 AND next_fire_at <= ?
    `).bind(retryLock, now, row.id, now).run();
    if (!claim.meta?.changes) continue;

    try {
      await sendPush(row, env, false);
      const next = computeNextFireAt(now + 60000, row.reminder_time, row.time_zone);
      await env.DB.prepare(`
        UPDATE japanese_reminders
        SET next_fire_at = ?, last_sent_at = ?, failure_count = 0, last_error = NULL, updated_at = ?
        WHERE id = ?
      `).bind(next, now, now, row.id).run();
    } catch (error) {
      const status = Number(error?.statusCode) || 0;
      if (status === 404 || status === 410) {
        await env.DB.prepare('DELETE FROM japanese_reminders WHERE id = ?').bind(row.id).run();
        continue;
      }
      const failures = Number(row.failure_count || 0) + 1;
      const next = failures < 3
        ? now + 5 * 60 * 1000
        : computeNextFireAt(now + 60000, row.reminder_time, row.time_zone);
      await env.DB.prepare(`
        UPDATE japanese_reminders
        SET next_fire_at = ?, failure_count = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).bind(next, failures, String(error?.message || 'PUSH_FAILED').slice(0, 300), now, row.id).run();
      console.error('[WebPush] Scheduled send failed:', row.id, status, error?.message || error);
    }
  }
}

async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    if (!isAllowedRequest(request, env)) return jsonResponse(request, env, { error: 'Origin not allowed' }, 403);
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  if (url.pathname === '/' && request.method === 'GET') {
    let databaseReady = false;
    if (env.DB) {
      try {
        await env.DB.prepare('SELECT 1 FROM japanese_reminders LIMIT 1').first();
        databaseReady = true;
      } catch {
        databaseReady = false;
      }
    }
    const checks = {
      database: databaseReady,
      vapidPublicKey: !!env.VAPID_PUBLIC_KEY,
      vapidPrivateKey: !!env.VAPID_PRIVATE_KEY,
      vapidSubject: !!env.VAPID_SUBJECT,
      appUrl: !!cleanAppUrl(env.APP_URL),
      allowedOrigins: allowedOrigins(env).length > 0
    };
    return jsonResponse(request, env, {
      ok: true,
      service: 'Japanese Daily Reminder',
      version: SERVICE_VERSION,
      configured: Object.values(checks).every(Boolean),
      checks
    });
  }

  if (!url.pathname.startsWith('/api/')) return jsonResponse(request, env, { error: 'Not found' }, 404);
  if (!isAllowedRequest(request, env)) return jsonResponse(request, env, { error: 'Origin not allowed' }, 403);
  if (!env.DB) return jsonResponse(request, env, { error: 'D1 database is not configured', code: 'SERVER_NOT_CONFIGURED' }, 503);

  if (url.pathname === '/api/config' && request.method === 'GET') {
    if (!env.VAPID_PUBLIC_KEY) return jsonResponse(request, env, { error: 'VAPID is not configured', code: 'SERVER_NOT_CONFIGURED' }, 503);
    return jsonResponse(request, env, { vapidPublicKey: env.VAPID_PUBLIC_KEY, serviceVersion: SERVICE_VERSION });
  }
  if (url.pathname === '/api/reminders' && request.method === 'POST') return handleRegister(request, env);
  if (url.pathname === '/api/reminders' && request.method === 'DELETE') return handleDelete(request, env);
  if (url.pathname === '/api/reminders/disable' && request.method === 'POST') return handleDisable(request, env);
  if (url.pathname === '/api/reminders/status' && request.method === 'GET') return handleStatus(request, env);
  if (url.pathname === '/api/reminders/test' && request.method === 'POST') return handleTest(request, env);
  return jsonResponse(request, env, { error: 'Not found' }, 404);
}

export default {
  fetch(request, env) {
    return handleFetch(request, env).catch(error => {
      console.error('[Worker] Request failed:', error?.stack || error);
      return jsonResponse(request, env, { error: 'Internal server error', code: 'SERVER_ERROR' }, 500);
    });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processDueReminders(env, controller.scheduledTime));
  }
};
