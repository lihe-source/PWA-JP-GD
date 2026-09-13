// Study streak domain logic for V7.2.2.
// The module is deliberately UI-independent so date math, migration and
// cross-device union merges can be verified with Node tests.

export const STUDY_ACTIVITY_TYPES = Object.freeze({
  WORD_QUIZ: 'word_quiz',
  READING_QUIZ: 'reading_quiz',
  ESSAY_REVIEW: 'essay_review',
  AI_ASK: 'ai_ask'
});

export const STUDY_DAYS_CSV_HEADER = '日期,時區,活動類型,事件ID,練習次數,首次練習時間,最後練習時間';

const VALID_ACTIVITY_TYPES = new Set(Object.values(STUDY_ACTIVITY_TYPES));
const DATE_PATTERN = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(safeArray(values).map(value => String(value || '').trim()).filter(Boolean))].sort();
}

function validIso(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeDateString(value) {
  const match = String(value || '').trim().match(DATE_PATTERN);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function getCurrentTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

export function dateKeyFor(value = new Date(), timeZone = getCurrentTimeZone()) {
  if (typeof value === 'string') {
    const normalized = normalizeDateString(value);
    if (normalized) return normalized;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function normalizeDay(day = {}) {
  const date = normalizeDateString(day.date);
  if (!date) return null;
  const eventIds = uniqueStrings(day.eventIds);
  const activities = uniqueStrings(day.activities).filter(type => VALID_ACTIVITY_TYPES.has(type));
  const firstCandidates = [day.firstActivityAt, day.firstAt].map(validIso).filter(Boolean).sort();
  const lastCandidates = [day.lastActivityAt, day.lastAt].map(validIso).filter(Boolean).sort();
  const fallback = `${date}T12:00:00.000Z`;
  const sessionCount = Math.max(activities.length ? 1 : 0, eventIds.length, Number(day.sessionCount) || 0);
  return {
    date,
    timezone: String(day.timezone || day.timeZone || 'UTC'),
    activities,
    eventIds,
    sessionCount,
    firstActivityAt: firstCandidates[0] || lastCandidates[0] || fallback,
    lastActivityAt: lastCandidates.at(-1) || firstCandidates.at(-1) || fallback
  };
}

export function mergeStudyDays(...collections) {
  const byDate = new Map();
  collections.flatMap(safeArray).forEach(raw => {
    const incoming = normalizeDay(raw);
    if (!incoming) return;
    const existing = byDate.get(incoming.date);
    if (!existing) {
      byDate.set(incoming.date, incoming);
      return;
    }
    const eventIds = uniqueStrings([...existing.eventIds, ...incoming.eventIds]);
    const activities = uniqueStrings([...existing.activities, ...incoming.activities]);
    const firstActivityAt = [existing.firstActivityAt, incoming.firstActivityAt].filter(Boolean).sort()[0];
    const lastActivityAt = [existing.lastActivityAt, incoming.lastActivityAt].filter(Boolean).sort().at(-1);
    byDate.set(incoming.date, {
      date: incoming.date,
      timezone: existing.timezone || incoming.timezone || 'UTC',
      activities,
      eventIds,
      sessionCount: Math.max(existing.sessionCount || 0, incoming.sessionCount || 0, eventIds.length),
      firstActivityAt,
      lastActivityAt
    });
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function normalizeStudyDays(days) {
  return mergeStudyDays(days);
}

function dateOrdinal(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

export function computeStudyStreak(days, { now = new Date(), timeZone = getCurrentTimeZone() } = {}) {
  const normalized = normalizeStudyDays(days);
  const uniqueDates = normalized.map(day => day.date);
  if (!uniqueDates.length) {
    return { current: 0, longest: 0, totalDays: 0, latestDate: '', practicedToday: false };
  }

  let longest = 1;
  let run = 1;
  for (let i = 1; i < uniqueDates.length; i++) {
    if (dateOrdinal(uniqueDates[i]) - dateOrdinal(uniqueDates[i - 1]) === 1) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
  }

  const today = dateKeyFor(now, timeZone);
  const latestDate = uniqueDates.at(-1);
  const latestGap = dateOrdinal(today) - dateOrdinal(latestDate);
  let current = 0;
  if (latestGap === 0 || latestGap === 1) {
    current = 1;
    for (let i = uniqueDates.length - 1; i > 0; i--) {
      if (dateOrdinal(uniqueDates[i]) - dateOrdinal(uniqueDates[i - 1]) !== 1) break;
      current += 1;
    }
  }

  return {
    current,
    longest,
    totalDays: uniqueDates.length,
    latestDate,
    practicedToday: latestDate === today
  };
}

function migrationEvent(type, date, suffix = '') {
  const normalizedDate = dateKeyFor(date);
  if (!normalizedDate) return null;
  const stamp = `${normalizedDate}T12:00:00.000Z`;
  return {
    date: normalizedDate,
    timezone: getCurrentTimeZone(),
    activities: [type],
    eventIds: [`legacy:${type}:${normalizedDate}${suffix ? `:${suffix}` : ''}`],
    sessionCount: 1,
    firstActivityAt: stamp,
    lastActivityAt: stamp
  };
}

export function deriveStudyDays({ history = [], readingQuizHistory = [], essayHistory = [], aiAskHistory = [] } = {}) {
  const derived = [];
  safeArray(history).forEach((entry, index) => {
    const day = migrationEvent(STUDY_ACTIVITY_TYPES.WORD_QUIZ, entry?.date, String(entry?.id || index));
    if (day && Number(entry?.total || 0) > 0) derived.push(day);
  });
  safeArray(readingQuizHistory).forEach((group, groupIndex) => {
    safeArray(group?.sessions).forEach((session, index) => {
      const day = migrationEvent(STUDY_ACTIVITY_TYPES.READING_QUIZ, group?.date || session?.ts, String(session?.id || session?.ts || `${groupIndex}-${index}`));
      if (day) derived.push(day);
    });
  });
  safeArray(essayHistory).forEach((group, groupIndex) => {
    safeArray(group?.sessions).forEach((session, index) => {
      const day = migrationEvent(STUDY_ACTIVITY_TYPES.ESSAY_REVIEW, group?.date || session?.ts, String(session?.id || session?.ts || `${groupIndex}-${index}`));
      if (day) derived.push(day);
    });
  });
  safeArray(aiAskHistory).forEach((entry, index) => {
    const suffix = `${entry?.id || 'entry'}-${entry?.ts || index}`;
    const day = migrationEvent(STUDY_ACTIVITY_TYPES.AI_ASK, entry?.ts || entry?.date, suffix);
    if (day) derived.push(day);
  });
  return mergeStudyDays(derived);
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(value); value = '';
    } else value += char;
  }
  cells.push(value);
  return cells;
}

export function exportStudyDaysCSV(days) {
  const rows = normalizeStudyDays(days).map(day => [
    day.date,
    day.timezone,
    day.activities.join(';'),
    day.eventIds.join(';'),
    day.sessionCount,
    day.firstActivityAt,
    day.lastActivityAt
  ].map(csvCell).join(','));
  return [STUDY_DAYS_CSV_HEADER, ...rows].join('\n');
}

export function importStudyDaysCSV(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (!lines.length || lines[0].replace(/"/g, '').trim() !== STUDY_DAYS_CSV_HEADER) {
    throw new Error('FORMAT_MISMATCH_STUDY_DAYS');
  }
  const rows = lines.slice(1).map(parseCsvLine).map(cells => ({
    date: cells[0],
    timezone: cells[1],
    activities: String(cells[2] || '').split(';').filter(Boolean),
    eventIds: String(cells[3] || '').split(';').filter(Boolean),
    sessionCount: Number(cells[4]) || 0,
    firstActivityAt: cells[5],
    lastActivityAt: cells[6]
  }));
  return normalizeStudyDays(rows);
}

export class StudyStreakManager {
  constructor({ storage, getDeviceId = () => 'unknown-device', now = () => new Date() } = {}) {
    if (!storage) throw new Error('STORAGE_REQUIRED');
    this.storage = storage;
    this.getDeviceId = getDeviceId;
    this.now = now;
  }

  getDays() {
    try { return normalizeStudyDays(JSON.parse(this.storage.getItem('studyActivityDays') || '[]')); }
    catch { return []; }
  }

  saveDays(days, { markPending = true } = {}) {
    const normalized = normalizeStudyDays(days);
    this.storage.setItem('studyActivityDays', JSON.stringify(normalized));
    if (markPending) this.storage.setItem('studyStreakSyncPending', '1');
    return normalized;
  }

  recordActivity(type, { occurredAt = this.now(), eventId = '', timeZone = getCurrentTimeZone() } = {}) {
    if (!VALID_ACTIVITY_TYPES.has(type)) throw new Error('INVALID_STUDY_ACTIVITY');
    const instant = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
    const iso = Number.isNaN(instant.getTime()) ? this.now().toISOString() : instant.toISOString();
    const date = dateKeyFor(instant, timeZone);
    const deviceId = this.getDeviceId();
    const id = eventId || `${deviceId}:${type}:${Date.now()}:${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    const next = mergeStudyDays(this.getDays(), [{
      date,
      timezone: timeZone,
      activities: [type],
      eventIds: [id],
      sessionCount: 1,
      firstActivityAt: iso,
      lastActivityAt: iso
    }]);
    this.saveDays(next);
    return { day: next.find(item => item.date === date), summary: this.getSummary() };
  }

  merge(days, options = {}) {
    return this.saveDays(mergeStudyDays(this.getDays(), days), options);
  }

  replace(days, options = {}) {
    return this.saveDays(days, options);
  }

  migrateFromHistories(histories, { markPending = true } = {}) {
    const current = this.getDays();
    const derived = deriveStudyDays(histories);
    const merged = mergeStudyDays(current, derived);
    const changed = JSON.stringify(current) !== JSON.stringify(merged);
    if (changed) this.saveDays(merged, { markPending });
    this.storage.setItem('studyStreakMigrationV8', new Date().toISOString());
    return { changed, addedDays: Math.max(0, merged.length - current.length), days: merged, summary: this.getSummary() };
  }

  getSummary(options = {}) {
    return computeStudyStreak(this.getDays(), options);
  }

  exportCSV() { return exportStudyDaysCSV(this.getDays()); }

  importCSV(text) {
    const incoming = importStudyDaysCSV(text);
    const before = this.getDays();
    const merged = mergeStudyDays(before, incoming);
    this.saveDays(merged);
    return { added: Math.max(0, merged.length - before.length), total: merged.length };
  }

  clear() { this.saveDays([]); }

  markSynced(at = new Date().toISOString()) {
    this.storage.setItem('studyStreakLastSync', at);
    this.storage.removeItem('studyStreakSyncPending');
  }

  markPending() { this.storage.setItem('studyStreakSyncPending', '1'); }

  getSyncState() {
    return {
      pending: this.storage.getItem('studyStreakSyncPending') === '1',
      lastSync: this.storage.getItem('studyStreakLastSync') || ''
    };
  }
}
