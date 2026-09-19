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

const SMALL_KANA_BASE = Object.freeze({
  'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お',
  'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'ゎ': 'わ', 'ゕ': 'か', 'ゖ': 'け'
});

// 促音與長音符是讀音修飾符，不獨立歸屬任何五十音行。其餘每一個
// 假名都必須落在使用者勾選的行內，避免只檢查第一字而讓「たべる」
// 在未選ら行時仍被接受。
const ROW_NEUTRAL_READING_MARKS = new Set(['っ', 'ー']);

export function readingMatchesRows(reading, rows = ['all']) {
  if (!reading) return false;
  const selected = selectedLearningRows(rows);
  const allowedRowIds = new Set(selected.map(row => row.id));
  const normalized = katakanaToHiragana(reading).normalize('NFC');
  let kanaCount = 0;
  for (const rawCharacter of normalized) {
    if (/[\s・]/u.test(rawCharacter) || ROW_NEUTRAL_READING_MARKS.has(rawCharacter)) continue;
    const character = SMALL_KANA_BASE[rawCharacter] || rawCharacter;
    const row = LEARNING_KANA_ROWS.find(candidate => candidate.kana.includes(character));
    // A vocabulary reading must be kana-only and every pronounced kana must
    // belong to an explicitly selected row.
    if (!row || !allowedRowIds.has(row.id)) return false;
    kanaCount++;
  }
  return kanaCount > 0;
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
  const parseCandidate = candidate => {
    try {
      const parsed = JSON.parse(candidate);
      const items = Array.isArray(parsed)
        ? parsed
        : parsed?.words || parsed?.vocabulary || parsed?.items || [];
      return normalizeDailyVocabulary(items, options);
    } catch {
      return [];
    }
  };
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    const parsed = parseCandidate(text.slice(arrayStart, arrayEnd + 1));
    if (parsed.length) return parsed;
  }
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    return parseCandidate(text.slice(objectStart, objectEnd + 1));
  }
  return [];
}

export const SENTENCE_VALIDATION_REASONS = Object.freeze({
  INVALID_FORMAT: 'INVALID_FORMAT',
  MISSING_JAPANESE: 'MISSING_JAPANESE',
  MISSING_READING: 'MISSING_READING',
  MISSING_TRANSLATION: 'MISSING_TRANSLATION',
  INVALID_JAPANESE: 'INVALID_JAPANESE',
  INVALID_READING: 'INVALID_READING',
  INVALID_TRANSLATION: 'INVALID_TRANSLATION',
  TARGET_NOT_USED: 'TARGET_NOT_USED',
  CONTENT_TOO_LONG: 'CONTENT_TOO_LONG'
});

const cleanSentenceField = value => String(value || '')
  .normalize('NFC')
  .replace(/[\u0000-\u001F\u007F]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Parse only the JSON contract used by newly generated daily sentences. */
export function parseGeneratedSentenceResponse(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      ja: cleanSentenceField(raw.ja ?? raw.japanese ?? raw.en),
      kana: cleanSentenceField(raw.kana ?? raw.reading),
      zh: cleanSentenceField(raw.zh ?? raw.translation)
    };
  }
  const text = String(raw || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parseGeneratedSentenceResponse(parsed);
  } catch {
    return null;
  }
}

function targetAppearsInSentence(sentence, rawTarget) {
  const target = cleanSentenceField(rawTarget).replace(/[\s・]/g, '');
  const compact = cleanSentenceField(sentence).replace(/[\s・]/g, '');
  if (!target) return true;
  if (compact.includes(target)) return true;

  // Permit common dictionary-form conjugation while keeping one-character
  // vocabulary strict enough to prevent an unrelated sentence from passing.
  if (target === 'する') return /(?:し|すれ|せ|さ|する)/u.test(compact);
  if (target === '来る' || target === 'くる') return /(?:来|き|くる|こ)/u.test(compact);
  const chars = [...target];
  const ending = chars.at(-1) || '';
  if (chars.length >= 3 && /[うくぐすつぬぶむるい]/u.test(ending)) {
    const stem = chars.slice(0, -1).join('');
    if ([...stem].length >= 2 && compact.includes(stem)) return true;
  }
  return false;
}

/**
 * Validate the semantic shape before a generated sentence can enter local or
 * Drive-backed learning history. This deliberately rejects the old two-line
 * fallback that accepted values such as `.)` and `Idea`.
 */
export function validateGeneratedSentence(candidate, target = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: SENTENCE_VALIDATION_REASONS.INVALID_FORMAT };
  }
  const value = {
    ja: cleanSentenceField(candidate.ja ?? candidate.en),
    kana: cleanSentenceField(candidate.kana ?? candidate.reading),
    zh: cleanSentenceField(candidate.zh)
  };
  if (!value.ja) return { ok: false, reason: SENTENCE_VALIDATION_REASONS.MISSING_JAPANESE };
  if (!value.kana) return { ok: false, reason: SENTENCE_VALIDATION_REASONS.MISSING_READING };
  if (!value.zh) return { ok: false, reason: SENTENCE_VALIDATION_REASONS.MISSING_TRANSLATION };
  if ([...value.ja].length > 120 || [...value.kana].length > 180 || [...value.zh].length > 120) {
    return { ok: false, reason: SENTENCE_VALIDATION_REASONS.CONTENT_TOO_LONG };
  }

  const japaneseCharacters = value.ja.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}々〆ヵヶ]/gu) || [];
  if (japaneseCharacters.length < 2) {
    return { ok: false, reason: SENTENCE_VALIDATION_REASONS.INVALID_JAPANESE };
  }
  const kanaCharacters = value.kana.match(/[\p{Script=Hiragana}\p{Script=Katakana}ー]/gu) || [];
  const readingRemainder = value.kana.replace(/[\p{Script=Hiragana}\p{Script=Katakana}ー\s。、！？!?・（）()「」『』〜～0-9０-９]/gu, '');
  if (kanaCharacters.length < 2 || readingRemainder) {
    return { ok: false, reason: SENTENCE_VALIDATION_REASONS.INVALID_READING };
  }
  if (!/\p{Script=Han}/u.test(value.zh) || /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value.zh)) {
    return { ok: false, reason: SENTENCE_VALIDATION_REASONS.INVALID_TRANSLATION };
  }
  if (!targetAppearsInSentence(value.ja, target.word ?? target.wordEn ?? target.english)) {
    return { ok: false, reason: SENTENCE_VALIDATION_REASONS.TARGET_NOT_USED };
  }
  return {
    ok: true,
    reason: '',
    value: { en: value.ja, reading: value.kana, zh: value.zh }
  };
}

export function validateStoredGeneratedSentence(entry) {
  return validateGeneratedSentence({ en: entry?.en, reading: entry?.reading, zh: entry?.zh }, {
    word: entry?.wordEn
  });
}

export function dailyLearningSignature({ date, source, level, rows }) {
  const normalized = normalizeDailyLearningPreferences({ source, level, rows });
  return `${date}|${normalized.source}|${normalized.level}|${normalized.rows.slice().sort().join('+')}`;
}
