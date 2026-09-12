import test from 'node:test';
import assert from 'node:assert/strict';
import { BASIC_KANA } from './kana-data.js';
import {
  KanaReadingProgressManager,
  acceptedRomaji,
  buildKanaReadingProgress,
  checkKanaReadingAnswer,
  normalizeRomajiAnswer
} from './kana-reading.js';

const kana = character => BASIC_KANA.find(item => item.character === character);

test('kana reading answers normalize latin input and accept common aliases', () => {
  assert.equal(normalizeRomajiAnswer(' ＳＨＩ '), 'shi');
  assert.equal(checkKanaReadingAnswer(kana('あ'), 'A').correct, true);
  assert.equal(checkKanaReadingAnswer(kana('し'), 'si').correct, true);
  assert.equal(checkKanaReadingAnswer(kana('チ'), 'ti').correct, true);
  assert.deepEqual(acceptedRomaji(kana('を')), ['wo', 'o']);
  assert.equal(checkKanaReadingAnswer(kana('ふ'), 'ho').correct, false);
});

test('kana reading progress separates hiragana and katakana statistics', () => {
  const history = [
    { id: '1', character: 'あ', script: 'hiragana', romaji: 'a', answer: 'a', correct: true, ts: 1 },
    { id: '2', character: 'あ', script: 'hiragana', romaji: 'a', answer: 'i', correct: false, ts: 2 },
    { id: '3', character: 'ア', script: 'katakana', romaji: 'a', answer: 'a', correct: true, ts: 3 }
  ];
  const progress = buildKanaReadingProgress(history);
  assert.equal(progress.length, 2);
  assert.equal(progress.find(item => item.character === 'あ').accuracy, 50);
  assert.equal(progress.find(item => item.character === 'ア').accuracy, 100);
});

test('kana reading manager stores attempts and calculates summary', () => {
  const map = new Map();
  const storage = {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value))
  };
  const manager = new KanaReadingProgressManager(storage);
  manager.recordAttempt(kana('か'), 'ka', true);
  manager.recordAttempt(kana('き'), 'ke', false);
  assert.equal(manager.getSummary().attempts, 2);
  assert.equal(manager.getSummary().correct, 1);
  assert.equal(manager.getSummary().accuracy, 50);
});

import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function readingSession(characters) {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('Views.kanaReadingPractice ='), source.indexOf('// READING QUIZ VIEW'));
  const elements = new Map();
  for (const id of ['answer', 'submit', 'feedback', 'progress-text', 'progress-fill', 'character']) elements.set('kana-reading-' + id, { value: '', style: {}, setAttribute() {}, isConnected: true, focus() {}, setSelectionRange() {} });
  const timers = [], records = [];
  const context = { Views: {}, checkKanaReadingAnswer, escapeHTML: String, showToast() {},
    document: { getElementById: id => elements.get(id) }, requestAnimationFrame() {},
    KanaReadingProgress: { recordAttempt: (...args) => records.push(args) },
    Sound: { playCorrect() {}, playWrong() {} }, setTimeout: fn => (timers.push(fn), timers.length) };
  vm.runInNewContext(block, context);
  const view = context.Views.kanaReadingPractice;
  view.state.items = characters.map(kana);
  view.state.initialTotal = characters.length;
  let finished = false;
  view.renderResult = () => { finished = true; };
  return { view, elements, records, get finished() { return finished; },
    submit(answer) { elements.get('kana-reading-answer').value = answer; view._submitCurrentAnswer({}); },
    advance() { timers.shift()?.(); } };
}
test('wrong third question appends after originals, dynamic progress and persistent input', () => {
  const s = readingSession(['あ', 'い', 'し', 'か']);
  const input = s.elements.get('kana-reading-answer');
  for (const answer of ['a', 'i', 'su']) { s.submit(answer); s.advance(); }
  assert.equal(s.view.state.items.length, 5);
  assert.equal(s.view.state.items[3].character, 'か');
  assert.equal(s.view.state.items[4].character, 'し');
  assert.match(s.elements.get('kana-reading-progress-text').textContent, /4 \/ 5/);
  s.submit('ka'); s.advance();
  assert.equal(s.finished, false);
  s.submit('shi'); s.advance();
  assert.equal(s.finished, true);
  assert.equal(s.records.length, 5);
  assert.equal(s.records.filter(r => r[2]).length, 4);
  assert.equal(s.elements.get('kana-reading-answer'), input);
});
test('wrong final and retry extend session; duplicate submit and empty input do not', () => {
  const s = readingSession(['し']);
  s.submit(''); assert.equal(s.records.length, 0);
  s.submit('su'); s.submit('su');
  assert.equal(s.view.state.items.length, 2);
  assert.equal(s.records.length, 1);
  s.advance(); assert.equal(s.finished, false);
  s.submit('su'); s.advance();
  assert.equal(s.view.state.items.length, 3);
  assert.equal(s.finished, false);
  s.submit('si'); s.advance();
  assert.equal(s.finished, true); assert.equal(s.records.length, 3);
});
test('all correct retains original total', () => {
  const s = readingSession(['あ', 'ア']);
  s.submit('a'); s.advance(); s.submit('a'); s.advance();
  assert.equal(s.finished, true); assert.equal(s.view.state.items.length, 2);
});
