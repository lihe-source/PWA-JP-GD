import { mergeStudyDays } from './study-streak.js?v=V1_5_3';
import { mergeHandwritingHistory } from './japanese-learning.js?v=V1_5_3';
import { mergeKanaReadingHistory } from './kana-reading.js?v=V1_5_3';
import { mergeWordReadingHistory } from './word-reading.js?v=V1_5_3';

export function mergeLearningStates(...states) {
  return {
    studyDays: mergeStudyDays(...states.map(s => s?.studyDays || [])),
    handwritingHistory: mergeHandwritingHistory(...states.map(s => s?.handwritingHistory || [])),
    kanaReadingHistory: mergeKanaReadingHistory(...states.map(s => s?.kanaReadingHistory || [])),
    wordReadingHistory: mergeWordReadingHistory(...states.map(s => s?.wordReadingHistory || []))
  };
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
      await writeRemote(published);
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
