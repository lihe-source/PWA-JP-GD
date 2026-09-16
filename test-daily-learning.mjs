import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_LEARNING_SOURCES,
  dailyLearningSignature,
  kanaToRomaji,
  normalizeDailyLearningPreferences,
  parseDailyVocabularyResponse,
  parseGeneratedSentenceResponse,
  readingMatchesRows,
  selectedLearningRowLabel,
  validateGeneratedSentence,
  validateStoredGeneratedSentence
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

test('generated sentences accept only the structured JSON contract', () => {
  assert.equal(parseGeneratedSentenceResponse('.)\nIdea'), null);
  assert.deepEqual(parseGeneratedSentenceResponse('```json\n{"ja":"手を洗います。","kana":"てをあらいます。","zh":"我要洗手。"}\n```'), {
    ja: '手を洗います。', kana: 'てをあらいます。', zh: '我要洗手。'
  });
});

test('sentence validation rejects the malformed response seen in the daily card', () => {
  const invalid = validateGeneratedSentence({ en: '.)', reading: '', zh: 'Idea' }, { word: '手' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'MISSING_READING');
  assert.equal(validateStoredGeneratedSentence({ wordEn: '手', en: '.)', reading: '', zh: 'Idea' }).ok, false);
});

test('sentence validation requires Japanese, kana, Traditional Chinese and the target word', () => {
  const valid = validateGeneratedSentence({
    ja: '手を洗ってください。', kana: 'てをあらってください。', zh: '請洗手。'
  }, { word: '手' });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value, { en: '手を洗ってください。', reading: 'てをあらってください。', zh: '請洗手。' });

  assert.equal(validateGeneratedSentence({
    ja: '顔を洗ってください。', kana: 'かおをあらってください。', zh: '請洗臉。'
  }, { word: '手' }).reason, 'TARGET_NOT_USED');
  assert.equal(validateGeneratedSentence({
    ja: '手を洗います。', kana: 'てをあらいます。', zh: 'Wash your hands.'
  }, { word: '手' }).reason, 'INVALID_TRANSLATION');
});

test('sentence validation permits a normal conjugated target form', () => {
  const result = validateGeneratedSentence({
    ja: '毎朝パンを食べます。', kana: 'まいあさぱんをたべます。', zh: '我每天早上吃麵包。'
  }, { word: '食べる' });
  assert.equal(result.ok, true);
});
