import { kanaToRomaji, readingMatchesRows, katakanaToHiragana } from './daily-learning.js?v=V1_5_2';
import { toKatakana } from './japanese-learning.js?v=V1_5_2';
import { normalizeRomajiAnswer } from './kana-reading.js?v=V1_5_2';
import { KANA_ROWS } from './kana-data.js?v=V1_5_2';

const ROW_IDS = new Set(KANA_ROWS.map(row => row.id));
export const WORD_READING_COUNTS = Object.freeze([5, 10, 15, 20, 25, 30]);
export const WORD_READING_CSV_HEADER = 'ID,日期,時間戳,假名類型,日文單詞,假名讀音,畫面題目,正確拼音,使用者答案,是否正確';

const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
function parseCsvLine(line) {
  const cells = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (character === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { cells.push(value); value = ''; }
    else value += character;
  }
  cells.push(value);
  return cells;
}

export function normalizeWordReadingPreferences(value = {}) {
  const rows = Array.isArray(value.rows) ? [...new Set(value.rows.filter(row => ROW_IDS.has(row)))] : [];
  return {
    script: ['hiragana', 'katakana', 'both'].includes(value.script) ? value.script : 'hiragana',
    rows: value.rows?.includes?.('all') || !rows.length ? ['all'] : rows,
    count: WORD_READING_COUNTS.includes(Number(value.count)) ? Number(value.count) : 10
  };
}

export function makeWordReadingPool(words = [], rows = ['all']) {
  const seen = new Set();
  return (Array.isArray(words) ? words : []).flatMap(word => {
    const surface = String(word?.english || word?.word || word?.japanese || '').trim();
    const reading = katakanaToHiragana(String(word?.reading || word?.phonetic || '').trim()).normalize('NFC');
    if (!surface || !readingMatchesRows(reading, rows)) return [];
    const romaji = kanaToRomaji(reading);
    if (!/^[a-z]+$/.test(romaji)) return [];
    // The learner only sees the kana reading, so homonyms with the same prompt
    // are one exercise even if their written words differ.
    const key = reading;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: String(word.id || key), word: surface, reading, romaji, meaning: String(word.chinese || word.meaning || '') }];
  });
}

function shuffle(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(Math.max(0, random()) * (i + 1)));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function buildWordReadingQuestions(pool, preferences = {}, random = Math.random) {
  const { script, count } = normalizeWordReadingPreferences(preferences);
  if (!pool?.length) return [];
  const questions = [];
  while (questions.length < count) {
    const round = shuffle(pool, random);
    if (round.length > 1 && questions.length && questions.at(-1).id === round[0].id) {
      const swapIndex = round.findIndex(item => item.id !== questions.at(-1).id);
      [round[0], round[swapIndex]] = [round[swapIndex], round[0]];
    }
    for (const word of round) {
      if (questions.length >= count) break;
      const questionScript = script === 'both' ? (random() < 0.5 ? 'hiragana' : 'katakana') : script;
      questions.push({ ...word, script: questionScript, display: questionScript === 'katakana' ? toKatakana(word.reading) : word.reading });
    }
  }
  return questions;
}

export function checkWordReadingAnswer(question, answer) {
  const normalized = normalizeRomajiAnswer(answer);
  const expected = normalizeRomajiAnswer(question?.romaji);
  const variants = new Set([expected]);
  // Accept the common Kunrei spellings also accepted in the single-kana mode.
  variants.add(expected.replaceAll('shi', 'si').replaceAll('chi', 'ti').replaceAll('tsu', 'tu').replaceAll('fu', 'hu').replaceAll('ji', 'zi'));
  return { normalized, expected, correct: !!normalized && variants.has(normalized) };
}

export function mergeWordReadingHistory(...sources) {
  const records = new Map();
  sources.flat().forEach((item, index) => {
    if (!item || typeof item !== 'object' || !item.word || !item.reading) return;
    const ts = Number(item.ts) || 0;
    const id = String(item.id || `legacy-word-reading:${ts}:${index}:${item.word}`);
    const entry = {
      id, ts, date: String(item.date || ''), word: String(item.word), reading: String(item.reading),
      display: String(item.display || item.reading), romaji: normalizeRomajiAnswer(item.romaji),
      answer: normalizeRomajiAnswer(item.answer), script: item.script === 'katakana' ? 'katakana' : 'hiragana',
      correct: item.correct === true
    };
    if (!records.has(id)) records.set(id, entry);
  });
  return [...records.values()].sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
}

export class WordReadingProgressManager {
  constructor(storage) { this.storage = storage; this.historyKey = 'wordReadingHistory'; }
  getHistory() {
    if (typeof this.storage.getRecordCollection === 'function') return mergeWordReadingHistory(this.storage.getRecordCollection(this.historyKey));
    try { return mergeWordReadingHistory(JSON.parse(this.storage.getItem(this.historyKey) || '[]')); } catch { return []; }
  }
  saveHistory(history) {
    const normalized = mergeWordReadingHistory(history);
    if (typeof this.storage.replaceRecordCollection === 'function') this.storage.replaceRecordCollection(this.historyKey, normalized);
    else this.storage.setItem(this.historyKey, JSON.stringify(normalized));
  }
  recordAttempt(question, answer, correct) {
    const ts = Date.now();
    const entry = { id: `${ts}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`,
      ts, date: new Date(ts).toLocaleDateString('en-CA'), word: question.word, reading: question.reading,
      display: question.display, romaji: question.romaji, answer, script: question.script, correct: correct === true };
    if (typeof this.storage.appendRecord === 'function') this.storage.appendRecord(this.historyKey, entry);
    else this.saveHistory([entry, ...this.getHistory()]);
    return entry;
  }
  mergeRemote(records) { const merged = mergeWordReadingHistory(this.getHistory(), records); this.saveHistory(merged); return merged; }
  getSummary() {
    const history = this.getHistory();
    const correct = history.filter(item => item.correct).length;
    return { attempts: history.length, correct, wrong: history.length - correct,
      accuracy: history.length ? Math.round(correct / history.length * 100) : 0,
      practiced: new Set(history.map(item => `${item.word}\u0000${item.reading}`)).size };
  }
  exportCSV() {
    const rows = this.getHistory().map(item => [item.id, item.date, item.ts,
      item.script === 'katakana' ? '片假名' : '平假名', item.word, item.reading,
      item.display, item.romaji, item.answer, item.correct ? '正確' : '錯誤'
    ].map(csvCell).join(','));
    return [WORD_READING_CSV_HEADER, ...rows].join('\n');
  }
  importCSV(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean);
    if (lines[0]?.replace(/"/g, '').trim() !== WORD_READING_CSV_HEADER) throw new Error('FORMAT_MISMATCH_WORD_READING');
    const before = this.getHistory();
    const imported = lines.slice(1).map((line, index) => {
      const cells = parseCsvLine(line);
      const ts = Number(cells[2]) || Date.now() + index;
      return { id: cells[0] || `import:word-reading:${ts}:${index}`, date: cells[1] || '', ts,
        script: cells[3] === '片假名' ? 'katakana' : 'hiragana',
        word: cells[4] || '', reading: cells[5] || '', display: cells[6] || '',
        romaji: cells[7] || '', answer: cells[8] || '', correct: cells[9] === '正確' || cells[9] === 'true' };
    });
    const merged = mergeWordReadingHistory(before, imported);
    this.saveHistory(merged);
    return { added: Math.max(0, merged.length - before.length), total: merged.length };
  }
}
