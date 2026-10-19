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
  splitTargetMatches,
  validateGeneratedSentence,
  validateStoredGeneratedSentence
} from './daily-learning.js';

test('sentence highlighting isolates every exact learned word and kana reading', () => {
  assert.deepEqual(splitTargetMatches('この時計は時計です。', '時計'), [
    { value: 'この', match: false },
    { value: '時計', match: true },
    { value: 'は', match: false },
    { value: '時計', match: true },
    { value: 'です。', match: false }
  ]);
  assert.deepEqual(splitTargetMatches('このとけいはいくらですか。', 'とけい'), [
    { value: 'この', match: false },
    { value: 'とけい', match: true },
    { value: 'はいくらですか。', match: false }
  ]);
  assert.deepEqual(splitTargetMatches('<時計>', ''), [{ value: '<時計>', match: false }]);
});

test('daily learning settings support JLPT level and multiple kana rows', () => {
  const settings = normalizeDailyLearningPreferences({ source: 'level', level: 'n3', rows: ['a', 'ka', 'sa', 'bad'] });
  assert.deepEqual(settings, { source: DAILY_LEARNING_SOURCES.LEVEL, level: 'N3', rows: ['a', 'ka', 'sa'], scriptRows: {hiragana:['a','ka','sa'],katakana:[]} });
  assert.equal(selectedLearningRowLabel(settings.rows), 'あ行、か行、さ行');
  assert.match(dailyLearningSignature({ date: '2026-08-30', ...settings }), /2026-08-30\|level\|N3\|a\+ka\+sa/);
});

test('the complete reading must stay inside selected rows', () => {
  assert.equal(readingMatchesRows('がっこう', ['ka']), false);
  assert.equal(readingMatchesRows('がっこう', ['ka', 'a']), true);
  assert.equal(readingMatchesRows('ざっし', ['sa']), true);
  assert.equal(readingMatchesRows('あい', ['ka', 'sa']), false);
  assert.equal(readingMatchesRows('たべる', ['a', 'ka', 'sa', 'ta', 'na', 'ha']), false);
  assert.equal(readingMatchesRows('たべた', ['a', 'ka', 'sa', 'ta', 'na', 'ha']), true);
  assert.equal(readingMatchesRows('キャー', ['ka']), false);
  assert.equal(readingMatchesRows('キャー', ['ka', 'ya']), true);
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
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].romaji, 'ai');
  assert.equal(parsed[0].reading, 'あい');
});

test('recommended vocabulary accepts a schema object wrapper from Gemini', () => {
  const parsed = parseDailyVocabularyResponse(JSON.stringify({
    words: [{ word: '傘', reading: 'かさ', romaji: 'kasa', partOfSpeech: '名詞', meaning: '雨傘', level: 'N5' }]
  }), { level: 'N5', rows: ['ka', 'sa'], limit: 1 });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].word, '傘');
  assert.equal(parsed[0].romaji, 'kasa');
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

test('daily script settings migrate legacy rows and preserve explicit disabled groups', () => {
  assert.deepEqual(normalizeDailyLearningPreferences({rows:['ka']}).scriptRows, {hiragana:['ka'],katakana:[]});
  const prefs = normalizeDailyLearningPreferences({scriptRows:{hiragana:[],katakana:['sa','ta','bad','sa']}});
  assert.deepEqual(prefs.scriptRows,{hiragana:[],katakana:['sa','ta']});
  assert.deepEqual(normalizeDailyLearningPreferences({scriptRows:{hiragana:[],katakana:[]}}).rows,[]);
});

test('daily script pools never borrow rows from the other script and preserve katakana', () => {
  const options = {scriptRows:{hiragana:['a','ka'],katakana:['sa','ta']},limit:20};
  const values = [
    {word:'愛',reading:'あい',meaning:'愛'},
    {word:'学校',reading:'がっこう',meaning:'學校'},
    {word:'傘',reading:'かさ',meaning:'雨傘'},
    {word:'サカ',reading:'サカ',meaning:'測試跨行'},
    {word:'シャツ',reading:'シャツ',meaning:'襯衫'},
    {word:'テスト',reading:'てすと',meaning:'測驗'}
  ];
  const result = parseDailyVocabularyResponse(JSON.stringify(values),options);
  assert.deepEqual(result.map(x=>x.word),['愛','学校','テスト']);
  assert.equal(result[2].reading,'テスト');
  assert.equal(result[2].romaji,'tesuto');
  assert.equal(parseDailyVocabularyResponse(JSON.stringify(values),{scriptRows:{hiragana:[],katakana:[]}}).length,0);
});

test('katakana handling checks the full spelling including small kana and halfwidth input', () => {
  const word={word:'ｺｰﾋｰ',reading:'こーひー',meaning:'咖啡'};
  assert.equal(parseDailyVocabularyResponse(JSON.stringify([word]),{scriptRows:{hiragana:[],katakana:['ka']}}).length,0);
  const result=parseDailyVocabularyResponse(JSON.stringify([word]),{scriptRows:{hiragana:[],katakana:['ka','ha']}});
  assert.equal(result[0].word,'コーヒー');assert.equal(result[0].reading,'コーヒー');
  assert.equal(parseDailyVocabularyResponse(JSON.stringify([{word:'シャツ',reading:'シャツ',meaning:'襯衫'}]),{scriptRows:{hiragana:[],katakana:['sa','ta','ya']}}).length,1);
  assert.equal(parseDailyVocabularyResponse(JSON.stringify([{word:'テスト',reading:'ササ',meaning:'測驗'}]),{scriptRows:{hiragana:[],katakana:['sa','ta']}}).length,0);
});

test('daily cache signature distinguishes script assignments with the same union of rows', () => {
  const common={date:'2026-10-19',source:'level',level:'N5'};
  const a=dailyLearningSignature({...common,scriptRows:{hiragana:['a'],katakana:['ka']}});
  const b=dailyLearningSignature({...common,scriptRows:{hiragana:['ka'],katakana:['a']}});
  assert.notEqual(a,b);
  assert.equal(dailyLearningSignature({...common,scriptRows:{hiragana:['a','ka'],katakana:[]}}),dailyLearningSignature({...common,scriptRows:{hiragana:['ka','a'],katakana:[]}}));
});

test('Gemini receives only the chosen script pool and rejects out-of-pool generated vocabulary', async t => {
  const {createGeminiClient}=await import('./gemini-client.js');
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch=async (_url,options)=>{
    calls++;const prompt=JSON.parse(options.body).contents[0].parts[0].text;
    assert.match(prompt,/Vocabulary script: katakana/);
    assert.match(prompt,/サ行/);assert.match(prompt,/タ行/);
    const words=calls===1 ? [{word:'カサ',reading:'カサ',meaning:'雨傘'}] : [{word:'テスト',reading:'テスト',meaning:'測驗'}];
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(words)}]},finishReason:'STOP'}]}));
  };
  const client=createGeminiClient({getApiKey:()=> 'mock-key',getModel:()=> 'mock'});
  client.ensureModelCatalog=async()=>[];client._shortTaskModels=()=>['mock','fallback'];
  const result=await client.generateDailyVocabulary({level:'N5',scriptRows:{hiragana:[],katakana:['sa','ta']}});
  assert.equal(calls,2);assert.equal(result[0].word,'テスト');assert.equal(result[0].reading,'テスト');
});

test('empty daily script selection never calls model discovery or generation', async () => {
  const {createGeminiClient}=await import('./gemini-client.js');
  const client=createGeminiClient({getApiKey:()=> 'mock-key'});
  client.ensureModelCatalog=async()=>{throw new Error('must not call');};
  await assert.rejects(client.generateDailyVocabulary({scriptRows:{hiragana:[],katakana:[]}}),/NO_LEARNING_ROWS/);
});

test('daily script preferences survive actual DB save, backup, restore, and invalidate cached words', async () => {
  const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
  const {BackupSchema}=await import('./backup-schema.js');
  const {normalizeDailyVocabulary}=await import('./daily-learning.js');
  const app=await readFile(new URL('./app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('const DB = {'),app.indexOf('\nfunction getOrCreateJapaneseDeviceId()'));
  const data=new Map();const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
  const context={DAILY_LEARNING_SOURCES,AppStorage:storage,normalizeDailyLearningPreferences,normalizeDailyVocabulary,dailyLearningSignature,todayStr:()=> '2026-10-19',JAPANESE_DEFAULTS:{jlptLevel:'N5'},STUDY_DAYS_CSV_HEADER:'date,type'};
  vm.runInNewContext(source+'\nthis.db=DB',context);const db=context.db;
  const scriptRows={hiragana:['a','ka'],katakana:['sa','ta']};
  db.saveDailyLearningPreferences({source:'level',scriptRows});
  db.saveTodayDailyVocabulary([{word:'テスト',reading:'テスト',meaning:'測驗'}]);
  assert.equal(db.getTodayDailyVocabulary().words[0].reading,'テスト');
  const payload=BackupSchema.attach({preferences:[{practice:{dailyLearning:db.getDailyLearningPreferences()}}]});
  const downloaded=JSON.parse(JSON.stringify(payload));
  db.saveDailyLearningPreferences({scriptRows:{hiragana:['all'],katakana:[]}});
  assert.equal(db.getTodayDailyVocabulary(),null);
  db.applyPracticePreferenceBundle(downloaded.preferences[0].practice);
  assert.deepEqual(db.getDailyLearningPreferences().scriptRows,scriptRows);
  db.saveDailyLearningPreferences({rows:['na']});
  assert.deepEqual(db.getDailyLearningPreferences().scriptRows,{hiragana:['na'],katakana:[]});
});
