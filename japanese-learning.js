export const JAPANESE_DEFAULTS = Object.freeze({
  oauthClientId: '171837667604-mtcf91qudt6ff79u382v37rjqpp7l51q.apps.googleusercontent.com',
  driveFolderId: '1kAtVOK2qqhK0BY9vmp8Sm4NhQaWMJYeb',
  jlptLevel: 'N5'
});

export function resolveWritingLayout({
  preference = 'auto',
  viewportWidth = 0,
  screenWidth = 0,
  screenHeight = 0,
  touch = false
} = {}) {
  if (preference === 'phone' || preference === 'tablet') return preference;
  const width = Math.max(0, Number(viewportWidth) || 0);
  const knownScreenSides = [Number(screenWidth), Number(screenHeight)].filter(value => Number.isFinite(value) && value > 0);
  const shortSide = knownScreenSides.length ? Math.min(...knownScreenSides) : width;
  return (touch ? shortSide >= 700 : width >= 700) ? 'tablet' : 'phone';
}

export function toHiragana(value) {
  return String(value || '').replace(/[ァ-ヶ]/g, character =>
    String.fromCodePoint(character.codePointAt(0) - 0x60));
}

export function toKatakana(value) {
  return String(value || '').replace(/[ぁ-ゖ]/g, character =>
    String.fromCodePoint(character.codePointAt(0) + 0x60));
}

export function normalizeJapaneseAnswer(value, { kanaOnly = false } = {}) {
  let normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[\s　・、。,.!?！？「」『』（）()\-]/g, '')
    .trim();
  if (kanaOnly) normalized = toHiragana(normalized);
  return normalized;
}

export function normalizeJapaneseWord(word = {}) {
  const surface = String(word.english || word.japanese || word.surface || '').trim();
  const reading = String(word.phonetic || word.reading || word.kana || '').trim();
  return {
    ...word,
    english: surface,
    japanese: surface,
    phonetic: reading,
    reading,
    romaji: String(word.romaji || '').trim(),
    chinese: String(word.chinese || word.meaningZh || '').trim(),
    partOfSpeech: String(word.partOfSpeech || '').trim(),
    jlpt: String(word.jlpt || 'N5').toUpperCase()
  };
}

export function mergeHandwritingHistory(...collections) {
  const byId = new Map();
  collections.flat().filter(Boolean).forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const id = String(entry.id || `${entry.script || ''}:${entry.character || ''}:${entry.ts || ''}`);
    if (!id) return;
    const normalized = {
      id,
      character: String(entry.character || ''),
      script: entry.script === 'katakana' ? 'katakana' : 'hiragana',
      romaji: String(entry.romaji || ''),
      mode: ['trace', 'copy', 'recall'].includes(entry.mode) ? entry.mode : 'trace',
      score: Math.max(0, Math.min(100, Math.round(Number(entry.score) || 0))),
      strokeCount: Math.max(0, Number(entry.strokeCount) || 0),
      expectedStrokeCount: Math.max(0, Number(entry.expectedStrokeCount) || 0),
      ts: Number(entry.ts) || Date.now(),
      date: String(entry.date || '')
    };
    const existing = byId.get(id);
    if (!existing || normalized.ts >= existing.ts) byId.set(id, normalized);
  });
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, 2500);
}

export function buildKanaProgress(history = []) {
  const progress = new Map();
  mergeHandwritingHistory(history).forEach(entry => {
    const key = `${entry.script}:${entry.character}`;
    const current = progress.get(key) || {
      key,
      character: entry.character,
      script: entry.script,
      romaji: entry.romaji,
      attempts: 0,
      totalScore: 0,
      bestScore: 0,
      lastScore: 0,
      lastPracticedAt: 0,
      mastered: false
    };
    current.attempts += 1;
    current.totalScore += entry.score;
    current.bestScore = Math.max(current.bestScore, entry.score);
    if (entry.ts >= current.lastPracticedAt) {
      current.lastPracticedAt = entry.ts;
      current.lastScore = entry.score;
    }
    current.mastered = current.bestScore >= 80;
    progress.set(key, current);
  });
  return [...progress.values()].map(item => ({
    ...item,
    averageScore: item.attempts ? Math.round(item.totalScore / item.attempts) : 0
  })).sort((a, b) => a.key.localeCompare(b.key));
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export class KanaProgressManager {
  constructor(storage) {
    this.storage = storage;
    this.historyKey = 'handwritingHistory';
  }

  getHistory() {
    try { return mergeHandwritingHistory(JSON.parse(this.storage.getItem(this.historyKey) || '[]')); }
    catch { return []; }
  }

  saveHistory(history) {
    this.storage.setItem(this.historyKey, JSON.stringify(mergeHandwritingHistory(history)));
  }

  recordAttempt(kana, scoreResult, mode = 'trace') {
    const now = Date.now();
    const entry = {
      id: `${now}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`,
      character: kana.character,
      script: kana.script,
      romaji: kana.romaji,
      mode,
      score: scoreResult.score,
      strokeCount: scoreResult.strokeCount,
      expectedStrokeCount: scoreResult.expectedStrokeCount,
      ts: now,
      date: new Date(now).toLocaleDateString('en-CA')
    };
    this.saveHistory([entry, ...this.getHistory()]);
    return entry;
  }

  getProgress() { return buildKanaProgress(this.getHistory()); }

  getSummary() {
    const progress = this.getProgress();
    const hiragana = progress.filter(item => item.script === 'hiragana');
    const katakana = progress.filter(item => item.script === 'katakana');
    const average = progress.length
      ? Math.round(progress.reduce((sum, item) => sum + item.averageScore, 0) / progress.length)
      : 0;
    return {
      practiced: progress.length,
      mastered: progress.filter(item => item.mastered).length,
      hiraganaMastered: hiragana.filter(item => item.mastered).length,
      katakanaMastered: katakana.filter(item => item.mastered).length,
      averageScore: average,
      attempts: progress.reduce((sum, item) => sum + item.attempts, 0)
    };
  }

  getWeakKeys() {
    return new Set(this.getProgress()
      .filter(item => item.bestScore < 80)
      .sort((a, b) => a.bestScore - b.bestScore || a.lastPracticedAt - b.lastPracticedAt)
      .map(item => item.key));
  }

  mergeRemote(history) {
    const merged = mergeHandwritingHistory(this.getHistory(), history);
    this.saveHistory(merged);
    return merged;
  }

  exportCSV() {
    const header = ['日期', '假名類型', '假名', '羅馬拼音', '練習模式', '分數', '實際筆畫數', '標準筆畫數', '時間戳'];
    const rows = this.getHistory().map(item => [
      item.date,
      item.script === 'katakana' ? '片假名' : '平假名',
      item.character,
      item.romaji,
      item.mode,
      item.score,
      item.strokeCount,
      item.expectedStrokeCount,
      item.ts
    ].map(csvEscape).join(','));
    return [header.join(','), ...rows].join('\n');
  }

  importCSV(text) {
    const source = String(text || '').replace(/^\uFEFF/, '').trim();
    const lines = source.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return { added: 0, total: this.getHistory().length };
    const parseLine = line => {
      const values = []; let value = ''; let quoted = false;
      for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (character === '"') {
          if (quoted && line[index + 1] === '"') { value += '"'; index++; }
          else quoted = !quoted;
        } else if (character === ',' && !quoted) { values.push(value); value = ''; }
        else value += character;
      }
      values.push(value); return values;
    };
    const existing = this.getHistory();
    const before = existing.length;
    const imported = lines.slice(1).map((line, index) => {
      const columns = parseLine(line);
      const script = columns[1] === '片假名' || columns[1] === 'katakana' ? 'katakana' : 'hiragana';
      const ts = Number(columns[8]) || Date.now() + index;
      return {
        id: `import:${script}:${columns[2] || ''}:${ts}`,
        date: columns[0] || '', script, character: columns[2] || '', romaji: columns[3] || '',
        mode: columns[4] || 'trace', score: Number(columns[5]) || 0,
        strokeCount: Number(columns[6]) || 0, expectedStrokeCount: Number(columns[7]) || 0, ts
      };
    }).filter(item => item.character);
    const merged = mergeHandwritingHistory(existing, imported);
    this.saveHistory(merged);
    return { added: Math.max(0, merged.length - before), total: merged.length };
  }
}
