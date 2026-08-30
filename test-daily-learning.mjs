import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_LEARNING_SOURCES,
  dailyLearningSignature,
  kanaToRomaji,
  normalizeDailyLearningPreferences,
  parseDailyVocabularyResponse,
  readingMatchesRows,
  selectedLearningRowLabel
} from './daily-learning.js';

test('daily learning settings support JLPT level and multiple kana rows', () => {
  const settings = normalizeDailyLearningPreferences({ source: 'level', level: 'n3', rows: ['a', 'ka', 'sa', 'bad'] });
  assert.deepEqual(settings, { source: DAILY_LEARNING_SOURCES.LEVEL, level: 'N3', rows: ['a', 'ka', 'sa'] });
  assert.equal(selectedLearningRowLabel(settings.rows), 'あ行、か行、さ行');
  assert.match(dailyLearningSignature({ date: '2026-08-30', ...settings }), /2026-08-30\|level\|N3\|a\+ka\+sa/);
});

test('kana rows include voiced sounds and exclude unselected rows', () => {
  assert.equal(readingMatchesRows('がっこう', ['ka']), true);
  assert.equal(readingMatchesRows('ざっし', ['sa']), true);
  assert.equal(readingMatchesRows('あい', ['ka', 'sa']), false);
});

test('recommended vocabulary always has kana and usable romaji', () => {
  assert.equal(kanaToRomaji('あい'), 'ai');
  assert.equal(kanaToRomaji('がっこう'), 'gakkou');
  const parsed = parseDailyVocabularyResponse(`\`\`\`json
  [
    {"word":"愛","reading":"あい","romaji":"","partOfSpeech":"名詞","meaning":"愛","level":"N5"},
    {"word":"朝","reading":"あさ","romaji":"asa","partOfSpeech":"名詞","meaning":"早晨","level":"N5"},
    {"word":"学校","reading":"がっこう","romaji":"gakkou","partOfSpeech":"名詞","meaning":"學校","level":"N5"}
  ]
  \`\`\``, { level: 'N5', rows: ['a'], limit: 5 });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].romaji, 'ai');
  assert.equal(parsed[0].reading, 'あい');
});
