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
