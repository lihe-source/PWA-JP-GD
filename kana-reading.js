const ROMAJI_ALIASES = Object.freeze({
  shi: ['si'],
  chi: ['ti'],
  tsu: ['tu'],
  fu: ['hu'],
  wo: ['o'],
  n: ['nn']
});

export function normalizeRomajiAnswer(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s　._・\-]/g, '');
}

export function acceptedRomaji(kana = {}) {
  const canonical = normalizeRomajiAnswer(kana.romaji);
  return [...new Set([canonical, ...(ROMAJI_ALIASES[canonical] || [])].map(normalizeRomajiAnswer).filter(Boolean))];
}

export function checkKanaReadingAnswer(kana, answer) {
  const normalized = normalizeRomajiAnswer(answer);
  return {
    normalized,
    correct: !!normalized && acceptedRomaji(kana).includes(normalized),
    expected: normalizeRomajiAnswer(kana?.romaji)
  };
}

export function mergeKanaReadingHistory(...collections) {
  const byId = new Map();
  collections.flat().filter(Boolean).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const ts = Number(entry.ts) || Date.now() + index;
    const character = String(entry.character || '');
    if (!character) return;
    const script = entry.script === 'katakana' ? 'katakana' : 'hiragana';
    const id = String(entry.id || `kana-reading:${script}:${character}:${ts}`);
    const normalized = {
      id,
      character,
      script,
      row: String(entry.row || ''),
      romaji: normalizeRomajiAnswer(entry.romaji),
      answer: normalizeRomajiAnswer(entry.answer),
      correct: entry.correct === true,
      ts,
      date: String(entry.date || '')
    };
    const existing = byId.get(id);
    if (!existing || normalized.ts >= existing.ts) byId.set(id, normalized);
  });
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, 5000);
}

export function buildKanaReadingProgress(history = []) {
  const progress = new Map();
  mergeKanaReadingHistory(history).forEach(entry => {
    const key = `${entry.script}:${entry.character}`;
    const current = progress.get(key) || {
      key,
      character: entry.character,
      script: entry.script,
      romaji: entry.romaji,
      attempts: 0,
      correct: 0,
      lastAnswer: '',
      lastPracticedAt: 0
    };
    current.attempts += 1;
    if (entry.correct) current.correct += 1;
    if (entry.ts >= current.lastPracticedAt) {
      current.lastPracticedAt = entry.ts;
      current.lastAnswer = entry.answer;
    }
    progress.set(key, current);
  });
  return [...progress.values()].map(item => ({
    ...item,
    accuracy: item.attempts ? Math.round(item.correct / item.attempts * 100) : 0,
    mastered: item.attempts > 0 && item.correct / item.attempts >= 0.8
  })).sort((a, b) => a.key.localeCompare(b.key));
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      cells.push(value); value = '';
    } else value += character;
  }
  cells.push(value);
  return cells;
}

export class KanaReadingProgressManager {
  constructor(storage) {
    this.storage = storage;
    this.historyKey = 'kanaReadingHistory';
  }

  getHistory() {
    try { return mergeKanaReadingHistory(JSON.parse(this.storage.getItem(this.historyKey) || '[]')); }
    catch { return []; }
  }

  saveHistory(history) {
    this.storage.setItem(this.historyKey, JSON.stringify(mergeKanaReadingHistory(history)));
  }

  recordAttempt(kana, answer, correct) {
    const now = Date.now();
    const entry = {
      id: `${now}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`,
      character: kana.character,
      script: kana.script,
      row: kana.row,
      romaji: kana.romaji,
      answer,
      correct: correct === true,
      ts: now,
      date: new Date(now).toLocaleDateString('en-CA')
    };
    this.saveHistory([entry, ...this.getHistory()]);
    return entry;
  }

  getProgress() { return buildKanaReadingProgress(this.getHistory()); }

  getSummary() {
    const history = this.getHistory();
    const progress = buildKanaReadingProgress(history);
    const correct = history.filter(item => item.correct).length;
    return {
      attempts: history.length,
      correct,
      wrong: history.length - correct,
      accuracy: history.length ? Math.round(correct / history.length * 100) : 0,
      practiced: progress.length,
      mastered: progress.filter(item => item.mastered).length,
      hiraganaPracticed: progress.filter(item => item.script === 'hiragana').length,
      katakanaPracticed: progress.filter(item => item.script === 'katakana').length
    };
  }

  mergeRemote(history) {
    const merged = mergeKanaReadingHistory(this.getHistory(), history);
    this.saveHistory(merged);
    return merged;
  }

  exportCSV() {
    const header = ['日期', '假名類型', '行別', '假名', '正確讀音', '使用者答案', '是否正確', '時間戳'];
    const rows = this.getHistory().map(item => [
      item.date,
      item.script === 'katakana' ? '片假名' : '平假名',
      item.row,
      item.character,
      item.romaji,
      item.answer,
      item.correct ? '正確' : '錯誤',
      item.ts
    ].map(csvEscape).join(','));
    return [header.join(','), ...rows].join('\n');
  }

  importCSV(text) {
    const source = String(text || '').replace(/^\uFEFF/, '').trim();
    const lines = source.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return { added: 0, total: this.getHistory().length };
    const header = lines[0].replace(/"/g, '').trim();
    if (header !== '日期,假名類型,行別,假名,正確讀音,使用者答案,是否正確,時間戳') throw new Error('FORMAT_MISMATCH_KANA_READING');
    const before = this.getHistory();
    const imported = lines.slice(1).map((line, index) => {
      const columns = parseCsvLine(line);
      const ts = Number(columns[7]) || Date.now() + index;
      const script = columns[1] === '片假名' || columns[1] === 'katakana' ? 'katakana' : 'hiragana';
      return {
        id: `import:kana-reading:${script}:${columns[3] || ''}:${ts}`,
        date: columns[0] || '',
        script,
        row: columns[2] || '',
        character: columns[3] || '',
        romaji: columns[4] || '',
        answer: columns[5] || '',
        correct: columns[6] === '正確' || columns[6] === 'true' || columns[6] === '1',
        ts
      };
    });
    const merged = mergeKanaReadingHistory(before, imported);
    this.saveHistory(merged);
    return { added: Math.max(0, merged.length - before.length), total: merged.length };
  }
}
