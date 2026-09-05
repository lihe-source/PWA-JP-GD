import { mergeStudyDays } from './study-streak.js?v=V1_2_13';
import { mergeHandwritingHistory } from './japanese-learning.js?v=V1_2_13';
import { mergeKanaReadingHistory } from './kana-reading.js?v=V1_2_13';

export function mergeLearningStates(...states) {
  return {
    studyDays: mergeStudyDays(...states.map(s => s?.studyDays || [])),
    handwritingHistory: mergeHandwritingHistory(...states.map(s => s?.handwritingHistory || [])),
    kanaReadingHistory: mergeKanaReadingHistory(...states.map(s => s?.kanaReadingHistory || []))
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
    await writeRemote(published);
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
