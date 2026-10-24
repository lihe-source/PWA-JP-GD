import { mergeStudyDays } from './study-streak.js?v=V1_5_11';
import { mergeHandwritingHistory } from './japanese-learning.js?v=V1_5_11';
import { mergeKanaReadingHistory } from './kana-reading.js?v=V1_5_11';
import { mergeWordReadingHistory } from './word-reading.js?v=V1_5_11';

export function mergeDeletedRecords(...lists) {
  const ids = new Set();
  for (const list of lists) for (const item of Array.isArray(list) ? list : []) {
    if (typeof item === 'string' && /^(handwritingHistory|kanaReadingHistory|wordReadingHistory):.{1,512}$/.test(item)) ids.add(item);
  }
  if (ids.size > 100000) throw new Error('同步刪除紀錄超過上限，已停止同步並保留本機資料。');
  return [...ids].sort();
}
export function mergeLearningStates(...states) {
  const deletedRecords = mergeDeletedRecords(...states.map(s => s?.deletedRecords));
  const deleted = new Set(deletedRecords);
  const result = {
    studyDays: mergeStudyDays(...states.map(s => s?.studyDays || [])),
    handwritingHistory: mergeHandwritingHistory(...states.map(s => s?.handwritingHistory || [])),
    kanaReadingHistory: mergeKanaReadingHistory(...states.map(s => s?.kanaReadingHistory || [])),
    wordReadingHistory: mergeWordReadingHistory(...states.map(s => s?.wordReadingHistory || []))
  };
  for (const collection of ['handwritingHistory','kanaReadingHistory','wordReadingHistory']) result[collection] = result[collection].filter(record => !deleted.has(collection+':'+record.id));
  if (deletedRecords.length) result.deletedRecords = deletedRecords;
  return result;
}

export const learningStateSignature = state => JSON.stringify(mergeLearningStates(state));

// readLocal/writeLocal are synchronous: no await may separate the final local
// read from the merge/commit. Network replies must never replace newer answers.
export async function syncLearningState({ readLocal, writeLocal, readRemote, writeRemote,
  flush, markPending, markSynced, ready = async () => {}, maxPasses = 3 }) {
  markPending();
  let published;
  for (let pass = 0; pass < maxPasses; pass++) {
    await ready();
    const remote = await readRemote(); // any unreadable source aborts the write
    await ready();
    published = mergeLearningStates(remote, readLocal());
    // If every local record is already represented by the remote union, avoid
    // uploading an identical state again. This removes most no-op Drive writes.
    if (learningStateSignature(remote) !== learningStateSignature(published)) {
      await writeRemote(published, learningDelta(remote, published));
    }
    await ready();
    writeLocal(mergeLearningStates(published, readLocal()));
    await flush();
    if (learningStateSignature(readLocal()) === learningStateSignature(published)) {
      const syncedAt = new Date().toISOString();
      markSynced(syncedAt);
      await flush();
      const latest = readLocal();
      const pending = learningStateSignature(latest) !== learningStateSignature(published);
      if (pending) markPending();
      return { ...latest, syncedAt, pending };
    }
  }
  markPending();
  await flush();
  return { ...readLocal(), syncedAt: '', pending: true };
}

export function escapeDriveQuery(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Device files retain only this device's contributions, not a fresh copy of the complete remote union.
export function learningDelta(remote, merged) {
  const result = {};
  for (const key of ['studyDays','handwritingHistory','kanaReadingHistory','wordReadingHistory']) {
    const identity = item => String(key === 'studyDays' ? item.date : item.id);
    const previous = new Map((remote[key] || []).map(item => [identity(item), JSON.stringify(item)]));
    result[key] = (merged[key] || []).filter(item => previous.get(identity(item)) !== JSON.stringify(item));
  }
  const old = new Set(remote.deletedRecords || []);
  result.deletedRecords = (merged.deletedRecords || []).filter(item => !old.has(item));
  return result;
}
