import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STUDY_ACTIVITY_TYPES,
  StudyStreakManager,
  computeStudyStreak,
  dateKeyFor,
  deriveStudyDays,
  exportStudyDaysCSV,
  importStudyDaysCSV,
  mergeStudyDays
} from './study-streak.js';

const makeDay = (date, eventId = date, activity = STUDY_ACTIVITY_TYPES.WORD_QUIZ) => ({
  date,
  timezone: 'Asia/Taipei',
  activities: [activity],
  eventIds: [eventId],
  sessionCount: 1,
  firstActivityAt: `${date}T04:00:00.000Z`,
  lastActivityAt: `${date}T04:00:00.000Z`
});

test('date keys respect the device time zone', () => {
  assert.equal(dateKeyFor('2026-08-08T16:30:00.000Z', 'Asia/Taipei'), '2026-08-09');
  assert.equal(dateKeyFor('2026/08/09', 'America/New_York'), '2026-08-09');
});

test('same-day events are unioned and the day is counted once', () => {
  const merged = mergeStudyDays(
    [makeDay('2026-08-08', 'phone-1')],
    [makeDay('2026-08-08', 'ipad-1', STUDY_ACTIVITY_TYPES.READING_QUIZ)]
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].eventIds, ['ipad-1', 'phone-1']);
  assert.deepEqual(merged[0].activities, ['reading_quiz', 'word_quiz']);
  assert.equal(merged[0].sessionCount, 2);
});

test('current and historical longest streaks are calculated across month boundaries', () => {
  const days = ['2026-07-29', '2026-07-30', '2026-07-31', '2026-08-02', '2026-08-03', '2026-08-04']
    .map(makeDay);
  const summary = computeStudyStreak(days, { now: new Date('2026-08-04T12:00:00.000Z'), timeZone: 'UTC' });
  assert.deepEqual(summary, {
    current: 3,
    longest: 3,
    totalDays: 6,
    latestDate: '2026-08-04',
    practicedToday: true
  });
});

test('yesterday keeps a streak active, but an older latest date resets it', () => {
  const yesterday = computeStudyStreak(
    ['2026-08-07', '2026-08-08'].map(makeDay),
    { now: new Date('2026-08-09T12:00:00.000Z'), timeZone: 'UTC' }
  );
  assert.equal(yesterday.current, 2);
  const expired = computeStudyStreak(
    ['2026-08-06', '2026-08-07'].map(makeDay),
    { now: new Date('2026-08-09T12:00:00.000Z'), timeZone: 'UTC' }
  );
  assert.equal(expired.current, 0);
  assert.equal(expired.longest, 2);
});

test('leap day and year boundaries remain consecutive', () => {
  const leap = computeStudyStreak(
    ['2028-02-28', '2028-02-29', '2028-03-01'].map(makeDay),
    { now: new Date('2028-03-01T12:00:00.000Z'), timeZone: 'UTC' }
  );
  assert.equal(leap.current, 3);
  const year = computeStudyStreak(
    ['2028-12-31', '2029-01-01'].map(makeDay),
    { now: new Date('2029-01-01T12:00:00.000Z'), timeZone: 'UTC' }
  );
  assert.equal(year.longest, 2);
});

test('legacy histories migrate all four qualifying activity types', () => {
  const migrated = deriveStudyDays({
    history: [{ date: '2026/08/01', total: 10 }],
    readingQuizHistory: [{ date: '2026/08/02', sessions: [{ id: 'r1' }] }],
    essayHistory: [{ date: '2026/08/03', sessions: [{ ts: 3 }] }],
    aiAskHistory: [{ id: 'a1', ts: Date.parse('2026-08-04T05:00:00.000Z') }]
  });
  assert.equal(migrated.length, 4);
  assert.deepEqual(migrated.flatMap(day => day.activities).sort(), ['ai_ask', 'essay_review', 'reading_quiz', 'word_quiz']);
});

test('study-day CSV survives an export/import round trip', () => {
  const source = mergeStudyDays([
    makeDay('2026-08-08', 'device:a'),
    makeDay('2026-08-09', 'device:b', STUDY_ACTIVITY_TYPES.AI_ASK)
  ]);
  assert.deepEqual(importStudyDaysCSV(exportStudyDaysCSV(source)), source);
});

test('manager keeps duplicate event IDs idempotent and marks changes pending', () => {
  const map = new Map();
  const storage = {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key)
  };
  const manager = new StudyStreakManager({ storage, getDeviceId: () => 'test-device' });
  const options = { occurredAt: new Date('2026-08-09T03:00:00.000Z'), eventId: 'same', timeZone: 'UTC' };
  manager.recordActivity(STUDY_ACTIVITY_TYPES.WORD_QUIZ, options);
  manager.recordActivity(STUDY_ACTIVITY_TYPES.WORD_QUIZ, options);
  assert.equal(manager.getDays().length, 1);
  assert.equal(manager.getDays()[0].sessionCount, 1);
  assert.equal(manager.getSyncState().pending, true);
});
