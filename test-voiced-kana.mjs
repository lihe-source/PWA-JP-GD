import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { KANA_ROWS, BASIC_KANA, getKana, getKanaSet, buildRepeatedKanaPractice, KANA_REPEAT_OPTIONS, kanaRowLabel, kanaRowGroupHeading } from './kana-data.js';
import { readingMatchesRows, normalizeDailyLearningPreferences, normalizeDailyVocabulary, dailyLearningSignature } from './daily-learning.js';
import { checkKanaReadingAnswer, KanaReadingProgressManager } from './kana-reading.js';
import { KanaProgressManager } from './japanese-learning.js';
import { makeWordReadingPool, normalizeWordReadingPreferences, WordReadingProgressManager } from './word-reading.js';
import { BackupSchema } from './backup-schema.js';
import { mergeLearningStates } from './learning-sync.js';
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const voicedRows = ['ga','za','da','ba','pa'];

test('each new row has five characters per script, complete original stroke paths and marks', () => {
  assert.equal(KANA_ROWS.length, 15);
  assert.equal(new Set(BASIC_KANA.map(k => k.id)).size, 142);
  for (const script of ['hiragana','katakana']) {
    const pool = getKanaSet({script, rows:voicedRows});
    assert.equal(pool.length, 25);
    for (const kana of pool) {
      const base = getKana(kana.character.normalize('NFD')[0]);
      assert.equal(kana.strokes.length, base.strokes.length + (kana.row === 'pa' ? 1 : 2), kana.character);
      assert.equal(kana.starts.length, kana.strokes.length);
      assert.ok(kana.starts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
      assert.ok(kana.strokes.every(path => /^[Mm]/.test(path)));
    }
  }
  assert.equal(getKana('か\u3099').character, 'が');
});

test('voiced row labels change with the selected script and retain separate groups', () => {
  assert.equal(kanaRowLabel('ga','katakana'), 'ガ行');
  assert.equal(kanaRowLabel('pa','both'), 'ぱ／パ行');
  assert.match(kanaRowGroupHeading('ga'), /濁音/);
  assert.match(kanaRowGroupHeading('pa'), /半濁音/);
  for (const attr of ['data-kana-row','data-reading-row','data-word-row','data-learning-row']) assert.ok(app.includes(attr));
  assert.equal((app.match(/kanaRowGroupHeading\(row.id\)/g) || []).length, 4);
});

test('selected voiced kana repeat continuously with exact counts and no adjacent duplicate', () => {
  const pool = getKanaSet({script:'both', rows:['ga','pa']});
  assert.equal(pool.length, 20);
  const queue = buildRepeatedKanaPractice(pool, 3, () => 0.37);
  assert.equal(queue.length, 60);
  for (const item of pool) assert.equal(queue.filter(q => q.id === item.id).length, 3);
  assert.ok(queue.every((item, i) => !i || item.id !== queue[i-1].id));
  assert.ok(getKanaSet({rows:['ka','ha']}).every(k => !voicedRows.includes(k.row)));
});

test('voiced readings support Hepburn and applicable input alternatives without accepting unrelated syllables', () => {
  for (const [char, answers] of [['じ',['ji','zi']],['ぢ',['ji','zi','di']],['づ',['zu','du']],['ヂ',['JI','di']],['パ',['pa']]]) {
    for (const answer of answers) assert.equal(checkKanaReadingAnswer(getKana(char),answer).correct,true);
    assert.equal(checkKanaReadingAnswer(getKana(char),'ka').correct,false);
  }
  assert.equal(checkKanaReadingAnswer(getKana('じ'),'di').correct,false);
  assert.equal(checkKanaReadingAnswer(getKana('ず'),'du').correct,false);
});

test('daily and word reading apply independent voiced rows to the entire reading', () => {
  for (const [reading, allowed, forbidden] of [
    ['がっこう',['ga','ka','a'],['ka','a']],
    ['ざっし',['za','sa'],['sa']],
    ['たべる',['ta','ba','ra'],['ta','ha','ra']],
    ['パンダ',['pa','wa','da'],['ha','wa','ta']],
    ['ぱぱ',['pa'],['ha']],
    ['ぎゃく',['ga','ya','ka'],['ka','ya']],
    ['ｶﾞｽ',['ga','sa'],['ka','sa']]
  ]) {
    assert.equal(readingMatchesRows(reading,allowed),true,reading);
    assert.equal(readingMatchesRows(reading,forbidden),false,reading);
  }
  const words = [{english:'母',reading:'はは'},{english:'パパ',reading:'ぱぱ'}];
  assert.deepEqual(makeWordReadingPool(words,['pa']).map(w=>w.word),['パパ']);
  assert.deepEqual(makeWordReadingPool(words,['ha']).map(w=>w.word),['母']);
  assert.equal(readingMatchesRows('ば',[]),false);
});

test('daily recommendation script pools do not borrow voiced rows and cache schema changes', () => {
  const options={scriptRows:{hiragana:['ga','ka','a'],katakana:['pa','wa','da']},limit:10};
  const words=[{word:'学校',reading:'がっこう',meaning:'學校'}, {word:'パンダ',reading:'パンダ',meaning:'熊貓'}, {word:'ガス',reading:'ガス',meaning:'瓦斯'}];
  assert.deepEqual(normalizeDailyVocabulary(words,options).map(w=>w.word),['学校','パンダ']);
  assert.match(dailyLearningSignature({date:'2026-11-07', ...options}),/^rows-v2\|/);
  assert.deepEqual(normalizeDailyLearningPreferences({rows:['ka']}).scriptRows.hiragana,['ka']);
  assert.deepEqual(normalizeWordReadingPreferences({rows:voicedRows}).rows,voicedRows);
});

test('all three practice preferences survive full backup and restore with voiced rows', () => {
  const data = new Map();
  const context = { AppStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)},
    KANA_ROWS,KANA_REPEAT_OPTIONS,normalizeWordReadingPreferences,normalizeDailyLearningPreferences,
    DAILY_LEARNING_SOURCES:{DATABASE:'database',LEVEL:'level'},STUDY_DAYS_CSV_HEADER:'date,type',
    JAPANESE_DEFAULTS:{jlptLevel:'N5'} };
  vm.runInNewContext(app.slice(app.indexOf('const DB = {'), app.indexOf('\nfunction getOrCreateJapaneseDeviceId()'))+'\nthis.db = DB;',context);
  const db=context.db;
  db.saveKanaPracticePreferences({script:'katakana',rows:['ga','pa'],repeat:3});
  db.saveKanaReadingPreferences({script:'both',rows:['da','za'],repeat:5});
  db.saveWordReadingPreferences({script:'hiragana',rows:['ba','pa'],count:10});
  db.saveDailyLearningPreferences({source:'level',scriptRows:{hiragana:['ga'],katakana:['pa']}});
  const bundle=JSON.parse(JSON.stringify(db.getPracticePreferenceBundle()));
  const backup=BackupSchema.attach({preferences:[{practice:bundle}]});
  data.clear();
  db.applyPracticePreferenceBundle(JSON.parse(JSON.stringify(backup)).preferences[0].practice);
  assert.deepEqual(JSON.parse(JSON.stringify(db.getPracticePreferenceBundle())),bundle);
});

test('voiced handwriting, kana and word records survive cloud merge without duplication', () => {
  const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
  const handwriting = new KanaProgressManager(storage), reading = new KanaReadingProgressManager(storage), words=new WordReadingProgressManager(storage);
  handwriting.recordAttempt(getKana('ぱ'),{score:85,strokeCount:4,expectedStrokeCount:4},'copy');
  reading.recordAttempt(getKana('ガ'),'ga',true);
  words.recordAttempt({word:'パパ',reading:'ぱぱ',display:'パパ',romaji:'papa',script:'katakana'},'baba',false);
  const state={handwritingHistory:handwriting.getHistory(),kanaReadingHistory:reading.getHistory(),wordReadingHistory:words.getHistory()};
  const merged=mergeLearningStates(state,JSON.parse(JSON.stringify(state)));
  assert.equal(merged.handwritingHistory.length,1);
  assert.equal(merged.handwritingHistory[0].character,'ぱ');
  assert.equal(merged.kanaReadingHistory[0].row,'ga');
  assert.equal(merged.wordReadingHistory[0].answer,'baba');
  assert.equal(reading.getSummary().correct,1);
});
