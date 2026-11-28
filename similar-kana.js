import { getKana, buildRepeatedKanaPractice } from './kana-data.js?v=V1_6_3';

export const SIMILAR_KANA_GROUPS = Object.freeze([
  'あお', 'こニ', 'せサ', 'さこ', 'ぬめ', 'ねれわ', 'るろ', 'ウワ', 'タク', 'シッンツ', 'ソン'
]);
// Small tsu has no independent syllable. xtsu/ltsu are keyboard input codes,
// used here to identify the symbol, never presented as its pronunciation.
export const SMALL_TSU = Object.freeze({id:'katakana:ッ',character:'ッ',script:'katakana',
  scriptLabel:'片假名',row:'small-tsu',romaji:'xtsu',kind:'sokuon'});
export function similarKanaPool() {
  return [...new Set(SIMILAR_KANA_GROUPS.join(''))].map(c => c === 'ッ' ? SMALL_TSU : getKana(c));
}
export function similarKanaQuestions(repeat = 1, random = Math.random) {
  return buildRepeatedKanaPractice(similarKanaPool(), repeat, random);
}
