import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {StorageBridge} from './storage.js';
import {DraftManager} from './draft-manager.js';
import {TaskManager} from './task-manager.js';
import {VersionManager} from './version-manager.js';

test('two failed queued writes restore the last committed value', async () => {
  const storage=new StorageBridge();
  storage.db={};storage.fallback=false;
  storage.cache.set('vocabWords','["committed"]');
  storage.committed.set('vocabWords','["committed"]');
  storage._putRecords=async()=>{throw new Error('STORAGE_WRITE_FAILED');};
  storage.setItem('vocabWords','["pending-a"]');
  storage.setItem('vocabWords','["pending-b"]');
  await assert.rejects(storage.flush(),/STORAGE_WRITE_FAILED/);
  assert.equal(storage.getItem('vocabWords'),'["committed"]');
});

test('draft flush saves pending text after its textarea is gone', () => {
  const values=new Map();
  const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const timers=new Map();let id=0;
  const drafts=new DraftManager({storage,setTimer:fn=>{timers.set(++id,fn);return id;},clearTimer:key=>timers.delete(key)});
  drafts.save('essay','Text that must survive navigation');
  drafts.flush();
  assert.equal(JSON.parse(values.get('vocabularyDrafts')).essay,'Text that must survive navigation');
});

test('exclusive tasks block different restore and sync labels', () => {
  const tasks=new TaskManager();
  const finish=tasks.start('drive-download',{exclusive:true});
  assert.throws(()=>tasks.start('backup-restore',{exclusive:true}),/TASK_ALREADY_RUNNING/);
  finish();
  const finishNext=tasks.start('backup-restore',{exclusive:true});
  finishNext();
});

test('update activation stops when storage flush fails', async () => {
  let posted=false;
  const manager=new VersionManager({currentVersion:'V7_4_2',displayVersion:'V7.4.2',storage:{flush:async()=>{throw new Error('write failed');}},canActivate:()=>true});
  const activated=await manager.activateWaitingIfSafe({postMessage:()=>{posted=true;}});
  assert.equal(activated,false);assert.equal(posted,false);
});

test('word list uses escaped fields and bounded batches', async () => {
  const app=await readFile(new URL('./app.js',import.meta.url),'utf8');
  assert.match(app,/pageSize:\s*80/);
  assert.match(app,/allWords\.slice\(0,this\.visibleCount\)/);
  assert.match(app,/escapeHTML\(w\.english\)/);
  assert.match(app,/escapeAttr\(w\.id\)/);
});
