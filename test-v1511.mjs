import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudError, driveReadFetch, verifyDriveReceipt, sessionValue, setSessionValue } from './cloud-runtime.js';
import { collectionRows } from './collection-store.js';
import { SETTINGS_GROUPS, selectSettings } from './settings-vault.js';
test('read transport retries transient reads but never repeats an uncertain upload', async () => {
  let calls=0;
  const fetcher=async () => {calls++;return new Response('{}',{status:503,headers:{'retry-after':'0'}});};
  await driveReadFetch('https://example.test',{method:'POST'},fetcher);assert.equal(calls,1);
  calls=0;await driveReadFetch('https://example.test',{},fetcher);assert.equal(calls,3);
  calls=0;await driveReadFetch('https://example.test',{},async()=>{calls++;return new Response('{}',{status:403});});assert.equal(calls,1);
});
test('upload receipt validates Unicode byte length and rejects missing metadata', () => {
  assert.equal(verifyDriveReceipt({id:'file',size:'6'},'日本').id,'file');
  assert.throws(()=>verifyDriveReceipt({id:'file',size:'2'},'日本'),/核對/);
  assert.throws(()=>verifyDriveReceipt({},'日本'),/核對/);
});
test('HTTP failures distinguish authorization, permission, quota and availability',()=>{
  assert.equal(cloudError(401).message,'TOKEN_EXPIRED');
  assert.match(cloudError(403).message,/權限/);
  assert.match(cloudError(403,{error:{errors:[{reason:'storageQuotaExceeded'}]}}).message,/配額/);
  assert.match(cloudError(429).message,/過多/);
  assert.match(cloudError(503).message,/暫時/);
});
test('blocked session storage uses memory without leaking tokens to persistent storage',()=>{
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){throw new Error('blocked');}});
  setSessionValue('test-token','memory-only');assert.equal(sessionValue('test-token'),'memory-only');
  setSessionValue('test-token',null);assert.equal(sessionValue('test-token'),null);
  delete globalThis.sessionStorage;
});
test('array migration preserves order, duplicates, primitives and timestamps',()=>{
  const values=[{id:'a',createdAt:'2026-01-01'},{id:'a'},'あ','あ',null];
  const rows=collectionRows('words',JSON.stringify(values));
  assert.deepEqual(rows.map(row=>row.value),values);
  assert.equal(new Set(rows.map(row=>row.id)).size,values.length);
  assert.deepEqual(rows.map(row=>row.position),[0,1,2,3,4]);
});
test('settings groups cover every allowed field exactly once',()=>{
  const keys=Object.values(SETTINGS_GROUPS).flat();assert.equal(new Set(keys).size,keys.length);assert.equal(keys.length,15);
});
import { mergeLearningStates, mergeDeletedRecords, learningDelta } from './learning-sync.js';
test('deletion marks survive older device states without affecting different records',()=>{
  const a={id:'a',ts:1,character:'あ',script:'hiragana',row:'a',romaji:'a',answer:'a',correct:true};
  const b={...a,id:'b',ts:2};
  const merged=mergeLearningStates({kanaReadingHistory:[a,b]},{deletedRecords:['kanaReadingHistory:a']});
  assert.deepEqual(merged.kanaReadingHistory.map(x=>x.id),['b']);
  assert.deepEqual(mergeLearningStates(merged,{kanaReadingHistory:[a]}),merged);
  assert.deepEqual(mergeDeletedRecords(['unknown:a',null]),[]);
});
test('device contribution delta excludes unchanged remote records',()=>{
  const remote={studyDays:[{date:'2026-10-24'}],wordReadingHistory:[{id:'a',answer:'ai'}]};
  const merged={...remote,wordReadingHistory:[...remote.wordReadingHistory,{id:'b',answer:'kasa'}],deletedRecords:['kanaReadingHistory:old']};
  const delta=learningDelta(remote,merged);
  assert.equal(delta.wordReadingHistory.length,1);assert.equal(delta.wordReadingHistory[0].id,'b');
  assert.deepEqual(delta.studyDays,[]);assert.deepEqual(delta.deletedRecords,['kanaReadingHistory:old']);
});
