import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWordReadingPool, buildWordReadingQuestions, checkWordReadingAnswer, WordReadingProgressManager, mergeWordReadingHistory } from './word-reading.js';
import { BackupSchema } from './backup-schema.js';
import { mergeLearningStates } from './learning-sync.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const words = [
  { id: '1', english: '愛', reading: 'あい', chinese: '愛' },
  { id: '2', english: '赤', reading: 'あか', chinese: '紅色' },
  { id: '3', english: '食べる', reading: 'たべる', chinese: '吃' },
  { id: '4', english: '寿司', reading: 'すし', chinese: '壽司' },
  { id: '5', english: 'お茶', reading: 'おちゃ', chinese: '茶' },
  { id: '6', english: 'ココア', reading: 'ココア', chinese: '可可' }
];

test('word pool checks every pronounced kana against all selected rows', () => {
  assert.deepEqual(makeWordReadingPool(words, ['a']).map(w => w.word), ['愛']);
  assert.deepEqual(makeWordReadingPool(words, ['a', 'ka']).map(w => w.word), ['愛', '赤', 'ココア']);
  assert.equal(makeWordReadingPool(words, ['ta']).some(w => w.word === '食べる'), false);
  assert.equal(makeWordReadingPool(words, ['ta', 'ha', 'ra']).some(w => w.word === '食べる'), true);
  assert.equal(makeWordReadingPool(words, ['sa']).some(w => w.word === '寿司'), true);
  assert.equal(makeWordReadingPool(words, ['a', 'ta']).some(w => w.word === 'お茶'), false);
  assert.equal(makeWordReadingPool(words, ['a', 'ta', 'ya']).some(w => w.word === 'お茶'), true);
  assert.equal(makeWordReadingPool([{ english: '橋', reading: 'はし' }, { english: '箸', reading: 'はし' }], ['ha', 'sa']).length, 1);
});

test('word questions display the chosen script, remain random and avoid immediate repeats', () => {
  const pool = makeWordReadingPool(words, ['a', 'ka']);
  const questions = buildWordReadingQuestions(pool, { script: 'katakana', count: 15 }, () => 0.2);
  assert.equal(questions.length, 15);
  assert.ok(questions.some(q => q.word === 'ココア' && q.display === 'ココア'));
  assert.ok(questions.every(q => /^[\u30a0-\u30ff]+$/.test(q.display)));
  assert.ok(questions.every((q, i) => !i || q.id !== questions[i - 1].id));
  assert.equal(checkWordReadingAnswer(questions.find(q => q.word === '愛'), 'ＡＩ').correct, true);
  assert.equal(checkWordReadingAnswer(questions.find(q => q.word === '愛'), 'ka').correct, false);
});

test('reading attempt history merges by ID and preserves wrong answers for backup', () => {
  const data = new Map();
  const storage = { getItem: k => data.get(k) || null, setItem: (k, v) => data.set(k, v) };
  const manager = new WordReadingProgressManager(storage);
  const question = buildWordReadingQuestions(makeWordReadingPool(words, ['a']), { count: 5 })[0];
  const first = manager.recordAttempt(question, 'wrong', false);
  manager.recordAttempt(question, question.romaji, true);
  assert.equal(manager.getSummary().attempts, 2);
  assert.equal(manager.getSummary().wrong, 1);
  assert.equal(mergeWordReadingHistory(manager.getHistory(), [first]).length, 2);
  assert.equal(manager.getHistory().find(item => item.id === first.id).answer, 'wrong');
});

test('word reading preserves keyboard input, requeues wrong words, and shows every answer with sounds', () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('Views.wordReadingPractice ='), source.indexOf('// READING QUIZ VIEW'));
  const elements = new Map();
  for (const id of ['answer', 'submit', 'feedback', 'progress-text', 'progress-fill', 'character']) {
    elements.set(`word-reading-${id}`, { value: '', style: {}, setAttribute() {}, isConnected: true, focus() {}, setSelectionRange() {} });
  }
  const calls = [], timers = [], records = [];
  const container = { innerHTML: '' };
  const context = { Views: { kanaReadingPractice: { _focusAnswerInput: () => true } },
    document: { getElementById: id => elements.get(id) },
    Router: { quizActive: true }, GDrive: { scheduleStudyStreakSync: () => calls.push('sync') },
    Sound: { playCorrect: () => calls.push('correct'), playWrong: () => calls.push('wrong'), playResult: () => calls.push('result') },
    WordReadingProgress: { recordAttempt: (...args) => records.push(args) },
    checkWordReadingAnswer, escapeHTML: String, showToast() {},
    recordStudyActivity: () => calls.push('study'), STUDY_ACTIVITY_TYPES: { WORD_READING: 'word_reading' },
    todayStr: () => '2026/09/26', refreshStudyStreakUI() {}, resumeAppUpdateWhenSafe() {},
    setTimeout: fn => (timers.push(fn), timers.length), clearTimeout() {} };
  vm.runInNewContext(block, context);
  const view = context.Views.wordReadingPractice;
  view.state.items = buildWordReadingQuestions(makeWordReadingPool(words, ['a', 'ka']), { count: 5 }, () => 0.3);
  view.state.initialTotal = 5;
  view.paintQuestion();
  const input = elements.get('word-reading-answer');
  const first = view.state.items[0];
  input.value = 'wrong'; view.submitAnswer(container);
  assert.equal(view.state.items.length, 6);
  assert.equal(records.length, 1);
  assert.equal(calls[0], 'wrong');
  timers.shift()();
  assert.equal(elements.get('word-reading-answer'), input);
  for (let index = 1; index < 5; index++) {
    input.value = view.state.items[index].romaji; view.submitAnswer(container); timers.shift()();
  }
  assert.equal(view.state.items[5].word, first.word);
  input.value = first.romaji; view.submitAnswer(container); timers.shift()();
  assert.match(container.innerHTML, /作答總表/);
  assert.match(container.innerHTML, /is-correct/);
  assert.match(container.innerHTML, /is-wrong/);
  assert.match(container.innerHTML, /wrong/);
  assert.match(container.innerHTML, new RegExp(first.romaji));
  assert.equal(records.length, 6);
  timers.shift()();
  assert.ok(calls.includes('result'));
});

test('schema 3 backup contains word reading and schema 2 backups still restore', () => {
  const entry = { id: 'wr1', word: '愛', reading: 'あい', romaji: 'ai', answer: 'a', correct: false };
  const current = BackupSchema.attach({ wordReadingHistory: [entry] });
  assert.equal(current.collectionCounts.wordReading, 1);
  assert.equal(BackupSchema.validate(current).valid, true);
  const previous = BackupSchema.attach({ kanaReadingHistory: [{ id: 'old', character: 'あ' }] });
  delete previous.wordReadingHistory;
  previous.schemaVersion = 2;
  const oldKeys = BackupSchema.collectionKeys.filter(key => key !== 'wordReadingHistory');
  const stable = value => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  };
  let hash = 0x811c9dc5;
  for (const char of stable(Object.fromEntries(oldKeys.map(key => [key, previous[key] || []])))) {
    hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193);
  }
  previous.payloadChecksum = (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
  assert.equal(BackupSchema.validate(previous).valid, true);
});

test('cross-device learning state merges word answers without duplication', () => {
  const phone = { wordReadingHistory: [{ id: 'phone-answer', ts: 1, word: '愛', reading: 'あい', romaji: 'ai', answer: 'a', correct: false }] };
  const tablet = { wordReadingHistory: [{ id: 'tablet-answer', ts: 2, word: '寿司', reading: 'すし', romaji: 'sushi', answer: 'sushi', correct: true }] };
  const merged = mergeLearningStates(phone, tablet);
  assert.deepEqual(merged.wordReadingHistory.map(item => item.id), ['tablet-answer', 'phone-answer']);
  assert.equal(mergeLearningStates(merged, phone).wordReadingHistory.length, 2);
});
