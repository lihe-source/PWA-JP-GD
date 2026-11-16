import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {SIMILAR_KANA_GROUPS,SMALL_TSU,similarKanaPool,similarKanaQuestions} from './similar-kana.js';
import {getKana} from './kana-data.js';
import {checkKanaReadingAnswer,KanaReadingProgressManager} from './kana-reading.js';
import {readingProgress,readingFeedback,firstAttemptSummary} from './ui-runtime.js';
import {BackupSchema} from './backup-schema.js';
import {mergeLearningStates} from './learning-sync.js';
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
test('all eleven requested groups preserve script and small tsu and deduplicate overlapping symbols',()=>{
 assert.deepEqual([...SIMILAR_KANA_GROUPS],['あお','こニ','せサ','さこ','ぬめ','ねれわ','るろ','ウワ','タク','シッンツ','ソン']);
 const pool=similarKanaPool();assert(pool.every(Boolean));
 assert.equal(pool.length,new Set(SIMILAR_KANA_GROUPS.join('')).size);
 assert.equal(pool.filter(k=>k.character==='こ').length,1);
 assert.equal(pool.filter(k=>k.character==='ン').length,1);
 assert.equal(pool.find(k=>k.character==='ニ').script,'katakana');
 assert.equal(pool.find(k=>k.character==='こ').script,'hiragana');
});
test('each repeat tests every unique glyph with randomized order and no adjacent duplicate',()=>{
 const pool=similarKanaPool();
 for(let seed=1;seed<25;seed++){
  let x=seed;const random=()=>((x=(x*1664525+1013904223)>>>0)/4294967296);
  const q=similarKanaQuestions(3,random);assert.equal(q.length,pool.length*3);
  for(const item of pool)assert.equal(q.filter(k=>k.id===item.id).length,3);
  assert(q.every((k,i)=>!i||k.id!==q[i-1].id));
 }
});
test('small tsu uses input code and cannot be confused with ordinary tsu',()=>{
 for(const a of ['xtsu','ltsu','ＸＴＳＵ'])assert(checkKanaReadingAnswer(SMALL_TSU,a).correct);
 assert(!checkKanaReadingAnswer(SMALL_TSU,'tsu').correct);
 assert(!checkKanaReadingAnswer(getKana('ツ'),'xtsu').correct);
 assert(checkKanaReadingAnswer(getKana('ツ'),'tsu').correct);
 for(const [ch,correct,wrong] of [['シ','shi','tsu'],['ソ','so','n'],['ン','n','so'],['ニ','ni','ko']]){
  assert(checkKanaReadingAnswer(getKana(ch),correct).correct);
  assert(!checkKanaReadingAnswer(getKana(ch),wrong).correct);
 }
});
function session(){
 const elements=new Map();const timers=[],records=[],sounds=[];
 for(const id of ['answer','submit','feedback','progress-text','progress-fill','character','listen']) elements.set('kana-reading-'+id,{value:'',style:{},classList:{toggle(){}},setAttribute(){},isConnected:true,focus(){},setSelectionRange(){},addEventListener(){}});
 const ctx={Views:{},readingProgress,readingFeedback,firstAttemptSummary,checkKanaReadingAnswer,escapeHTML:String,showToast(){},document:{getElementById:id=>elements.get(id)},requestAnimationFrame(){},KanaReadingProgress:{recordAttempt:(...a)=>records.push(a)},Sound:{playCorrect:()=>sounds.push('correct'),playWrong:()=>sounds.push('wrong'),playResult:()=>sounds.push('end')},setTimeout:fn=>(timers.push(fn),timers.length),clearTimeout(){},Router:{quizActive:true},recordStudyActivity(){},STUDY_ACTIVITY_TYPES:{KANA_READING:'kana'},todayStr:()=> '2026-11-16',GDrive:{scheduleStudyStreakSync(){}},refreshStudyStreakUI(){},resumeAppUpdateWhenSafe(){},TTS:{stop(){}}};
 vm.runInNewContext(source.slice(source.indexOf('Views.kanaReadingPractice ='),source.indexOf("// A word's entire kana reading")),ctx);
 const view=ctx.Views.similarKanaPractice;
 view.state.items=[getKana('シ'),SMALL_TSU,getKana('ツ')];view.state.initialTotal=3;
 const container={innerHTML:''};
 return {view,ctx,records,sounds,elements,container,timers,answer(a){elements.get('kana-reading-answer').value=a;view._submitCurrentAnswer(container);}};
}
test('similar mode reuses focused input, appends wrong glyph, records answers and displays full colored summary',()=>{
 const s=session(),input=s.elements.get('kana-reading-answer');
 s.answer('tsu');assert.equal(s.view.state.items.length,4);
 assert.equal(s.view.state.items[3].character,'シ');
 assert.equal(s.elements.get('kana-reading-listen').hidden,true);
 s.answer('xtsu');assert.equal(s.elements.get('kana-reading-listen').hidden,false);
 s.answer('tsu');s.answer('shi');s.timers.shift()();s.timers.shift()();
 assert.equal(s.elements.get('kana-reading-answer'),input);
 assert.equal(s.records.length,4);assert.deepEqual(s.sounds,['wrong','correct','correct','correct','end']);
 assert.match(s.container.innerHTML,/相似字形讀音完成/);
 assert.equal((s.container.innerHTML.match(/similar-result-row /g)||[]).length,4);
 assert.match(s.container.innerHTML,/is-wrong/);assert.match(s.container.innerHTML,/is-correct/);
 assert.equal(s.ctx.Router.quizActive,false);
});
test('leaving similar mode cancels its own completion timer and releases practice state',()=>{
 const s=session();let cleared=false;s.ctx.clearTimeout=()=>{cleared=true};
 s.view._advanceTimer=99;s.view.cleanup();assert(cleared);assert.equal(s.view._advanceTimer,null);assert.equal(s.ctx.Router.quizActive,false);
 assert.notEqual(s.view.state,s.ctx.Views.kanaReadingPractice.state);
});
test('small tsu history survives backup and cloud merge without duplicate records',()=>{
 const map=new Map(), storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};
 const manager=new KanaReadingProgressManager(storage);manager.recordAttempt(SMALL_TSU,'xtsu',true);
 const state={kanaReadingHistory:manager.getHistory()};
 const backup=JSON.parse(JSON.stringify(BackupSchema.attach(state)));
 assert.equal(backup.kanaReadingHistory[0].character,'ッ');
 const merged=mergeLearningStates(state,backup);assert.equal(merged.kanaReadingHistory.length,1);
 assert.equal(merged.kanaReadingHistory[0].romaji,'xtsu');
 assert.equal(manager.getSummary().correct,1);
});
