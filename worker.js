import webpush from 'web-push';

const SERVICE_VERSION = 'V1.4.2';
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

function isValidScopeKey(value) {
  return /^s1_[A-Za-z0-9_-]{43}$/.test(String(value || ''));
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

export function localDateKey(timestamp, timeZone) {
  const parts = zonedParts(timestamp, timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function shouldSkipReminder(row, practice, scheduledAt = Number(row?.next_fire_at) || 0) {
  if (!row || !practice || !scheduledAt) return false;
  const completedAt = Number(practice.completed_at) || 0;
  if (!completedAt || completedAt > scheduledAt) return false;
  return String(practice.practice_date || '') === localDateKey(scheduledAt, row.time_zone);
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
  if (candidate <= now) {
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
    const host = url.hostname.toLowerCase();
    const provider = (host.endsWith('.push.apple.com') && host !== 'push.apple.com') ||
      host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com';
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !provider) return null;
  } catch {
    return null;
  }
  const decodeKey = text => {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
    try { return atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)); }
    catch { return null; }
  };
  if (!endpoint || endpoint.length > 2048 || decodeKey(p256dh)?.length !== 65 || decodeKey(auth)?.length !== 16) return null;
  return { endpoint, p256dh, auth };
}

async function parseJson(request) {
  try {
    if (Number(request.headers.get('Content-Length') || 0) > 8192) return null;
    const reader = request.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  catch { return null; }
}

async function findByToken(request, env) {
  const token = bearerToken(request);
  if (!token || token.length > 256) return null;
  const hash = await tokenHash(token);
  return env.DB.prepare('SELECT * FROM japanese_reminders WHERE token_hash = ? LIMIT 1').bind(hash).first();
}

async function reminderScopeState(row, env) {
  const mapping = await env.DB.prepare('SELECT scope_key, scheduled_for FROM japanese_reminder_scopes WHERE reminder_id = ? LIMIT 1')
    .bind(row.id).first();
  return {
    scopeKey: isValidScopeKey(mapping?.scope_key) ? mapping.scope_key : `reminder_${row.id}`,
    scheduledFor: Number(mapping?.scheduled_for) || Number(row.next_fire_at) || 0
  };
}

function normalizePractice(value, now = Date.now()) {
  const completedAt = new Date(value?.occurredAt || '').getTime();
  if (!Number.isFinite(completedAt)) return null;
  if (completedAt > now + 5 * 60 * 1000 || completedAt < now - 8 * 24 * 60 * 60 * 1000) return null;
  return {
    completedAt,
    occurredAt: new Date(completedAt).toISOString(),
    activityType: String(value?.activityType || 'practice').trim().slice(0, 40) || 'practice'
  };
}

function scopeStatement(db, id, key, now) {
  return db.prepare(`
    INSERT INTO japanese_reminder_scopes (reminder_id, scope_key, scheduled_for, updated_at)
    SELECT id, COALESCE(NULLIF(?, ''), 'reminder_' || id), next_fire_at, ?
    FROM japanese_reminders WHERE id = ?
    ON CONFLICT(reminder_id) DO UPDATE SET
      scope_key = COALESCE(NULLIF(?, ''), japanese_reminder_scopes.scope_key),
      scheduled_for = COALESCE(japanese_reminder_scopes.scheduled_for, excluded.scheduled_for),
      updated_at = excluded.updated_at
    WHERE (? <> '' AND scope_key <> excluded.scope_key) OR scheduled_for IS NULL
  `).bind(key, now, id, key, key);
}

function practiceStatement(db, id, practiceDate, practice, now) {
  return db.prepare(`
    INSERT INTO japanese_practice_days (scope_key, practice_date, completed_at, activity_type, updated_at)
    SELECT scope_key, ?, ?, ?, ? FROM japanese_reminder_scopes WHERE reminder_id = ?
    ON CONFLICT(scope_key, practice_date) DO UPDATE SET
      completed_at = MIN(japanese_practice_days.completed_at, excluded.completed_at),
      activity_type = CASE WHEN excluded.completed_at <= japanese_practice_days.completed_at THEN excluded.activity_type ELSE japanese_practice_days.activity_type END,
      updated_at = excluded.updated_at
  `).bind(practiceDate, practice.completedAt, practice.activityType, now, id);
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
    contentEncoding: 'aes128gcm'
  });
}

function pushErrorDetails(error) {
  const rawBody = typeof error?.body === 'string'
    ? error.body
    : error?.body ? String(error.body) : '';
  let providerReason = '';
  try {
    const parsed = JSON.parse(rawBody || '{}');
    providerReason = String(parsed.reason || parsed.error || '').slice(0, 100);
  } catch {}
  return {
    status: Number(error?.statusCode) || 500,
    providerReason,
    rawBody: rawBody.slice(0, 300)
  };
}

function subscriptionIsInvalid(status, providerReason) {
  return status === 404 || status === 410 || [
    'BadDeviceToken',
    'DeviceTokenNotForTopic',
    'Unregistered'
  ].includes(providerReason);
}

async function handleRegister(request, env) {
  const input = await parseJson(request);
  const subscription = validateSubscription(input?.subscription);
  const reminderTime = String(input?.reminderTime || '');
  const timeZone = String(input?.timeZone || '');
  const title = String(input?.title || '日本語練習時間到了').trim().slice(0, 80);
  const body = String(input?.body || '每天複習一點點，保持日文學習節奏！').trim().slice(0, 180);
  const scopeKey = isValidScopeKey(input?.scopeKey) ? String(input.scopeKey) : '';
  const practice = normalizePractice(input?.practice);

  if (!subscription) return jsonResponse(request, env, { error: '推播訂閱資料不完整', code: 'INVALID_SUBSCRIPTION' }, 400);
  if (!isValidTime(reminderTime)) return jsonResponse(request, env, { error: '提醒時間格式錯誤', code: 'INVALID_TIME' }, 400);
  if (!isValidTimeZone(timeZone)) return jsonResponse(request, env, { error: '時區格式錯誤', code: 'INVALID_TIME_ZONE' }, 400);
  if (!title || !body) return jsonResponse(request, env, { error: '提醒文字不可為空', code: 'INVALID_MESSAGE' }, 400);

  const now = Date.now();
  const candidate = computeNextFireAt(now, reminderTime, timeZone);
  const token = bearerToken(request);
  const row = token ? await findByToken(request, env) : null;
  if (token && !row) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  const reminderId = row?.id || crypto.randomUUID();
  const managementToken = row ? '' : randomToken();
  const db = env.DB;
  const statements = [];
  if (row) {
    // Only a changed (or re-enabled) schedule replaces the original due time.
    // Ordinary startup reconciliation must preserve both a due reminder and its retry lease.
    const changedSchedule = 'id = ? AND (enabled = 0 OR reminder_time <> ? OR time_zone <> ?)';
    statements.push(
      db.prepare(`UPDATE japanese_reminder_scopes SET scheduled_for = ?, updated_at = ?
        WHERE reminder_id = ? AND EXISTS (SELECT 1 FROM japanese_reminders WHERE ${changedSchedule})`)
        .bind(candidate, now, reminderId, reminderId, reminderTime, timeZone),
      db.prepare(`UPDATE japanese_reminders SET next_fire_at = ?, failure_count = 0, last_error = NULL
        WHERE ${changedSchedule}`).bind(candidate, reminderId, reminderTime, timeZone),
      db.prepare(`UPDATE japanese_reminders SET endpoint = ?, p256dh = ?, auth = ?, reminder_time = ?,
        time_zone = ?, title = ?, body = ?, enabled = 1, updated_at = ? WHERE id = ?`)
        .bind(subscription.endpoint, subscription.p256dh, subscription.auth, reminderTime, timeZone, title, body, now, reminderId)
    );
  } else {
    statements.push(db.prepare(`
      INSERT INTO japanese_reminders (
        id, token_hash, endpoint, p256dh, auth, reminder_time, time_zone, title, body,
        enabled, next_fire_at, failure_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
    `).bind(reminderId, await tokenHash(managementToken), subscription.endpoint, subscription.p256dh,
      subscription.auth, reminderTime, timeZone, title, body, candidate, now, now));
  }

  statements.push(scopeStatement(db, reminderId, scopeKey, now));
  const date = practice ? localDateKey(practice.completedAt, timeZone) : '';
  if (practice) statements.push(practiceStatement(db, reminderId, date, practice, now));
  statements.push(db.prepare('SELECT next_fire_at FROM japanese_reminders WHERE id = ?').bind(reminderId));
  let result;
  try {
    result = await db.batch(statements);
  } catch (error) {
    if (!/UNIQUE constraint failed: japanese_reminders\.endpoint/i.test(String(error?.cause?.message || error?.message))) throw error;
    return jsonResponse(request, env, { error: '此通知訂閱已註冊，請重新建立訂閱', code: 'SUBSCRIPTION_ALREADY_REGISTERED' }, 409);
  }
  const nextFireAt = result.at(-1)?.results?.[0]?.next_fire_at;
  if (!nextFireAt) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  return jsonResponse(request, env, {
    ok: true, enabled: true, reminderTime, timeZone, nextFireAt,
    ...(practice ? { practice: { date, occurredAt: practice.occurredAt, activityType: practice.activityType } } : {}),
    ...(managementToken ? { managementToken } : {})
  });
}

async function handleActivity(request, env) {
  const row = await findByToken(request, env);
  if (!row) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  const input = await parseJson(request);
  const now = Date.now();
  const practice = normalizePractice(input, now);
  if (!practice) return jsonResponse(request, env, { error: '練習完成時間格式錯誤', code: 'INVALID_ACTIVITY' }, 400);
  const scope = isValidScopeKey(input?.scopeKey) ? input.scopeKey : '';
  const date = localDateKey(practice.completedAt, row.time_zone);
  const [, saved] = await env.DB.batch([
    scopeStatement(env.DB, row.id, scope, now),
    practiceStatement(env.DB, row.id, date, practice, now)
  ]);
  if (!saved.meta?.changes) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  return jsonResponse(request, env, { ok: true, practice: { date, occurredAt: practice.occurredAt, activityType: practice.activityType } });
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

async function removeSubscription(db, where, values) {
  return db.batch([
    db.prepare(`DELETE FROM japanese_reminder_scopes WHERE reminder_id IN
      (SELECT id FROM japanese_reminders WHERE ${where})`).bind(...values),
    db.prepare(`DELETE FROM japanese_reminders WHERE ${where}`).bind(...values)
  ]);
}

async function handleTest(request, env) {
  const row = await findByToken(request, env);
  if (!row) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  try {
    await sendPush(row, env, true);
    return jsonResponse(request, env, { ok: true });
  } catch (error) {
    const { status, providerReason, rawBody } = pushErrorDetails(error);
    if (subscriptionIsInvalid(status, providerReason)) {
      await removeSubscription(env.DB, 'id = ? AND endpoint = ?', [row.id, row.endpoint]);
      console.warn('[WebPush] Invalid subscription removed:', status, providerReason || 'expired');
      return jsonResponse(request, env, {
        error: '裝置訂閱已失效，正在要求重新建立',
        code: 'SUBSCRIPTION_INVALID',
        providerReason
      }, 410);
    }
    console.error('[WebPush] Test failed:', status, error?.message || error, providerReason || rawBody);
    return jsonResponse(request, env, {
      error: providerReason ? `Apple 推播拒絕：${providerReason}` : '測試通知傳送失敗',
      code: status === 400 ? 'PUSH_REJECTED' : 'PUSH_FAILED',
      providerReason
    }, 502);
  }
}

async function handleDelete(request, env) {
  const row = await findByToken(request, env);
  if (!row) return jsonResponse(request, env, { error: '提醒憑證無效', code: 'AUTH_EXPIRED' }, 401);
  await removeSubscription(env.DB, 'id = ?', [row.id]);
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
    const ownsSchedule = 'id = ? AND enabled = 1 AND next_fire_at = ? AND endpoint = ? AND reminder_time = ? AND time_zone = ?';
    const schedule = [row.endpoint, row.reminder_time, row.time_zone];
    const claim = await env.DB.prepare(`
      UPDATE japanese_reminders SET next_fire_at = ?, updated_at = ? WHERE ${ownsSchedule}
    `).bind(retryLock, now, row.id, row.next_fire_at, ...schedule).run();
    if (!claim.meta?.changes) continue;
    const lease = [row.id, retryLock, ...schedule];

    let sent = false;
    let failures = 0;
    let failureMessage = null;
    try {
      const scope = await reminderScopeState(row, env);
      const scheduledFor = scope.scheduledFor;
      const dueDate = localDateKey(scheduledFor, row.time_zone);
      const practice = await env.DB.prepare(`
        SELECT practice_date, completed_at FROM japanese_practice_days
        WHERE scope_key = ? AND practice_date = ? LIMIT 1
      `).bind(scope.scopeKey, dueDate).first();
      if (shouldSkipReminder(row, practice, scheduledFor)) {
        console.info('[WebPush] Daily reminder skipped after completed practice:', row.id, dueDate);
      } else {
        if (!await env.DB.prepare(`SELECT 1 FROM japanese_reminders WHERE ${ownsSchedule}`).bind(...lease).first()) continue;
        await sendPush(row, env, false);
        sent = true;
      }
    } catch (error) {
      const { status, providerReason } = pushErrorDetails(error);
      if (subscriptionIsInvalid(status, providerReason)) {
        await removeSubscription(env.DB, ownsSchedule, lease);
        continue;
      }
      failures = Number(row.failure_count || 0) + 1;
      failureMessage = String(providerReason || error?.message || 'PUSH_FAILED').slice(0, 300);
      console.error('[WebPush] Scheduled send failed:', row.id, status, failureMessage);
    }

    // The two statements observe the same lease. A slow response cannot undo
    // a time change or a disabled subscription saved while the push was in flight.
    const retry = failures > 0 && failures < 3;
    const next = retry ? retryLock : computeNextFireAt(now, row.reminder_time, row.time_zone);
    const changes = [];
    if (!retry) changes.push(env.DB.prepare(`UPDATE japanese_reminder_scopes SET scheduled_for = ?, updated_at = ?
      WHERE reminder_id = ? AND EXISTS (SELECT 1 FROM japanese_reminders WHERE ${ownsSchedule})`)
      .bind(next, now, row.id, ...lease));
    changes.push(env.DB.prepare(`UPDATE japanese_reminders SET next_fire_at = ?, failure_count = ?, last_error = ?,
      last_sent_at = COALESCE(?, last_sent_at), updated_at = ? WHERE ${ownsSchedule}`)
      .bind(next, failures, failureMessage, sent ? now : null, now, ...lease));
    await env.DB.batch(changes);
  }

  // Expiration is measured in days. Use the indexed cleanup once an hour.
  if (Math.floor(now / 60000) % 60 === 0) {
    await env.DB.prepare('DELETE FROM japanese_practice_days WHERE updated_at < ?')
      .bind(now - 40 * 24 * 60 * 60 * 1000).run();
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
        await env.DB.batch([
          env.DB.prepare('SELECT 1 FROM japanese_reminders LIMIT 1'),
          env.DB.prepare('SELECT 1 FROM japanese_reminder_scopes LIMIT 1'),
          env.DB.prepare('SELECT 1 FROM japanese_practice_days LIMIT 1')
        ]);
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
  if (url.pathname === '/api/reminders/activity' && request.method === 'POST') return handleActivity(request, env);
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
