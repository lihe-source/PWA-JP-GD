import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import webpush from 'web-push';
import api, { computeNextFireAt } from './worker.js';

const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
const sqliteTest = { skip: DatabaseSync ? false : '完整 D1 SQL 回歸需使用支援 node:sqlite 的 Node.js' };
const origin = 'https://example.test';
const due = Date.parse('2026-11-23T14:00:00Z'); // Taiwan 22:00
const day = 86400000;
const endpoint = 'https://fcm.googleapis.com/fcm/send/reminder-test';
const schema = readFileSync(new URL('schema.sql', import.meta.url), 'utf8');

// Run the Worker's actual bound SQL and transactions against an isolated SQLite database.
function setup(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(schema);
  t.after(() => sql.close());
  const statement = (query, args = []) => ({
    bind: (...values) => statement(query, values),
    first: () => sql.prepare(query).get(...args),
    all: () => ({ results: sql.prepare(query).all(...args) }),
    run() {
      const prepared = sql.prepare(query);
      if (prepared.columns().length) return this.all();
      const { changes } = prepared.run(...args);
      return { results: [], meta: { changes } };
    }
  });
  const db = {
    prepare: query => statement(query),
    batch(statements) {
      sql.exec('BEGIN');
      try {
        const result = statements.map(item => item.run());
        sql.exec('COMMIT');
        return result;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    }
  };
  let now = due - 10000;
  t.mock.method(Date, 'now', () => now);
  const vapid = webpush.generateVAPIDKeys();
  const env = { DB: db, ALLOWED_ORIGINS: origin, APP_URL: origin + '/app/',
    VAPID_SUBJECT: 'mailto:test@example.test', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey };
  const post = async (path, data, token) => {
    const headers = { Origin: origin, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await api.fetch(new Request(origin + '/api/reminders' + path, {
      method: 'POST', headers, body: JSON.stringify(data)
    }), env);
    return { status: response.status, ...(await response.json()) };
  };
  const registration = {
    subscription: { endpoint, keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } },
    reminderTime: '22:00', timeZone: 'Asia/Taipei', scopeKey: 's1_' + 'a'.repeat(43)
  };
  const cron = async at => {
    now = at;
    let finished;
    await api.scheduled({ scheduledTime: at }, env, { waitUntil(task) { finished = task; } });
    await finished;
  };
  return {
    sql, post, registration, cron, clock: at => { now = at; },
    register: (overrides = {}, token) => post('', { ...registration, ...overrides }, token),
    reminder: () => sql.prepare('SELECT * FROM japanese_reminders').get(),
    scope: () => sql.prepare('SELECT * FROM japanese_reminder_scopes').get()
  };
}

test('the final second before the configured minute still belongs to today', () => {
  assert.equal(computeNextFireAt(due - 1, '22:00', 'Asia/Taipei'), due);
  assert.equal(computeNextFireAt(due, '22:00', 'Asia/Taipei'), due + day);
});

test('reopening at the deadline keeps today scheduled and acknowledges early practice in the same transaction', sqliteTest, async t => {
  const f = setup(t);
  const send = t.mock.method(webpush, 'sendNotification', async () => {});
  const initial = await f.register();
  assert.equal(initial.status, 200);
  assert.equal(initial.nextFireAt, due);
  f.clock(due + 1000);
  const renewal = await f.register({ practice: { occurredAt: new Date(due - 2000).toISOString(), activityType: 'kana_reading' } }, initial.managementToken);
  assert.equal(renewal.nextFireAt, due);
  assert.equal(renewal.practice.date, '2026-11-23');
  assert.equal(f.scope().scheduled_for, due);
  await f.cron(due + 1500);
  assert.equal(send.mock.callCount(), 0);
  assert.equal(f.reminder().next_fire_at, due + day);
  assert.equal(f.scope().scheduled_for, due + day);
});

test('retry keeps its original boundary after re-registration and late practice', sqliteTest, async t => {
  const f = setup(t);
  let sends = 0;
  t.mock.method(webpush, 'sendNotification', async () => {
    if (++sends === 1) throw Object.assign(new Error('TEMPORARY'), { statusCode: 503 });
  });
  const { managementToken } = await f.register();
  await f.cron(due);
  f.clock(due + 60000);
  const renewed = await f.register({}, managementToken);
  assert.equal(renewed.nextFireAt, due + 300000);
  assert.equal(f.reminder().failure_count, 1);
  assert.equal(f.scope().scheduled_for, due);
  const report = await f.post('/activity', { occurredAt: new Date(due + 1000).toISOString() }, managementToken);
  assert.equal(report.status, 200);
  await Promise.all([f.cron(due + 300000), f.cron(due + 300000)]);
  assert.equal(sends, 2);
  assert.equal(f.reminder().last_sent_at, due + 300000);
  assert.equal(f.scope().scheduled_for, due + day);
});

test('an in-flight push cannot replace a newer schedule or re-enable a stopped reminder', sqliteTest, async t => {
  const f = setup(t);
  const { managementToken } = await f.register();
  t.mock.method(webpush, 'sendNotification', async () => {
    const updated = await f.register({ reminderTime: '23:59' }, managementToken);
    assert.equal(updated.status, 200);
    assert.equal((await f.post('/disable', {}, managementToken)).status, 200);
  });
  await f.cron(due);
  const expected = due + (60 + 59) * 60000;
  assert.equal(f.reminder().enabled, 0);
  assert.equal(f.reminder().next_fire_at, expected);
  assert.equal(f.scope().scheduled_for, expected);
});

test('expired push endpoints remove their scope and a conflicting endpoint keeps its original subscription', sqliteTest, async t => {
  const f = setup(t);
  const first = await f.register();
  assert.equal((await f.register()).code, 'SUBSCRIPTION_ALREADY_REGISTERED');
  const second = await f.register({ subscription: { ...f.registration.subscription, endpoint: endpoint + '-2' } });
  const conflict = await f.register({ reminderTime: '23:59' }, second.managementToken);
  assert.equal(conflict.status, 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM japanese_reminders').get().n, 2);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM japanese_reminder_scopes WHERE scheduled_for = ?').get(due).n, 2);
  t.mock.method(webpush, 'sendNotification', async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); });
  assert.equal((await f.post('/test', {}, first.managementToken)).status, 410);
  await f.cron(due);
  assert.equal(f.reminder(), undefined);
  assert.equal(f.scope(), undefined);
});

test('failed practice or scope writes roll back the registration and the same request can retry', sqliteTest, async t => {
  const f = setup(t);
  f.sql.exec("CREATE TRIGGER fail_scope BEFORE INSERT ON japanese_reminder_scopes BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await f.register()).status, 500);
  assert.equal(f.reminder(), undefined);
  f.sql.exec('DROP TRIGGER fail_scope');
  const { managementToken } = await f.register();
  f.sql.exec("CREATE TRIGGER fail_activity BEFORE INSERT ON japanese_practice_days BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const result = await f.register({ reminderTime: '23:59', practice: { occurredAt: new Date(due - 2000).toISOString() } }, managementToken);
  assert.equal(result.status, 500);
  assert.equal(f.reminder().reminder_time, '22:00');
  assert.equal(f.scope().scheduled_for, due);
});
