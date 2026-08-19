import test from 'node:test';
import assert from 'node:assert/strict';
import { BASIC_KANA, getKanaSet } from './kana-data.js';
import { buildKanaProgress, mergeHandwritingHistory, normalizeJapaneseAnswer, resolveWritingLayout, toHiragana } from './japanese-learning.js';

test('the basic kana curriculum includes 46 hiragana and 46 katakana with strokes', () => {
  assert.equal(BASIC_KANA.length, 92);
  assert.equal(getKanaSet({ script: 'hiragana' }).length, 46);
  assert.equal(getKanaSet({ script: 'katakana' }).length, 46);
  assert.equal(BASIC_KANA.every(kana => kana.strokes.length > 0), true);
});

test('kana curriculum accepts more than one selected row', () => {
  const twoHiraganaRows = getKanaSet({ script: 'hiragana', rows: ['a', 'ka'] });
  const mixedShortRows = getKanaSet({ script: 'both', rows: ['ya', 'wa'] });
  assert.equal(twoHiraganaRows.length, 10);
  assert.equal(twoHiraganaRows.every(kana => ['a', 'ka'].includes(kana.row)), true);
  assert.equal(mixedShortRows.length, 12);
  assert.equal(mixedShortRows.every(kana => ['ya', 'wa'].includes(kana.row)), true);
});

test('writing layout distinguishes iPhone 15 Pro Max and iPad Air in both orientations', () => {
  assert.equal(resolveWritingLayout({ viewportWidth: 430, screenWidth: 430, screenHeight: 932, touch: true }), 'phone');
  assert.equal(resolveWritingLayout({ viewportWidth: 932, screenWidth: 932, screenHeight: 430, touch: true }), 'phone');
  assert.equal(resolveWritingLayout({ viewportWidth: 820, screenWidth: 820, screenHeight: 1180, touch: true }), 'tablet');
  assert.equal(resolveWritingLayout({ viewportWidth: 1180, screenWidth: 1180, screenHeight: 820, touch: true }), 'tablet');
  assert.equal(resolveWritingLayout({ preference: 'phone', viewportWidth: 1180, screenWidth: 1180, screenHeight: 820, touch: true }), 'phone');
});

test('Japanese answers normalize width, spacing and punctuation', () => {
  assert.equal(normalizeJapaneseAnswer(' 食べる。 '), '食べる');
  assert.equal(normalizeJapaneseAnswer('カタカナ', { kanaOnly: true }), 'かたかな');
  assert.equal(toHiragana('アイウ'), 'あいう');
});

test('handwriting progress merges attempts and marks an 80-point best as mastered', () => {
  const history = mergeHandwritingHistory([
    { id: 'a', character: 'あ', script: 'hiragana', romaji: 'a', mode: 'trace', score: 62, ts: 1 },
    { id: 'b', character: 'あ', script: 'hiragana', romaji: 'a', mode: 'copy', score: 84, ts: 2 }
  ]);
  const progress = buildKanaProgress(history)[0];
  assert.equal(progress.attempts, 2);
  assert.equal(progress.bestScore, 84);
  assert.equal(progress.averageScore, 73);
  assert.equal(progress.mastered, true);
});
