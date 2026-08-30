export const DAILY_LEARNING_SOURCES = Object.freeze({
  DATABASE: 'database',
  LEVEL: 'level'
});

export const LEARNING_KANA_ROWS = Object.freeze([
  { id: 'a',  label: 'あ行', kana: 'あいうえお' },
  { id: 'ka', label: 'か行', kana: 'かきくけこがぎぐげご' },
  { id: 'sa', label: 'さ行', kana: 'さしすせそざじずぜぞ' },
  { id: 'ta', label: 'た行', kana: 'たちつてとだぢづでど' },
  { id: 'na', label: 'な行', kana: 'なにぬねの' },
  { id: 'ha', label: 'は行', kana: 'はひふへほばびぶべぼぱぴぷぺぽ' },
  { id: 'ma', label: 'ま行', kana: 'まみむめも' },
  { id: 'ya', label: 'や行', kana: 'やゆよ' },
  { id: 'ra', label: 'ら行', kana: 'らりるれろ' },
  { id: 'wa', label: 'わ行', kana: 'わをん' }
]);

const JLPT_LEVELS = new Set(['N1', 'N2', 'N3', 'N4', 'N5']);
const ROW_IDS = new Set(LEARNING_KANA_ROWS.map(row => row.id));

export function normalizeDailyLearningPreferences(value = {}) {
  const source = Object.values(DAILY_LEARNING_SOURCES).includes(value.source)
    ? value.source
    : DAILY_LEARNING_SOURCES.DATABASE;
  const level = JLPT_LEVELS.has(String(value.level || '').toUpperCase())
    ? String(value.level).toUpperCase()
    : 'N5';
  let rows = Array.isArray(value.rows)
    ? [...new Set(value.rows.filter(row => ROW_IDS.has(row)))]
    : ['all'];
  if (value.rows?.includes?.('all') || !rows.length) rows = ['all'];
  return { source, level, rows };
}

export function selectedLearningRows(rows = ['all']) {
  const selected = Array.isArray(rows) ? rows : ['all'];
  return selected.includes('all')
    ? [...LEARNING_KANA_ROWS]
    : LEARNING_KANA_ROWS.filter(row => selected.includes(row.id));
}

export function selectedLearningRowLabel(rows = ['all']) {
  const selected = selectedLearningRows(rows);
  return selected.length === LEARNING_KANA_ROWS.length
    ? '全部五十音行'
    : selected.map(row => row.label).join('、');
}

export function katakanaToHiragana(value) {
  return [...String(value || '')].map(character => {
    const code = character.charCodeAt(0);
    return code >= 0x30A1 && code <= 0x30F6 ? String.fromCharCode(code - 0x60) : character;
  }).join('');
}

export function readingMatchesRows(reading, rows = ['all']) {
  if (!reading) return false;
  const selected = selectedLearningRows(rows);
  if (selected.length === LEARNING_KANA_ROWS.length) return true;
  const first = [...katakanaToHiragana(reading).replace(/[\s・ー]/g, '')][0] || '';
  return selected.some(row => row.kana.includes(first));
}

const ROMAJI = Object.freeze({
  きゃ:'kya',きゅ:'kyu',きょ:'kyo',しゃ:'sha',しゅ:'shu',しょ:'sho',ちゃ:'cha',ちゅ:'chu',ちょ:'cho',
  にゃ:'nya',にゅ:'nyu',にょ:'nyo',ひゃ:'hya',ひゅ:'hyu',ひょ:'hyo',みゃ:'mya',みゅ:'myu',みょ:'myo',
  りゃ:'rya',りゅ:'ryu',りょ:'ryo',ぎゃ:'gya',ぎゅ:'gyu',ぎょ:'gyo',じゃ:'ja',じゅ:'ju',じょ:'jo',
  びゃ:'bya',びゅ:'byu',びょ:'byo',ぴゃ:'pya',ぴゅ:'pyu',ぴょ:'pyo',てぃ:'ti',でぃ:'di',ふぁ:'fa',ふぃ:'fi',ふぇ:'fe',ふぉ:'fo',
  あ:'a',い:'i',う:'u',え:'e',お:'o',か:'ka',き:'ki',く:'ku',け:'ke',こ:'ko',さ:'sa',し:'shi',す:'su',せ:'se',そ:'so',
  た:'ta',ち:'chi',つ:'tsu',て:'te',と:'to',な:'na',に:'ni',ぬ:'nu',ね:'ne',の:'no',は:'ha',ひ:'hi',ふ:'fu',へ:'he',ほ:'ho',
  ま:'ma',み:'mi',む:'mu',め:'me',も:'mo',や:'ya',ゆ:'yu',よ:'yo',ら:'ra',り:'ri',る:'ru',れ:'re',ろ:'ro',わ:'wa',を:'o',ん:'n',
  が:'ga',ぎ:'gi',ぐ:'gu',げ:'ge',ご:'go',ざ:'za',じ:'ji',ず:'zu',ぜ:'ze',ぞ:'zo',だ:'da',ぢ:'ji',づ:'zu',で:'de',ど:'do',
  ば:'ba',び:'bi',ぶ:'bu',べ:'be',ぼ:'bo',ぱ:'pa',ぴ:'pi',ぷ:'pu',ぺ:'pe',ぽ:'po',ゔ:'vu',
  ぁ:'a',ぃ:'i',ぅ:'u',ぇ:'e',ぉ:'o',ゃ:'ya',ゅ:'yu',ょ:'yo'
});

export function kanaToRomaji(value) {
  const kana = katakanaToHiragana(value).replace(/[\s・]/g, '');
  let result = '';
  let geminate = false;
  for (let index = 0; index < kana.length; index++) {
    const character = kana[index];
    if (character === 'っ') { geminate = true; continue; }
    if (character === 'ー') {
      const vowel = result.match(/[aeiou](?!.*[aeiou])/i)?.[0] || '';
      result += vowel;
      continue;
    }
    const pair = kana.slice(index, index + 2);
    let syllable = ROMAJI[pair];
    if (syllable) index++;
    else syllable = ROMAJI[character] || character;
    if (geminate && /^[bcdfghjklmnpqrstvwxyz]/i.test(syllable)) syllable = syllable[0] + syllable;
    geminate = false;
    result += syllable;
  }
  return result;
}

export function normalizeDailyVocabulary(items, { level = 'N5', rows = ['all'], limit = 1 } = {}) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const word = String(raw?.word || raw?.japanese || '').trim();
    const reading = katakanaToHiragana(String(raw?.reading || raw?.kana || '').trim());
    const meaning = String(raw?.meaning || raw?.chinese || '').trim();
    if (!word || !reading || !meaning || !readingMatchesRows(reading, rows)) continue;
    const key = `${word}|${reading}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      word,
      reading,
      romaji: String(raw?.romaji || '').trim().toLowerCase() || kanaToRomaji(reading),
      meaning,
      partOfSpeech: String(raw?.partOfSpeech || raw?.pos || '').trim() || '語彙',
      level: JLPT_LEVELS.has(String(raw?.level || '').toUpperCase()) ? String(raw.level).toUpperCase() : level
    });
    if (result.length >= limit) break;
  }
  return result;
}

export function parseDailyVocabularyResponse(raw, options = {}) {
  const text = String(raw || '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try { return normalizeDailyVocabulary(JSON.parse(text.slice(start, end + 1)), options); }
  catch { return []; }
}

export function dailyLearningSignature({ date, source, level, rows }) {
  const normalized = normalizeDailyLearningPreferences({ source, level, rows });
  return `${date}|${normalized.source}|${normalized.level}|${normalized.rows.slice().sort().join('+')}`;
}
