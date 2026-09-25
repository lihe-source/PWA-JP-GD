import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageBridge } from './storage.js';

function memoryLocalStorage() {
  const values = new Map();
  globalThis.localStorage = {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  return values;
}

test('atomic updates reject a second transaction before the first await', async () => {
  memoryLocalStorage();
  const storage = new StorageBridge();
  storage.db = { transaction() {} };
  let release;
  storage._commitAtomicStage = () => new Promise(resolve => { release = resolve; });
  const first = storage.atomicUpdate(() => storage.setItem('example', 'first'));
  await assert.rejects(storage.atomicUpdate(() => storage.setItem('example', 'second')), /ATOMIC_UPDATE_IN_PROGRESS/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(storage.getStatus().saveState, 'saving');
  release();
  await first;
  assert.equal(storage.getItem('example'), 'first');
});

test('a normal write during atomic commit stays pending and persists after the commit', async () => {
  memoryLocalStorage();
  const storage = new StorageBridge();
  const disk = new Map();
  storage.db = { transaction() {} };
  let finishCommit;
  storage._commitAtomicStage = stage => new Promise(resolve => {
    const committed = new Map(stage.kv);
    finishCommit = () => { committed.forEach((value, key) => disk.set(key, value)); resolve(); };
  });
  storage._putRecord = async (key, value) => { disk.set(key, value); };
  const transaction = storage.atomicUpdate(() => storage.setItem('first', 'one'));
  await new Promise(resolve => setImmediate(resolve));
  storage.setItem('duringCommit', 'two');
  let flushed = false;
  const flush = storage.flush().then(() => { flushed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushed, false);
  assert.equal(storage.getStatus().saveState, 'saving');
  finishCommit();
  await transaction;
  await flush;
  assert.deepEqual([...disk.entries()].sort(), [['duringCommit', 'two'], ['first', 'one']]);
  assert.equal(storage.getStatus().saveState, 'saved');
});

test('success of a second record does not hide failure of the first', async () => {
  memoryLocalStorage();
  const storage = new StorageBridge();
  storage.db = { transaction() {}, objectStoreNames: { contains: () => true } };
  const disk = new Map();
  let failFirst = true;
  storage._putCollectionRow = async (_collection, record) => {
    if (record.id === 'A' && failFirst) throw new Error('disk full');
    disk.set(record.id, record);
  };
  storage.appendRecord('handwritingHistory', { id: 'A', ts: 1 });
  storage.appendRecord('handwritingHistory', { id: 'B', ts: 2 });
  await assert.rejects(storage.flush(), error => error.failedKeys.includes('records:handwritingHistory:A'));
  assert.equal(disk.has('A'), false);
  assert.equal(disk.has('B'), true);
  failFirst = false;
  await storage.retryFailedWrites();
  assert.equal(disk.has('A'), true);
  assert.equal(storage.getStatus().saveState, 'saved');
});

test('failed legacy collection migration retains its source and reports read only', async () => {
  memoryLocalStorage();
  const storage = new StorageBridge();
  let deleted = false;
  storage._open = async () => ({ close() {} });
  storage._getAllKvRecords = async () => [{ key: 'handwritingHistory', value: JSON.stringify([{ id: 'old', ts: 1 }]) }];
  storage._getAllCollectionRows = async () => [];
  storage._replaceCollectionRows = async () => { throw new Error('quota'); };
  storage._deleteRecord = async () => { deleted = true; };
  await storage.init();
  assert.equal(deleted, false);
  assert.equal(storage.getStatus().readOnly, true);
  assert.equal(storage.getStatus().saveState, 'error');
  assert.equal(JSON.parse(storage.getItem('handwritingHistory'))[0].id, 'old');
});
