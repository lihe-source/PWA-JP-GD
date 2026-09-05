import { KANA_STROKES } from './kana-strokes.js?v=V1_2_14';

export const KANA_SCRIPTS = Object.freeze({
  HIRAGANA: 'hiragana',
  KATAKANA: 'katakana'
});

const ROWS = [
  { id: 'a',  label: 'あ行', romaji: ['a', 'i', 'u', 'e', 'o'], hiragana: 'あいうえお', katakana: 'アイウエオ' },
  { id: 'ka', label: 'か行', romaji: ['ka', 'ki', 'ku', 'ke', 'ko'], hiragana: 'かきくけこ', katakana: 'カキクケコ' },
  { id: 'sa', label: 'さ行', romaji: ['sa', 'shi', 'su', 'se', 'so'], hiragana: 'さしすせそ', katakana: 'サシスセソ' },
  { id: 'ta', label: 'た行', romaji: ['ta', 'chi', 'tsu', 'te', 'to'], hiragana: 'たちつてと', katakana: 'タチツテト' },
  { id: 'na', label: 'な行', romaji: ['na', 'ni', 'nu', 'ne', 'no'], hiragana: 'なにぬねの', katakana: 'ナニヌネノ' },
  { id: 'ha', label: 'は行', romaji: ['ha', 'hi', 'fu', 'he', 'ho'], hiragana: 'はひふへほ', katakana: 'ハヒフヘホ' },
  { id: 'ma', label: 'ま行', romaji: ['ma', 'mi', 'mu', 'me', 'mo'], hiragana: 'まみむめも', katakana: 'マミムメモ' },
  { id: 'ya', label: 'や行', romaji: ['ya', 'yu', 'yo'], hiragana: 'やゆよ', katakana: 'ヤユヨ' },
  { id: 'ra', label: 'ら行', romaji: ['ra', 'ri', 'ru', 're', 'ro'], hiragana: 'らりるれろ', katakana: 'ラリルレロ' },
  { id: 'wa', label: 'わ行・ん', romaji: ['wa', 'wo', 'n'], hiragana: 'わをん', katakana: 'ワヲン' }
];

function buildKana(script) {
  return ROWS.flatMap(row => {
    const characters = [...row[script]];
    return characters.map((character, index) => Object.freeze({
      id: `${script}:${character}`,
      character,
      script,
      scriptLabel: script === KANA_SCRIPTS.HIRAGANA ? '平假名' : '片假名',
      row: row.id,
      rowLabel: row.label,
      romaji: row.romaji[index],
      strokes: KANA_STROKES[character]?.paths || [],
      starts: KANA_STROKES[character]?.starts || []
    }));
  });
}

export const HIRAGANA = Object.freeze(buildKana(KANA_SCRIPTS.HIRAGANA));
export const KATAKANA = Object.freeze(buildKana(KANA_SCRIPTS.KATAKANA));
export const BASIC_KANA = Object.freeze([...HIRAGANA, ...KATAKANA]);
export const KANA_ROWS = Object.freeze(ROWS.map(({ id, label }) => Object.freeze({ id, label })));

const BY_ID = new Map(BASIC_KANA.map(item => [item.id, item]));
const BY_CHARACTER = new Map(BASIC_KANA.map(item => [item.character, item]));

export function getKana(value) {
  const key = String(value || '');
  return BY_ID.get(key) || BY_CHARACTER.get(key) || null;
}

export function getKanaSet({ script = 'hiragana', row = 'all', rows = null } = {}) {
  const source = script === 'both'
    ? BASIC_KANA
    : script === KANA_SCRIPTS.KATAKANA ? KATAKANA : HIRAGANA;
  const selectedRows = Array.isArray(rows)
    ? new Set(rows.filter(Boolean))
    : new Set([row]);
  if (!selectedRows.size || selectedRows.has('all')) return [...source];
  return source.filter(item => selectedRows.has(item.row));
}

export function shuffleKana(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export const KANA_REPEAT_OPTIONS = Object.freeze([1, 2, 3, 5, 10]);

function arrangeWithoutAdjacentDuplicates(items, random = Math.random) {
  const groups = new Map();
  items.forEach(item => {
    const key = String(item?.id || `${item?.script || ''}:${item?.character || ''}`);
    const group = groups.get(key) || { key, item, remaining: 0 };
    group.remaining += 1;
    groups.set(key, group);
  });

  const result = [];
  let previousKey = null;
  while (result.length < items.length) {
    const available = [...groups.values()].filter(group => group.remaining > 0 && group.key !== previousKey);
    const candidates = available.length
      ? available
      : [...groups.values()].filter(group => group.remaining > 0);
    if (!candidates.length) break;

    // 優先抽取剩餘數量最多的題目，並在同數量候選中隨機選擇。
    // 當至少有兩個不同假名且排法成立時，可避免把相同題目排在相鄰位置。
    const highestRemaining = Math.max(...candidates.map(group => group.remaining));
    const balanced = candidates.filter(group => group.remaining === highestRemaining);
    const randomIndex = Math.min(balanced.length - 1, Math.floor(Math.max(0, random()) * balanced.length));
    const selected = balanced[randomIndex];
    result.push(selected.item);
    selected.remaining -= 1;
    previousKey = selected.key;
  }
  return result;
}

export function buildRepeatedKanaPractice(items, repeat = 1, random = Math.random) {
  const repetitions = KANA_REPEAT_OPTIONS.includes(Number(repeat)) ? Number(repeat) : 1;
  const source = Array.isArray(items) ? items.filter(Boolean) : [];
  const repeated = [];
  for (let round = 0; round < repetitions; round++) repeated.push(...source);
  return arrangeWithoutAdjacentDuplicates(repeated, random);
}
