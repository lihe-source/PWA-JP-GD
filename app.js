import { AppStorage } from './storage.js?v=V1_2_12';
import { BackupSchema } from './backup-schema.js?v=V1_2_12';
import { VersionManager } from './version-manager.js?v=V1_2_12';
import { TrendChart } from './chart-renderer.js?v=V1_2_12';
import { PUSH_CONFIG } from './push-config.js?v=V1_2_12';
import { ReminderManager, reminderErrorMessage } from './reminder-manager.js?v=V1_2_12';
import { StudyStreakManager, STUDY_ACTIVITY_TYPES, STUDY_DAYS_CSV_HEADER, mergeStudyDays } from './study-streak.js?v=V1_2_12';
import { JAPANESE_DEFAULTS, KanaProgressManager, buildKanaProgress, mergeHandwritingHistory, normalizeJapaneseAnswer, normalizeJapaneseWord, resolveWritingLayout } from './japanese-learning.js?v=V1_2_12';
import { BASIC_KANA, KANA_REPEAT_OPTIONS, KANA_ROWS, buildRepeatedKanaPractice, getKanaSet } from './kana-data.js?v=V1_2_12';
import { HandwritingEngine } from './handwriting-engine.js?v=V1_2_12';
import { DAILY_LEARNING_SOURCES, LEARNING_KANA_ROWS, dailyLearningSignature, normalizeDailyLearningPreferences, parseDailyVocabularyResponse, selectedLearningRowLabel, selectedLearningRows } from './daily-learning.js?v=V1_2_12';
import { KanaReadingProgressManager, checkKanaReadingAnswer } from './kana-reading.js?v=V1_2_12';

// ===========================
// 日本語練習 PWA - app.js V1_2_12
// V1.2.12：五十音手寫批次路徑與練習期間雲端同步隔離
// ===========================

const APP_VERSION = 'V1_2_12';
const APP_DISPLAY_VERSION = 'V1.2.12';
const APP_CACHE_VERSION = 'Japanese-PWA-V1_2_12';
const canActivateAppUpdate = () => {
  if (document.querySelector('#quiz-ghost-input, .essay-textarea, .reading-quiz-shell, .reading-loading, .ai-loading, .kana-writing-canvas')) return false;
  const aiAskInput = document.querySelector('.aiask-textarea');
  return !String(aiAskInput?.value || '').trim();
};
const AppUpdater = new VersionManager({
  currentVersion: APP_VERSION,
  displayVersion: APP_DISPLAY_VERSION,
  cachePrefix: 'Japanese-PWA-',
  versionUrl: './version.json',
  storage: AppStorage,
  canActivate: canActivateAppUpdate
});
const DailyReminder = new ReminderManager({ storage: AppStorage, config: PUSH_CONFIG });
const resumeAppUpdateWhenSafe = () => {
  void AppStorage.flush().then(() => {
    void AppUpdater.activateWaitingIfSafe();
    void AppUpdater.reloadIfSafe();
  });
};

// ===== Web Audio Sound Effects =====
// iOS/PWA note: speechSynthesis can interrupt Web Audio.  Keep one low-latency
// context, explicitly unlock it from user gestures, and resume it before every cue.
const Sound = {
  ctx: null,
  _unlockPromise: null,
  lastError: '',
  lastPlayed: '',
  lastPlayedAt: '',

  _configureAudioSession() {
    // iOS uses an ambient session for Web Audio by default, which is muted by the
    // Ring/Silent switch. Playback keeps learning feedback audible in an installed PWA.
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') {
        navigator.audioSession.type = 'playback';
      }
    } catch {}
  },

  _getCtx() {
    this._configureAudioSession();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      this.lastError = '此瀏覽器不支援 Web Audio API';
      return null;
    }
    if (!this.ctx || this.ctx.state === 'closed') {
      // Use the same simple AudioContext construction as V6.6. On iOS standalone
      // PWAs this is more reliable than using latencyHint plus an extra master node.
      this.ctx = new AudioContextClass();
      this.ctx.onstatechange = () => this._emitStatus();
      this.lastError = '';
    }
    return this.ctx;
  },

  _emitStatus() {
    try {
      window.dispatchEvent(new CustomEvent('quiz-sound-state', { detail: this.getStatus() }));
    } catch {}
  },

  getStatus() {
    const supported = !!(window.AudioContext || window.webkitAudioContext);
    const state = this.ctx?.state || (supported ? 'not-created' : 'unsupported');
    return {
      supported,
      state,
      audioSessionType: navigator.audioSession?.type || 'unavailable',
      lastError: this.lastError,
      lastPlayed: this.lastPlayed,
      lastPlayedAt: this.lastPlayedAt
    };
  },

  // Call from a direct tap/click/key action. The silent oscillator primes the
  // audio route without relying on speechSynthesis or an asynchronous timer.
  unlock() {
    try {
      this._configureAudioSession();
      const ctx = this._getCtx();
      if (!ctx) return Promise.resolve(false);

      // A running context is already ready. Avoid creating a silent oscillator on
      // every question and every key press, which is costly on iOS PWAs.
      if (ctx.state === 'running') {
        this.lastError = '';
        return Promise.resolve(true);
      }

      // pointerdown/touch/keydown can describe the same physical gesture. Share
      // one resume attempt so suspended contexts do not accumulate audio nodes.
      if (this._unlockPromise) return this._unlockPromise;

      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.00001, ctx.currentTime);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.015);
      } catch {}

      const resumed = ctx.resume();
      this._unlockPromise = Promise.resolve(resumed).then(() => {
        const ready = ctx.state === 'running';
        this.lastError = ready ? '' : `AudioContext 狀態：${ctx.state}`;
        this._emitStatus();
        return ready;
      }).catch(error => {
        this.lastError = error?.message || '無法啟用音效';
        this._emitStatus();
        return false;
      }).finally(() => {
        this._unlockPromise = null;
      });
      return this._unlockPromise;
    } catch (error) {
      this._unlockPromise = null;
      this.lastError = error?.message || '音效初始化失敗';
      this._emitStatus();
      return Promise.resolve(false);
    }
  },

  // Keep the V6.6 synchronous fast path. When the context is already running,
  // the oscillator is scheduled immediately inside the user's input event.
  _withCtx(fn, label) {
    try {
      this._configureAudioSession();
      const ctx = this._getCtx();
      if (!ctx) return Promise.resolve(false);

      const play = () => {
        try {
          fn(ctx);
          this.lastPlayed = label;
          this.lastPlayedAt = new Date().toISOString();
          this.lastError = '';
          this._emitStatus();
          return true;
        } catch (error) {
          this.lastError = error?.message || '音效播放失敗';
          this._emitStatus();
          return false;
        }
      };

      if (ctx.state === 'running') return Promise.resolve(play());

      // resume() is invoked synchronously from the current user action. Do not
      // await before calling it, otherwise iOS may discard the activation token.
      const resumed = ctx.resume();
      return Promise.resolve(resumed).then(() => {
        if (ctx.state !== 'running') {
          this.lastError = `AudioContext 狀態：${ctx.state}`;
          this._emitStatus();
          return false;
        }
        return play();
      }).catch(error => {
        this.lastError = error?.message || '無法恢復音效';
        this._emitStatus();
        return false;
      });
    } catch (error) {
      this.lastError = error?.message || '音效播放失敗';
      this._emitStatus();
      return Promise.resolve(false);
    }
  },

  playCorrect() {
    return this._withCtx(ctx => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.type = 'sine';
      o.frequency.setValueAtTime(523, ctx.currentTime);
      o.frequency.setValueAtTime(659, ctx.currentTime + 0.1);
      o.frequency.setValueAtTime(784, ctx.currentTime + 0.2);
      g.gain.setValueAtTime(0.46, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.5);
    }, '答對音效');
  },

  playWrong() {
    return this._withCtx(ctx => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.type = 'sawtooth';
      o.frequency.setValueAtTime(200, ctx.currentTime);
      o.frequency.setValueAtTime(150, ctx.currentTime + 0.1);
      g.gain.setValueAtTime(0.36, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.32);
      o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.33);
    }, '答錯音效');
  },

  // pct: 0-100 → tiered result fanfare
  playResult(pct) {
    return this._withCtx(ctx => {
      const t = ctx.currentTime;
      const schedule = (notes, type = 'sine', gain = 0.34, step = 0.11, duration = 0.35) => {
        notes.forEach((freq, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination); o.type = type;
          o.frequency.value = freq;
          g.gain.setValueAtTime(0.0001, t + i * step);
          g.gain.linearRampToValueAtTime(gain, t + i * step + 0.025);
          g.gain.exponentialRampToValueAtTime(0.001, t + i * step + duration);
          o.start(t + i * step); o.stop(t + i * step + duration + 0.03);
        });
      };

      if (pct === 100) schedule([523, 659, 784, 1047, 1319], 'sine', 0.38, 0.10, 0.40);
      else if (pct >= 80) schedule([523, 659, 784, 1047], 'sine', 0.36, 0.11, 0.36);
      else if (pct >= 60) schedule([523, 659, 784], 'sine', 0.34, 0.12, 0.34);
      else if (pct >= 40) schedule([440, 523], 'triangle', 0.32, 0.15, 0.34);
      else if (pct >= 20) schedule([392, 330], 'triangle', 0.30, 0.18, 0.38);
      else {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination); o.type = 'sawtooth';
        o.frequency.setValueAtTime(280, t);
        o.frequency.linearRampToValueAtTime(180, t + 0.4);
        g.gain.setValueAtTime(0.34, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.52);
        o.start(t); o.stop(t + 0.55);
      }
    }, `總結音效 ${Math.round(Number(pct) || 0)}%`);
  }
};

// Prime/resume Web Audio from genuine user gestures. This is especially important
// after iOS speech synthesis or returning to the PWA from the background.
let lastQuizSoundPrimeAt = 0;
const primeQuizSound = () => {
  // Keep the global listeners dormant outside spelling and kana-reading practice.
  if (!document.querySelector('#quiz-ghost-input, #kana-reading-answer')) return;
  if (Sound.ctx?.state === 'running') return;
  const now = Date.now();
  if (now - lastQuizSoundPrimeAt < 750) return;
  lastQuizSoundPrimeAt = now;
  void Sound.unlock();
};
if ('PointerEvent' in window) {
  document.addEventListener('pointerdown', primeQuizSound, { passive: true, capture: true });
} else {
  document.addEventListener('touchstart', primeQuizSound, { passive: true, capture: true });
}
document.addEventListener('keydown', primeQuizSound, { passive: true, capture: true });

// ===== ECDICT IndexedDB Module =====
const ECDICT = {
  DB_NAME: 'ecdict_db', DB_VERSION: 1,
  STORE_NAME: 'words', META_NAME: 'meta',
  _db: null,
  async openDB() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME, { keyPath: 'word' }).createIndex('word', 'word', { unique: true });
        }
        if (!db.objectStoreNames.contains(this.META_NAME)) db.createObjectStore(this.META_NAME, { keyPath: 'key' });
      };
      req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async getMeta() {
    try {
      const db = await this.openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(this.META_NAME, 'readonly');
        const req = tx.objectStore(this.META_NAME).get('info');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch { return null; }
  },
  async saveMeta(info) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.META_NAME, 'readwrite');
      tx.objectStore(this.META_NAME).put({ key: 'info', ...info });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  },
  async clearAll() {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME, this.META_NAME], 'readwrite');
      tx.objectStore(this.STORE_NAME).clear(); tx.objectStore(this.META_NAME).clear();
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  },
  // Parse full CSV text into records, correctly handling quoted fields with embedded newlines
  _parseCSVRecords(text) {
    const records = [];
    let i = 0; const n = text.length;
    let fields = []; let cur = ''; let inQ = false;
    while (i < n) {
      const ch = text[i];
      if (ch === '"') {
        if (inQ && text[i+1] === '"') { cur += '"'; i += 2; continue; }
        inQ = !inQ; i++; continue;
      }
      if (ch === ',' && !inQ) { fields.push(cur); cur = ''; i++; continue; }
      if (!inQ && (ch === '\r' || ch === '\n')) {
        fields.push(cur); cur = '';
        if (fields.some(f => f.trim())) records.push(fields);
        fields = [];
        if (ch === '\r' && (i + 1) < n && text[i+1] === '\n') i++;
        i++; continue;
      }
      cur += ch; i++;
    }
    if (cur || fields.length) { fields.push(cur); if (fields.some(f => f.trim())) records.push(fields); }
    return records;
  },
  _mapPos(posStr) {
    if (!posStr) return '';
    // ECDICT pos field format (per README): "n:46/v:54"
    //   Each segment = code:percentage, "/" separates multiple pos.
    //   Pick the code with the highest percentage as the primary pos.
    //
    // ECDICT single-letter codes (from BNC-derived scheme):
    //   n = noun      v = verb      a = adjective   r = adverb
    //   p = prep      c = conj      u = aux/modal   d = determiner
    //   m = numeral   q = classifier/meas
    // Two-letter codes also found in ECDICT:
    //   vt = transitive verb    vi = intransitive verb    ad = adverb
    const codeMap = {
      // ── ECDICT native codes ──
      'n':'n.', 'v':'v.', 'a':'adj.', 'r':'adv.',
      'p':'prep.', 'c':'conj.', 'u':'aux.', 'd':'det.',
      'm':'num.', 'q':'meas.',
      'vt':'v.', 'vi':'v.', 'ad':'adv.', 'pron':'pron.',
      // ── Full English words (for manually-added words) ──
      'noun':'n.', 'verb':'v.', 'adjective':'adj.', 'adj':'adj.',
      'adverb':'adv.', 'adv':'adv.', 'preposition':'prep.', 'prep':'prep.',
      'conjunction':'conj.', 'conj':'conj.', 'pronoun':'pron.',
      'auxiliary':'aux.', 'aux':'aux.', 'interjection':'interj.', 'interj':'interj.',
      'numeral':'num.', 'num':'num.', 'phrase':'phrase', 'phr':'phrase',
    };
    const p = posStr.trim();
    // Format A: "n:46/v:54" — pick code with highest percentage
    if (p.includes(':')) {
      let best = '', bestPct = -1;
      p.split('/').forEach(seg => {
        const m = seg.match(/^([a-z]+):([0-9]+)/i);
        if (m) {
          const code = m[1].toLowerCase();
          const pct  = parseInt(m[2]);
          const label = codeMap[code];
          if (label && pct > bestPct) { best = label; bestPct = pct; }
        }
      });
      if (best) return best;
    }
    // Format B: plain code "n" / "adj" / "vt"
    const first = p.toLowerCase().split(/[\/\s]/)[0].replace(/\.$/, '');
    return codeMap[first] || '';
  },
  _extractChinese(translationField, posField) {
    if (!translationField) return '';
    // ECDICT translation field: each line = "pos. 中文釋義", separated by literal "\n"
    // e.g. "n. 名詞釋義\nv. 動詞釋義\nvt. 及物動詞釋義"
    const lines = translationField.split(/\\n|\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return '';

    // Find the dominant raw pos code from posField "n:46/v:54" → "v"
    // Use the FULL raw code (e.g. "ad", "vt") so we can match "ad. " or "vt. " lines
    let targetCode = '';
    if (posField) {
      const ps = posField.trim();
      if (ps.includes(':')) {
        // "n:46/v:54" — pick code with highest percentage
        let bestCode = '', bestPct = -1;
        ps.split('/').forEach(seg => {
          const m = seg.match(/^([a-z]+):([0-9]+)/i);
          if (m && parseInt(m[2]) > bestPct) { bestPct = parseInt(m[2]); bestCode = m[1].toLowerCase(); }
        });
        targetCode = bestCode;
      } else {
        // plain "n" or "adj"
        targetCode = ps.toLowerCase().split(/[\/\s]/)[0].replace(/\.$/, '');
      }
    }

    // Try to match a translation line whose prefix equals targetCode (full match, e.g. "vt. " not just "v. ")
    // Also try the single-letter fallback in case targetCode is "ad" but line uses "r. "
    const adverbAliases = { 'ad': 'r', 'adv': 'r' };
    let bestLine = lines[0];
    if (targetCode) {
      // Escape for regex: targetCode is always letters only
      const tryMatch = (code) => lines.find(l => new RegExp('^' + code + '\\.\\s', 'i').test(l));
      bestLine = tryMatch(targetCode)
              || tryMatch(adverbAliases[targetCode] || '')
              || lines[0];
    }

    // Strip leading pos prefix ("n. ", "vt. ", "adj. " …)
    bestLine = bestLine.replace(/^[a-z]+\.\s*/i, '').trim();
    return bestLine.split(/[；;]/)[0].trim() || bestLine;
  },
  async importCSV(text, onProgress) {
    // Use record-aware parser to handle quoted fields with embedded newlines
    const records = this._parseCSVRecords(text);
    // Skip header row (first record)
    const dataRecords = records.slice(1);
    const total = dataRecords.length;
    await this.clearAll(); const db = await this.openDB();
    const BATCH = 2000; let count = 0; let batch = [];
    const writeBatch = (items) => new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      items.forEach(item => store.put(item));
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    for (let i = 0; i < dataRecords.length; i++) {
      const cols = dataRecords[i];
      const word = (cols[0] || '').trim().toLowerCase(); if (!word) continue;
      // ECDICT columns: word(0) phonetic(1) definition(2) translation(3) pos(4)
      //                 collins(5) oxford(6) tag(7) bnc(8) frq(9) exchange(10)
      const posRaw  = (cols[4] || '').trim();
      const transRaw = (cols[3] || '').trim();
      const chinese = this._extractChinese(transRaw, posRaw);
      if (!chinese) continue;
      batch.push({
        word,
        phonetic:    (cols[1] || '').trim(),
        chinese,
        pos:         this._mapPos(posRaw),
        frq:         parseInt(cols[9]) || 0,
        translation: transRaw
      });
      count++;
      if (batch.length >= BATCH) { await writeBatch(batch); batch = []; if (onProgress) onProgress(count, total); await new Promise(r => setTimeout(r, 0)); }
    }
    if (batch.length) await writeBatch(batch);
    if (onProgress) onProgress(count, total);
    await this.saveMeta({ count, importedAt: new Date().toISOString() });
    return count;
  },
  // If a record was imported with empty pos (old data), derive pos on-the-fly
  // from the translation field prefix lines (e.g. "n. 游泳\nv. 游过" → dominant pos)
  _enrichPos(record) {
    if (!record) return record;
    if (record.pos) return record;            // already has pos — nothing to do
    if (!record.translation) return record;   // no translation to derive from

    // Parse translation lines, count pos occurrences + Chinese definition richness
    // e.g. "n. 游泳；漂浮；潮流；眩晕\nv. 游泳；游过；漂浮"
    //   n: lines=1, defs=4   v: lines=1, defs=3  → n wins by def count
    // Secondary score: number of Chinese items (separated by ；/;) on all matching lines
    const lines = record.translation.split(/\\n|\n/).map(s => s.trim()).filter(Boolean);
    const tally = {};  // code → { lines, defs }
    lines.forEach(l => {
      const m = l.match(/^([a-z]+)\.\s+(.+)/i);
      if (m) {
        const c = m[1].toLowerCase();
        const defCount = (m[2].match(/[；;]/g) || []).length + 1;
        if (!tally[c]) tally[c] = { lines: 0, defs: 0 };
        tally[c].lines += 1;
        tally[c].defs  += defCount;
      }
    });
    // Pick best: primary sort by line count, secondary by def count
    let bestCode = '', bestScore = [-1, -1];
    Object.entries(tally).forEach(([code, stat]) => {
      const score = [stat.lines, stat.defs];
      if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
        bestScore = score; bestCode = code;
      }
    });
    if (bestCode) {
      const derived = this._mapPos(bestCode);
      if (derived) return { ...record, pos: derived };
    }
    return record;
  },
  async search(query, limit = 20) {
    if (!query) return [];
    const db = await this.openDB(); const q = query.toLowerCase().trim();
    return new Promise((resolve) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const results = []; const range = IDBKeyRange.bound(q, q + '\uffff');
      const req = tx.objectStore(this.STORE_NAME).openCursor(range);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) { results.push(this._enrichPos(cursor.value)); cursor.continue(); }
        else { resolve(results.sort((a, b) => (b.frq || 0) - (a.frq || 0))); }
      };
      req.onerror = () => resolve([]);
    });
  },
  async isLoaded() {
    // Check actual records in the store (meta may be missing for older imports)
    try {
      const db = await this.openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(this.STORE_NAME, 'readonly');
        const req = tx.objectStore(this.STORE_NAME).count();
        req.onsuccess = () => resolve(req.result > 0);
        req.onerror = () => resolve(false);
      });
    } catch { return false; }
  },
  async lookup(word) {
    try {
      const db = await this.openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(this.STORE_NAME, 'readonly');
        const req = tx.objectStore(this.STORE_NAME).get(word.toLowerCase());
        req.onsuccess = () => resolve(this._enrichPos(req.result) || null);
        req.onerror = () => resolve(null);
      });
    } catch { return null; }
  }
};

// ===== DATA MANAGEMENT =====
const DB = {
  getWords() { try { return JSON.parse(AppStorage.getItem('vocabWords') || '[]'); } catch { return []; } },
  saveWords(words) { AppStorage.setItem('vocabWords', JSON.stringify(words)); },
  addWord(word) {
    const words = this.getWords();
    const normalized = normalizeJapaneseWord(word);
    const newWord = { ...normalized, id: Date.now().toString(), wrongCount: 0, createdAt: todayStr(), frequencyWeight: 1 };
    words.push(newWord); this.saveWords(words); return newWord;
  },
  updateWord(id, data) {
    const words = this.getWords(); const idx = words.findIndex(w => w.id === id);
    if (idx !== -1) { words[idx] = { ...words[idx], ...data }; this.saveWords(words); return words[idx]; }
  },
  incrementWrongCounts(ids) {
    const pending = new Set((ids || []).map(id => String(id)));
    if (!pending.size) return 0;
    const words = this.getWords();
    let changed = 0;
    words.forEach(word => {
      if (!pending.has(String(word.id))) return;
      word.wrongCount = (Number(word.wrongCount) || 0) + 1;
      changed++;
    });
    if (changed) this.saveWords(words);
    return changed;
  },
  deleteWords(ids) { this.saveWords(this.getWords().filter(w => !ids.includes(w.id))); },
  getHistory() { try { return JSON.parse(AppStorage.getItem('practiceHistory') || '[]'); } catch { return []; } },
  saveHistory(h) { AppStorage.setItem('practiceHistory', JSON.stringify(h)); },
  // ── Reading Quiz History ──
  getReadingQuizHistory() { try { return JSON.parse(AppStorage.getItem('readingQuizHistory') || '[]'); } catch { return []; } },
  saveReadingQuizHistory(arr) { AppStorage.setItem('readingQuizHistory', JSON.stringify(arr)); },
  addReadingQuizSession(entry) {
    const history = this.getReadingQuizHistory();
    const date = entry.date || todayStr();
    const session = {
      id: entry.id || String(Date.now()),
      article: entry.article || '',
      articleZh: entry.articleZh || '',
      words: Array.isArray(entry.words) ? entry.words : [],
      questions: Array.isArray(entry.questions) ? entry.questions : [],
      answers: entry.answers || {},
      score: Number(entry.score) || 0,
      correct: Number(entry.correct) || 0,
      total: Number(entry.total) || 5,
      ts: entry.ts || Date.now()
    };
    const idx = history.findIndex(h => h.date === date);
    if (idx >= 0) history[idx].sessions = [...(history[idx].sessions || []), session];
    else history.unshift({ date, sessions: [session] });
    if (history.length > 180) history.length = 180;
    this.saveReadingQuizHistory(history);
    recordStudyActivity(STUDY_ACTIVITY_TYPES.READING_QUIZ, `reading:${session.id}`);
    return session;
  },
  exportReadingQuizCSV() {
    const history = this.getReadingQuizHistory();
    const header = ['日期','分數','正確題數','總題數','使用單字','文章','題目結果','時間戳'];
    const rows = [];
    history.forEach(h => {
      (h.sessions || []).forEach(s => {
        const words = (s.words || []).map(w => w.english || w.word || '').filter(Boolean).join(';');
        const qa = JSON.stringify({ questions: s.questions || [], answers: s.answers || {}, articleZh: s.articleZh || '' });
        rows.push([h.date, s.score || 0, s.correct || 0, s.total || 5, words, s.article || '', qa, s.ts || ''].map(v => `"${String(v).replace(/"/g,'""')}"`));
      });
    });
    return [header.join(','), ...rows.map(r => r.join(','))].join('\n');
  },
  importReadingQuizCSV(text) {
    const records = this._splitCSVRecords(text.replace(/^\uFEFF/, '').trim());
    if (records.length < 2) return { added: 0 };
    const headerLine = records[0].replace(/"/g, '').trim();
    if (headerLine !== this.CSV_HEADERS.reading) throw new Error('FORMAT_MISMATCH_READING');
    const history = this.getReadingQuizHistory();
    let added = 0;
    const seen = new Set();
    history.forEach(h => (h.sessions || []).forEach(s => seen.add(String(s.ts || s.id || '') + '|' + (s.article || '').slice(0, 40))));
    for (let i = 1; i < records.length; i++) {
      const cols = this._parseCSVLine(records[i]);
      if (cols.length < 7) continue;
      const date = (cols[0] || '').trim();
      const score = parseInt(cols[1]) || 0;
      const correct = parseInt(cols[2]) || 0;
      const total = parseInt(cols[3]) || 5;
      const wordsStr = (cols[4] || '').trim();
      const article = (cols[5] || '').trim();
      const qaRaw = (cols[6] || '').trim();
      const ts = parseInt(cols[7] || '0') || (Date.now() + i);
      if (!date || !article) continue;
      let qa = {}; try { qa = qaRaw ? JSON.parse(qaRaw) : {}; } catch { qa = {}; }
      const words = wordsStr ? wordsStr.split(';').map(w => ({ english: w.trim(), chinese: '', partOfSpeech: '' })).filter(w => w.english) : [];
      const key = String(ts) + '|' + article.slice(0, 40);
      if (seen.has(key)) continue;
      const session = { id: String(ts), article, articleZh: qa.articleZh || '', words, questions: qa.questions || [], answers: qa.answers || {}, score, correct, total, ts };
      const idx = history.findIndex(h => h.date === date);
      if (idx >= 0) history[idx].sessions = [...(history[idx].sessions || []), session];
      else history.unshift({ date, sessions: [session] });
      seen.add(key); added++;
    }
    this.saveReadingQuizHistory(history);
    return { added };
  },
  // ── Essay Writing History ──
  getEssayHistory() { try { return JSON.parse(AppStorage.getItem('essayHistory') || '[]'); } catch { return []; } },
  saveEssayHistory(arr) { AppStorage.setItem('essayHistory', JSON.stringify(arr)); },
  addEssaySession(entry) {
    // entry: { date, words:[{english,chinese,partOfSpeech}], essay, feedback, score, annotatedHtml }
    const history = this.getEssayHistory();
    const idx = history.findIndex(h => h.date === entry.date);
    const newSession = { essay: entry.essay, feedback: entry.feedback, score: entry.score, words: entry.words, annotatedHtml: entry.annotatedHtml||'', ts: Date.now() };
    if (idx >= 0) {
      // Append new session — never overwrite existing sessions
      history[idx].sessions = [...(history[idx].sessions||[]), newSession];
    } else {
      history.unshift({ date: entry.date, sessions: [newSession] });
    }
    if (history.length > 180) history.length = 180;
    this.saveEssayHistory(history);
    recordStudyActivity(STUDY_ACTIVITY_TYPES.ESSAY_REVIEW, `essay:${newSession.ts}`);
    return newSession;
  },
  exportEssayCSV() {
    const history = this.getEssayHistory();
    const header = ['日期','使用單字','文章','AI批改','分數','模式','題目'];
    const rows = [];
    history.forEach(h => {
      (h.sessions||[]).forEach(s => {
        rows.push([h.date, (s.words||[]).map(w=>w.english).join(';'), s.essay||'', s.feedback||'', s.score||'', s.essayMode||'vocab', s.topic||''].map(v=>`"${String(v).replace(/"/g,'""')}"`));
      });
    });
    return [header.join(','), ...rows.map(r=>r.join(','))].join('\n');
  },
  importEssayCSV(text) {
    const records = this._splitCSVRecords(text.replace(/^\uFEFF/, '').trim());
    if (records.length < 2) return { added: 0 };
    const headerLine = records[0].replace(/"/g, '').trim();
    if (headerLine !== this.CSV_HEADERS.essay) throw new Error('FORMAT_MISMATCH_ESSAY');
    const history = this.getEssayHistory();
    let added = 0;
    for (let i = 1; i < records.length; i++) {
      const cols = this._parseCSVLine(records[i]);
      if (cols.length < 4) continue;
      const date = (cols[0]||'').trim();
      const wordsStr = (cols[1]||'').trim();
      const essay = (cols[2]||'').trim();
      const feedback = (cols[3]||'').trim();
      const score = (cols[4]||'').trim();
      const essayMode = (cols[5]||'vocab').trim() || 'vocab';
      const topic = (cols[6]||'').trim();
      if (!date || !essay) continue;
      const words = wordsStr ? wordsStr.split(';').map(w=>({ english: w.trim(), chinese:'', partOfSpeech:'' })) : [];
      const session = { essay, feedback, score, words, essayMode, topic, ts: Date.now() + i };
      const idx = history.findIndex(h => h.date === date);
      if (idx >= 0) { history[idx].sessions = history[idx].sessions || []; history[idx].sessions.push(session); }
      else { history.unshift({ date, sessions: [session] }); added++; }
    }
    this.saveEssayHistory(history);
    return { added };
  },
  // ── AI Ask History ──
  getAiAskHistory()         { try { return JSON.parse(AppStorage.getItem('aiAskHistory') || '[]'); } catch { return []; } },
  saveAiAskHistory(arr)     { AppStorage.setItem('aiAskHistory', JSON.stringify(arr)); },
  addAiAskEntry(entry) {
    // entry: { id (YYMMDDHHMM), question, answer, ts }
    const history = this.getAiAskHistory();
    history.unshift(entry);
    if (history.length > 300) history.length = 300;
    this.saveAiAskHistory(history);
    recordStudyActivity(STUDY_ACTIVITY_TYPES.AI_ASK, `aiask:${entry.id || 'entry'}:${entry.ts || Date.now()}`);
  },
  exportAiAskCSV() {
    const history = this.getAiAskHistory();
    const header  = ['ID','問題','回覆','時間戳'];
    const rows    = history.map(e =>
      [e.id||'', e.question||'', e.answer||'', e.ts||''].map(v => `"${String(v).replace(/"/g,'""')}"`)
    );
    return [header.join(','), ...rows.map(r => r.join(','))].join('\n');
  },
  importAiAskCSV(text) {
    const records = this._splitCSVRecords(text.replace(/^\uFEFF/, '').trim());
    if (records.length < 2) return { added: 0 };
    const headerLine = records[0].replace(/"/g, '').trim();
    if (headerLine !== this.CSV_HEADERS.aiask) throw new Error('FORMAT_MISMATCH_AIASK');
    const history = this.getAiAskHistory();
    let added = 0;
    for (let i = 1; i < records.length; i++) {
      const cols = this._parseCSVLine(records[i]);
      if (cols.length < 2) continue;
      const id = (cols[0]||'').trim(); const question = (cols[1]||'').trim();
      const answer = (cols[2]||'').trim(); const ts = parseInt(cols[3]||'0') || Date.now();
      if (!id || !question) continue;
      if (!history.find(e => e.id === id)) { history.unshift({ id, question, answer, ts }); added++; }
    }
    this.saveAiAskHistory(history);
    return { added };
  },

  addPracticeSession(date, totalWords, wrongWordDetails) {
    const correct = totalWords - wrongWordDetails.length; const wrong = wrongWordDetails.length;
    const history = this.getHistory(); const existing = history.find(h => h.date === date);
    if (existing) {
      existing.correct += correct; existing.wrong += wrong; existing.total += totalWords;
      if (!existing.wrongWordDetails) existing.wrongWordDetails = [];
      wrongWordDetails.forEach(wd => { if (!existing.wrongWordDetails.find(e => e.english === wd.english)) existing.wrongWordDetails.push(wd); });
    } else { history.push({ date, correct, wrong, total: totalWords, wrongWordDetails }); }
    this.saveHistory(history);
    recordStudyActivity(STUDY_ACTIVITY_TYPES.WORD_QUIZ, `word:${date}:${Date.now()}`);
  },
  getApiKey() { return AppStorage.getItem('geminiApiKey') || ''; },
  saveApiKey(key) { AppStorage.setItem('geminiApiKey', key); },
  getModel() {
    const saved = AppStorage.getItem('geminiModel') || '';
    const validModels = (typeof Gemini !== 'undefined' && Gemini.AVAILABLE_MODELS)
      ? Gemini.AVAILABLE_MODELS.map(m => m.id)
      : [];
    if (saved && (!validModels.length || validModels.includes(saved))) return saved;
    const fallback = 'gemini-3.5-flash';
    if (saved && validModels.length && !validModels.includes(saved)) AppStorage.setItem('geminiModel', fallback);
    return fallback;
  },
  saveModel(m) { AppStorage.setItem('geminiModel', m); },
  // ── Google Drive config ──
  getGDriveClientId()  { return AppStorage.getItem('gdriveClientId') || JAPANESE_DEFAULTS.oauthClientId; },
  setGDriveClientId(v) { AppStorage.setItem('gdriveClientId', v); },
  getGDriveFolderId()  { return AppStorage.getItem('gdriveFolderId') || JAPANESE_DEFAULTS.driveFolderId; },
  setGDriveFolderId(v) { AppStorage.setItem('gdriveFolderId', v); },
  getGDriveAutoSync()  { return AppStorage.getItem('gdriveAutoSync') === '1'; },
  setGDriveAutoSync(v) { AppStorage.setItem('gdriveAutoSync', v ? '1' : '0'); },
  getGDriveLastSync()  { return AppStorage.getItem('gdriveLastSync') || ''; },
  setGDriveLastSync(v) { AppStorage.setItem('gdriveLastSync', v); },
  getBoostedWords() { try { return JSON.parse(AppStorage.getItem('boostedWords') || '[]'); } catch { return []; } },
  saveBoostedWords(ids) { AppStorage.setItem('boostedWords', JSON.stringify(ids)); },
  getTtsDelay()    { return parseInt(AppStorage.getItem('ttsDelay') || '300'); },
  saveTtsDelay(ms) { AppStorage.setItem('ttsDelay', String(ms)); },
  getJlptLevel() { return AppStorage.getItem('japaneseJlptLevel') || JAPANESE_DEFAULTS.jlptLevel; },
  saveJlptLevel(level) { AppStorage.setItem('japaneseJlptLevel', String(level || 'N5').toUpperCase()); },
  getDailyLearningPreferences() {
    let saved = {};
    try { saved = JSON.parse(AppStorage.getItem('dailyLearningPreferencesV1') || '{}') || {}; } catch {}
    return normalizeDailyLearningPreferences({ ...saved, level: this.getJlptLevel() });
  },
  saveDailyLearningPreferences(patch = {}) {
    const current = this.getDailyLearningPreferences();
    const normalized = normalizeDailyLearningPreferences({ ...current, ...patch });
    this.saveJlptLevel(normalized.level);
    AppStorage.setItem('dailyLearningPreferencesV1', JSON.stringify({ source: normalized.source, rows: normalized.rows }));
    return normalized;
  },
  getTodayDailyVocabulary() {
    try {
      const saved = JSON.parse(AppStorage.getItem('todayDailyVocabularyV1') || 'null');
      const preferences = this.getDailyLearningPreferences();
      const signature = dailyLearningSignature({ date: todayStr(), ...preferences });
      if (saved?.signature !== signature || !Array.isArray(saved.words) || !saved.words.length) return null;
      // 每日只保留一個推薦詞；升級當天也會自動收斂舊版的五詞快取。
      const normalized = { ...saved, words: saved.words.slice(0, 1) };
      if (saved.words.length !== normalized.words.length) {
        AppStorage.setItem('todayDailyVocabularyV1', JSON.stringify(normalized));
      }
      return normalized;
    } catch { return null; }
  },
  saveTodayDailyVocabulary(words) {
    const preferences = this.getDailyLearningPreferences();
    const data = {
      date: todayStr(),
      signature: dailyLearningSignature({ date: todayStr(), ...preferences }),
      source: DAILY_LEARNING_SOURCES.LEVEL,
      level: preferences.level,
      rows: preferences.rows,
      words: Array.isArray(words) ? words.slice(0, 1) : [],
      generatedAt: new Date().toISOString()
    };
    AppStorage.setItem('todayDailyVocabularyV1', JSON.stringify(data));
    return data;
  },
  getLastPracticeMode() {
    const saved = AppStorage.getItem('lastPracticeMode') || 'quiz';
    return ['quiz', 'kana', 'kanaReading', 'essay', 'reading', 'aiask'].includes(saved) ? saved : 'quiz';
  },
  saveLastPracticeMode(mode) {
    const value = ['quiz', 'kana', 'kanaReading', 'essay', 'reading', 'aiask'].includes(mode) ? mode : 'quiz';
    AppStorage.setItem('lastPracticeMode', value);
    return value;
  },
  getWordPracticePreferences() {
    let saved = {};
    try { saved = JSON.parse(AppStorage.getItem('wordPracticePreferencesV1') || '{}') || {}; } catch {}
    const count = [5, 10, 15, 20, 25, 30].includes(Number(saved.count)) ? Number(saved.count) : 10;
    const order = ['newest', 'all'].includes(saved.order) ? saved.order : 'all';
    return { count, order };
  },
  saveWordPracticePreferences(patch = {}) {
    const current = this.getWordPracticePreferences();
    const next = { ...current, ...patch };
    const normalized = {
      count: [5, 10, 15, 20, 25, 30].includes(Number(next.count)) ? Number(next.count) : current.count,
      order: ['newest', 'all'].includes(next.order) ? next.order : current.order
    };
    AppStorage.setItem('wordPracticePreferencesV1', JSON.stringify(normalized));
    return normalized;
  },
  getKanaPracticePreferences() {
    let saved = {};
    try { saved = JSON.parse(AppStorage.getItem('kanaPracticePreferencesV1') || '{}') || {}; } catch {}
    const validRows = new Set(KANA_ROWS.map(row => row.id));
    let rows = Array.isArray(saved.rows) ? [...new Set(saved.rows.filter(row => validRows.has(row)))] : [];
    if (saved.row && validRows.has(saved.row) && !rows.length) rows = [saved.row];
    if (saved.row === 'all' || saved.rows?.includes?.('all') || !rows.length) rows = ['all'];
    return {
      script: ['hiragana', 'katakana', 'both'].includes(saved.script) ? saved.script : 'hiragana',
      rows,
      mode: ['trace', 'copy', 'recall'].includes(saved.mode) ? saved.mode : 'trace',
      count: [0, 5, 10, 20].includes(Number(saved.count)) ? Number(saved.count) : 10,
      repeat: KANA_REPEAT_OPTIONS.includes(Number(saved.repeat)) ? Number(saved.repeat) : 1,
      weakOnly: saved.weakOnly === true,
      layout: ['auto', 'phone', 'tablet'].includes(saved.layout) ? saved.layout : 'auto',
      autoSpeak: saved.autoSpeak !== false
    };
  },
  saveKanaPracticePreferences(patch = {}) {
    const current = this.getKanaPracticePreferences();
    const next = { ...current, ...patch };
    const validRows = new Set(KANA_ROWS.map(row => row.id));
    let rows = Array.isArray(next.rows) ? [...new Set(next.rows.filter(row => validRows.has(row)))] : current.rows;
    if (next.rows?.includes?.('all') || !rows.length) rows = ['all'];
    const normalized = {
      script: ['hiragana', 'katakana', 'both'].includes(next.script) ? next.script : current.script,
      rows,
      mode: ['trace', 'copy', 'recall'].includes(next.mode) ? next.mode : current.mode,
      count: [0, 5, 10, 20].includes(Number(next.count)) ? Number(next.count) : current.count,
      repeat: KANA_REPEAT_OPTIONS.includes(Number(next.repeat)) ? Number(next.repeat) : current.repeat,
      weakOnly: next.weakOnly === true,
      layout: ['auto', 'phone', 'tablet'].includes(next.layout) ? next.layout : current.layout,
      autoSpeak: next.autoSpeak !== false
    };
    AppStorage.setItem('kanaPracticePreferencesV1', JSON.stringify(normalized));
    return normalized;
  },
  getKanaReadingPreferences() {
    let saved = {};
    try { saved = JSON.parse(AppStorage.getItem('kanaReadingPreferencesV1') || '{}') || {}; } catch {}
    const validRows = new Set(KANA_ROWS.map(row => row.id));
    let rows = Array.isArray(saved.rows) ? [...new Set(saved.rows.filter(row => validRows.has(row)))] : [];
    if (saved.rows?.includes?.('all') || !rows.length) rows = ['all'];
    return {
      script: ['hiragana', 'katakana', 'both'].includes(saved.script) ? saved.script : 'hiragana',
      rows,
      repeat: KANA_REPEAT_OPTIONS.includes(Number(saved.repeat)) ? Number(saved.repeat) : 1
    };
  },
  saveKanaReadingPreferences(patch = {}) {
    const current = this.getKanaReadingPreferences();
    const next = { ...current, ...patch };
    const validRows = new Set(KANA_ROWS.map(row => row.id));
    let rows = Array.isArray(next.rows) ? [...new Set(next.rows.filter(row => validRows.has(row)))] : current.rows;
    if (next.rows?.includes?.('all') || !rows.length) rows = ['all'];
    const normalized = {
      script: ['hiragana', 'katakana', 'both'].includes(next.script) ? next.script : current.script,
      rows,
      repeat: KANA_REPEAT_OPTIONS.includes(Number(next.repeat)) ? Number(next.repeat) : current.repeat
    };
    AppStorage.setItem('kanaReadingPreferencesV1', JSON.stringify(normalized));
    return normalized;
  },
  getPracticePreferenceBundle() {
    return {
      lastPracticeMode: this.getLastPracticeMode(),
      wordPractice: this.getWordPracticePreferences(),
      kanaPractice: this.getKanaPracticePreferences(),
      kanaReading: this.getKanaReadingPreferences(),
      dailyLearning: this.getDailyLearningPreferences()
    };
  },
  applyPracticePreferenceBundle(bundle = {}) {
    if (bundle.lastPracticeMode) this.saveLastPracticeMode(bundle.lastPracticeMode);
    if (bundle.wordPractice) this.saveWordPracticePreferences(bundle.wordPractice);
    if (bundle.kanaPractice) this.saveKanaPracticePreferences(bundle.kanaPractice);
    if (bundle.kanaReading) this.saveKanaReadingPreferences(bundle.kanaReading);
    if (bundle.dailyLearning) this.saveDailyLearningPreferences(bundle.dailyLearning);
  },
  toggleBoost(id) {
    const b = this.getBoostedWords(); const idx = b.indexOf(id);
    if (idx === -1) b.push(id); else b.splice(idx, 1);
    this.saveBoostedWords(b); return idx === -1;
  },
  isBoosted(id) { return this.getBoostedWords().includes(id); },
  getTodaySentence() {
    try { const s = JSON.parse(AppStorage.getItem('todaySentence') || 'null'); return (s && s.date === todayStr()) ? s : null; }
    catch { return null; }
  },
  saveTodaySentence(data) { AppStorage.setItem('todaySentence', JSON.stringify({ ...data, date: todayStr() })); },
  // AI-generated sentence log
  getSentenceLog() { try { return JSON.parse(AppStorage.getItem('sentenceLog') || '[]'); } catch { return []; } },
  saveSentenceToLog(entry) {
    const log = this.getSentenceLog();
    if (entry?.source === 'daily-recommendation') {
      for (let index = log.length - 1; index >= 0; index--) {
        if (log[index]?.date === entry.date && log[index]?.source === 'daily-recommendation') log.splice(index, 1);
      }
    }
    const key = `${entry?.date || todayStr()}|${entry?.wordEn || ''}`;
    const duplicateIndex = log.findIndex(item => `${item?.date || ''}|${item?.wordEn || ''}` === key);
    const previous = duplicateIndex >= 0 ? log.splice(duplicateIndex, 1)[0] : null;
    log.unshift({ ...previous, ...entry, id: previous?.id || Date.now().toString() });
    if (log.length > 120) log.length = 120;
    AppStorage.setItem('sentenceLog', JSON.stringify(log));
  },
  // Imported sentence bank (CSV)
  getImportedSentences() { try { return JSON.parse(AppStorage.getItem('importedSentences') || '[]'); } catch { return []; } },
  saveImportedSentences(arr) { AppStorage.setItem('importedSentences', JSON.stringify(arr)); },
  importSentencesCSV(text) {
    const records = this._splitCSVRecords(text.replace(/^\uFEFF/, '').trim());
    if (records.length < 2) return { added: 0, total: 0 };
    // ── 格式驗證 ──
    const headerLine = records[0].replace(/\r/,'').trim().replace(/^\uFEFF/,'').replace(/"/g,'');
    if (headerLine !== this.CSV_HEADERS.sentences) throw new Error('FORMAT_MISMATCH_SENTENCES');
    const existing = this.getImportedSentences();
    const existingKeys = new Set(existing.map(s => s.date + '|' + s.wordEn));
    let added = 0;
    for (let i = 1; i < records.length; i++) {
      const cols = this._parseCSVLine(records[i]);
      if (cols.length < 6) continue;
      const date = (cols[0] || '').trim();
      const wordEn = (cols[1] || '').trim().toLowerCase();
      const wordPos = (cols[2] || '').trim();
      const wordZh = (cols[3] || '').trim();
      const en = (cols[4] || '').trim();
      const reading = (cols[5] || '').trim();
      const zh = (cols[6] || '').trim();
      if (!date || !wordEn || !en || !zh) continue;
      const key = date + '|' + wordEn;
      if (!existingKeys.has(key)) {
        existing.unshift({ date, wordEn, wordPos, wordZh, en, reading, zh, id: Date.now().toString() + i, source: 'csv' });
        existingKeys.add(key); added++;
      }
    }
    this.saveImportedSentences(existing);
    return { added, total: existing.length };
  },
  exportSentencesCSV() {
    const wordMap = {};
    this.getWords().forEach(w => { wordMap[w.english.toLowerCase()] = w.chinese; });
    const ai = this.getSentenceLog().map(e => ({
      date: e.date, wordEn: e.wordEn, wordPos: e.wordPos||'',
      // wordZh: use stored value, fall back to DB lookup so older entries still highlight
      wordZh: e.wordZh || wordMap[(e.wordEn||'').toLowerCase()] || '',
      en: e.en, reading: e.reading || '', zh: e.zh, source: 'ai'
    }));
    const imported = this.getImportedSentences();
    const all = [...imported, ...ai];
    // Deduplicate by date+wordEn
    const seen = new Set(); const unique = all.filter(e => { const k = e.date+'|'+e.wordEn; if (seen.has(k)) return false; seen.add(k); return true; });
    const header = ['date','wordJa','wordPos','wordZh','ja','reading','zh'];
    const rows = unique.map(e => [e.date, e.wordEn, e.wordPos||'', e.wordZh||'', e.en, e.reading||'', e.zh].map(v => `"${String(v).replace(/"/g,'""')}"`));
    return [header.join(','), ...rows.map(r => r.join(','))].join('\n');
  },
  // Combined sentence log for home display
  getCombinedSentenceLog() {
    const ai = this.getSentenceLog();
    const imported = this.getImportedSentences();
    // Merge, prefer AI for same date+word key
    const seen = new Set();
    const result = [];
    [...ai, ...imported].forEach(e => {
      const k = e.date + '|' + (e.wordEn || '');
      if (!seen.has(k)) { seen.add(k); result.push(e); }
    });
    // Sort by date descending
    result.sort((a, b) => {
      const da = a.date || ''; const db2 = b.date || '';
      return db2.localeCompare(da);
    });
    return result.slice(0, 150);
  },
  // Get sentence for today from any source
  getTodaySentenceAny() {
    const today = todayStr();
    // 1. Check AI cached (priority)
    const ai = this.getTodaySentence();
    if (ai) return ai;
    // 2. Filter all imported sentences matching today, pick one at random
    const todayImported = this.getImportedSentences().filter(s => s.date === today);
    if (todayImported.length > 0) {
      return todayImported[Math.floor(Math.random() * todayImported.length)];
    }
    return null;
  },
  // ── CSV 標頭定義（格式鎖定）──
  CSV_HEADERS: {
    vocab:     '日文語彙,假名讀音,羅馬拼音,詞性,繁體中文,JLPT,答錯次數,建立日期,頻率加權',
    essay:     '日期,使用單字,文章,AI批改,分數,模式,題目',
    sentences: 'date,wordJa,wordPos,wordZh,ja,reading,zh',
    stats:     '日期,總題數,正確,錯誤,正確率%',
    reading:   '日期,分數,正確題數,總題數,使用單字,文章,題目結果,時間戳',
    aiask:     'ID,問題,回覆,時間戳',
    studyDays: STUDY_DAYS_CSV_HEADER,
    handwriting: '日期,假名類型,假名,羅馬拼音,練習模式,分數,實際筆畫數,標準筆畫數,時間戳',
    kanaReading: '日期,假名類型,行別,假名,正確讀音,使用者答案,是否正確,時間戳'
  },
  // 自動偵測 CSV 類型，回傳 'vocab' | 'sentences' | 'stats' | null
  detectCSVType(text) {
    const firstLine = text.trim().split('\n')[0].replace(/\r/,'').trim();
    // 去除 BOM 和引號比對
    const clean = firstLine.replace(/^\uFEFF/,'').replace(/"/g,'');
    if (clean === this.CSV_HEADERS.vocab)     return 'vocab';
    if (clean === this.CSV_HEADERS.sentences)  return 'sentences';
    if (clean === this.CSV_HEADERS.stats)      return 'stats';
    if (clean === this.CSV_HEADERS.reading)    return 'reading';
    if (clean === this.CSV_HEADERS.essay)      return 'essay';
    if (clean === this.CSV_HEADERS.aiask)      return 'aiask';
    if (clean === this.CSV_HEADERS.studyDays)  return 'studyDays';
    if (clean === this.CSV_HEADERS.handwriting) return 'handwriting';
    if (clean === this.CSV_HEADERS.kanaReading) return 'kanaReading';
    return null;
  },
  exportStudyDaysCSV() { return StudyStreak.exportCSV(); },
  importStudyDaysCSV(text) { return StudyStreak.importCSV(text); },
  exportCSV() {
    const words = this.getWords();
    const header = ['日文語彙','假名讀音','羅馬拼音','詞性','繁體中文','JLPT','答錯次數','建立日期','頻率加權'];
    const rows = words.map(w => [w.english, w.reading||w.phonetic||'', w.romaji||'', w.partOfSpeech, w.chinese, w.jlpt||'未分級', w.wrongCount||0, w.createdAt||'', w.frequencyWeight||1].map(v => `"${String(v).replace(/"/g,'""')}"`));
    return [header.join(','), ...rows.map(r => r.join(','))].join('\n');
  },
  importCSV(text) {
    const records = this._splitCSVRecords(text.replace(/^\uFEFF/, '').trim());
    if (records.length < 2) return { added: 0, skipped: 0 };
    // ── 格式驗證 ──
    const headerLine = records[0].replace(/\r/,'').trim().replace(/^\uFEFF/,'').replace(/"/g,'');
    if (headerLine !== this.CSV_HEADERS.vocab) throw new Error('FORMAT_MISMATCH_VOCAB');
    const words = this.getWords(); let added = 0, skipped = 0;
    for (let i = 1; i < records.length; i++) {
      const cols = this._parseCSVLine(records[i]);
      if (cols.length < 5) { skipped++; continue; }
      const english = (cols[0] || '').trim();
      const reading = (cols[1] || '').trim();
      const romaji = (cols[2] || '').trim();
      const partOfSpeech = (cols[3] || '').trim();
      const chinese = (cols[4] || '').trim();
      if (!english || !chinese) { skipped++; continue; }
      const existing = words.find(w => normalizeJapaneseAnswer(w.english) === normalizeJapaneseAnswer(english));
      if (existing) {
        existing.partOfSpeech = partOfSpeech; existing.chinese = chinese; existing.romaji = romaji;
        existing.phonetic = reading; existing.reading = reading; existing.jlpt = (cols[5] || '未分級').trim();
        if (cols[6]) existing.wrongCount = parseInt(cols[6]) || 0;
        if (cols[8]) existing.frequencyWeight = parseInt(cols[8]) || 1;
      } else {
        words.push(normalizeJapaneseWord({ id: (Date.now() + i).toString(), english, reading, phonetic: reading, romaji, partOfSpeech, chinese, jlpt: (cols[5]||'未分級').trim(), wrongCount: parseInt(cols[6])||0, createdAt: (cols[7]||'').trim()||todayStr(), frequencyWeight: parseInt(cols[8])||1 }));
        added++;
      }
    }
    this.saveWords(words); return { added, skipped };
  },
  // Stats CSV export
  exportStatsCSV() {
    const history = this.getHistory();
    const header = ['日期','總題數','正確','錯誤','正確率%'];
    const rows = history.map(h => {
      const pct = h.total > 0 ? Math.round((h.correct/h.total)*100) : 0;
      return [h.date, h.total||0, h.correct||0, h.wrong||0, pct].map(v=>`"${v}"`);
    });
    return [header.join(','), ...rows.map(r=>r.join(','))].join('\n');
  },
  // Stats CSV import (merge into existing history)
  importStatsCSV(text) {
    const records = this._splitCSVRecords(text.replace(/^\uFEFF/, '').trim());
    if (records.length < 2) return { added: 0, updated: 0 };
    // ── 格式驗證 ──
    const headerLine = records[0].replace(/\r/,'').trim().replace(/^\uFEFF/,'').replace(/"/g,'');
    if (headerLine !== this.CSV_HEADERS.stats) throw new Error('FORMAT_MISMATCH_STATS');
    const history = this.getHistory();
    const dataMap = {};
    history.forEach(h => { dataMap[h.date] = h; });
    let added = 0, updated = 0;
    for (let i = 1; i < records.length; i++) {
      const cols = this._parseCSVLine(records[i]);
      if (cols.length < 4) continue;
      const date = (cols[0]||'').trim();
      const total = parseInt(cols[1])||0;
      const correct = parseInt(cols[2])||0;
      const wrong = parseInt(cols[3])||0;
      if (!date || (!total && !correct && !wrong)) continue;
      if (dataMap[date]) {
        if (total > (dataMap[date].total||0)) {
          dataMap[date].total = total; dataMap[date].correct = correct; dataMap[date].wrong = wrong; updated++;
        }
      } else {
        dataMap[date] = { date, total, correct, wrong, wrongWordDetails: [] }; added++;
      }
    }
    const merged = Object.values(dataMap).sort((a,b)=>a.date.localeCompare(b.date));
    this.saveHistory(merged);
    return { added, updated };
  },
  // Split CSV text into records, respecting quoted multiline fields
  _splitCSVRecords(text) {
    const records = [];
    let current = '';
    let inQuote = false;
    const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"') {
        if (inQuote && src[i + 1] === '"') { current += '"'; i++; }
        else { inQuote = !inQuote; current += ch; }
      } else if (ch === '\n' && !inQuote) {
        records.push(current); current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) records.push(current);
    return records;
  },
  _parseCSVLine(line) {
    const result = []; let current = ''; let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQuote && line[i+1] === '"') { current += '"'; i++; } else inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { result.push(current); current = ''; }
      else { current += ch; }
    }
    result.push(current); return result;
  }
};

function getOrCreateJapaneseDeviceId() {
  let id = AppStorage.getItem('japaneseDeviceId') || '';
  if (!id) {
    id = crypto.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    AppStorage.setItem('japaneseDeviceId', id);
  }
  return id;
}

const StudyStreak = new StudyStreakManager({
  storage: AppStorage,
  getDeviceId: getOrCreateJapaneseDeviceId
});
const KanaProgress = new KanaProgressManager(AppStorage);
const KanaReadingProgress = new KanaReadingProgressManager(AppStorage);

function getStudyHistorySources() {
  return {
    history: DB.getHistory(),
    readingQuizHistory: DB.getReadingQuizHistory(),
    essayHistory: DB.getEssayHistory(),
    aiAskHistory: DB.getAiAskHistory(),
    handwritingHistory: KanaProgress.getHistory(),
    kanaReadingHistory: KanaReadingProgress.getHistory()
  };
}

function refreshStudyStreakUI() {
  const summary = StudyStreak.getSummary();
  const values = {
    'streak-current-days': summary.current,
    'streak-longest-days': summary.longest,
    'streak-total-days': summary.totalDays,
    'settings-streak-current': summary.current,
    'settings-streak-longest': summary.longest,
    'settings-streak-total': summary.totalDays
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
  });
  const todayState = document.getElementById('streak-today-state');
  if (todayState) {
    todayState.textContent = summary.practicedToday ? '今天已完成練習' : '今天尚未完成練習';
    todayState.classList.toggle('is-complete', summary.practicedToday);
  }
  const syncState = document.getElementById('study-streak-sync-status');
  if (syncState) {
    const state = StudyStreak.getSyncState();
    syncState.textContent = state.pending
      ? '本機有待同步的練習天數'
      : state.lastSync ? `練習天數已同步：${new Date(state.lastSync).toLocaleString('zh-TW')}` : '練習天數尚未同步';
  }
}

function recordStudyActivity(type, eventId = '') {
  StudyStreak.recordActivity(type, { eventId: `${getOrCreateJapaneseDeviceId()}:${eventId || Date.now()}` });
  refreshStudyStreakUI();
  queueMicrotask(() => GDrive.scheduleStudyStreakSync());
}

// ===== GEMINI API =====
const Gemini = {
  // All selectable models (display name -> API id)
  AVAILABLE_MODELS: [
    { label: 'Gemini 3.5 Flash',      id: 'gemini-3.5-flash',      tag: '推薦・穩定', tier: 'stable' },
    { label: 'Gemini 3.1 Flash-Lite', id: 'gemini-3.1-flash-lite', tag: '快速・穩定', tier: 'stable' },
    { label: 'Gemini 2.5 Flash',      id: 'gemini-2.5-flash',      tag: '備援・穩定', tier: 'stable' },
    { label: 'Gemini 2.5 Flash-Lite', id: 'gemini-2.5-flash-lite', tag: '省配額・穩定', tier: 'stable' },
    { label: 'Gemini 2.5 Pro',        id: 'gemini-2.5-pro',        tag: '高階・穩定', tier: 'stable' },
    { label: 'Gemini 3.1 Pro Preview', id: 'gemini-3.1-pro-preview', tag: '預覽', tier: 'preview' },
    { label: 'Gemini 3 Flash Preview', id: 'gemini-3-flash-preview', tag: '預覽', tier: 'preview' },
  ],

  // Production fallback stays on stable endpoints. Preview models are tried only when explicitly selected.
  _getModelList() {
    const selected = DB.getModel();
    const selectedMeta = this.AVAILABLE_MODELS.find(m => m.id === selected);
    const stableIds = this.AVAILABLE_MODELS.filter(m => m.tier === 'stable').map(m => m.id);
    const previewIds = selectedMeta?.tier === 'preview'
      ? this.AVAILABLE_MODELS.filter(m => m.tier === 'preview').map(m => m.id)
      : [];
    return [...new Set([selected, ...stableIds, ...previewIds])].filter(Boolean);
  },

  // Extract the actual response text, skipping "thought" parts from thinking models
  _extractText(data) {
    const parts = data.candidates?.[0]?.content?.parts || [];
    if (!parts.length) return '';
    // Thinking / preview models may split the final answer across multiple non-thought text parts.
    // Join every visible text part so long translations are not cut off after the first segment.
    const visibleText = parts
      .filter(p => !p.thought && typeof p.text === 'string')
      .map(p => p.text)
      .join('');
    if (visibleText.trim()) return visibleText;
    return parts
      .filter(p => typeof p.text === 'string')
      .map(p => p.text)
      .join('');
  },

  // Robust parser for Japanese sentence generation (JA/KANA/ZH).
  _parse(raw) {
    if (!raw) return null;
    // Strip markdown bold/italic markers and <thinking> blocks
    let text = raw
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/\*+/g, '')
      .trim();
    // Keep the historical `en` property as the stored target-language field.
    const enMatch = text.match(/(?:JA|JP|Japanese|日文|日本語):\s*([^\n]+)/i);
    const kanaMatch = text.match(/(?:KANA|Reading|讀音|假名|かな):\s*([^\n]+)/i);
    const zhMatch = text.match(/ZH:\s*([^\n]+)/i);
    if (enMatch && zhMatch) {
      const en = enMatch[1].trim().replace(/^["']|["']$/g, '');
      const zh = zhMatch[1].trim().replace(/^["']|["']$/g, '');
      const reading = kanaMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
      if (en && zh) return { en, zh, reading };
    }
    // Fallback: accept either two lines (Japanese/Chinese) or three lines.
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const en = lines[0].replace(/^(Japanese|JA|JP|Sentence|日文|日本語|句子):\s*/i, '').replace(/^["']|["']$/g, '').trim();
      const hasReadingLine = lines.length >= 3 && /^(KANA|Reading|讀音|假名|かな):/i.test(lines[1]);
      const reading = hasReadingLine ? lines[1].replace(/^(KANA|Reading|讀音|假名|かな):\s*/i, '').replace(/^["']|["']$/g, '').trim() : '';
      const zhLine = hasReadingLine ? lines[2] : lines[1];
      const zh = zhLine.replace(/^(Chinese|ZH|Translation|中文|翻譯):\s*/i, '').replace(/^["']|["']$/g, '').trim();
      if (en && zh && en.length > 1 && zh.length > 1) return { en, zh, reading };
    }
    return null;
  },

  async _callModel(model, body, apiKey, attempt = 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal }
      );
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('API_TIMEOUT');
      throw new Error('NETWORK_ERROR');
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try { const d = await res.json(); errMsg = d.error?.message || errMsg; } catch {}
      const lower = String(errMsg).toLowerCase();
      const err = new Error(errMsg);
      const apiKeyProblem = lower.includes('api key') || lower.includes('apikey') || lower.includes('permission denied') || lower.includes('authentication');
      const modelProblem = lower.includes('model') || lower.includes('not found') || lower.includes('not supported') || lower.includes('deprecated') || lower.includes('quota') || lower.includes('rate limit') || lower.includes('unavailable');
      if (!apiKeyProblem && attempt < 1 && (res.status === 429 || res.status === 503)) {
        await new Promise(resolve => setTimeout(resolve, 900));
        return this._callModel(model, body, apiKey, attempt + 1);
      }
      err.fallback = !apiKeyProblem && (res.status === 404 || res.status === 429 || res.status === 503 || (res.status === 400 && modelProblem));
      throw err;
    }
    const data = await res.json();
    return this._extractText(data);
  },

  async reviewEssay(essay, words) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    const wordList = words.map(w => `"${w.english}" (${w.partOfSpeech}: ${w.chinese})`).join(', ');
    const prompt = `You are a Japanese writing teacher for a Traditional Chinese learner. Review the Japanese composition below.

Required vocabulary words: ${wordList}

Student Japanese composition:
${essay}

Respond ONLY with a single valid JSON object. No markdown fences, no explanation, no text before or after the JSON.
Required format:
{"wordCheck":[{"word":"string","used":true,"correct":true,"note":"string"}],"grammar":[{"exact":"string","corrected":"string","explanation":"string"}],"suggestions":["string"],"score":7,"comment":"string"}

Rules:
- wordCheck: one entry per required vocabulary word (used=false if not found in essay)
- grammar: list up to 5 errors in particles, conjugation, kanji/kana spelling, word choice, or naturalness (empty array [] if none).
  CRITICAL CONSTRAINT: Keep each required Japanese vocabulary item unchanged in "corrected". Fix only the surrounding grammar and expression.
  "exact" must be the EXACT substring copied verbatim from the student essay so it can be found by string search. "corrected" is the fixed replacement. "explanation" is in Traditional Chinese (繁體中文).
- suggestions: 2-3 tips to improve the essay in Traditional Chinese (繁體中文). Do NOT suggest replacing the required vocabulary words.
- comment: one sentence overall evaluation in Traditional Chinese (繁體中文)
- score: integer 1-10`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2500 }
    });

    // Helper: extract first valid JSON object from raw text
    const extractJSON = (raw) => {
      // Remove thinking tags (Gemini 2.5 Flash thinking model)
      let text = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
      // Remove markdown fences (```json ... ``` or ``` ... ```)
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      // Find the first { ... } block (handles leading/trailing whitespace or text)
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return null;
      return text.slice(start, end + 1);
    };

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        if (!raw) { lastErr = new Error('EMPTY_RESPONSE'); continue; }
        const jsonStr = extractJSON(raw);
        if (!jsonStr) { lastErr = new Error(`PARSE_ERROR: no JSON found in response`); continue; }
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed.score !== 'undefined') return parsed;
        lastErr = new Error('PARSE_ERROR: missing score field');
      } catch(err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        if (err instanceof SyntaxError) { lastErr = new Error(`PARSE_ERROR: ${err.message}`); continue; }
        throw err;
      }
    }
    throw lastErr || new Error('API_ERROR');
  },
  // Review essay with a free topic (no required vocabulary words)
  async reviewEssayFree(essay, topic) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    const prompt = `You are a Japanese writing teacher for a Traditional Chinese learner. The student was given this topic/prompt: "${topic}"

Student essay:
${essay}

Respond ONLY with a single valid JSON object. No markdown fences, no explanation.
Required format:
{"grammar":[{"exact":"string","corrected":"string","explanation":"string"}],"suggestions":["string"],"score":7,"comment":"string"}

Rules:
- grammar: up to 5 errors in particles, conjugation, kanji/kana spelling, word choice, or naturalness. "exact" must be verbatim from the composition. "explanation" in 繁體中文.
- suggestions: 2-3 tips in 繁體中文.
- comment: one sentence evaluation in 繁體中文.
- score: integer 1-10`;

    const body = JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.2,maxOutputTokens:2500} });

    const extractJSON = (raw) => {
      let text = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi,'').trim()
        .replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`\s*$/,'').trim();
      const start = text.indexOf('{'); const end = text.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return null;
      return text.slice(start, end + 1);
    };

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        if (!raw) { lastErr = new Error('EMPTY_RESPONSE'); continue; }
        const jsonStr = extractJSON(raw);
        if (!jsonStr) { lastErr = new Error('PARSE_ERROR: no JSON'); continue; }
        const parsed = JSON.parse(jsonStr);
        // Normalize: add empty wordCheck for compatibility
        if (parsed && typeof parsed.score !== 'undefined') {
          parsed.wordCheck = parsed.wordCheck || [];
          return parsed;
        }
        lastErr = new Error('PARSE_ERROR: missing score');
      } catch(err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        if (err instanceof SyntaxError) { lastErr = new Error('PARSE_ERROR: ' + err.message); continue; }
        throw err;
      }
    }
    throw lastErr || new Error('API_ERROR');
  },

  async generateSentence(word) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');

    const prompt = `You are a Japanese language learning assistant for a Traditional Chinese learner. Create one natural Japanese sentence at ${DB.getJlptLevel?.() || 'JLPT N5'} level using "${word.english}" (${word.partOfSpeech}: ${word.chinese}). Provide the full kana reading and Traditional Chinese translation.

Output ONLY these three lines, nothing else:
JA: [Japanese sentence]
KANA: [full sentence reading in kana]
ZH: [繁體中文翻譯]`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 200 }
    });

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        const parsed = this._parse(raw);
        if (parsed && parsed.en && parsed.zh) return parsed;
        lastErr = new Error('PARSE_ERROR');
        // Parse failed — try next model
      } catch (err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        throw err;
      }
    }
    throw lastErr || new Error('API_ERROR');
  },

  async generateDailyVocabulary({ level, rows, count = 1 }) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    const normalized = normalizeDailyLearningPreferences({ source: DAILY_LEARNING_SOURCES.LEVEL, level, rows });
    const rowDescription = selectedLearningRows(normalized.rows)
      .map(row => `${row.label}（${row.kana}）`).join('、');
    const prompt = `You are selecting daily Japanese vocabulary for a Traditional Chinese learner.

Target level: JLPT ${normalized.level}
Allowed initial kana rows: ${rowDescription}
Number of words: ${count}

Choose ${count} useful, non-duplicate Japanese words commonly taught around JLPT ${normalized.level}. The full kana reading of every word MUST begin with a kana from one of the allowed rows. When several rows are selected, distribute the words across them as evenly as practical. Avoid names, brands, obsolete words, particles by themselves, and words substantially outside the target level.

Return ONLY a JSON array with exactly ${count} objects and no markdown:
[{"word":"愛","reading":"あい","romaji":"ai","partOfSpeech":"名詞","meaning":"愛、愛情","level":"${normalized.level}"}]

Requirements:
- word: normal Japanese spelling (kanji/kana as commonly written)
- reading: full hiragana reading
- romaji: Hepburn-style lowercase romaji
- partOfSpeech: Traditional Chinese label
- meaning: concise Traditional Chinese meaning
- level: exactly ${normalized.level}`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.65, maxOutputTokens: 360 }
    });
    let best = [];
    let lastError = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        const parsed = parseDailyVocabularyResponse(raw, { level: normalized.level, rows: normalized.rows, limit: count });
        if (parsed.length === count) return parsed;
        for (const word of parsed) {
          if (!best.some(item => item.word === word.word && item.reading === word.reading)) best.push(word);
          if (best.length === count) return best;
        }
        lastError = new Error('PARSE_ERROR');
      } catch (error) {
        if (error.message === 'NETWORK_ERROR') throw error;
        if (error.fallback) { lastError = error; continue; }
        throw error;
      }
    }
    throw lastError || new Error('PARSE_ERROR');
  },


  async translateReadingArticle(article, words) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    const cleanArticle = String(article || '').trim();
    if (!cleanArticle) throw new Error('NO_ARTICLE');
    const wordList = (Array.isArray(words) ? words : []).slice(0, 5).map((w, i) => {
      const en = String(w.english || w.word || '').trim();
      const zh = String(w.chinese || '').trim();
      return `${i + 1}. ${en}: ${zh || '請依文章脈絡翻譯'}`;
    }).filter(Boolean).join('\n');
    const prompt = `Translate the full Japanese reading passage into natural Traditional Chinese for Taiwan learners.

Japanese passage:
${cleanArticle}

Target vocabulary and preferred Chinese meanings:
${wordList}

Requirements:
- Translate EVERY sentence from beginning to end. Do not summarize, shorten, skip, or stop early.
- Keep the original sentence order and meaning.
- Use the preferred Chinese meanings for the target vocabulary when they fit the passage.
- Output ONLY the complete Traditional Chinese translation.
- Do not add explanations, markdown, title, bullet points, or extra notes.`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.15, maxOutputTokens: 2400 }
    });

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        const zh = String(raw || '')
          .replace(/^\s*```(?:text|markdown)?\s*/i, '')
          .replace(/\s*```\s*$/i, '')
          .replace(/^\s*(?:ZH|Chinese|Translation|中文翻譯|翻譯)\s*[:：]\s*/i, '')
          .trim();
        if (zh) return zh;
        lastErr = new Error('PARSE_ERROR');
      } catch (err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        throw err;
      }
    }
    throw lastErr || new Error('API_ERROR');
  },


  async generateReadingQuiz(words) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    const cleanWords = (Array.isArray(words) ? words : []).slice(0, 5).map((w, i) => ({
      index: i + 1,
      english: String(w.english || '').trim(),
      partOfSpeech: String(w.partOfSpeech || '').trim(),
      chinese: String(w.chinese || '').trim()
    })).filter(w => w.english);
    if (cleanWords.length < 5) throw new Error('NOT_ENOUGH_WORDS');

    const wordList = cleanWords.map(w => `${w.index}. "${w.english}" (${w.partOfSpeech || '語彙'}: ${w.chinese || '請依脈絡判斷'})`).join('\n');
    const prompt = `You are a Japanese reading-test generator for Traditional Chinese learners at ${DB.getJlptLevel?.() || 'JLPT N5'} level.

Selected vocabulary words:
${wordList}

Create a short, natural Japanese reading passage and a closest-meaning multiple-choice quiz.

Respond ONLY with a single valid JSON object. No markdown fences, no explanation, no text before or after JSON.
Required JSON format:
{
  "article": "Natural Japanese passage, about 180-300 Japanese characters. Use every selected vocabulary item exactly as written at least once.",
  "questions": [
    {"word":"selected vocabulary item", "correctSynonym":"one correct Japanese meaning or paraphrase", "options":["Japanese option A", "Japanese option B", "Japanese option C"]}
  ]
}

Rules:
- article must be natural Japanese and no more than 450 Japanese characters.
- questions must contain exactly 5 items, one item for each selected vocabulary word.
- options must contain exactly 3 short Japanese options.
- exactly one option must be the correct synonym, and it must equal correctSynonym.
- the other two options must be plausible Japanese distractors but NOT equivalent meanings.
- Do not translate the article.
- Use everyday vocabulary and short sentences suitable for the selected JLPT level.`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.55, maxOutputTokens: 1800 }
    });

    const extractJSON = (raw) => {
      let text = String(raw || '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return null;
      return text.slice(start, end + 1);
    };
    const normalizeQuestion = (q, wordObj, idx) => {
      const correct = String(q?.correctSynonym || '').trim();
      let options = Array.isArray(q?.options) ? q.options.map(o => String(o || '').trim()).filter(Boolean) : [];
      if (correct && !options.some(o => o.toLowerCase() === correct.toLowerCase())) options.unshift(correct);
      options = [...new Set(options)].slice(0, 3);
      while (options.length < 3) options.push(['同じ意味', '反対の意味', '別の表現'][options.length] + String(idx + 1));
      return {
        word: wordObj.english,
        wordId: wordObj.id || '',
        chinese: wordObj.chinese || '',
        partOfSpeech: wordObj.partOfSpeech || '',
        correctSynonym: correct || options[0],
        options: options.sort(() => Math.random() - 0.5).slice(0, 3)
      };
    };

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        const jsonStr = extractJSON(raw);
        if (!jsonStr) { lastErr = new Error('PARSE_ERROR: no JSON'); continue; }
        const parsed = JSON.parse(jsonStr);
        const article = String(parsed.article || '').trim();
        const articleCharacterCount = Array.from(article.replace(/\s/g, '')).length;
        const missingWords = cleanWords.filter(w => !article.includes(w.english));
        const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
        if (!article || articleCharacterCount > 450 || missingWords.length || rawQuestions.length < 5) {
          lastErr = new Error('PARSE_ERROR: article or quiz does not meet requirements');
          continue;
        }
        const questions = cleanWords.map((cw, i) => {
          const originalWord = words.find(w => normalizeJapaneseAnswer(w.english) === normalizeJapaneseAnswer(cw.english)) || cw;
          const match = rawQuestions.find(q => normalizeJapaneseAnswer(q?.word) === normalizeJapaneseAnswer(cw.english)) || rawQuestions[i] || {};
          return normalizeQuestion(match, originalWord, i);
        });
        if (questions.every(q => q.correctSynonym && q.options.length === 3)) return { article, questions };
        lastErr = new Error('PARSE_ERROR: invalid questions');
      } catch(err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        if (err instanceof SyntaxError) { lastErr = new Error('PARSE_ERROR: ' + err.message); continue; }
        throw err;
      }
    }
    throw lastErr || new Error('API_ERROR');
  },

  _isLocationError(err) {
    return /user location is not supported|location.*not supported|region.*not supported|failed_precondition/i.test(String(err?.message || err || ''));
  },

  _isAuthError(err) {
    return /api key|apikey|invalid|permission denied|authentication|unauthenticated/i.test(String(err?.message || err || ''));
  },

  _normalizePos(pos) {
    const map = {
      noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', preposition: 'prep.', conjunction: 'conj.',
      pronoun: 'pron.', auxiliary: 'aux.', numeral: 'num.', interjection: 'interj.'
    };
    const key = String(pos || '').toLowerCase().trim();
    return map[key] || key.replace(/\.$/, '') + (key ? '.' : '');
  },

  async _translateWithPublicService(text) {
    const q = String(text || '').trim();
    if (!q) return '';
    const endpoints = [
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en|zh-TW`,
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en|zh-CN`
    ];
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) continue;
        const data = await res.json();
        const translated = data?.responseData?.translatedText || data?.matches?.find(m => m?.translation)?.translation || '';
        const cleaned = String(translated).replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        if (cleaned && cleaned.toLowerCase() !== q.toLowerCase()) return cleaned;
      } catch {}
    }
    return '';
  },

  async _lookupWordPublicFallback(word) {
    const cleanWord = String(word || '').trim().toLowerCase();
    if (!cleanWord) return [];
    let dict = null;
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanWord)}`);
      if (res.ok) dict = await res.json();
    } catch {}

    const entries = [];
    const first = Array.isArray(dict) ? dict[0] : null;
    const phonetic = (first?.phonetic || first?.phonetics?.find(p => p?.text)?.text || '').replace(/^\/+|\/+$/g, '').trim();
    const meanings = Array.isArray(first?.meanings) ? first.meanings : [];
    for (const meaning of meanings.slice(0, 6)) {
      const def = meaning?.definitions?.find(d => d?.definition)?.definition || '';
      const example = meaning?.definitions?.find(d => d?.example)?.example || '';
      const zh = await this._translateWithPublicService(def || cleanWord);
      entries.push({
        english: cleanWord,
        phonetic,
        pos: this._normalizePos(meaning?.partOfSpeech),
        chinese: (zh || await this._translateWithPublicService(cleanWord) || '公開字典查詢結果').replace(/；\s*$/,'').slice(0, 60),
        example: String(example || '').slice(0, 120),
        source: 'public-fallback'
      });
    }

    if (!entries.length) {
      const zh = await this._translateWithPublicService(cleanWord);
      if (zh) entries.push({ english: cleanWord, phonetic: '', pos: '', chinese: zh.slice(0, 60), example: '', source: 'public-fallback' });
    }
    return entries.filter(e => e.english && e.chinese);
  },

  // Look up Japanese vocabulary via AI. Historical field names remain compatible
  // with the existing views: `english` stores Japanese and `phonetic` stores kana.
  async lookupWord(word) {
    const apiKey = DB.getApiKey();
    if (!apiKey) throw new Error('NO_API_KEY');
    const prompt = `You are a Japanese dictionary for Traditional Chinese learners. Look up "${word}" and return its useful Japanese senses as a JSON array.

Each element must have these fields:
- "japanese": the standard Japanese spelling
- "reading": the full reading in hiragana
- "romaji": Hepburn romanization without tone marks
- "pos": concise Traditional Chinese part of speech, such as 名詞、五段動詞、一段動詞、い形容詞、な形容詞、副詞、慣用語
- "chinese": concise Traditional Chinese definition (1-3 meanings separated by semicolons, max 30 chars)
- "example": one short natural Japanese example sentence
- "exampleReading": the example sentence's full kana reading
- "jlpt": one of N5, N4, N3, N2, N1, or 未分級

Return ONLY the JSON array. No markdown, no explanation. Example:
[{"japanese":"食べる","reading":"たべる","romaji":"taberu","pos":"一段動詞","chinese":"吃；食用","example":"毎朝パンを食べます。","exampleReading":"まいあさぱんをたべます。","jlpt":"N5"}]

If the input is not valid Japanese vocabulary, return: []`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1200,
        responseMimeType: 'application/json'
      }
    });

    let lastErr = null;
    for (const model of this._getModelList()) {
      try {
        const raw = await this._callModel(model, body, apiKey);
        if (!raw) { lastErr = new Error('EMPTY_RESPONSE'); continue; }
        // Strip markdown fences/thinking tags and extract the first JSON array.
        let text = String(raw)
          .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
          .replace(/^\s*```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/i, '')
          .trim();
        const start = text.indexOf('['), end = text.lastIndexOf(']');
        if (start === -1 || end === -1 || end <= start) { lastErr = new Error('PARSE_ERROR'); continue; }
        const arr = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(arr)) {
          return arr.map(item => ({
            english:  String(item.japanese || item.english || word || '').trim(),
            phonetic: String(item.reading || item.phonetic || '').trim(),
            reading:  String(item.reading || item.phonetic || '').trim(),
            romaji:   String(item.romaji || '').trim(),
            pos:      String(item.pos || '').trim(),
            chinese:  String(item.chinese || '').trim(),
            example:  String(item.example || '').trim(),
            exampleReading: String(item.exampleReading || '').trim(),
            jlpt: String(item.jlpt || '未分級').trim()
          })).filter(item => item.english && item.chinese);
        }
        lastErr = new Error('NOT_ARRAY');
      } catch(err) {
        if (err.message === 'NETWORK_ERROR') throw err;
        if (err.fallback) { lastErr = err; continue; }
        lastErr = err;
      }
    }
    if (this._isLocationError(lastErr)) {
      const e = new Error('REGION_UNSUPPORTED_NO_FALLBACK');
      e.originalMessage = String(lastErr?.message || '');
      throw e;
    }
    throw lastErr || new Error('API_ERROR');
  }
};

// ===== GOOGLE DRIVE SYNC =====
const GDrive = {
  _token: null,
  _email: null,
  _client: null,
  _clientKey: '',
  _gisPromise: null,
  _silentRestorePromise: null,
  _streakSyncTimer: null,
  _streakSyncPromise: null,
  STUDY_STREAK_FILE: 'japanese_learning_state.json',
  SESSION_KEYS: {
    token: 'japaneseGdriveToken',
    email: 'japaneseGdriveEmail',
    expiry: 'japaneseGdriveExpiry',
    clientId: 'japaneseGdriveSessionClientId',
    scope: 'japaneseGdriveSessionScope',
    lastLogin: 'japaneseGdriveLastLoginAt'
  },
  SCOPE: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
  EXPIRY_MARGIN_MS: 5 * 60 * 1000,
  REQUEST_TIMEOUT_MS: 20000,
  UPLOAD_TIMEOUT_MS: 45000,

  isSignedIn() { return !!this._token && !this._isTokenExpired(); },
  hasRememberedSession() {
    return !!this.getUserEmail() || !!AppStorage.getItem(this.SESSION_KEYS.lastLogin);
  },
  getUserEmail() { return this._email || AppStorage.getItem(this.SESSION_KEYS.email) || ''; },
  getSessionStatus() {
    if (this.isSignedIn()) return 'active';
    return this.hasRememberedSession() ? 'remembered' : 'none';
  },

  _loadGIS() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (this._gisPromise) return this._gisPromise;
    this._gisPromise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        if (error) reject(error);
        else resolve();
      };
      const detect = () => {
        if (window.google?.accounts?.oauth2) finish();
      };
      const timeout = setTimeout(() => finish(new Error('GIS_LOAD_TIMEOUT')), 12000);
      const poll = setInterval(detect, 50);
      let script = document.querySelector('script[data-gis="1"]');
      if (!script) {
        script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.dataset.gis = '1';
        document.head.appendChild(script);
      }
      script.addEventListener('load', detect, { once: true });
      script.addEventListener('error', () => finish(new Error('GIS_LOAD_FAILED')), { once: true });
      detect();
    }).catch(error => {
      this._gisPromise = null;
      throw error;
    });
    return this._gisPromise;
  },

  preload() {
    if (!navigator.onLine || !DB.getGDriveClientId()) return;
    void this._loadGIS().catch(error => {
      console.info('[GDrive] GIS preload deferred:', error.message);
    });
  },

  _progress(options, message, percent = 0) {
    try { options?.onProgress?.({ message, percent }); } catch {}
  },

  async _fetch(url, options = {}, timeoutMs = this.REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('DRIVE_TIMEOUT');
      throw new Error('DRIVE_NETWORK_ERROR: ' + (error?.message || 'Fetch failed'));
    } finally {
      clearTimeout(timeout);
    }
  },

  _sessionClientId() { return AppStorage.getItem(this.SESSION_KEYS.clientId) || ''; },
  _sessionScope() { return AppStorage.getItem(this.SESSION_KEYS.scope) || ''; },
  _expiry() { return parseInt(sessionStorage.getItem(this.SESSION_KEYS.expiry) || '0', 10) || 0; },
  _isTokenExpired() { return !this._token || Date.now() > this._expiry() - this.EXPIRY_MARGIN_MS; },
  _hasSameClientAndScope(clientId) {
    return this._sessionClientId() === clientId && this._sessionScope() === this.SCOPE;
  },

  _saveSession(token, email, expiresIn, clientId) {
    const exp = Date.now() + (Number(expiresIn) || 3500) * 1000;
    this._token = token;
    this._email = email || this.getUserEmail();
    // Access tokens are intentionally session-only and never written to localStorage/IndexedDB.
    sessionStorage.setItem(this.SESSION_KEYS.token, token);
    sessionStorage.setItem(this.SESSION_KEYS.expiry, String(exp));
    AppStorage.setItem(this.SESSION_KEYS.email, this._email || '');
    AppStorage.setItem(this.SESSION_KEYS.clientId, clientId || DB.getGDriveClientId());
    AppStorage.setItem(this.SESSION_KEYS.scope, this.SCOPE);
    AppStorage.setItem(this.SESSION_KEYS.lastLogin, new Date().toISOString());
  },

  _clearTokenOnly() {
    this._token = null;
    sessionStorage.removeItem(this.SESSION_KEYS.token);
    sessionStorage.removeItem(this.SESSION_KEYS.expiry);
  },

  _clearSession() {
    this._token = null;
    this._email = null;
    sessionStorage.removeItem(this.SESSION_KEYS.token);
    sessionStorage.removeItem(this.SESSION_KEYS.expiry);
    [this.SESSION_KEYS.email, this.SESSION_KEYS.clientId, this.SESSION_KEYS.scope, this.SESSION_KEYS.lastLogin]
      .forEach(k => AppStorage.removeItem(k));
  },

  tryRestoreFromStorage() {
    const clientId = DB.getGDriveClientId();
    const token = sessionStorage.getItem(this.SESSION_KEYS.token);
    const email = AppStorage.getItem(this.SESSION_KEYS.email) || '';
    const exp = this._expiry();
    if (email) this._email = email;
    if (!token || !clientId || !this._hasSameClientAndScope(clientId)) return false;
    if (Date.now() > exp - this.EXPIRY_MARGIN_MS) return false;
    this._token = token;
    this._email = email;
    return true;
  },

  _createClient(clientId, callback, errorCallback) {
    this._clientKey = clientId + '|' + this.SCOPE;
    this._client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: this.SCOPE,
      include_granted_scopes: true,
      callback,
      error_callback: errorCallback
    });
    return this._client;
  },

  async _refreshUserEmail(accessToken) {
    try {
      const response = await this._fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + accessToken }
      }, 12000);
      if (!response.ok) return;
      const info = await response.json();
      if (this._token !== accessToken || !info.email) return;
      this._email = info.email;
      AppStorage.setItem(this.SESSION_KEYS.email, info.email);
      this.scheduleStudyStreakSync(500);
    } catch (error) {
      console.info('[GDrive] Account email refresh deferred:', error.message);
    }
  },

  async _requestToken({ promptMode, accountHint = '' } = {}) {
    const clientId = DB.getGDriveClientId();
    if (!clientId) throw new Error('NO_CLIENT_ID');
    await this._loadGIS();
    const hint = accountHint || this.getUserEmail();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new Error('AUTH_TIMEOUT')), 30000);
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err || 'AUTH_FAILED')));
      };
      const handleToken = (resp) => {
        if (settled) return;
        if (resp.error) { fail(new Error(resp.error)); return; }
        settled = true;
        clearTimeout(timer);
        this._saveSession(resp.access_token, this.getUserEmail(), resp.expires_in, clientId);
        resolve();
        // User info is useful for display, but it must not delay login or Drive operations.
        void this._refreshUserEmail(resp.access_token);
      };
      const req = {};
      // An empty prompt is meaningful to Google: it reuses a previously approved
      // account without showing the account chooser. Do not test truthiness here,
      // otherwise GIS falls back to its default `select_account` prompt.
      if (promptMode !== undefined) req.prompt = promptMode;
      if (hint) req.login_hint = hint;
      try {
        const client = this._createClient(
          clientId,
          handleToken,
          e => fail(new Error(e?.type || e?.message || 'AUTH_FAILED'))
        );
        client.requestAccessToken(req);
      } catch (error) {
        fail(error);
      }
    });
  },

  async silentRefresh() {
    // Startup must never display an account chooser or consent dialog. When the
    // Google session cannot be restored without UI, the app remains usable and
    // Drive authorization is deferred to the next user-initiated Drive action.
    await this._requestToken({ promptMode: 'none', accountHint: this.getUserEmail() });
  },

  async signIn() {
    await this._requestToken({ promptMode: 'select_account' });
  },

  async reconnect() {
    await this._requestToken({ promptMode: '', accountHint: this.getUserEmail() });
  },

  async ensureToken(options = {}) {
    const interactive = !!options.interactive;
    if (this.isSignedIn()) return;
    if (this.tryRestoreFromStorage()) return;
    if (interactive) {
      // Keep the token request inside the original tap. A silent attempt followed by
      // a second request loses Safari's user activation and can block the popup.
      await this._requestToken({
        promptMode: this.getUserEmail() ? '' : 'consent select_account',
        accountHint: this.getUserEmail()
      });
      return;
    }
    try { await this.silentRefresh(); }
    catch {
      this._clearTokenOnly();
      throw new Error('TOKEN_EXPIRED');
    }
  },

  async tryRestoreToken() {
    if (this.tryRestoreFromStorage()) return true;
    if (!DB.getGDriveClientId()) return false;
    if (!this.hasRememberedSession()) return false;
    if (this._silentRestorePromise) return this._silentRestorePromise;
    this._silentRestorePromise = (async () => {
      try {
        await this.silentRefresh();
        return true;
      } catch (error) {
        this._clearTokenOnly();
        console.info('[GDrive] Silent account restore deferred:', error?.message || error);
        return false;
      } finally {
        this._silentRestorePromise = null;
      }
    })();
    return this._silentRestorePromise;
  },

  signOut() {
    if (this._token && window.google?.accounts?.oauth2) {
      google.accounts.oauth2.revoke(this._token, () => {});
    }
    this._client = null;
    this._clientKey = '';
    this._silentRestorePromise = null;
    clearTimeout(this._streakSyncTimer);
    this._streakSyncTimer = null;
    this._clearSession();
  },

  _getDeviceId() {
    return getOrCreateJapaneseDeviceId();
  },

  _buildCollections() {
    return {
      words: DB.getWords(),
      history: DB.getHistory(),
      sentences: DB.getSentenceLog(),
      imported: DB.getImportedSentences(),
      boosted: DB.getBoostedWords(),
      readingQuizHistory: DB.getReadingQuizHistory(),
      essayHistory: DB.getEssayHistory(),
      aiAskHistory: DB.getAiAskHistory(),
      studyDays: StudyStreak.getDays(),
      handwritingHistory: KanaProgress.getHistory(),
      kanaReadingHistory: KanaReadingProgress.getHistory(),
      kanaProgress: KanaProgress.getProgress(),
      preferences: [{
        jlptLevel: DB.getJlptLevel(),
        ttsDelay: DB.getTtsDelay(),
        geminiModel: DB.getModel(),
        practice: DB.getPracticePreferenceBundle()
      }]
    };
  },

  _buildPayload() {
    return BackupSchema.attach(this._buildCollections(), {
      appVersion: APP_DISPLAY_VERSION,
      deviceId: this._getDeviceId(),
      revision: Date.now()
    });
  },

  _countPayloadItems(data = {}) {
    return BackupSchema.counts(data);
  },

  _comparePayloads(localData, cloudData) {
    return BackupSchema.compare(localData, cloudData);
  },

  _formatCounts(counts = {}) {
    return [
      '單字 ' + (counts.words || 0),
      '例句 ' + (counts.examples || 0),
      '練習 ' + (counts.practice || 0),
      '加強 ' + (counts.boosted || 0),
      '閱讀測驗 ' + (counts.reading || 0),
      '文章 ' + (counts.essay || 0),
      'AI詢問 ' + (counts.aiAsk || 0),
      '練習天數 ' + (counts.studyDays || 0),
      '五十音手寫 ' + (counts.handwriting || 0),
      '五十音讀音 ' + (counts.kanaReading || 0)
    ].join('・');
  },

  async _listStudyStreakFiles() {
    const q = `name='${this.STUDY_STREAK_FILE}' and mimeType='application/json' and trashed=false`;
    const params = new URLSearchParams({ q, fields: 'files(id,name,createdTime,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: '20' });
    const response = await this._fetch('https://www.googleapis.com/drive/v3/files?' + params, {
      headers: { Authorization: 'Bearer ' + this._token }
    });
    if (!response.ok) {
      if (response.status === 401) this._clearTokenOnly();
      throw new Error('STREAK_LIST_FAILED: ' + response.status);
    }
    return (await response.json()).files || [];
  },

  async _downloadStudyStreakFile(fileId) {
    const response = await this._fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: 'Bearer ' + this._token }
    });
    if (!response.ok) {
      if (response.status === 401) this._clearTokenOnly();
      throw new Error('STREAK_DOWNLOAD_FAILED: ' + response.status);
    }
    const data = await response.json();
    if (!data || data.dataType !== 'japanese-learning-state' || !Array.isArray(data.studyDays)) throw new Error('STREAK_FILE_INVALID');
    return data;
  },

  _buildStudyStreakPayload(studyDays, handwritingHistory = KanaProgress.getHistory()) {
    return {
      dataType: 'japanese-learning-state',
      schemaVersion: 1,
      appVersion: APP_DISPLAY_VERSION,
      deviceId: this._getDeviceId(),
      userEmail: this.getUserEmail(),
      revision: Date.now(),
      updatedAt: new Date().toISOString(),
      studyDays: mergeStudyDays(studyDays),
      handwritingHistory: mergeHandwritingHistory(handwritingHistory),
      kanaProgress: buildKanaProgress(handwritingHistory)
    };
  },

  async _createStudyStreakFile(payload) {
    const boundary = 'streak_boundary_' + Date.now();
    const folderId = DB.getGDriveFolderId();
    const metadata = {
      name: this.STUDY_STREAK_FILE,
      mimeType: 'application/json',
      description: 'Japanese PWA cross-device learning state',
      appProperties: { dataType: 'japanese-learning-state' },
      ...(folderId ? { parents: [folderId] } : {})
    };
    const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
      + JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n'
      + JSON.stringify(payload) + '\r\n--' + boundary + '--';
    const response = await this._fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this._token, 'Content-Type': 'multipart/related; boundary=' + boundary },
      body
    }, this.UPLOAD_TIMEOUT_MS);
    if (!response.ok) {
      if (response.status === 401) this._clearTokenOnly();
      throw new Error('STREAK_CREATE_FAILED: ' + response.status);
    }
    return response.json();
  },

  async _updateStudyStreakFile(fileId, payload) {
    const response = await this._fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + this._token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, this.UPLOAD_TIMEOUT_MS);
    if (!response.ok) {
      if (response.status === 401) this._clearTokenOnly();
      throw new Error('STREAK_UPDATE_FAILED: ' + response.status);
    }
    return response.json();
  },

  async _readStudyStreakFiles(files) {
    const days = [];
    const handwriting = [];
    const results = await Promise.allSettled(files.map(file => this._downloadStudyStreakFile(file.id)));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        days.push(...result.value.studyDays);
        handwriting.push(...(result.value.handwritingHistory || []));
      } else {
        console.warn('[GDrive] Ignored unreadable streak file.', files[index]?.id, result.reason?.message || result.reason);
      }
    });
    return { studyDays: mergeStudyDays(days), handwritingHistory: mergeHandwritingHistory(handwriting) };
  },

  async syncStudyStreak(options = {}) {
    if (this._streakSyncPromise) return this._streakSyncPromise;
    this._streakSyncPromise = (async () => {
      this._progress(options, '確認 Google 授權…', 10);
      await this.ensureToken(options);
      let merged = StudyStreak.getDays();
      let mergedHandwriting = KanaProgress.getHistory();
      this._progress(options, '讀取跨裝置練習資料…', 30);
      let files = await this._listStudyStreakFiles();

      // Two union/write/read passes close the normal race where two devices add
      // different dates at nearly the same time. No side ever overwrites a date
      // that exists on the other side.
      for (let pass = 0; pass < 2; pass++) {
        this._progress(options, pass === 0 ? '合併練習天數…' : '確認雲端資料一致…', pass === 0 ? 45 : 75);
        const cloudState = await this._readStudyStreakFiles(files);
        merged = mergeStudyDays(merged, cloudState.studyDays);
        mergedHandwriting = mergeHandwritingHistory(mergedHandwriting, cloudState.handwritingHistory);
        const payload = this._buildStudyStreakPayload(merged, mergedHandwriting);
        if (!files.length) {
          const created = await this._createStudyStreakFile(payload);
          files = [{ id: created.id, name: this.STUDY_STREAK_FILE }];
        } else {
          await Promise.all(files.map(file => this._updateStudyStreakFile(file.id, payload)));
        }
        const verifiedFiles = await this._listStudyStreakFiles();
        const verifiedState = await this._readStudyStreakFiles(verifiedFiles);
        const verifiedMerge = mergeStudyDays(merged, verifiedState.studyDays);
        const verifiedHandwriting = mergeHandwritingHistory(mergedHandwriting, verifiedState.handwritingHistory);
        files = verifiedFiles;
        if (JSON.stringify(verifiedMerge) === JSON.stringify(merged) && JSON.stringify(verifiedHandwriting) === JSON.stringify(mergedHandwriting)) break;
        merged = verifiedMerge;
        mergedHandwriting = verifiedHandwriting;
      }

      StudyStreak.replace(merged, { markPending: false });
      KanaProgress.saveHistory(mergedHandwriting);
      const syncedAt = new Date().toISOString();
      StudyStreak.markSynced(syncedAt);
      refreshStudyStreakUI();
      this._progress(options, '練習天數同步完成', 100);
      return { studyDays: merged, handwritingHistory: mergedHandwriting, summary: StudyStreak.getSummary(), syncedAt };
    })();
    try { return await this._streakSyncPromise; }
    finally { this._streakSyncPromise = null; }
  },

  scheduleStudyStreakSync(delay = 1200) {
    clearTimeout(this._streakSyncTimer);
    this._streakSyncTimer = null;
    if (!navigator.onLine || !this.hasRememberedSession() || !DB.getGDriveClientId()) return;
    const runWhenPracticeIsIdle = () => {
      // A Drive sync downloads, merges and serializes handwriting history. On
      // iPhone/iPad this can briefly occupy the main thread just as the user
      // starts the next character. Keep the local save immediate, but defer the
      // cloud work until the handwriting/reading input surface is gone.
      if (document.querySelector('.kana-writing-canvas, #kana-reading-answer')) {
        this._streakSyncTimer = setTimeout(runWhenPracticeIsIdle, 2500);
        return;
      }
      this._streakSyncTimer = null;
      void this.syncStudyStreak({ interactive: false }).catch(error => {
        StudyStreak.markPending();
        refreshStudyStreakUI();
        console.warn('[GDrive] Study streak sync deferred.', error.message);
      });
    };
    this._streakSyncTimer = setTimeout(runWhenPracticeIsIdle, delay);
  },

  async upload(options = {}) {
    this._progress(options, '確認 Google 授權…', 10);
    await this.ensureToken(options);
    this._progress(options, '整理本機備份資料…', 30);
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    const data     = this._buildPayload();
    const folderId = DB.getGDriveFolderId();
    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = 'japanese_backup_' + ts + '.json';
    const boundary = 'japanese_boundary_' + Date.now();
    const dataCounts = this._countPayloadItems(data);
    const summary  = {
      words:     dataCounts.words,
      sentences: dataCounts.examples,
      stats:     dataCounts.practice,
      boosted:   dataCounts.boosted,
      reading:   dataCounts.reading,
      essay:     dataCounts.essay,
      aiAsk:     dataCounts.aiAsk,
      studyDays: dataCounts.studyDays,
      handwriting: dataCounts.handwriting,
      total:     dataCounts.total,
      version:   APP_DISPLAY_VERSION
    };
    const metadata = { name: fileName, mimeType: 'application/json', description: JSON.stringify(summary), ...(folderId ? { parents: [folderId] } : {}) };
    const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
      + JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n'
      + JSON.stringify(data) + '\r\n--' + boundary + '--';
    this._progress(options, '上傳至 Google Drive…', 55);
    const r = await this._fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this._token, 'Content-Type': 'multipart/related; boundary=' + boundary },
      body
    }, this.UPLOAD_TIMEOUT_MS);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      if (r.status === 401) { this._clearTokenOnly(); throw new Error('TOKEN_EXPIRED'); }
      throw new Error('UPLOAD_FAILED: ' + (err.error?.message || r.status));
    }
    const now = new Date().toLocaleString('zh-TW');
    DB.setGDriveLastSync(now);
    this._progress(options, '備份上傳完成', 100);
    // The full backup already contains study days. Keep the separate live-state
    // union in the background so it never blocks the user's upload button.
    this.scheduleStudyStreakSync(250);
    return now;
  },

  async listBackups(options = {}) {
    this._progress(options, '確認 Google 授權…', 10);
    await this.ensureToken(options);
    this._progress(options, '讀取雲端備份清單…', 45);
    const folderId = DB.getGDriveFolderId();
    let q = "name contains 'japanese_backup_' and mimeType='application/json' and trashed=false";
    if (folderId) q += " and '" + folderId + "' in parents";
    const params = new URLSearchParams({ q, fields: 'files(id,name,createdTime,description)', orderBy: 'createdTime desc', pageSize: '10' });
    const r = await this._fetch('https://www.googleapis.com/drive/v3/files?' + params, {
      headers: { Authorization: 'Bearer ' + this._token }
    });
    if (!r.ok) {
      if (r.status === 401) { this._clearTokenOnly(); throw new Error('TOKEN_EXPIRED'); }
      throw new Error('LIST_FAILED: ' + r.status);
    }
    const data = await r.json();
    this._progress(options, '備份清單讀取完成', 100);
    return data.files || [];
  },

  async downloadFile(fileId, options = {}) {
    this._progress(options, '確認 Google 授權…', 10);
    await this.ensureToken(options);
    this._progress(options, '下載備份資料…', 50);
    const r = await this._fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
      headers: { Authorization: 'Bearer ' + this._token }
    });
    if (!r.ok) {
      if (r.status === 401) { this._clearTokenOnly(); throw new Error('TOKEN_EXPIRED'); }
      throw new Error('DOWNLOAD_FAILED: ' + r.status);
    }
    const data = await r.json();
    const validation = BackupSchema.validate(data);
    if (!validation.valid) throw new Error('BACKUP_INVALID_' + validation.reason);
    this._progress(options, '備份下載完成', 100);
    return data;
  },

  async autoRestoreIfCloudHasMore(options = {}) {
    const files = await this.listBackups(options);
    const localPayload = this._buildPayload();
    if (!files.length) {
      return { status: 'no_backup', localCounts: this._countPayloadItems(localPayload), cloudCounts: null, file: null };
    }
    const latestFile = files[0];
    const cloudData = await this.downloadFile(latestFile.id, options);
    const comparison = this._comparePayloads(localPayload, cloudData);

    if (comparison.same) {
      return { status: 'same', ...comparison, file: latestFile };
    }
    if (comparison.conflict) {
      return { status: 'conflict', ...comparison, file: latestFile };
    }
    if (!comparison.cloudIsStrictSuperset) {
      return { status: 'skipped', ...comparison, file: latestFile };
    }
    if (AppStorage.getStatus().mode !== 'indexeddb') {
      return { status: 'safety_blocked', ...comparison, file: latestFile };
    }

    await AppStorage.createRecoverySnapshot(localPayload, 'before-auto-cloud-restore');
    const syncedAt = this.applyDownload(cloudData, 'overwrite', { skipSnapshot: true });
    return { status: 'restored', syncedAt, ...comparison, file: latestFile };
  },

  applyDownload(data, mode, options = {}) {
    const validation = BackupSchema.validate(data);
    if (!validation.valid) throw new Error('BACKUP_INVALID_' + validation.reason);
    const normalized = validation.collections;
    if (!options.skipSnapshot) {
      AppStorage.createRecoverySnapshot(this._buildPayload(), 'before-manual-cloud-restore').catch(() => {});
    }
    data = normalized;
    if (mode === 'overwrite') {
      if (Array.isArray(data.words))        AppStorage.setItem('vocabWords',        JSON.stringify(data.words.map(normalizeJapaneseWord)));
      if (Array.isArray(data.history))      AppStorage.setItem('practiceHistory',   JSON.stringify(data.history));
      if (Array.isArray(data.sentences))    AppStorage.setItem('sentenceLog',       JSON.stringify(data.sentences));
      if (Array.isArray(data.imported))     AppStorage.setItem('importedSentences', JSON.stringify(data.imported));
      if (Array.isArray(data.boosted))      AppStorage.setItem('boostedWords',      JSON.stringify(data.boosted));
      if (Array.isArray(data.readingQuizHistory)) AppStorage.setItem('readingQuizHistory', JSON.stringify(data.readingQuizHistory));
      if (Array.isArray(data.essayHistory)) AppStorage.setItem('essayHistory',      JSON.stringify(data.essayHistory));
      if (Array.isArray(data.aiAskHistory)) AppStorage.setItem('aiAskHistory',      JSON.stringify(data.aiAskHistory));
      if (Array.isArray(data.handwritingHistory)) KanaProgress.saveHistory(data.handwritingHistory);
      if (Array.isArray(data.kanaReadingHistory)) KanaReadingProgress.saveHistory(data.kanaReadingHistory);
      if (data.preferences?.[0]) {
        DB.saveJlptLevel(data.preferences[0].jlptLevel || 'N5');
        DB.saveTtsDelay(Number(data.preferences[0].ttsDelay) || 300);
        if (data.preferences[0].geminiModel) DB.saveModel(data.preferences[0].geminiModel);
        if (data.preferences[0].practice) DB.applyPracticePreferenceBundle(data.preferences[0].practice);
      }
      StudyStreak.replace(data.studyDays || [], { markPending: true });
    } else {
      const lw = DB.getWords(); const cw = data.words || [];
      const merged = [...lw]; cw.forEach(w => { const key = String(w.english || w.wordEn || '').toLowerCase(); if (key && !merged.find(x => String(x.english || x.wordEn || '').toLowerCase() === key)) merged.push(w); });
      AppStorage.setItem('vocabWords', JSON.stringify(merged.map(normalizeJapaneseWord)));
      const lh = DB.getHistory(); const ch = data.history || []; const hm = {};
      [...lh, ...ch].forEach(h => { if (!hm[h.date] || h.total > hm[h.date].total) hm[h.date] = h; });
      AppStorage.setItem('practiceHistory', JSON.stringify(Object.values(hm)));
      const ls = DB.getSentenceLog(); const cs = data.sentences || [];
      const ss = new Set(ls.map(s => s.word + s.date));
      AppStorage.setItem('sentenceLog', JSON.stringify([...ls, ...cs.filter(s => !ss.has(s.word + s.date))]));
      const li = DB.getImportedSentences(); const ci = data.imported || [];
      const iss = new Set(li.map(s => s.word + s.english));
      AppStorage.setItem('importedSentences', JSON.stringify([...li, ...ci.filter(s => !iss.has(s.word + s.english))]));
      const lb = new Set(DB.getBoostedWords()); (data.boosted || []).forEach(id => lb.add(id));
      AppStorage.setItem('boostedWords', JSON.stringify([...lb]));
      if (Array.isArray(data.readingQuizHistory)) {
        const lr = DB.getReadingQuizHistory(); const rm = {};
        [...lr, ...data.readingQuizHistory].forEach(h => {
          if (!rm[h.date]) { rm[h.date] = { ...h, sessions: [...(h.sessions||[])] }; }
          else { const ex = new Set((rm[h.date].sessions||[]).map(s => String(s.ts || s.id || ''))); (h.sessions||[]).forEach(s => { const key = String(s.ts || s.id || ''); if (!ex.has(key)) { rm[h.date].sessions.push(s); ex.add(key); } }); }
        });
        AppStorage.setItem('readingQuizHistory', JSON.stringify(Object.values(rm)));
      }
      if (Array.isArray(data.essayHistory)) {
        const le = DB.getEssayHistory(); const em = {};
        [...le, ...data.essayHistory].forEach(h => {
          if (!em[h.date]) { em[h.date] = { ...h, sessions: [...(h.sessions||[])] }; }
          else { const ex = new Set((em[h.date].sessions||[]).map(s => s.ts)); (h.sessions||[]).forEach(s => { if (!ex.has(s.ts)) { em[h.date].sessions.push(s); ex.add(s.ts); } }); }
        });
        AppStorage.setItem('essayHistory', JSON.stringify(Object.values(em)));
      }
      if (Array.isArray(data.aiAskHistory)) {
        const la = DB.getAiAskHistory(); const as = new Set(la.map(e => e.id));
        AppStorage.setItem('aiAskHistory', JSON.stringify([...la, ...data.aiAskHistory.filter(e => !as.has(e.id))]));
      }
      if (Array.isArray(data.handwritingHistory)) KanaProgress.mergeRemote(data.handwritingHistory);
      if (Array.isArray(data.kanaReadingHistory)) KanaReadingProgress.mergeRemote(data.kanaReadingHistory);
      if (data.preferences?.[0] && !AppStorage.getItem('japaneseJlptLevel')) DB.saveJlptLevel(data.preferences[0].jlptLevel || 'N5');
      if (data.preferences?.[0]?.practice) {
        const remotePractice = data.preferences[0].practice;
        if (!AppStorage.getItem('lastPracticeMode') && remotePractice.lastPracticeMode) DB.saveLastPracticeMode(remotePractice.lastPracticeMode);
        if (!AppStorage.getItem('wordPracticePreferencesV1') && remotePractice.wordPractice) DB.saveWordPracticePreferences(remotePractice.wordPractice);
        if (!AppStorage.getItem('kanaPracticePreferencesV1') && remotePractice.kanaPractice) DB.saveKanaPracticePreferences(remotePractice.kanaPractice);
        if (!AppStorage.getItem('kanaReadingPreferencesV1') && remotePractice.kanaReading) DB.saveKanaReadingPreferences(remotePractice.kanaReading);
        if (!AppStorage.getItem('dailyLearningPreferencesV1') && remotePractice.dailyLearning) DB.saveDailyLearningPreferences(remotePractice.dailyLearning);
      }
      StudyStreak.merge(data.studyDays || [], { markPending: true });
    }
    const now = new Date().toLocaleString('zh-TW');
    DB.setGDriveLastSync(now);
    refreshStudyStreakUI();
    this.scheduleStudyStreakSync(300);
    return now;
  }
};

// ===== UTILITIES =====
function showToast(msg, duration = 2200) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id='toast'; t.setAttribute('role','status'); t.setAttribute('aria-live','polite'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}
function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function nl2br(value) { return escapeHTML(value).replace(/\n/g, '<br>'); }
function escapeAttr(value) { return escapeHTML(value).replace(/`/g, '&#96;'); }
const Modal = {
  show(html) {
    const o = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    content.innerHTML = html;
    o.classList.remove('hidden');
    o.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => content.querySelector('button, input, select, textarea, [tabindex]')?.focus());
    o.onclick = (e) => { if (e.target === o) this.hide(); };
  },
  hide() { const o = document.getElementById('modal-overlay'); o.classList.add('hidden'); o.setAttribute('aria-hidden','true'); }
};
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function selectWords(count, mode, boostedIds) {
  const all = DB.getWords(); if (!all.length) return [];
  let pool = mode === 'newest' ? [...all].sort((a,b)=>b.id-a.id).slice(0,Math.max(count*2,30)) : [...all];
  const weighted = [];
  pool.forEach(w => { const wt = boostedIds.includes(w.id)?(w.frequencyWeight||1)*3:(w.frequencyWeight||1); for(let i=0;i<wt;i++) weighted.push(w); });
  const selected=[], usedIds=new Set(), shuffled=[...weighted].sort(()=>Math.random()-0.5);
  for(const w of shuffled) { if(!usedIds.has(w.id)){ usedIds.add(w.id); selected.push(w); if(selected.length>=count)break;} }
  return selected;
}
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function highlightEn(text, word) {
  const safeText = escapeHTML(text);
  if (!word || !safeText) return safeText;
  const safeWord = escapeHTML(word);
  return safeText.replace(new RegExp(`(${escapeRegex(safeWord)})`, 'gi'), '<span class="hl-en">$1</span>');
}
function highlightZh(text, wordZh) {
  const safeText = escapeHTML(text);
  if (!wordZh || !safeText) return safeText;
  const tokens = String(wordZh).split(/[、，,；;／/\s]+/)
    .map(t => t.replace(/[（(）)【】「」『』""''<>]/g,'').trim())
    .filter(t => t.length >= 2)
    .map(t => escapeHTML(t));
  if (!tokens.length) return safeText;
  tokens.sort((a,b) => b.length - a.length);
  const pattern = tokens.map(t => escapeRegex(t)).join('|');
  return safeText.replace(new RegExp(`(${pattern})`, 'g'), '<span class="hl-zh">$1</span>');
}
const TTS = {
  _synth: window.speechSynthesis || null,
  _enabled: AppStorage.getItem('ttsEnabled') !== 'false',

  get enabled() { return this._enabled; },
  set enabled(v) { this._enabled = v; AppStorage.setItem('ttsEnabled', v); },

  cancelPending() {
    if (this._synth) this._synth.onvoiceschanged = null;
  },

  stop() {
    if (!this._synth) return;
    this._synth.onvoiceschanged = null;
    this._synth.cancel();
  },

  speak(text, rate = 0.85, options = {}) {
    const force = options?.force === true;
    if (!this._synth || (!this._enabled && !force)) return false;
    this._synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ja-JP'; utter.rate = rate; utter.pitch = 1.0; utter.volume = 1.0;
    const voices = this._synth.getVoices();
    const preferred = voices.find(v => /^ja/i.test(v.lang) &&
      /Kyoko|O-ren|Hattori|Google 日本語|Japanese/i.test(v.name)
    ) || voices.find(v => /^ja-JP/i.test(v.lang)) || voices.find(v => /^ja/i.test(v.lang));
    if (preferred) utter.voice = preferred;
    this._synth.speak(utter);
    return true;
  },

  speakWhenReady(text, rate = 0.85, options = {}) {
    const force = options?.force === true;
    if (!this._synth || (!this._enabled && !force)) return false;
    const voices = this._synth.getVoices();
    if (voices.length > 0) {
      return this.speak(text, rate, options);
    } else {
      this._synth.onvoiceschanged = () => { this.speak(text, rate, options); this._synth.onvoiceschanged = null; };
      return true;
    }
  },

  speakKana(text, rate = 0.62, { immediate = false } = {}) {
    // Handwriting pronunciation has its own saved preference, independent of
    // the spelling quiz TTS switch. A direct call preserves the user gesture on
    // iPhone/iPad; the ready path is retained for manual replay.
    return immediate
      ? this.speak(text, rate, { force: true })
      : this.speakWhenReady(text, rate, { force: true });
  }
};

// ===== ROUTER — FIX: quiz guard applies to ALL nav clicks including practice =====
const Router = {
  currentView: 'home',
  quizActive: false,
  essayActive: false,
  handwritingActive: false,
  navigate(view, params = {}, force = false) {
    // Block ALL navigation (even back to practice) when quiz is active
    if ((this.quizActive || this.essayActive || this.handwritingActive) && !force) {
      const isEssay = this.essayActive && !this.quizActive;
      const isHandwriting = this.handwritingActive;
      // If already on that view AND quiz is active → show warning
      Modal.show(`
        <div class="modal-handle"></div>
        <div class="modal-title">⚠️ ${isEssay ? "文章撰寫中" : isHandwriting ? "五十音書寫中" : "測驗進行中"}</div>
        <p style="color:var(--text-muted);font-size:14px;margin-bottom:16px">
          ${isEssay ? "離開將會中斷目前的文章撰寫，<br>已輸入的內容將不會被儲存。" : isHandwriting ? "離開將會中斷目前的五十音書寫，<br>尚未評分的字不會被記錄。" : "離開將會中斷目前的測驗，<br>進度將不會被記錄。"}確定要離開嗎？
        </p>
        <div class="modal-actions">
          <button class="modal-btn-cancel" id="stay-btn">${isEssay ? "繼續撰寫" : isHandwriting ? "繼續書寫" : "繼續測驗"}</button>
          <button class="modal-btn-delete" id="leave-btn">${isEssay ? "離開撰寫" : isHandwriting ? "離開書寫" : "離開測驗"}</button>
        </div>
      `);
      document.getElementById('stay-btn').addEventListener('click', () => Modal.hide());
      document.getElementById('leave-btn').addEventListener('click', () => {
        Modal.hide(); this.quizActive = false; this.essayActive = false; this.handwritingActive = false; this._doNavigate(view, params);
      });
      return;
    }
    this._doNavigate(view, params);
  },
  _doNavigate(view, params) {
    if (this.currentView === 'practice') Views.practice?.cleanupQuiz?.();
    if (this.currentView === 'kanaPractice' || this.handwritingActive || document.documentElement.classList.contains('kana-view-active')) Views.kanaPractice?.cleanup?.();
    const activeNavView = ['practice', 'kanaPractice', 'essay', 'readingQuiz', 'aiAsk'].includes(view) ? 'practice' : view;
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === activeNavView));
    this.currentView = view;
    const container = document.getElementById('view-container');
    container.innerHTML = '';
    const viewDiv = document.createElement('div');
    viewDiv.id = `${view}-view`; viewDiv.className = 'view-enter';
    container.appendChild(viewDiv);
    Views[view].render(viewDiv, params);
    setTimeout(() => {
      window.updateScrollFabs?.();
      resumeAppUpdateWhenSafe();
    }, 0);
  }
};

// ===== VIEWS =====
const Views = {};

// ===========================
// HOME VIEW
// ===========================
Views.home = {
  render(container) {
    const streak = StudyStreak.getSummary();
    const dailyPreferences = DB.getDailyLearningPreferences();
    const levelLearning = dailyPreferences.source === DAILY_LEARNING_SOURCES.LEVEL;
    container.innerHTML = `
      <div id="home-view">
        <section class="study-streak-card" aria-labelledby="study-streak-title">
          <div class="study-streak-heading">
            <div class="study-streak-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2s1 4-2 6c-2 1-3-1-3-1s-4 4-2 9a6 6 0 0 0 12 0c1-4-2-7-5-8 1-2 0-4 0-6z"/><path d="M10 17c0 1.1.9 2 2 2s2-.9 2-2c0-1-.7-1.7-1.5-2.3-.1.8-.6 1.3-1.2 1.5-.5.1-.9-.2-1.1-.6-.1.4-.2.9-.2 1.4z"/></svg>
            </div>
            <div>
              <div class="study-streak-title" id="study-streak-title">累積練習天數</div>
              <div class="study-streak-today ${streak.practicedToday ? 'is-complete' : ''}" id="streak-today-state">${streak.practicedToday ? '今天已完成練習' : '今天尚未完成練習'}</div>
            </div>
            <div class="study-streak-total"><strong id="streak-total-days">${streak.totalDays}</strong><span>累積天數</span></div>
          </div>
          <div class="study-streak-metrics">
            <div class="study-streak-metric is-current">
              <span>連續練習天數</span>
              <strong><b id="streak-current-days">${streak.current}</b> 天</strong>
            </div>
            <div class="study-streak-divider" aria-hidden="true"></div>
            <div class="study-streak-metric">
              <span>歷史最久練習天數</span>
              <strong><b id="streak-longest-days">${streak.longest}</b> 天</strong>
            </div>
          </div>
        </section>
        <div class="home-hero" id="hero-card">
          <div class="hero-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            <span>${levelLearning ? '今日推薦單字' : '今日例句'}</span>
            <small class="hero-learning-context">${levelLearning ? `JLPT ${escapeHTML(dailyPreferences.level)}・${escapeHTML(selectedLearningRowLabel(dailyPreferences.rows))}` : '來源：單字庫'}</small>
          </div>
          <div id="hero-content">
            <div class="hero-idle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:28px;height:28px;opacity:0.35;display:block;margin:0 auto 8px"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg><div style="font-size:12px;opacity:0.5">${levelLearning ? '正在準備今日推薦單字…' : '點右上角 ↻ 生成今日例句'}</div></div>
          </div>
          <button class="hero-refresh-btn" id="hero-refresh" title="強制重新生成">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
        </div>
        <div class="home-menu-grid">
          <div class="menu-card" data-nav="practice">
            <div class="menu-icon" style="background:#e3f2fd"><svg viewBox="0 0 24 24" fill="none" stroke="#1565c0" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></div>
            <div><div class="menu-card-title">日文練習</div><div class="menu-card-sub">語彙拼寫與閱讀測驗</div></div>
          </div>
          <div class="menu-card" data-nav="kanaPractice">
            <div class="menu-icon" style="background:#e8eafc;color:#3949ab;font-size:25px;font-weight:800">あ</div>
            <div><div class="menu-card-title">五十音手寫</div><div class="menu-card-sub">平假名・片假名・Apple Pencil</div></div>
          </div>
          <div class="menu-card" data-nav="database">
            <div class="menu-icon" style="background:#e8f0ff"><svg viewBox="0 0 24 24" fill="none" stroke="#3366cc" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></div>
            <div><div class="menu-card-title">資料庫</div><div class="menu-card-sub">管理單字資料</div></div>
          </div>
          <div class="menu-card" data-nav="stats">
            <div class="menu-icon" style="background:#fff3e0"><svg viewBox="0 0 24 24" fill="none" stroke="#e67e00" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div>
            <div><div class="menu-card-title">練習統計</div><div class="menu-card-sub">近期練習情形</div></div>
          </div>
          <div class="menu-card" data-nav="settings">
            <div class="menu-icon" style="background:#f0e8ff"><svg viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></div>
            <div><div class="menu-card-title">設定</div><div class="menu-card-sub">API Key 與例句匯入</div><div class="menu-card-ver">版本別：${APP_VERSION}</div></div>
          </div>
        </div>
        <div class="sentence-log-section">
          <div class="sentence-log-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            每日例句記錄
          </div>
          <div id="sentence-log-content"></div>
        </div>
        <div style="height:8px"></div>
      </div>
    `;
    container.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => {
      const target = el.dataset.nav;
      Router.navigate(target, target === 'practice' ? { restoreLast: true } : {});
    }));
    document.getElementById('hero-refresh').addEventListener('click', () => this.loadHero(true));
    if (levelLearning) {
      const cached = DB.getTodayDailyVocabulary();
      if (cached) {
        this.displayDailyVocabulary(cached);
        queueMicrotask(() => this.ensureDailyVocabularySentence(cached));
      }
      else queueMicrotask(() => this.loadDailyVocabulary(false));
    } else {
      // 單字庫模式沿用既有流程，不會自動消耗 AI 配額。
      const cached = DB.getTodaySentenceAny();
      if (cached) this.displaySentence(cached);
    }
    this.renderSentenceLog();
    refreshStudyStreakUI();
  },
  loadHero(forceNew) {
    const preferences = DB.getDailyLearningPreferences();
    return preferences.source === DAILY_LEARNING_SOURCES.LEVEL
      ? this.loadDailyVocabulary(forceNew)
      : this.loadSentence(forceNew);
  },
  async loadDailyVocabulary(forceNew = false) {
    const heroContent = document.getElementById('hero-content');
    if (!heroContent) return;
    const cached = DB.getTodayDailyVocabulary();
    if (!forceNew && cached) { this.displayDailyVocabulary(cached); return; }
    if (!DB.getApiKey()) {
      heroContent.innerHTML = '<div class="daily-vocab-message">請先在設定頁填入 Gemini API Key，才能依等級產生推薦單字。</div>';
      return;
    }
    const preferences = DB.getDailyLearningPreferences();
    heroContent.innerHTML = '<div class="hero-loading"><div class="loading-dots"><span></span><span></span><span></span></div><span>正在產生今日推薦單字…</span></div>';
    try {
      const words = await Gemini.generateDailyVocabulary(preferences);
      if (!words.length) throw new Error('PARSE_ERROR');
      if (!document.getElementById('hero-content')) return;
      const saved = DB.saveTodayDailyVocabulary(words);
      this.displayDailyVocabulary(saved);
      await this.ensureDailyVocabularySentence(saved);
    } catch (error) {
      if (!document.getElementById('hero-content')) return;
      let message = '推薦單字產生失敗，請點右上角重試。';
      if (error.message === 'NO_API_KEY') message = '請先在設定頁填入 Gemini API Key。';
      else if (error.message === 'NETWORK_ERROR') message = '目前無法連線 Gemini，請確認網路後重試。';
      else if (/quota|RESOURCE_EXHAUSTED|429/i.test(error.message || '')) message = 'Gemini 今日配額暫時不足，請稍後再試。';
      else if (/API_KEY_INVALID|403|permission/i.test(error.message || '')) message = 'Gemini API Key 無效或沒有權限，請到設定頁確認。';
      heroContent.innerHTML = `<div class="daily-vocab-message">${escapeHTML(message)}</div>`;
    }
  },
  displayDailyVocabulary(data) {
    const heroContent = document.getElementById('hero-content');
    if (!heroContent) return;
    const words = Array.isArray(data?.words) ? data.words : [];
    if (!words.length) {
      heroContent.innerHTML = '<div class="daily-vocab-message">尚無今日推薦單字，請點右上角重新產生。</div>';
      return;
    }
    heroContent.innerHTML = `
      <div class="daily-vocab-grid">
        ${words.map((word, index) => `
          <article class="daily-vocab-card">
            <div class="daily-vocab-index">${index + 1}</div>
            <div class="daily-vocab-main">
              <div class="daily-vocab-word">${escapeHTML(word.word)}</div>
              <div class="daily-vocab-reading">${escapeHTML(word.reading)} <span>${escapeHTML(word.romaji)}</span></div>
              <div class="daily-vocab-meaning">${escapeHTML(word.meaning)}</div>
            </div>
            <div class="daily-vocab-side">
              <span>${escapeHTML(word.partOfSpeech || '語彙')}</span>
              <button type="button" class="daily-vocab-speak" data-daily-speak="${escapeAttr(word.reading)}" aria-label="播放 ${escapeAttr(word.reading)} 發音">🔊</button>
            </div>
          </article>
        `).join('')}
      </div>
      <div class="daily-vocab-foot">JLPT ${escapeHTML(data.level || DB.getJlptLevel())}・${escapeHTML(selectedLearningRowLabel(data.rows || ['all']))}・每日一詞</div>
      <div class="daily-vocab-sentence-status" id="daily-vocab-sentence-status" role="status" aria-live="polite">正在同步至每日例句…</div>`;
    heroContent.querySelectorAll('[data-daily-speak]').forEach(button => {
      button.addEventListener('click', () => TTS.speakKana(button.dataset.dailySpeak, 0.72, { immediate: true }));
    });
  },
  async ensureDailyVocabularySentence(data) {
    const word = Array.isArray(data?.words) ? data.words[0] : null;
    if (!word?.word) return null;
    const status = document.getElementById('daily-vocab-sentence-status');
    const existing = DB.getCombinedSentenceLog().find(entry =>
      entry?.date === todayStr() && normalizeJapaneseAnswer(entry?.wordEn) === normalizeJapaneseAnswer(word.word)
    );
    if (existing) {
      DB.saveTodaySentence(existing);
      if (status) status.textContent = '已儲存至今日例句練習';
      return existing;
    }
    if (status) status.textContent = '正在建立並儲存今日例句…';
    try {
      const result = await Gemini.generateSentence({
        english: word.word,
        reading: word.reading || '',
        romaji: word.romaji || '',
        partOfSpeech: word.partOfSpeech || '語彙',
        chinese: word.meaning || ''
      });
      if (!result?.en || !result?.zh) throw new Error('PARSE_ERROR');
      const entry = {
        date: todayStr(),
        wordEn: word.word,
        wordZh: word.meaning || '',
        wordPos: word.partOfSpeech || '語彙',
        wordReading: word.reading || '',
        wordRomaji: word.romaji || '',
        en: result.en,
        reading: result.reading || '',
        zh: result.zh,
        source: 'daily-recommendation'
      };
      DB.saveTodaySentence(entry);
      DB.saveSentenceToLog(entry);
      this.renderSentenceLog();
      if (status) status.textContent = '已儲存至今日例句練習';
      return entry;
    } catch (error) {
      if (status) status.textContent = '推薦詞已保存；例句建立失敗，可點右上角重試';
      return null;
    }
  },
  async loadSentence(forceNew) {
    const heroContent = document.getElementById('hero-content');
    if (!heroContent) return;
    // If not force, show cached and stop — user must press ↻ to generate
    if (!forceNew) {
      const cached = DB.getTodaySentenceAny();
      if (cached) { this.displaySentence(cached); }
      return;
    }
    // Check prerequisites before calling API
    if (!DB.getApiKey()) {
      heroContent.innerHTML = `<div style="font-size:13px;opacity:0.8">請先在設定頁填入 Gemini API Key</div>`;
      return;
    }
    const words = DB.getWords();
    if (!words.length) { heroContent.innerHTML = `<div style="font-size:13px;opacity:0.8">請先在資料庫新增單字</div>`; return; }
    heroContent.innerHTML = `<div class="hero-loading"><div class="loading-dots"><span></span><span></span><span></span></div><span>正在生成例句...</span></div>`;
    try {
      const word = words[Math.floor(Math.random() * words.length)];
      const result = await Gemini.generateSentence(word);
      if (!result.en || !result.zh) throw new Error('Invalid');
      if (!document.getElementById('hero-content')) return;
      const entry = { date: todayStr(), wordEn: word.english, wordZh: word.chinese, wordPos: word.partOfSpeech, en: result.en, reading: result.reading || '', zh: result.zh };
      DB.saveTodaySentence(entry); DB.saveSentenceToLog(entry);
      this.displaySentence(entry); this.renderSentenceLog();
    } catch(e) {
      if (!document.getElementById('hero-content')) return;
      let errText = '例句生成失敗，請點右上角重試';
      if (e.message === 'NO_API_KEY') errText = '請先在設定頁填入 Gemini API Key';
      else if (e.message === 'NETWORK_ERROR') errText = '網路連線失敗，請確認網路狀態後重試';
      else if (e.message === 'PARSE_ERROR') errText = 'AI 回應格式異常，請重試';
      else if (e.message) {
        const m = e.message;
        if (m.includes('quota') || m.includes('Quota') || m.includes('RESOURCE_EXHAUSTED')) errText = '⏳ API 配額已用盡，請稍後再試';
        else if (m.includes('API_KEY_INVALID') || m.includes('invalid')) errText = '🔑 API Key 無效，請重新確認';
        else if (m.includes('403') || m.includes('permission')) errText = '🔑 API Key 無權限，請確認設定';
        else if (m.includes('429')) errText = '⏳ 請求過於頻繁，請稍後再試';
        else errText = '⚠️ API 暫時無法使用，請稍後重試';
      }
      heroContent.innerHTML = `<div style="font-size:13px;opacity:0.85;line-height:1.6">${escapeHTML(errText)}<br><span style="font-size:11px;opacity:0.6">點右上角 ↻ 重試</span></div>`;
    }
  },
  displaySentence(entry) {
    const heroContent = document.getElementById('hero-content');
    if (!heroContent) return;
    const sourceTag = entry.source === 'csv'
      ? `<span class="hero-source-tag">📄 CSV</span>`
      : entry.source === 'daily-recommendation'
        ? `<span class="hero-source-tag">🌱 每日推薦</span>`
        : `<span class="hero-source-tag">✨ AI</span>`;
    heroContent.innerHTML = `
      <div class="hero-sentence">
        <div>${highlightEn(entry.en, entry.wordEn)}</div>
        ${entry.reading ? `<div class="japanese-reading">${escapeHTML(entry.reading)}</div>` : ''}
        <span class="zh-text">${highlightZh(entry.zh, entry.wordZh)}</span>
        <div style="margin-top:8px;display:flex;align-items:center;gap:6px">
          <span class="log-word-chip" style="margin:0">${escapeHTML(entry.wordEn)} <span style="opacity:0.6;font-size:10px">${escapeHTML(entry.wordPos||'')}</span></span>
          ${sourceTag}
        </div>
      </div>`;
  },
  renderSentenceLog() {
    const logContent = document.getElementById('sentence-log-content');
    if (!logContent) return;
    const log = DB.getCombinedSentenceLog();
    if (!log.length) {
      logContent.innerHTML = `<div class="log-empty">尚無例句記錄<br><span style="font-size:12px">可生成 AI 例句，或在設定頁匯入 CSV 例句</span></div>`;
      return;
    }
    // Show all entries in a scrollable container (shows ~4 at a time)
    logContent.innerHTML = `<div class="sentence-log-scroll">${log.map(entry => `
      <div class="log-entry-card">
        <div class="log-entry-header">
          <span class="log-date">${escapeHTML(entry.date)}</span>
          <span class="log-word-chip">${escapeHTML(entry.wordEn)} <span style="opacity:0.6;font-size:10px">${escapeHTML(entry.wordPos||'')}</span></span>
          ${entry.source === 'csv' ? `<span class="log-source-csv">CSV</span>` : entry.source === 'daily-recommendation' ? `<span class="log-source-csv">每日推薦</span>` : ''}
        </div>
        <div class="log-entry-en">${highlightEn(entry.en, entry.wordEn)}</div>
        ${entry.reading ? `<div class="japanese-reading">${escapeHTML(entry.reading)}</div>` : ''}
        <div class="log-entry-zh">${highlightZh(entry.zh, entry.wordZh)}</div>
      </div>`).join('')}</div>`;
  }
};


// ===========================
// PRACTICE MODE SELECTOR — shared by quiz / essay / AI ask
// ===========================
function renderPracticeModeSelector(currentMode = 'quiz') {
  DB.saveLastPracticeMode(currentMode);
  const isQuiz = currentMode === 'quiz';
  const isKana = currentMode === 'kana';
  const isKanaReading = currentMode === 'kanaReading';
  const isEssay = currentMode === 'essay';
  const isReading = currentMode === 'reading';
  const isAiAsk = currentMode === 'aiask';
  return `
    <div class="practice-mode-bar">
      <select class="practice-mode-select" id="practice-mode-select" aria-label="選擇練習模式">
        <option value="quiz" ${isQuiz ? 'selected' : ''}>📝 單字拼寫</option>
        <option value="kana" ${isKana ? 'selected' : ''}>🖌️ 五十音手寫</option>
        <option value="kanaReading" ${isKanaReading ? 'selected' : ''}>🔤 五十音讀音</option>
        <option value="essay" ${isEssay ? 'selected' : ''}>✍️ 文章撰寫</option>
        <option value="reading" ${isReading ? 'selected' : ''}>📖 文章閱讀測驗</option>
        <option value="aiask" ${isAiAsk ? 'selected' : ''}>💬 AI 詢問</option>
      </select>
    </div>`;
}

function renderPracticeModeInContainer(container, mode) {
  if (mode === 'kana') Views.kanaPractice.render(container);
  else if (mode === 'kanaReading') Views.kanaReadingPractice.render(container);
  else if (mode === 'essay') Views.essay.render(container);
  else if (mode === 'reading') Views.readingQuiz.render(container);
  else if (mode === 'aiask') Views.aiAsk.render(container);
  else Views.practice.render(container);
}

function bindPracticeModeSelector(container, currentMode = 'quiz') {
  const selector = container.querySelector('#practice-mode-select');
  if (!selector) return;
  selector.addEventListener('change', (e) => {
    const mode = e.target.value;
    if (mode === currentMode) return;
    DB.saveLastPracticeMode(mode);
    Router.essayActive = false;
    Router.quizActive = false;
    Router.handwritingActive = false;
    Views.kanaPractice?.cleanup?.();
    Views.kanaReadingPractice?.cleanup?.();
    renderPracticeModeInContainer(container, mode);
  });
}

// ===========================
// PRACTICE VIEW
// ===========================
Views.practice = {
  state: { selectedCount: 10, selectedMode: 'all', phase: 'setup', words: [], currentIdx: 0, wrongWords: [], showAnswer: false, waitingRetype: false },
  _pendingWrongIds: new Set(),
  _ttsTimer: null,
  _retryTimer: null,
  _answerTimer: null,
  _resultTimer: null,
  _sessionSaveTimer: null,
  _pendingSessionSave: null,
  _canQueueAdvance: false,
  _queuedAdvance: false,
  _questionToken: 0,

  _clearTimer(name) {
    if (this[name] === null) return;
    clearTimeout(this[name]);
    this[name] = null;
  },

  _clearQuestionTimers() {
    this._clearTimer('_ttsTimer');
    this._clearTimer('_retryTimer');
    this._clearTimer('_answerTimer');
    this._clearTimer('_resultTimer');
    TTS.cancelPending();
  },

  _detachGhostHandlers(ghost) {
    if (!ghost) return;
    [
      ['beforeinput', '_beforeInputH'],
      ['input', '_inputH'],
      ['keydown', '_keydownH'],
      ['compositionstart', '_compositionStartH'],
      ['compositionend', '_compositionEndH']
    ].forEach(([type, key]) => {
      if (ghost[key]) ghost.removeEventListener(type, ghost[key]);
      ghost[key] = null;
    });
    if (this._enterNextH) {
      ghost.removeEventListener('keydown', this._enterNextH);
      this._enterNextH = null;
    }
  },

  _focusGhost() {
    const ghost = this._ghost;
    if (!ghost?.isConnected || document.activeElement === ghost) return;
    try { ghost.focus({ preventScroll: true }); }
    catch { ghost.focus(); }
  },

  _recordWrong(word) {
    if (word?.id !== undefined && word?.id !== null) this._pendingWrongIds.add(String(word.id));
  },

  _flushWrongCounts() {
    if (!this._pendingWrongIds.size) return;
    DB.incrementWrongCounts([...this._pendingWrongIds]);
    this._pendingWrongIds.clear();
  },

  _persistPendingSession() {
    if (this._sessionSaveTimer !== null) {
      clearTimeout(this._sessionSaveTimer);
      this._sessionSaveTimer = null;
    }
    const save = this._pendingSessionSave;
    this._pendingSessionSave = null;
    if (save) save();
  },

  cleanupQuiz() {
    const ghost = this._ghost || document.getElementById('quiz-ghost-input');
    const hadActiveQuiz = !!ghost || this.state.phase === 'quiz';
    this._questionToken++;
    this._persistPendingSession();
    this._clearQuestionTimers();
    this._flushWrongCounts();
    this._detachGhostHandlers(ghost);
    if (ghost) {
      ghost.style.pointerEvents = 'none';
      ghost.blur();
      ghost.remove();
    }
    this._ghost = null;
    this._canQueueAdvance = false;
    this._queuedAdvance = false;
    if (hadActiveQuiz) TTS.stop();
    Router.quizActive = false;
    resumeAppUpdateWhenSafe();
  },

  render(container, options = {}) {
    this.cleanupQuiz();
    if (options?.restoreLast) {
      const lastMode = DB.getLastPracticeMode();
      if (lastMode !== 'quiz') {
        renderPracticeModeInContainer(container, lastMode);
        return;
      }
    }
    this.state.phase = 'setup';
    this.renderSetup(container);
    setTimeout(resumeAppUpdateWhenSafe, 0);
  },
  renderSetup(container) {
    Router.quizActive = false;
    const savedPreferences = DB.getWordPracticePreferences();
    this.state.selectedCount = savedPreferences.count;
    this.state.selectedMode = savedPreferences.order;
    const totalWords = DB.getWords().length;
    const savedDelay = DB.getTtsDelay();
    const orderLabel = this.state.selectedMode === 'newest' ? '最新' : '隨機';
    const delayLabel = savedDelay === 0 ? '立即' : savedDelay < 1000 ? `${savedDelay}ms` : `${savedDelay / 1000}s`;
    container.innerHTML = `
      <div class="practice-compact-page word-practice-page">
      <div class="section-header practice-page-header"><h1 class="section-title">練習</h1></div>
      ${renderPracticeModeSelector('quiz')}
      <section class="practice-compact-card word-practice-setup-card">
        <div class="practice-compact-heading">
          <div class="practice-compact-mark" aria-hidden="true">日</div>
          <div><h2>單字拼寫練習</h2><p>選擇題數、出題順序與發音延遲後開始練習。</p></div>
        </div>
        <div class="practice-summary-strip" aria-label="單字拼寫設定摘要">
          <div><strong>${totalWords}</strong><span>題庫</span></div>
          <div><strong id="word-summary-count">${this.state.selectedCount}</strong><span>題數</span></div>
          <div><strong id="word-summary-order">${orderLabel}</strong><span>順序</span></div>
          <div><strong id="word-summary-delay">${delayLabel}</strong><span>延遲</span></div>
        </div>
        ${totalWords === 0 ? `<div class="no-api-warning"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>資料庫尚無單字，請先新增單字</div>` : ''}
        <div class="option-group practice-compact-group">
          <div class="option-label">練習題數</div>
          <div class="option-chips practice-six-grid">${[5,10,15,20,25,30].map(n=>`<button class="chip ${n===this.state.selectedCount?'selected':''}" data-count="${n}">${n}</button>`).join('')}</div>
        </div>
        <div class="option-group practice-compact-group">
          <div class="option-label">出題順序</div>
          <div class="option-radio-group practice-two-grid">
            <div class="radio-option ${this.state.selectedMode==='newest'?'selected':''}" data-mode="newest"><div class="radio-circle"></div><div><div class="radio-text">從最新加入開始</div><div class="radio-sub">依最近加入的單字優先出題</div></div></div>
            <div class="radio-option ${this.state.selectedMode==='all'?'selected':''}" data-mode="all"><div class="radio-circle"></div><div><div class="radio-text">全部隨機</div><div class="radio-sub">從題庫所有單字中隨機出題</div></div></div>
          </div>
        </div>
        <div class="option-group practice-compact-group">
          <div class="option-label">唸單字延遲</div>
          <div class="option-chips practice-five-grid">
            ${[0,300,600,1000,2000].map(ms => {
              const label = ms === 0 ? '立即' : ms < 1000 ? ms+'ms' : (ms/1000)+'s';
              return `<button class="chip ${ms === savedDelay ? 'selected' : ''}" data-tts-delay="${ms}">${label}</button>`;
            }).join('')}
          </div>
        </div>
        <button class="btn-primary" id="start-btn" ${totalWords===0?'disabled':''}>開始練習</button>
      </section>
      </div>
    `;
    const state = this.state;
    container.querySelectorAll('[data-count]').forEach(btn => btn.addEventListener('click', () => {
      container.querySelectorAll('[data-count]').forEach(b=>b.classList.remove('selected')); btn.classList.add('selected'); state.selectedCount = parseInt(btn.dataset.count);
      DB.saveWordPracticePreferences({ count: state.selectedCount });
      const summaryCount = document.getElementById('word-summary-count');
      if (summaryCount) summaryCount.textContent = String(state.selectedCount);
    }));
    container.querySelectorAll('[data-mode]').forEach(opt => opt.addEventListener('click', () => {
      container.querySelectorAll('[data-mode]').forEach(o=>o.classList.remove('selected')); opt.classList.add('selected'); state.selectedMode = opt.dataset.mode;
      DB.saveWordPracticePreferences({ order: state.selectedMode });
      const summaryOrder = document.getElementById('word-summary-order');
      if (summaryOrder) summaryOrder.textContent = state.selectedMode === 'newest' ? '最新' : '隨機';
    }));
    bindPracticeModeSelector(container, 'quiz');
    container.querySelectorAll('[data-tts-delay]').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('[data-tts-delay]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const ms = parseInt(btn.dataset.ttsDelay);
        DB.saveTtsDelay(ms);
        const summaryDelay = document.getElementById('word-summary-delay');
        if (summaryDelay) summaryDelay.textContent = ms === 0 ? '立即' : ms < 1000 ? `${ms}ms` : `${ms / 1000}s`;
      });
    });

    document.getElementById('start-btn').addEventListener('click', () => {
      void Sound.unlock(); // Prime AudioContext on user gesture before quiz starts
      const selected = selectWords(state.selectedCount, state.selectedMode, DB.getBoostedWords());
      if (!selected.length) { showToast('沒有可練習的單字'); return; }
      state.words = selected; state.currentIdx = 0; state.wrongWords = []; state.phase = 'quiz';
      state.showAnswer = false; state.waitingRetype = false;
      this._pendingWrongIds.clear();
      Router.quizActive = true; this.initQuizShell(container);
      // Pre-warm speech synthesis so first word has voices ready
      if (window.speechSynthesis) { window.speechSynthesis.getVoices(); }
      this.renderQuiz(container);
    });
  },
  initQuizShell(container) {
    container.innerHTML = `
      <div class="progress-bar-wrap" id="quiz-progress-wrap">
        <div class="progress-label"><span id="progress-text">進度 1 / ${this.state.words.length}</span><span id="progress-pct">0%</span></div>
        <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="transform:scaleX(0)"></div></div>
      </div>
      <div class="quiz-area">
        <div class="quiz-word-info" id="quiz-word-info"></div>
        <div class="letter-input-wrap" id="letter-wrap"></div>
      </div>
      <div class="quiz-actions" id="quiz-actions"></div>
    `;
    this._setupGhostInput();
  },
  _setupGhostInput() {
    let ghost = document.getElementById('quiz-ghost-input');
    if (!ghost) {
      ghost = document.createElement('input');
      ghost.id = 'quiz-ghost-input';
      // Keep a real input focused for the iOS keyboard, but make it visually inert.
      // type="text" avoids native search-field decoration work while typing.
      ghost.type = 'text';
      ghost.style.cssText = `position:fixed;left:50%;bottom:1px;width:1px;height:1px;opacity:0.01;border:0;padding:0;margin:0;outline:none;background:transparent;color:transparent;caret-color:transparent;font-size:16px;line-height:1;z-index:1;pointer-events:none;clip-path:inset(50%);transform:translateZ(0);-webkit-appearance:none;appearance:none;`;
      ghost.setAttribute('autocapitalize','none');
      ghost.setAttribute('autocorrect','off');
      ghost.setAttribute('autocomplete','off');
      ghost.setAttribute('spellcheck','false');
      ghost.setAttribute('inputmode','text');
      ghost.setAttribute('lang','ja');
      ghost.setAttribute('enterkeyhint','done');
      ghost.setAttribute('name', 'quiz-' + Date.now()); // unique name prevents browser autocomplete
      document.getElementById('app').appendChild(ghost);
    }
    ghost.readOnly = false;
    this._ghost = ghost; return ghost;
  },
  renderQuiz(container) {
    this._clearQuestionTimers();
    const questionToken = ++this._questionToken;
    const state = this.state; const word = state.words[state.currentIdx];
    const total = state.words.length; const current = state.currentIdx + 1;
    const progress = Math.round((state.currentIdx / total) * 100);
    state.showAnswer = false; state.waitingRetype = false;
    const progressText = document.getElementById('progress-text');
    const progressPct = document.getElementById('progress-pct');
    const progressFill = document.getElementById('progress-fill');
    if (progressText) progressText.textContent = `進度 ${current} / ${total}`;
    if (progressPct) progressPct.textContent = `${progress}%`;
    if (progressFill) progressFill.style.transform = `scaleX(${progress / 100})`;
    const wordInfo = document.getElementById('quiz-word-info');
    if (wordInfo) {
      const ttsOn = TTS.enabled;
      wordInfo.innerHTML = `
        <div class="quiz-chinese">${word.chinese}</div>
        <div class="quiz-phonetic-row">
          <span class="quiz-pos">${word.partOfSpeech}</span>
          ${word.phonetic ? `<span class="quiz-phonetic">/${word.phonetic}/</span>` : ''}
          <button class="tts-inline-btn ${ttsOn?'':'tts-off'}" id="tts-replay-btn" title="${ttsOn?'再聽一次':'發音已關閉'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>${ttsOn?`<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`:`<line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`}</svg>
          </button>
        </div>
        <div class="quiz-hint">${Array.from(this._norm(word.english)).length} 個字</div>
      `;
      document.getElementById('tts-replay-btn')?.addEventListener('click', () => {
        this._clearTimer('_ttsTimer');
        TTS.cancelPending();
        if (TTS.enabled) {
          TTS.speakWhenReady(word.english, 0.75);
        } else {
          TTS.enabled = true;
          this.renderQuiz(container); // re-render to update icon state
        }
      });
    }
    const actionsEl = document.getElementById('quiz-actions');
    if (actionsEl) actionsEl.innerHTML = `<button class="btn-secondary" id="show-answer-btn">顯示答案</button>`;
    this.buildLetterBoxes(word, container);
    document.getElementById('show-answer-btn')?.addEventListener('click', () => this.showAnswer(word, container));
    // Track the timer so an old question can never begin speaking during a new one.
    // The first valid keystroke also cancels a delayed cue; the replay button remains available.
    const ttsDelay = DB.getTtsDelay();
    this._ttsTimer = setTimeout(() => {
      this._ttsTimer = null;
      if (questionToken !== this._questionToken || state.words[state.currentIdx] !== word) return;
      TTS.speakWhenReady(word.english, 0.82);
    }, ttsDelay);
  },
  buildLetterBoxes(word, container) {
    const wrap = document.getElementById('letter-wrap');
    const ghost = this._ghost;
    if (!wrap || !ghost) return;

    const wordParts = String(word.english || '').split(/\s+/).filter(Boolean);
    const totalLetters = Array.from(this._norm(word.english)).length;
    const GAP = 4;
    const PADDING = 48;
    const maxWidth = (window.innerWidth || 390) - PADDING;
    const longestPartLetters = Math.max(...wordParts.map(part => Array.from(this._norm(part)).length || 1));
    const maxBoxSize = Math.floor((maxWidth - GAP * (longestPartLetters - 1)) / longestPartLetters);
    const boxSize = Math.max(20, Math.min(38, maxBoxSize));
    const fontSize = Math.round(boxSize * 0.52);
    const allBoxDivs = [];
    const fragment = document.createDocumentFragment();

    wordParts.forEach((part, wordIndex) => {
      if (wordIndex > 0) {
        const separator = document.createElement('div');
        separator.className = 'word-separator';
        separator.textContent = ' ';
        fragment.appendChild(separator);
      }
      const group = document.createElement('div');
      group.className = 'word-group';
      [...part].forEach(ch => {
        const box = document.createElement('div');
        if (!/\s/.test(ch)) {
          box.className = 'letter-box-vis';
          box.style.width = `${boxSize}px`;
          box.style.height = `${boxSize + 6}px`;
          box.style.fontSize = `${fontSize}px`;
          allBoxDivs.push(box);
        } else {
          box.className = 'letter-box-sep';
          box.textContent = ch;
          box.style.fontSize = `${Math.round(fontSize * 1.1)}px`;
          box.style.lineHeight = `${boxSize + 6}px`;
        }
        group.appendChild(box);
      });
      fragment.appendChild(group);
    });
    wrap.replaceChildren(fragment);

    // Remove handlers from the previous question/retry before binding the new ones.
    this._detachGhostHandlers(ghost);
    this._canQueueAdvance = false;
    this._queuedAdvance = false;

    let userInput = '';
    let renderedInput = null;
    let evaluating = false;
    let composing = false;
    const maxLen = totalLetters;
    const correctStr = this._norm(word.english);
    const prevCls = new Array(allBoxDivs.length).fill(null);
    const prevTxt = new Array(allBoxDivs.length).fill(null);

    ghost.value = '';
    // IME composition temporarily contains romaji; limiting the native input to
    // the answer length would truncate Japanese conversion on iOS/iPadOS.
    ghost.maxLength = 64;

    const writeBox = (index, state, text) => {
      if (index < 0 || index >= allBoxDivs.length) return;
      const box = allBoxDivs[index];
      const className = state ? `letter-box-vis ${state}` : 'letter-box-vis';
      if (prevTxt[index] !== text) {
        box.textContent = text;
        prevTxt[index] = text;
      }
      if (prevCls[index] !== className) {
        box.className = className;
        prevCls[index] = className;
      }
    };

    const paintIndex = (index, value) => {
      if (index < value.length) writeBox(index, 'filled', value[index]);
      else if (index === value.length && index < allBoxDivs.length) writeBox(index, 'cursor cursor-active', '');
      else writeBox(index, '', '');
    };

    const updateDefaultVisual = () => {
      const next = userInput;
      const previous = renderedInput;
      if (previous === null) {
        for (let i = 0; i < allBoxDivs.length; i++) paintIndex(i, next);
      } else if (next.length === previous.length + 1 && next.startsWith(previous)) {
        // Common typing path: update only the old cursor/typed character and new cursor.
        paintIndex(previous.length, next);
        paintIndex(next.length, next);
      } else if (previous.length === next.length + 1 && previous.startsWith(next)) {
        // Common backspace path: update only the removed character/new cursor and old cursor.
        paintIndex(next.length, next);
        paintIndex(previous.length, next);
      } else {
        let firstChanged = 0;
        const commonLength = Math.min(previous.length, next.length);
        while (firstChanged < commonLength && previous[firstChanged] === next[firstChanged]) firstChanged++;
        const lastChanged = Math.min(allBoxDivs.length - 1, Math.max(previous.length, next.length));
        for (let i = firstChanged; i <= lastChanged; i++) paintIndex(i, next);
      }
      renderedInput = next;
    };

    const updateVisual = (state = 'default') => {
      if (state === 'correct') {
        for (let i = 0; i < allBoxDivs.length; i++) writeBox(i, 'correct', correctStr[i] || '');
        renderedInput = userInput;
        return;
      }
      if (state === 'wrong') {
        for (let i = 0; i < allBoxDivs.length; i++) writeBox(i, 'wrong', userInput[i] || '');
        renderedInput = userInput;
        return;
      }
      updateDefaultVisual();
    };

    const sanitizeInput = value => normalizeJapaneseAnswer(value);
    const normalizeInput = value => Array.from(sanitizeInput(value)).slice(0, maxLen).join('');

    const evaluate = () => {
      if (userInput.length < maxLen || evaluating) return;
      evaluating = true;
      const snapshot = userInput;
      if (this.state.showAnswer) return;
      this._canQueueAdvance = snapshot === correctStr;
      // Run answer evaluation inside the native input event. This preserves the
      // iOS user-activation token so AudioContext.resume() and the cue can start
      // immediately after the final character, without adding input latency.
      if (!this.state.waitingRetype) {
        this._checkAnswer(word, snapshot, allBoxDivs, container, updateVisual, correctStr, maxLen);
      } else {
        this._checkRetype(word, snapshot, allBoxDivs, container, updateVisual, correctStr);
      }
    };

    const applyNativeValue = event => {
      if (this.state.showAnswer || evaluating) return;
      const raw = ghost.value;
      const sanitized = sanitizeInput(raw);
      const next = normalizeInput(sanitized);
      const isComposing = composing || !!event?.isComposing;

      // Preserve the keyboard's native casing. Write back only when characters were
      // actually removed, so auto-capitalisation cannot force an iOS text resync.
      if (!isComposing && raw !== sanitized) {
        ghost.value = sanitized;
        try { ghost.setSelectionRange(sanitized.length, sanitized.length); } catch {}
      }

      const isFirstValidInput = userInput.length === 0 && next.length > 0;
      if (next !== userInput) {
        userInput = next;
        updateDefaultVisual();
      }
      if (isFirstValidInput) {
        this._clearTimer('_ttsTimer');
        TTS.cancelPending();
      }
      if (isComposing) return;
      evaluate();
    };

    // Do not prevent normal insert/delete operations. Let WebKit update the real input
    // natively, then mirror its value to the visual boxes in the input event.
    ghost._beforeInputH = event => {
      if (this.state.showAnswer || evaluating) event.preventDefault();
    };
    ghost._inputH = event => applyNativeValue(event);
    ghost._compositionStartH = () => { composing = true; };
    ghost._compositionEndH = event => { composing = false; applyNativeValue(event); };
    ghost._keydownH = event => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      if (userInput.length < maxLen) {
        event.preventDefault();
      } else if (evaluating && this._canQueueAdvance) {
        event.preventDefault();
        this._queuedAdvance = true;
      }
    };

    ghost.addEventListener('beforeinput', ghost._beforeInputH, { passive: false });
    ghost.addEventListener('input', ghost._inputH, { passive: true });
    ghost.addEventListener('compositionstart', ghost._compositionStartH, { passive: true });
    ghost.addEventListener('compositionend', ghost._compositionEndH, { passive: true });
    ghost.addEventListener('keydown', ghost._keydownH);

    ghost.style.pointerEvents = 'auto';
    wrap.style.cursor = 'text';
    wrap.onclick = event => {
      event.stopPropagation();
      this._focusGhost();
    };
    const quizArea = document.querySelector('.quiz-area');
    if (quizArea) quizArea.onclick = () => this._focusGhost();

    void Sound.unlock();
    this._focusGhost();
    updateDefaultVisual();
  },
  // Canonical Japanese answer normaliser (NFKC + punctuation/space removal).
  _norm(s) { return normalizeJapaneseAnswer(s); },

  _checkAnswer(word, typed, allBoxDivs, container, updateVisual, correctStr, maxLen) {
    // Always recompute from the word itself — guards against any stale closure value
    const canonical = this._norm(word.english);
    const isCorrect = this._norm(typed) === canonical;
    const questionToken = this._questionToken;
    const isCurrentQuestion = () => questionToken === this._questionToken && this.state.words[this.state.currentIdx] === word;

    if (isCorrect) {
      // Start audio within the native input event, then move full-word colouring to
      // the next frame so the final typed letter is never delayed.
      void Sound.playCorrect();
      requestAnimationFrame(() => {
        if (!isCurrentQuestion()) return;
        updateVisual('correct');
        requestAnimationFrame(() => {
          if (isCurrentQuestion()) this.showNextBtn(word, container);
        });
      });
    } else {
      void Sound.playWrong();
      requestAnimationFrame(() => { if (isCurrentQuestion()) updateVisual('wrong'); });
      if (!this.state.wrongWords.find(w => w.id === word.id)) {
        this.state.wrongWords.push(word);
        this._recordWrong(word);
      }
      this._clearTimer('_retryTimer');
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (!isCurrentQuestion()) return;
        this.buildLetterBoxes(word, container);
        if (!document.getElementById('show-answer-btn')) {
          const actionsEl = document.getElementById('quiz-actions');
          if (actionsEl) { const btn = document.createElement('button'); btn.className='btn-secondary'; btn.id='show-answer-btn'; btn.textContent='顯示答案'; btn.addEventListener('click',()=>this.showAnswer(word,container)); actionsEl.prepend(btn); }
        }
      }, 800);
    }
  },
  _checkRetype(word, typed, allBoxDivs, container, updateVisual, correctStr) {
    const isCorrect = this._norm(typed) === this._norm(word.english);
    const questionToken = this._questionToken;
    const isCurrentQuestion = () => questionToken === this._questionToken && this.state.words[this.state.currentIdx] === word;
    if (isCorrect) {
      void Sound.playCorrect();
      this.state.waitingRetype = false;
      requestAnimationFrame(() => {
        if (!isCurrentQuestion()) return;
        updateVisual('correct');
        requestAnimationFrame(() => {
          if (isCurrentQuestion()) this.showNextBtn(word, container);
        });
      });
    } else {
      void Sound.playWrong();
      requestAnimationFrame(() => { if (isCurrentQuestion()) updateVisual('wrong'); });
      this._clearTimer('_retryTimer');
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (isCurrentQuestion()) this.buildLetterBoxes(word, container);
      }, 800);
    }
  },
  showAnswer(word, container) {
    this._clearQuestionTimers();
    // Invalidate any answer-colouring rAF queued by the final input event.
    const questionToken = ++this._questionToken;
    const state = this.state; state.showAnswer = true;
    // Count as wrong silently
    if (!state.wrongWords.find(w => w.id === word.id)) {
      state.wrongWords.push(word);
      this._recordWrong(word);
    }
    const correctStr = this._norm(word.english);
    const actionsEl  = document.getElementById('quiz-actions');
    const boxes      = document.querySelectorAll('.letter-box-vis');
    // Flash correct letters in red
    boxes.forEach((box,i) => { box.className='letter-box-vis wrong'; box.textContent=correctStr[i]||''; });
    if (!actionsEl) return;
    actionsEl.innerHTML = `<div class="answer-reveal answer-reveal-wrong"><div class="revealed-word revealed-word-wrong">${escapeHTML(word.english)}</div><div class="reveal-hint">請重新輸入一次正確日文</div></div>`;
    state.waitingRetype = true;
    // Keep input locked until rebuilding finishes. This removes the old 80 ms
    // window where fast retyping was accepted and then silently erased.
    this._answerTimer = setTimeout(() => {
      this._answerTimer = null;
      if (questionToken !== this._questionToken || state.words[state.currentIdx] !== word) return;
      state.showAnswer = false;
      this.buildLetterBoxes(word, container);
    }, 80);
  },
  showNextBtn(word, container) {
    const actionsEl = document.getElementById('quiz-actions');
    if (!actionsEl || this.state.words[this.state.currentIdx] !== word) return;
    if (this._ghost && this._enterNextH) {
      this._ghost.removeEventListener('keydown', this._enterNextH);
      this._enterNextH = null;
    }
    const isLast = this.state.currentIdx + 1 >= this.state.words.length;
    actionsEl.innerHTML = `<div class="correct-answer-row">${escapeHTML(word.english)}</div><button class="btn-primary" id="next-btn">${isLast ? '查看結果 →' : '下一題 → (Enter)'}</button>`;
    let advanced = false;
    const doNext = () => {
      if (advanced) return;
      advanced = true;
      this._clearQuestionTimers();
      if (this._ghost && this._enterNextH) this._ghost.removeEventListener('keydown', this._enterNextH);
      this._enterNextH = null;
      this.state.currentIdx++;
      if (this.state.currentIdx >= this.state.words.length) {
        Router.quizActive = false;
        const ghost = document.getElementById('quiz-ghost-input');
        this._detachGhostHandlers(ghost);
        if (ghost) { ghost.style.pointerEvents='none'; ghost.blur(); ghost.remove(); }
        this._ghost = null;
        this.renderResult(container);
      } else {
        this.renderQuiz(container);
      }
    };
    const advanceWasQueued = this._queuedAdvance;
    this._queuedAdvance = false;
    this._canQueueAdvance = false;
    if (advanceWasQueued) {
      doNext();
      return;
    }
    document.getElementById('next-btn')?.addEventListener('click', doNext);
    this._enterNextH = (e) => { if (e.key==='Enter') { e.preventDefault(); doNext(); } };
    if (this._ghost) {
      this._ghost.addEventListener('keydown', this._enterNextH);
      this._focusGhost();
    }
  },
  renderResult(container) {
    const state = this.state; const total = state.words.length; const wrongCount = state.wrongWords.length;
    const correctCount = total - wrongCount; const pct = total > 0 ? Math.round((correctCount/total)*100) : 0;
    state.phase = 'result';
    this._flushWrongCounts();
    const sessionDetails = state.wrongWords.map(w=>({english:w.english,partOfSpeech:w.partOfSpeech,chinese:w.chinese}));
    this._resultTimer = setTimeout(() => {
      this._resultTimer = null;
      void Sound.playResult(pct);
    }, 150);
    container.innerHTML = `
      <div class="result-view">
        <div class="result-score">
          <div class="result-circle"><div class="result-percent">${pct}%</div><div class="result-label">正確率</div></div>
          <div class="result-stats"><span class="stat-correct">✓ 正確 ${correctCount}</span><span style="color:var(--border)">|</span><span class="stat-wrong">✗ 錯誤 ${wrongCount}</span><span style="color:var(--border)">|</span><span>共 ${total} 題</span></div>
        </div>
        ${wrongCount > 0 ? `<div class="wrong-list-title">需要加強的單字（${wrongCount}個）</div>` : ''}
        ${wrongCount === 0 ? `<div style="text-align:center;padding:24px;color:var(--text-muted);font-weight:700">🎉 全部答對！太棒了！</div>`
          : state.wrongWords.map(w=>`
            <div class="wrong-word-card" data-id="${w.id}">
              <div class="wrong-word-en">${escapeHTML(w.english)}</div>
              <div class="wrong-word-meta"><span class="wrong-word-pos">${w.partOfSpeech}</span><span class="wrong-word-zh">${w.chinese}</span></div>
              <button class="boost-btn ${DB.isBoosted(w.id)?'boosted':''}" data-boost="${w.id}">${DB.isBoosted(w.id)?'✓ 已加強練習':'⚡ 加入加強練習'}</button>
            </div>`).join('')}
        <div style="height:16px"></div>
        <button class="btn-primary" id="back-home-btn">回到主頁</button>
        <div style="height:8px"></div>
        <button class="btn-secondary" id="retry-btn">重新練習</button>
      </div>
    `;
    this._pendingSessionSave = () => DB.addPracticeSession(todayStr(), total, sessionDetails);
    this._sessionSaveTimer = setTimeout(() => this._persistPendingSession(), 0);
    container.querySelectorAll('[data-boost]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.dataset.boost; const isBoosted = DB.toggleBoost(id);
      btn.textContent = isBoosted?'✓ 已加強練習':'⚡ 加入加強練習'; btn.classList.toggle('boosted', isBoosted);
      showToast(isBoosted?'已加入加強練習清單':'已移除加強練習');
    }));
    document.getElementById('back-home-btn').addEventListener('click', () => Router.navigate('home'));
    document.getElementById('retry-btn').addEventListener('click', () => {
      this.cleanupQuiz();
      state.phase='setup';
      this.renderSetup(container);
    });
  }
};


// ===========================
// KANA HANDWRITING VIEW — iPad / Apple Pencil optimized
// ===========================
Views.kanaPractice = {
  engine: null,
  _viewportHandler: null,
  state: {
    script: 'hiragana', rows: ['all'], mode: 'trace', repeat: 1, weakOnly: false, layout: 'auto', autoSpeak: true,
    selection: 'random', items: [], index: 0, results: [], scored: false
  },

  cleanup() {
    TTS.stop();
    this.engine?.destroy?.();
    this.engine = null;
    if (this._viewportHandler) {
      window.removeEventListener('resize', this._viewportHandler);
      window.removeEventListener('orientationchange', this._viewportHandler);
      window.visualViewport?.removeEventListener?.('resize', this._viewportHandler);
      this._viewportHandler = null;
    }
    document.documentElement.classList.remove('kana-view-active');
    Router.handwritingActive = false;
    resumeAppUpdateWhenSafe();
  },

  _resolveLayout() {
    const viewportWidth = window.visualViewport?.width || window.innerWidth || 0;
    const isTouchDevice = navigator.maxTouchPoints > 0 || window.matchMedia?.('(pointer: coarse)').matches;
    return resolveWritingLayout({
      preference: this.state.layout,
      viewportWidth,
      screenWidth: window.screen?.width || viewportWidth,
      screenHeight: window.screen?.height || window.innerHeight || viewportWidth,
      touch: isTouchDevice
    });
  },

  _layoutLabel() {
    return this._resolveLayout() === 'tablet' ? '目前自動套用：iPad 寬版' : '目前自動套用：iPhone 精簡版';
  },

  _applySessionLayout() {
    const session = document.querySelector('.kana-session');
    if (session) session.dataset.layout = this._resolveLayout();
    const detected = document.getElementById('kana-layout-detected');
    if (detected && this.state.layout === 'auto') detected.textContent = this._layoutLabel();
  },

  _bindViewportLayout() {
    if (this._viewportHandler) {
      window.removeEventListener('resize', this._viewportHandler);
      window.removeEventListener('orientationchange', this._viewportHandler);
      window.visualViewport?.removeEventListener?.('resize', this._viewportHandler);
    }
    this._viewportHandler = () => this._applySessionLayout();
    window.addEventListener('resize', this._viewportHandler, { passive: true });
    window.addEventListener('orientationchange', this._viewportHandler, { passive: true });
    window.visualViewport?.addEventListener?.('resize', this._viewportHandler, { passive: true });
  },

  render(container) {
    this.cleanup();
    this.renderSetup(container);
  },

  renderSetup(container) {
    Router.handwritingActive = false;
    document.documentElement.classList.add('kana-view-active');
    const savedPreferences = DB.getKanaPracticePreferences();
    this.state.script = savedPreferences.script;
    this.state.rows = savedPreferences.rows;
    this.state.mode = savedPreferences.mode;
    this.state.repeat = savedPreferences.repeat;
    this.state.weakOnly = savedPreferences.weakOnly;
    this.state.layout = savedPreferences.layout;
    this.state.autoSpeak = savedPreferences.autoSpeak;
    const summary = KanaProgress.getSummary();
    container.innerHTML = `
      <div class="kana-setup-page">
        <div class="section-header kana-page-header"><h1 class="section-title">練習</h1></div>
        ${renderPracticeModeSelector('kana')}
        <section class="kana-setup-card kana-setup-compact">
          <div class="kana-setup-heading">
            <div class="kana-setup-mark" aria-hidden="true">あ</div>
            <div><h2>五十音手寫練習</h2><p>選擇假名後可設定每個字的重複次數，題目會隨機排列且相同假名不會相鄰。</p></div>
          </div>
          <div class="kana-summary-grid kana-summary-strip" aria-label="五十音練習摘要">
            <div><strong>${summary.practiced}</strong><span>已練</span></div>
            <div><strong>${summary.mastered}</strong><span>熟練</span></div>
            <div><strong>${summary.averageScore}</strong><span>均分</span></div>
            <div><strong>${summary.attempts}</strong><span>次數</span></div>
          </div>
          <div class="kana-setup-grid">
            <div class="option-group kana-compact-group kana-script-group">
              <div class="option-label">假名類型</div>
              <div class="option-chips kana-option-chips kana-script-options">
                <button class="chip ${this.state.script==='hiragana'?'selected':''}" data-kana-script="hiragana">平假名</button>
                <button class="chip ${this.state.script==='katakana'?'selected':''}" data-kana-script="katakana">片假名</button>
                <button class="chip ${this.state.script==='both'?'selected':''}" data-kana-script="both">兩者混合</button>
              </div>
            </div>
            <div class="option-group kana-compact-group kana-row-group">
              <div class="option-label">五十音行（可複選）</div>
              <div class="kana-row-grid" id="kana-row-grid" role="group" aria-label="選擇要練習的五十音行">
                <button class="kana-row-chip ${this.state.rows.includes('all')?'selected':''}" type="button" data-kana-row="all" aria-pressed="${this.state.rows.includes('all')}">全部行</button>
                ${KANA_ROWS.map(row => `<button class="kana-row-chip ${this.state.rows.includes(row.id)?'selected':''}" type="button" data-kana-row="${row.id}" aria-pressed="${this.state.rows.includes(row.id)}">${row.label}</button>`).join('')}
              </div>
              <div class="kana-row-summary" id="kana-row-summary"></div>
            </div>
            <div class="option-group kana-compact-group kana-mode-group">
              <div class="option-label">練習方式</div>
              <div class="kana-mode-grid">
                <button class="kana-mode-option ${this.state.mode==='trace'?'selected':''}" data-kana-mode="trace"><b>描紅</b><span>顯示底稿</span></button>
                <button class="kana-mode-option ${this.state.mode==='copy'?'selected':''}" data-kana-mode="copy"><b>臨摹</b><span>看字書寫</span></button>
                <button class="kana-mode-option ${this.state.mode==='recall'?'selected':''}" data-kana-mode="recall"><b>默寫</b><span>看拼音回想</span></button>
              </div>
            </div>
            <div class="option-group kana-compact-group kana-repeat-group">
              <div class="option-label">每個假名重複次數</div>
              <div class="kana-repeat-grid" role="group" aria-label="選擇每個假名的重複次數">
                ${KANA_REPEAT_OPTIONS.map(value => `<button type="button" class="kana-repeat-chip ${value===this.state.repeat?'selected':''}" data-kana-repeat="${value}" aria-pressed="${value===this.state.repeat}">${value} 次</button>`).join('')}
              </div>
              <div class="kana-repeat-summary" id="kana-repeat-summary"></div>
            </div>
          </div>
          <details class="kana-advanced-settings">
            <summary><b>更多設定</b><span>版面、弱項優先</span></summary>
            <div class="kana-advanced-content">
              <div class="option-group kana-compact-group kana-layout-option-group">
                <div class="option-label">書寫版面</div>
                <div class="kana-layout-grid" role="group" aria-label="選擇書寫版面">
                  <button type="button" class="kana-layout-option ${this.state.layout==='auto'?'selected':''}" data-kana-layout="auto"><b>自動</b><span>依裝置調整</span></button>
                  <button type="button" class="kana-layout-option ${this.state.layout==='phone'?'selected':''}" data-kana-layout="phone"><b>iPhone</b><span>單欄精簡版</span></button>
                  <button type="button" class="kana-layout-option ${this.state.layout==='tablet'?'selected':''}" data-kana-layout="tablet"><b>iPad</b><span>大畫布寬版</span></button>
                </div>
                <div class="kana-layout-detected" id="kana-layout-detected">${this.state.layout === 'auto' ? this._layoutLabel() : '使用手動指定版面'}</div>
              </div>
              <label class="kana-weak-toggle"><input type="checkbox" id="kana-auto-speak" ${this.state.autoSpeak?'checked':''}><span>進入每一題時自動播放該假名發音</span></label>
              <label class="kana-weak-toggle"><input type="checkbox" id="kana-weak-only" ${this.state.weakOnly?'checked':''}><span>優先練習尚未熟練的假名（最高分未達 80）</span></label>
              <p class="kana-device-tip">iPad 建議橫向使用 Apple Pencil；偵測到 Pencil 後會暫時忽略手掌觸碰。</p>
            </div>
          </details>
          <button class="btn-primary kana-start-btn" id="kana-start-btn">開始手寫練習</button>
        </section>
      </div>`;

    bindPracticeModeSelector(container, 'kana');
    const persistPreferences = patch => DB.saveKanaPracticePreferences(patch);
    const getPracticePool = () => {
      let pool = getKanaSet({ script: this.state.script, rows: this.state.rows });
      if (this.state.weakOnly) {
        const weakKeys = KanaProgress.getWeakKeys();
        const attemptedKeys = new Set(KanaProgress.getProgress().map(item => item.key));
        const weakPool = pool.filter(item => weakKeys.has(item.id) || !attemptedKeys.has(item.id));
        if (weakPool.length) pool = weakPool;
      }
      return pool;
    };
    const updateSetupUI = () => {
      container.querySelectorAll('[data-kana-row]').forEach(button => {
        const selected = this.state.rows.includes(button.dataset.kanaRow);
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      container.querySelectorAll('[data-kana-repeat]').forEach(button => {
        const selected = Number(button.dataset.kanaRepeat) === this.state.repeat;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      const selectedCount = getKanaSet({ script: this.state.script, rows: this.state.rows }).length;
      const practiceCount = getPracticePool().length;
      const totalQuestions = practiceCount * this.state.repeat;
      const rowSummary = document.getElementById('kana-row-summary');
      if (rowSummary) {
        const rowText = this.state.rows.includes('all') ? '全部 10 行' : `已選 ${this.state.rows.length} 行`;
        rowSummary.textContent = `${rowText}・${selectedCount} 個假名`;
      }
      const repeatSummary = document.getElementById('kana-repeat-summary');
      if (repeatSummary) {
        const orderLabel = practiceCount > 1 ? '不連續隨機' : '單一假名重複';
        repeatSummary.textContent = `${this.state.weakOnly ? '弱項優先・' : ''}${practiceCount} 個假名 × ${this.state.repeat} 次 ＝ ${totalQuestions} 題・${orderLabel}`;
      }
      const startButton = document.getElementById('kana-start-btn');
      if (startButton) {
        startButton.disabled = totalQuestions === 0;
        startButton.textContent = totalQuestions ? `開始 ${totalQuestions} 題手寫練習` : '目前沒有可練習的假名';
      }
    };
    container.querySelectorAll('[data-kana-script]').forEach(button => button.addEventListener('click', () => {
      container.querySelectorAll('[data-kana-script]').forEach(item => item.classList.remove('selected'));
      button.classList.add('selected'); this.state.script = button.dataset.kanaScript;
      persistPreferences({ script: this.state.script });
      updateSetupUI();
    }));
    container.querySelectorAll('[data-kana-row]').forEach(button => button.addEventListener('click', () => {
      const row = button.dataset.kanaRow;
      if (row === 'all') {
        this.state.rows = ['all'];
      } else {
        const selected = new Set(this.state.rows.filter(value => value !== 'all'));
        if (selected.has(row)) selected.delete(row); else selected.add(row);
        this.state.rows = selected.size ? [...selected] : ['all'];
      }
      persistPreferences({ rows: this.state.rows });
      updateSetupUI();
    }));
    container.querySelectorAll('[data-kana-mode]').forEach(button => button.addEventListener('click', () => {
      container.querySelectorAll('[data-kana-mode]').forEach(item => item.classList.remove('selected'));
      button.classList.add('selected'); this.state.mode = button.dataset.kanaMode;
      persistPreferences({ mode: this.state.mode });
    }));
    container.querySelectorAll('[data-kana-repeat]').forEach(button => button.addEventListener('click', () => {
      this.state.repeat = Number(button.dataset.kanaRepeat);
      persistPreferences({ repeat: this.state.repeat });
      updateSetupUI();
    }));
    container.querySelectorAll('[data-kana-layout]').forEach(button => button.addEventListener('click', () => {
      container.querySelectorAll('[data-kana-layout]').forEach(item => item.classList.remove('selected'));
      button.classList.add('selected'); this.state.layout = button.dataset.kanaLayout;
      persistPreferences({ layout: this.state.layout });
      const detected = document.getElementById('kana-layout-detected');
      if (detected) detected.textContent = this.state.layout === 'auto' ? this._layoutLabel() : '使用手動指定版面';
    }));
    document.getElementById('kana-weak-only')?.addEventListener('change', event => {
      this.state.weakOnly = event.target.checked;
      persistPreferences({ weakOnly: this.state.weakOnly });
      updateSetupUI();
    });
    document.getElementById('kana-auto-speak')?.addEventListener('change', event => {
      this.state.autoSpeak = event.target.checked;
      persistPreferences({ autoSpeak: this.state.autoSpeak });
    });
    updateSetupUI();
    this._bindViewportLayout();
    document.getElementById('kana-start-btn')?.addEventListener('click', () => {
      persistPreferences({
        script: this.state.script, rows: this.state.rows, mode: this.state.mode,
        repeat: this.state.repeat, weakOnly: this.state.weakOnly, layout: this.state.layout,
        autoSpeak: this.state.autoSpeak
      });
      const pool = getPracticePool();
      this.state.items = buildRepeatedKanaPractice(pool, this.state.repeat);
      this.state.index = 0; this.state.results = []; this.state.scored = false;
      if (!this.state.items.length) { showToast('此條件沒有可練習的假名'); return; }
      Router.handwritingActive = true;
      this.renderWriter(container);
    });
  },

  renderWriter(container) {
    this.engine?.destroy?.(); this.engine = null;
    const kana = this.state.items[this.state.index];
    const total = this.state.items.length;
    const progress = Math.round(this.state.index / total * 100);
    const hideCharacter = this.state.mode === 'recall';
    this.state.scored = false;
    container.innerHTML = `
      <div class="kana-session" data-mode="${this.state.mode}" data-layout="${this._resolveLayout()}">
        <header class="kana-session-header">
          <button class="kana-back-btn" id="kana-exit-btn" type="button" aria-label="返回設定">‹</button>
          <div class="kana-session-progress"><span>五十音手寫 ${this.state.index + 1} / ${total}</span><div><i style="width:${progress}%"></i></div></div>
          <span class="kana-mode-badge">${({trace:'描紅',copy:'臨摹',recall:'默寫'})[this.state.mode]}</span>
        </header>
        <div class="kana-workspace">
          <aside class="kana-reference-card">
            <span class="kana-script-label">${kana.scriptLabel}・${kana.rowLabel}</span>
            <div class="kana-reference-character ${hideCharacter ? 'is-hidden' : ''}" id="kana-reference-character">${hideCharacter ? '？' : kana.character}</div>
            <strong class="kana-romaji">${escapeHTML(kana.romaji)}</strong>
            <span class="kana-stroke-count">標準 ${kana.strokes.length} 畫</span>
            <div class="kana-reference-actions">
              <button class="btn-secondary kana-small-btn" id="kana-listen-btn" type="button">🔊 發音</button>
              <button class="btn-secondary kana-small-btn" id="kana-animate-btn" type="button">▶ 筆順</button>
              ${hideCharacter ? '<button class="btn-secondary kana-small-btn" id="kana-reveal-btn" type="button">顯示字形</button>' : ''}
            </div>
          </aside>
          <main class="kana-canvas-card">
            <div class="kana-canvas-caption"><span id="kana-stroke-live">請開始書寫</span><span>分數為本機輔助判定</span></div>
            <canvas class="kana-writing-canvas" id="kana-writing-canvas" aria-label="${kana.character} 手寫區"></canvas>
            <div class="kana-canvas-tools">
              <button type="button" id="kana-undo-btn">↶ 復原</button>
              <button type="button" id="kana-clear-btn">清除</button>
              <button type="button" id="kana-guide-btn">顯示筆畫</button>
            </div>
          </main>
        </div>
        <section class="kana-score-panel" id="kana-score-panel" aria-live="polite">
          <div class="kana-score-placeholder">完成後點選「評分」，系統會顯示筆形與筆順建議。</div>
        </section>
        <div class="kana-session-actions"><button class="btn-primary" id="kana-score-btn">評分</button></div>
      </div>`;

    this._bindViewportLayout();
    const scrollContainer = document.getElementById('view-container');
    if (scrollContainer) scrollContainer.scrollTop = 0;

    const canvas = document.getElementById('kana-writing-canvas');
    this.engine = new HandwritingEngine(canvas, {
      onChange: count => {
        const label = document.getElementById('kana-stroke-live');
        if (label) label.textContent = count ? `已寫 ${count} 畫` : '請開始書寫';
      }
    });
    this.engine.setMode(this.state.mode);
    this.engine.setKana(kana);

    document.getElementById('kana-undo-btn')?.addEventListener('click', () => this.engine?.undo());
    document.getElementById('kana-clear-btn')?.addEventListener('click', () => this.engine?.clear());
    document.getElementById('kana-guide-btn')?.addEventListener('click', () => this.engine?.revealGuide());
    document.getElementById('kana-animate-btn')?.addEventListener('click', () => this.engine?.animateGuide());
    document.getElementById('kana-listen-btn')?.addEventListener('click', () => TTS.speakKana(kana.character));
    document.getElementById('kana-reveal-btn')?.addEventListener('click', event => {
      const reference = document.getElementById('kana-reference-character');
      if (reference) { reference.textContent = kana.character; reference.classList.remove('is-hidden'); }
      this.engine?.revealGuide(); event.currentTarget.remove();
    });
    document.getElementById('kana-exit-btn')?.addEventListener('click', () => {
      Modal.show(`<div class="modal-handle"></div><div class="modal-title">離開五十音書寫？</div><p style="color:var(--text-muted);font-size:14px;margin-bottom:16px">已評分的字會保留，尚未評分的字不會記錄。</p><div class="modal-actions"><button class="modal-btn-cancel" id="kana-stay">繼續書寫</button><button class="modal-btn-delete" id="kana-leave">離開</button></div>`);
      document.getElementById('kana-stay')?.addEventListener('click', () => Modal.hide());
      document.getElementById('kana-leave')?.addEventListener('click', () => { Modal.hide(); this.cleanup(); this.renderSetup(container); });
    });
    document.getElementById('kana-score-btn')?.addEventListener('click', event => this.scoreCurrent(container, kana, event.currentTarget));

    // renderWriter is entered directly from the Start / Next user gesture, so
    // speaking here works reliably in iPhone and iPad standalone PWA mode.
    if (this.state.autoSpeak) TTS.speakKana(kana.character, 0.62, { immediate: true });
  },

  scoreCurrent(container, kana, button) {
    if (this.state.scored || !this.engine) return;
    const result = this.engine.score();
    if (!result.strokeCount) { showToast('請先寫下假名再評分'); return; }
    this.state.scored = true;
    this.state.results.push({ kana, ...result });
    KanaProgress.recordAttempt(kana, result, this.state.mode);
    recordStudyActivity(STUDY_ACTIVITY_TYPES.KANA_HANDWRITING, `kana:${kana.id}:${Date.now()}`);
    const tone = result.score >= 80 ? 'excellent' : result.score >= 60 ? 'good' : 'retry';
    const panel = document.getElementById('kana-score-panel');
    if (panel) panel.innerHTML = `
      <div class="kana-score-result ${tone}">
        <div class="kana-score-total"><strong>${result.score}</strong><span>分</span></div>
        <div class="kana-score-details">
          <div><span>筆形</span><b>${result.shape}/40</b></div>
          <div><span>筆順</span><b>${result.order}/25</b></div>
          <div><span>方向</span><b>${result.direction}/15</b></div>
          <div><span>起收筆</span><b>${result.endpoints}/10</b></div>
          <div><span>配置</span><b>${result.balance}/10</b></div>
        </div>
        <p>${result.score >= 80 ? '字形與筆順掌握得很好！' : result.score >= 60 ? '已接近標準，請對照淡藍色筆畫再練一次。' : '建議播放筆順動畫，留意起筆位置與筆畫順序。'}</p>
      </div>`;
    const isLast = this.state.index + 1 >= this.state.items.length;
    button.textContent = isLast ? '查看練習結果' : '下一個假名';
    button.onclick = () => {
      if (isLast) this.renderResult(container);
      else { this.state.index += 1; this.renderWriter(container); }
    };
    requestAnimationFrame(() => {
      const actions = container.querySelector('.kana-session-actions');
      const session = container.querySelector('.kana-session');
      actions?.classList.add('is-scored');
      if (session?.dataset.layout === 'phone') {
        panel?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      } else {
        actions?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      }
    });
  },

  renderResult(container) {
    this.engine?.destroy?.(); this.engine = null; Router.handwritingActive = false;
    const results = this.state.results;
    const average = results.length ? Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length) : 0;
    const mastered = results.filter(item => item.score >= 80).length;
    container.innerHTML = `
      <div class="kana-result-view">
        <div class="kana-result-mark">${average >= 80 ? '上手！' : average >= 60 ? '進步中' : '再練習'}</div>
        <h1>五十音手寫完成</h1>
        <div class="kana-result-summary"><div><strong>${average}</strong><span>平均分數</span></div><div><strong>${mastered}/${results.length}</strong><span>本次達 80 分</span></div></div>
        <div class="kana-result-list">${results.map(item => `<div><b>${item.kana.character}</b><span>${escapeHTML(item.kana.romaji)}</span><strong class="${item.score>=80?'is-mastered':''}">${item.score}</strong></div>`).join('')}</div>
        <button class="btn-primary" id="kana-again-btn">再練一次</button>
        <button class="btn-secondary" id="kana-home-btn">回到主頁</button>
      </div>`;
    document.getElementById('kana-again-btn')?.addEventListener('click', () => this.renderSetup(container));
    document.getElementById('kana-home-btn')?.addEventListener('click', () => Router.navigate('home'));
    GDrive.scheduleStudyStreakSync(900);
    resumeAppUpdateWhenSafe();
  }
};


// ===========================
// KANA READING VIEW — kana to romaji practice
// ===========================
Views.kanaReadingPractice = {
  state: {
    script: 'hiragana', rows: ['all'], repeat: 1,
    items: [], index: 0, results: [], answered: false, transitioning: false
  },
  _advanceTimer: null,

  cleanup() {
    if (this._advanceTimer !== null) {
      clearTimeout(this._advanceTimer);
      this._advanceTimer = null;
    }
    TTS.stop();
    Router.quizActive = false;
    resumeAppUpdateWhenSafe();
  },

  _focusAnswerInput(input) {
    if (!input?.isConnected || input.disabled) return false;
    const focus = () => {
      if (!input?.isConnected || input.disabled) return;
      try { input.focus({ preventScroll: true }); }
      catch { input.focus(); }
      try {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      } catch {}
    };
    // The first focus must stay synchronous with Start／Next. iOS only opens the
    // software keyboard when focus is part of the user's current tap or key event.
    focus();
    // Desktop browsers and a few iPadOS transitions may replace the active element
    // during layout. Retry only when the synchronous focus did not stick.
    requestAnimationFrame(() => {
      if (document.activeElement !== input) focus();
    });
    return document.activeElement === input;
  },

  render(container) {
    this.cleanup();
    this.renderSetup(container);
  },

  renderSetup(container) {
    const saved = DB.getKanaReadingPreferences();
    this.state.script = saved.script;
    this.state.rows = saved.rows;
    this.state.repeat = saved.repeat;
    this.state.items = [];
    this.state.index = 0;
    this.state.results = [];
    this.state.answered = false;
    const summary = KanaReadingProgress.getSummary();
    container.innerHTML = `
      <div class="kana-reading-page kana-setup-page practice-compact-page">
        <div class="section-header kana-page-header practice-page-header"><h1 class="section-title">練習</h1></div>
        ${renderPracticeModeSelector('kanaReading')}
        <section class="kana-reading-setup-card kana-setup-card kana-setup-compact practice-compact-card">
          <div class="kana-setup-heading">
            <div class="kana-setup-mark" aria-hidden="true">A</div>
            <div><h2>五十音讀音練習</h2><p>看平假名或片假名，輸入對應的羅馬拼音。例如看到「あ」，輸入「a」。</p></div>
          </div>
          <div class="kana-summary-grid kana-summary-strip" aria-label="五十音讀音練習摘要">
            <div><strong>${summary.practiced}</strong><span>已練</span></div>
            <div><strong>${summary.correct}</strong><span>答對</span></div>
            <div><strong>${summary.accuracy}%</strong><span>正確率</span></div>
            <div><strong>${summary.attempts}</strong><span>總題數</span></div>
          </div>
          <div class="kana-setup-grid kana-reading-setup-grid">
            <div class="option-group kana-compact-group kana-script-group">
              <div class="option-label">假名類型</div>
              <div class="option-chips kana-option-chips kana-script-options">
                <button class="chip ${this.state.script==='hiragana'?'selected':''}" type="button" data-reading-script="hiragana">平假名</button>
                <button class="chip ${this.state.script==='katakana'?'selected':''}" type="button" data-reading-script="katakana">片假名</button>
                <button class="chip ${this.state.script==='both'?'selected':''}" type="button" data-reading-script="both">兩者混合</button>
              </div>
            </div>
            <div class="option-group kana-compact-group kana-row-group">
              <div class="option-label">五十音行（可複選）</div>
              <div class="kana-row-grid kana-row-grid-compact" role="group" aria-label="選擇五十音行">
                <button class="kana-row-chip ${this.state.rows.includes('all')?'selected':''}" type="button" data-reading-row="all" aria-pressed="${this.state.rows.includes('all')}">全部行</button>
                ${KANA_ROWS.map(row => `<button class="kana-row-chip ${this.state.rows.includes(row.id)?'selected':''}" type="button" data-reading-row="${row.id}" aria-pressed="${this.state.rows.includes(row.id)}">${row.label}</button>`).join('')}
              </div>
              <div class="kana-row-summary" id="kana-reading-row-summary"></div>
            </div>
            <div class="option-group kana-compact-group kana-repeat-group">
              <div class="option-label">每個假名練習次數</div>
              <div class="kana-repeat-grid" role="group" aria-label="選擇每個假名的練習次數">
                ${KANA_REPEAT_OPTIONS.map(value => `<button type="button" class="kana-repeat-chip ${value===this.state.repeat?'selected':''}" data-reading-repeat="${value}" aria-pressed="${value===this.state.repeat}">${value} 次</button>`).join('')}
              </div>
              <div class="kana-repeat-summary" id="kana-reading-repeat-summary"></div>
            </div>
          </div>
          <button class="btn-primary kana-start-btn" id="kana-reading-start-btn">開始讀音練習</button>
        </section>
      </div>`;

    bindPracticeModeSelector(container, 'kanaReading');
    const updateSetupUI = () => {
      container.querySelectorAll('[data-reading-row]').forEach(button => {
        const selected = this.state.rows.includes(button.dataset.readingRow);
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      container.querySelectorAll('[data-reading-repeat]').forEach(button => {
        const selected = Number(button.dataset.readingRepeat) === this.state.repeat;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      const pool = getKanaSet({ script: this.state.script, rows: this.state.rows });
      const total = pool.length * this.state.repeat;
      const rowLabel = this.state.rows.includes('all') ? '全部 10 行' : `已選 ${this.state.rows.length} 行`;
      const rowSummary = document.getElementById('kana-reading-row-summary');
      if (rowSummary) rowSummary.textContent = `${rowLabel}・${pool.length} 個假名`;
      const repeatSummary = document.getElementById('kana-reading-repeat-summary');
      if (repeatSummary) repeatSummary.textContent = `${pool.length} 個假名 × ${this.state.repeat} 次 ＝ ${total} 題・不連續隨機`;
      const start = document.getElementById('kana-reading-start-btn');
      if (start) {
        start.disabled = !total;
        start.textContent = total ? `開始 ${total} 題讀音練習` : '目前沒有可練習的假名';
      }
    };
    container.querySelectorAll('[data-reading-script]').forEach(button => button.addEventListener('click', () => {
      container.querySelectorAll('[data-reading-script]').forEach(item => item.classList.remove('selected'));
      button.classList.add('selected');
      this.state.script = button.dataset.readingScript;
      DB.saveKanaReadingPreferences({ script: this.state.script });
      updateSetupUI();
    }));
    container.querySelectorAll('[data-reading-row]').forEach(button => button.addEventListener('click', () => {
      const row = button.dataset.readingRow;
      if (row === 'all') this.state.rows = ['all'];
      else {
        const selected = new Set(this.state.rows.filter(value => value !== 'all'));
        if (selected.has(row)) selected.delete(row); else selected.add(row);
        this.state.rows = selected.size ? [...selected] : ['all'];
      }
      DB.saveKanaReadingPreferences({ rows: this.state.rows });
      updateSetupUI();
    }));
    container.querySelectorAll('[data-reading-repeat]').forEach(button => button.addEventListener('click', () => {
      this.state.repeat = Number(button.dataset.readingRepeat);
      DB.saveKanaReadingPreferences({ repeat: this.state.repeat });
      updateSetupUI();
    }));
    document.getElementById('kana-reading-start-btn')?.addEventListener('click', () => {
      void Sound.unlock();
      const pool = getKanaSet({ script: this.state.script, rows: this.state.rows });
      this.state.items = buildRepeatedKanaPractice(pool, this.state.repeat);
      if (!this.state.items.length) { showToast('此條件沒有可練習的假名'); return; }
      this.state.index = 0;
      this.state.results = [];
      this.state.answered = false;
      this.state.transitioning = false;
      DB.saveKanaReadingPreferences({ script: this.state.script, rows: this.state.rows, repeat: this.state.repeat });
      Router.quizActive = true;
      this.renderQuestion(container);
    });
    updateSetupUI();
  },

  renderQuestion(container) {
    container.innerHTML = `
      <div class="kana-reading-session">
        <header class="kana-session-header">
          <button class="kana-back-btn" id="kana-reading-exit-btn" type="button" aria-label="離開讀音練習">‹</button>
          <div class="kana-session-progress"><span id="kana-reading-progress-text"></span><div><i id="kana-reading-progress-fill"></i></div></div>
          <span class="kana-mode-badge" id="kana-reading-script-badge"></span>
        </header>
        <main class="kana-reading-question-card">
          <span class="kana-reading-row-label" id="kana-reading-row-label"></span>
          <div class="kana-reading-character" id="kana-reading-character"></div>
          <p>輸入羅馬拼音，按鍵盤「下一個／換行」送出並自動換題</p>
          <form class="kana-reading-answer-form" id="kana-reading-answer-form">
            <input id="kana-reading-answer" type="text" inputmode="text" lang="en" enterkeyhint="next" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="8" autofocus aria-label="輸入假名的羅馬拼音" placeholder="例如：a">
            <button class="btn-primary" id="kana-reading-submit" type="submit">送出並下一題</button>
          </form>
          <div class="kana-reading-feedback" id="kana-reading-feedback" role="status" aria-live="polite"></div>
          <button class="btn-secondary kana-reading-listen" id="kana-reading-listen" type="button">🔊 播放假名發音</button>
        </main>
      </div>`;
    const input = document.getElementById('kana-reading-answer');
    const form = document.getElementById('kana-reading-answer-form');
    input?.addEventListener('beforeinput', event => {
      if (this.state.transitioning) event.preventDefault();
    });
    input?.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      form?.requestSubmit();
    });
    document.getElementById('kana-reading-listen')?.addEventListener('click', () => {
      const kana = this.state.items[this.state.index];
      if (kana) TTS.speakKana(kana.character, 0.62, { immediate: true });
    });
    document.getElementById('kana-reading-exit-btn')?.addEventListener('click', () => {
      Modal.show(`<div class="modal-handle"></div><div class="modal-title">離開五十音讀音練習？</div><p style="color:var(--text-muted);font-size:14px;margin-bottom:16px">已完成的題目會保留，這次未完成的進度不列入測驗結果。</p><div class="modal-actions"><button class="modal-btn-cancel" id="kana-reading-stay">繼續練習</button><button class="modal-btn-delete" id="kana-reading-leave">離開</button></div>`);
      document.getElementById('kana-reading-stay')?.addEventListener('click', () => Modal.hide());
      document.getElementById('kana-reading-leave')?.addEventListener('click', () => { Modal.hide(); this.cleanup(); this.renderSetup(container); });
    });
    form?.addEventListener('submit', event => {
      event.preventDefault();
      this._submitCurrentAnswer(container);
      this._focusAnswerInput(input);
    });
    this._paintCurrentQuestion();
    this._focusAnswerInput(input);
  },

  _paintCurrentQuestion() {
    const kana = this.state.items[this.state.index];
    const total = this.state.items.length;
    if (!kana || !total) return;
    const progress = Math.round(this.state.index / total * 100);
    const isLast = this.state.index + 1 >= total;
    this.state.answered = false;
    this.state.transitioning = false;
    const progressText = document.getElementById('kana-reading-progress-text');
    const progressFill = document.getElementById('kana-reading-progress-fill');
    const badge = document.getElementById('kana-reading-script-badge');
    const rowLabel = document.getElementById('kana-reading-row-label');
    const character = document.getElementById('kana-reading-character');
    const input = document.getElementById('kana-reading-answer');
    const submit = document.getElementById('kana-reading-submit');
    const feedback = document.getElementById('kana-reading-feedback');
    if (progressText) progressText.textContent = `五十音讀音 ${this.state.index + 1} / ${total}`;
    if (progressFill) progressFill.style.width = `${progress}%`;
    if (badge) badge.textContent = kana.scriptLabel;
    if (rowLabel) rowLabel.textContent = `${kana.scriptLabel}・${kana.rowLabel}`;
    if (character) {
      character.textContent = kana.character;
      character.setAttribute('aria-label', `題目 ${kana.character}`);
    }
    if (input) {
      input.value = '';
      input.disabled = false;
      input.setAttribute('aria-label', `輸入 ${kana.character} 的羅馬拼音`);
      input.setAttribute('enterkeyhint', isLast ? 'done' : 'next');
    }
    if (submit) {
      submit.disabled = false;
      submit.textContent = isLast ? '送出並完成練習' : '送出並下一題';
    }
    if (feedback) feedback.innerHTML = '';
  },

  _submitCurrentAnswer(container) {
    if (this.state.transitioning) return;
    const kana = this.state.items[this.state.index];
    const total = this.state.items.length;
    const input = document.getElementById('kana-reading-answer');
    const submit = document.getElementById('kana-reading-submit');
    if (!kana || !input || !total) return;
      const checked = checkKanaReadingAnswer(kana, input?.value || '');
      if (!checked.normalized) { showToast('請先輸入羅馬拼音'); this._focusAnswerInput(input); return; }
      this.state.answered = true;
      this.state.transitioning = true;
      const result = { kana, answer: checked.normalized, correct: checked.correct };
      this.state.results.push(result);
      KanaReadingProgress.recordAttempt(kana, checked.normalized, checked.correct);
      void (checked.correct ? Sound.playCorrect() : Sound.playWrong());
      const feedback = document.getElementById('kana-reading-feedback');
      if (feedback) feedback.innerHTML = checked.correct
        ? `<div class="is-correct"><strong>✓ 答對了</strong><span>${escapeHTML(kana.character)} = ${escapeHTML(checked.expected)}</span></div>`
        : `<div class="is-wrong"><strong>✗ 再加油</strong><span>你的答案：${escapeHTML(checked.normalized)}　正確答案：${escapeHTML(checked.expected)}</span></div>`;
      if (submit) {
        submit.disabled = true;
        submit.textContent = this.state.index + 1 >= total ? '正在完成…' : '正在前往下一題…';
      }
      // Keep the same input element focused. Replacing or disabling it makes iOS
      // dismiss the keyboard, which forced the learner to tap and scroll each time.
      this._advanceTimer = setTimeout(() => {
        this._advanceTimer = null;
        if (this.state.index + 1 >= total) {
          this.renderResult(container);
          return;
        }
        this.state.index += 1;
        this._paintCurrentQuestion();
        this._focusAnswerInput(input);
      }, 650);
  },

  renderResult(container) {
    Router.quizActive = false;
    const results = this.state.results;
    const correct = results.filter(item => item.correct).length;
    const score = results.length ? Math.round(correct / results.length * 100) : 0;
    const wrong = results.filter(item => !item.correct);
    setTimeout(() => { void Sound.playResult(score); }, 150);
    recordStudyActivity(STUDY_ACTIVITY_TYPES.KANA_READING, `kana-reading:${todayStr()}:${Date.now()}`);
    GDrive.scheduleStudyStreakSync(350);
    container.innerHTML = `
      <div class="kana-reading-result-view">
        <div class="kana-result-mark">${score >= 80 ? '上手！' : score >= 60 ? '進步中' : '再練習'}</div>
        <h1>五十音讀音完成</h1>
        <div class="kana-result-summary"><div><strong>${score}</strong><span>正確率</span></div><div><strong>${correct}/${results.length}</strong><span>答對題數</span></div></div>
        ${wrong.length ? `<section class="kana-reading-wrong-list"><h2>需要加強</h2>${wrong.map(item => `<div><b>${item.kana.character}</b><span>你的答案：${escapeHTML(item.answer)}</span><strong>${escapeHTML(item.kana.romaji)}</strong></div>`).join('')}</section>` : '<div class="kana-reading-perfect">🎉 全部答對！</div>'}
        <button class="btn-primary" id="kana-reading-again">再練一次</button>
        <button class="btn-secondary" id="kana-reading-home">回到主頁</button>
      </div>`;
    document.getElementById('kana-reading-again')?.addEventListener('click', () => this.renderSetup(container));
    document.getElementById('kana-reading-home')?.addEventListener('click', () => Router.navigate('home'));
    refreshStudyStreakUI();
    resumeAppUpdateWhenSafe();
  }
};


// ===========================
// READING QUIZ VIEW
// ===========================
Views.readingQuiz = {
  state: { phase: 'setup', words: [], article: '', articleZh: '', questions: [], answers: {}, submitted: false, score: 0, correct: 0, translationLoading: false },

  _blankState() {
    return { phase: 'setup', words: [], article: '', articleZh: '', questions: [], answers: {}, submitted: false, score: 0, correct: 0, translationLoading: false };
  },

  render(container) {
    this.state = this._blankState();
    this.renderSetup(container);
  },

  renderSetup(container) {
    Router.quizActive = false;
    const totalWords = DB.getWords().length;
    const hasKey = !!DB.getApiKey();
    const canStart = totalWords >= 5 && hasKey;
    container.innerHTML = `
      <div class="practice-compact-page reading-practice-page">
      <div class="section-header practice-page-header"><h1 class="section-title">練習</h1></div>
      ${renderPracticeModeSelector('reading')}
      <section class="reading-setup-card practice-compact-card">
        <div class="practice-compact-heading">
          <div class="practice-compact-mark" aria-hidden="true">読</div>
          <div><h2>文章閱讀測驗</h2><p>從單字庫選出 5 個日文語彙，依 JLPT 等級生成短文與選擇題。</p></div>
        </div>
        <div class="reading-rule-grid practice-summary-strip">
          <div><strong>5</strong><span>個單字</span></div>
          <div><strong>5</strong><span>題測驗</span></div>
          <div><strong>20</strong><span>分 / 題</span></div>
          <div><strong>100</strong><span>滿分</span></div>
        </div>
        ${!hasKey ? `<div class="no-api-warning" style="margin-top:12px">請先在設定頁填入 Gemini API Key</div>` : ''}
        ${totalWords < 5 ? `<div class="no-api-warning" style="margin-top:12px">資料庫至少需要 5 個單字，目前只有 ${totalWords} 個</div>` : ''}
        <button class="btn-primary" id="reading-start-btn" ${canStart ? '' : 'disabled'}>生成文章並開始測驗</button>
      </section>
      <div id="reading-generate-status"></div>
      </div>
    `;
    bindPracticeModeSelector(container, 'reading');
    document.getElementById('reading-start-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('reading-start-btn');
      const status = document.getElementById('reading-generate-status');
      const selected = selectWords(5, 'all', DB.getBoostedWords());
      if (selected.length < 5) { showToast('資料庫至少需要 5 個單字'); return; }
      btn.disabled = true;
      if (status) status.innerHTML = `<div class="reading-loading"><div class="loading-dots"><span></span><span></span><span></span></div><span>AI 正在生成日文閱讀文章與語意測驗...</span></div>`;
      try {
        const result = await Gemini.generateReadingQuiz(selected);
        this.state = { ...this._blankState(), phase: 'quiz', words: selected, article: result.article, questions: result.questions, answers: {}, submitted: false, score: 0, correct: 0 };
        Router.quizActive = true;
        this.renderQuiz(container);
      } catch(err) {
        let msg = '文章閱讀測驗生成失敗，請稍後重試';
        if (err.message === 'NO_API_KEY') msg = '請先在設定頁填入 Gemini API Key';
        else if (err.message === 'NETWORK_ERROR') msg = '網路連線失敗，請確認連線後重試';
        else if (String(err.message || '').includes('quota') || String(err.message || '').includes('429')) msg = 'API 配額或請求頻率限制，請稍後再試';
        else if (String(err.message || '').includes('API') || String(err.message || '').includes('permission')) msg = 'API Key 或模型權限異常，請到設定頁確認';
        if (status) status.innerHTML = `<div class="essay-error">${escapeHTML(msg)}<div class="essay-error-detail">${escapeHTML(err.message || '')}</div></div>`;
        btn.disabled = false;
      }
    });
  },

  renderQuiz(container) {
    const state = this.state;
    container.innerHTML = `
      <div class="section-header"><h1 class="section-title">文章閱讀測驗</h1></div>
      ${renderPracticeModeSelector('reading')}
      <div class="reading-quiz-shell">
        <div class="reading-article-card" id="reading-article-top">
          <div class="reading-section-title-row">
            <div class="reading-section-title">AI 生成文章</div>
            <button class="reading-article-zh-btn" id="reading-article-zh-btn" aria-expanded="false">顯示中文</button>
          </div>
          <div class="reading-hint">綠色粗體底線單字可點擊，會跳到下方對應題目。中文翻譯可展開在文章下方，方便上下對照。</div>
          <div class="reading-article" id="reading-article">${this._buildArticleHtml(state.article, state.words)}</div>
          <div class="reading-article-zh-panel" id="reading-article-zh-panel" hidden>
            <div class="reading-article-zh-panel-head">
              <span>中文翻譯</span>
              <span>可與上方日文文章對照閱讀</span>
            </div>
            <div class="reading-article reading-article-zh" id="reading-article-zh-content"></div>
          </div>
        </div>
        <div class="reading-questions-card">
          <div class="reading-section-title">日文語意選擇題</div>
          <div class="reading-score-note">每題 20 分，共 100 分。請選出與題目單字最接近的日文近義詞。</div>
          <div class="reading-question-list">
            ${state.questions.map((q, i) => this._questionHtml(q, i)).join('')}
          </div>
          <div class="reading-submit-row">
            <button class="btn-primary" id="reading-submit-btn" disabled>提交答案</button>
            <button class="btn-secondary" id="reading-regenerate-btn">重新生成</button>
          </div>
          <div id="reading-result-area"></div>
        </div>
      </div>
      <div style="height:20px"></div>
    `;
    bindPracticeModeSelector(container, 'reading');
    this._bindQuizEvents(container);
    setTimeout(() => window.updateScrollFabs?.(), 0);
  },

  _buildArticleHtml(article, words, options = {}) {
    const interactive = options.interactive !== false;
    const idPrefix = options.idPrefix || 'reading-word';
    let html = nl2br(article || '');
    (words || []).forEach((w, i) => {
      const safeWord = escapeHTML(w.english || w.word || '');
      if (!safeWord) return;
      const pattern = new RegExp(`\\b(${escapeRegex(safeWord)})\\b`, 'gi');
      let firstMatch = true;
      html = html.replace(pattern, (match) => {
        if (interactive) {
          const idAttr = firstMatch ? ` id="${idPrefix}-${i}"` : '';
          firstMatch = false;
          return `<button class="reading-word-token"${idAttr} data-q="${i}"><strong><u>${match}</u></strong></button>`;
        }
        return `<span class="reading-word-token reading-word-token-static"><strong><u>${match}</u></strong></span>`;
      });
    });
    return html;
  },

  _buildArticleZhHtml(text, words) {
    let html = nl2br(text || '');
    const tokens = [];
    (words || []).forEach(w => {
      String(w.chinese || '')
        .split(/[、，,；;／/\s]+/)
        .map(t => t.replace(/[（(）)【】「」『』“”"'<>]/g, '').trim())
        .filter(t => t.length >= 2)
        .forEach(t => tokens.push(t));
    });
    const unique = [...new Set(tokens)].sort((a, b) => b.length - a.length);
    unique.forEach(token => {
      const safeToken = escapeHTML(token);
      if (!safeToken) return;
      html = html.replace(new RegExp(`(${escapeRegex(safeToken)})`, 'g'), '<span class="reading-zh-token"><strong><u>$1</u></strong></span>');
    });
    return html;
  },

  _questionHtml(q, i) {
    const selected = this.state.answers[i];
    const submitted = this.state.submitted;
    const isCorrect = submitted && selected && selected.toLowerCase() === String(q.correctSynonym || '').toLowerCase();
    return `<div class="reading-question-card ${submitted ? (isCorrect ? 'correct' : 'wrong') : ''}" id="reading-question-${i}">
      <div class="reading-question-head">
        <div>
          <div class="reading-q-num">Q${i + 1}｜20 分</div>
          <div class="reading-q-word">${escapeHTML(q.word || '')}<span>${escapeHTML(q.partOfSpeech || '')}</span></div>
          <button class="reading-meaning-btn" data-q="${i}">顯示中文意思</button>
        </div>
        <div class="reading-question-actions">
          <button class="reading-return-word-btn" data-word-index="${i}">回到單字 ↑</button>
        </div>
      </div>
      <div class="reading-options">
        ${(q.options || []).map(opt => {
          const optSafe = escapeHTML(opt);
          const chosen = selected === opt;
          const correct = submitted && opt.toLowerCase() === String(q.correctSynonym || '').toLowerCase();
          const wrong = submitted && chosen && !correct;
          return `<button class="reading-option-btn ${chosen ? 'selected' : ''} ${correct ? 'correct' : ''} ${wrong ? 'wrong' : ''}" data-q="${i}" data-opt="${escapeAttr(opt)}" ${submitted ? 'disabled' : ''}>${optSafe}</button>`;
        }).join('')}
      </div>
      ${submitted ? `<div class="reading-answer-note ${isCorrect ? 'ok' : 'ng'}">${isCorrect ? '✓ 正確' : `✗ 答錯，正確答案是 ${escapeHTML(q.correctSynonym || '')}`}</div>` : ''}
    </div>`;
  },

  _bindQuizEvents(container) {
    container.querySelectorAll('.reading-word-token').forEach(btn => {
      btn.addEventListener('click', () => this._scrollToQuestion(parseInt(btn.dataset.q)));
    });
    container.querySelectorAll('.reading-return-word-btn').forEach(btn => {
      btn.addEventListener('click', () => this._scrollToWord(parseInt(btn.dataset.wordIndex)));
    });
    container.querySelectorAll('.reading-meaning-btn').forEach(btn => {
      btn.addEventListener('click', () => this._showWordMeaning(parseInt(btn.dataset.q)));
    });
    document.getElementById('reading-article-zh-btn')?.addEventListener('click', () => this._toggleArticleTranslation());
    container.querySelectorAll('.reading-option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const qIdx = parseInt(btn.dataset.q);
        this.state.answers[qIdx] = btn.dataset.opt;
        const card = document.getElementById(`reading-question-${qIdx}`);
        card?.querySelectorAll('.reading-option-btn').forEach(b => b.classList.toggle('selected', b === btn));
        this._updateSubmitState();
      });
    });
    document.getElementById('reading-submit-btn')?.addEventListener('click', () => this.submit(container));
    document.getElementById('reading-regenerate-btn')?.addEventListener('click', () => this.renderSetup(container));
  },

  _updateSubmitState() {
    const done = Object.keys(this.state.answers || {}).length >= 5;
    const btn = document.getElementById('reading-submit-btn');
    if (btn) btn.disabled = !done;
  },

  _scrollToQuestion(i) {
    const target = document.getElementById(`reading-question-${i}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  _scrollToWord(i) {
    const target = document.getElementById(`reading-word-${i}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  _showFloating(title, bodyHtml, extraClass = '') {
    let overlay = document.getElementById('reading-floating-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'reading-floating-overlay';
      overlay.className = 'reading-floating-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="reading-floating-card ${extraClass}" role="dialog" aria-modal="true">
      <div class="reading-floating-head">
        <div class="reading-floating-title">${escapeHTML(title)}</div>
        <button class="reading-floating-close" id="reading-floating-close" aria-label="關閉">×</button>
      </div>
      <div class="reading-floating-body">${bodyHtml}</div>
    </div>`;
    const close = () => overlay.classList.remove('show');
    overlay.classList.add('show');
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.getElementById('reading-floating-close')?.addEventListener('click', close);
  },

  _showWordMeaning(i) {
    const q = this.state.questions?.[i] || {};
    const w = this.state.words?.[i] || {};
    const word = q.word || w.english || '';
    const pos = q.partOfSpeech || w.partOfSpeech || '';
    const zh = q.chinese || w.chinese || '目前沒有中文意思';
    this._showFloating(`${word} 中文意思`, `<div class="reading-meaning-word">${escapeHTML(word)}${pos ? `<span>${escapeHTML(pos)}</span>` : ''}</div><div class="reading-meaning-zh">${escapeHTML(zh)}</div>`, 'reading-meaning-floating');
  },

  _setArticleTranslationPanel({ open, html = '', loading = false, errorHtml = '' } = {}) {
    const panel = document.getElementById('reading-article-zh-panel');
    const content = document.getElementById('reading-article-zh-content');
    const btn = document.getElementById('reading-article-zh-btn');
    if (!panel || !content || !btn) return;
    panel.hidden = !open;
    panel.classList.toggle('show', !!open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? '收合中文' : '顯示中文';
    if (loading) {
      content.innerHTML = `<div class="reading-loading"><div class="loading-dots"><span></span><span></span><span></span></div><span>AI 正在翻譯文章...</span></div>`;
    } else if (errorHtml) {
      content.innerHTML = errorHtml;
    } else if (html) {
      content.innerHTML = html;
    }
  },

  async _toggleArticleTranslation() {
    const panel = document.getElementById('reading-article-zh-panel');
    const btn = document.getElementById('reading-article-zh-btn');
    if (!panel || !btn) return;
    if (!panel.hidden && panel.classList.contains('show')) {
      this._setArticleTranslationPanel({ open: false });
      return;
    }
    if (this.state.articleZh) {
      this._setArticleTranslationPanel({
        open: true,
        html: this._buildArticleZhHtml(this.state.articleZh, this.state.words)
      });
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    this._setArticleTranslationPanel({ open: true, loading: true });
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (btn) btn.disabled = true;
    try {
      const zh = await Gemini.translateReadingArticle(this.state.article, this.state.words);
      this.state.articleZh = zh;
      this._setArticleTranslationPanel({
        open: true,
        html: this._buildArticleZhHtml(zh, this.state.words)
      });
    } catch (err) {
      let msg = '文章翻譯失敗，請稍後重試';
      if (err.message === 'NO_API_KEY') msg = '請先在設定頁填入 Gemini API Key';
      else if (err.message === 'NETWORK_ERROR') msg = '網路連線失敗，請確認連線後重試';
      this._setArticleTranslationPanel({
        open: true,
        errorHtml: `<div class="essay-error">${escapeHTML(msg)}<div class="essay-error-detail">${escapeHTML(err.message || '')}</div></div>`
      });
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  submit(container) {
    if (this.state.submitted) return;
    let correct = 0;
    this.state.questions.forEach((q, i) => {
      const ans = this.state.answers[i] || '';
      if (ans.toLowerCase() === String(q.correctSynonym || '').toLowerCase()) correct++;
    });
    const score = correct * 20;
    this.state.correct = correct;
    this.state.score = score;
    this.state.submitted = true;
    Router.quizActive = false;
    DB.addReadingQuizSession({
      date: todayStr(),
      article: this.state.article,
      articleZh: this.state.articleZh || '',
      words: this.state.words,
      questions: this.state.questions,
      answers: this.state.answers,
      correct,
      total: 5,
      score,
      ts: Date.now()
    });
    Sound.playResult(score);
    this.renderQuiz(container);
    const result = document.getElementById('reading-result-area');
    const color = score >= 80 ? 'var(--correct)' : score >= 60 ? '#f5a623' : 'var(--danger)';
    if (result) {
      result.innerHTML = `<div class="reading-result-card">
        <div class="reading-result-score" style="color:${color}">${score}<span>/100</span></div>
        <div class="reading-result-text">答對 ${correct} / 5 題</div>
        <button class="btn-primary" id="reading-new-test-btn">再測一次</button>
      </div>`;
      document.getElementById('reading-new-test-btn')?.addEventListener('click', () => this.renderSetup(container));
      result.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
};

// ===========================
// DATABASE VIEW
// ===========================
Views.database = {
  deleteMode: false, selectedIds: new Set(),
  aiCorrectMode: false, aiCorrectIds: new Set(),
  sortMode: AppStorage.getItem('dbSortMode') || 'createdAt',
  render(container) { this.deleteMode = false; this.selectedIds = new Set(); this.aiCorrectMode = false; this.aiCorrectIds = new Set(); this.renderList(container); },
  _sortWords(words) {
    const arr = [...words];
    if (this.sortMode === 'alpha') {
      arr.sort((a, b) => a.english.localeCompare(b.english, 'ja'));
    } else if (this.sortMode === 'wrongCount') {
      arr.sort((a, b) => (b.wrongCount || 0) - (a.wrongCount || 0));
    } else {
      // createdAt: newest first (default)
      arr.sort((a, b) => {
        const ta = a.createdAt || ''; const tb = b.createdAt || '';
        if (ta === tb) return b.id.localeCompare(a.id);
        return tb.localeCompare(ta);
      });
    }
    return arr;
  },
  // Lightweight refresh: update only the word list + badge without destroying lookup card state
  _refreshWordList(container) {
    const rawWords = DB.getWords();
    const words    = this._sortWords(rawWords);
    const dm  = this.deleteMode;  const sel = this.selectedIds;
    const acm = this.aiCorrectMode; const acs = this.aiCorrectIds;
    // Update badge
    const badge = container.querySelector('.word-count-badge');
    if (badge) badge.textContent = words.length + ' 個單字';
    // Update list
    const listEl = container.querySelector('#db-list');
    if (!listEl) return;
    if (words.length === 0) {
      listEl.innerHTML = `<div class="db-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;margin:auto"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg><div class="db-empty-title">資料庫是空的</div><div class="db-empty-sub">點選「新增」或使用上方 AI 日語辭典加入語彙</div></div>`;
      return;
    }
    listEl.innerHTML = words.map(w => {
      const boosted = DB.isBoosted(w.id);
      return `<div class="db-word-card ${dm?'delete-mode':acm?'ai-correct-mode':''}" data-id="${w.id}">
        <div class="db-checkbox ${dm&&sel.has(w.id)?'checked':acm&&acs.has(w.id)?'checked ai-check':''}" data-id="${w.id}"></div>
        <div class="db-word-main">
          <div class="db-word-en">${w.english}${w.partOfSpeech?`<span class="db-word-pos">${w.partOfSpeech}</span>`:''}${boosted?'<span class="boost-badge">⚡</span>':''}</div>
          ${w.phonetic?`<div class="db-word-phonetic">${escapeHTML(w.phonetic)}${w.romaji ? `・${escapeHTML(w.romaji)}` : ''}</div>`:''}
          <div class="db-word-zh">${w.chinese}</div>
          <div class="db-word-meta"><span>${w.createdAt||'—'}</span><span>答錯 ${w.wrongCount||0}次</span>${(w.frequencyWeight||1)>1?`<span>加權${w.frequencyWeight}x</span>`:''}</div>
        </div>
        <div class="db-word-actions">
          <button class="db-tts-btn" data-tts="${w.english}" title="播放發音"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></button>
          ${(!dm&&!acm)?`<button class="db-word-edit-btn" data-edit="${w.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`:''}
        </div>
      </div>`;
    }).join('');
    // Re-bind TTS and edit buttons on the refreshed list
    listEl.querySelectorAll('.db-tts-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        TTS.speakWhenReady(btn.dataset.tts, 0.82);
        btn.classList.add('tts-playing');
        setTimeout(() => btn.classList.remove('tts-playing'), 1200);
      });
    });
    listEl.querySelectorAll('.db-word-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const w = DB.getWords().find(x => x.id === btn.dataset.edit);
        if (w) this.showEditModal(w, container);
      });
    });
    listEl.querySelectorAll('.db-word-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        if (this.deleteMode) {
          this.selectedIds[this.selectedIds.has(id)?'delete':'add'](id);
          card.querySelector('.db-checkbox')?.classList.toggle('checked', this.selectedIds.has(id));
          const confBtn = container.querySelector('#delete-toggle-btn');
          if (confBtn) confBtn.textContent = this.selectedIds.size > 0 ? `確認(${this.selectedIds.size})` : '確認';
        } else if (this.aiCorrectMode) {
          this.aiCorrectIds[this.aiCorrectIds.has(id)?'delete':'add'](id);
          const cb = card.querySelector('.db-checkbox');
          if (cb) { cb.classList.toggle('checked', this.aiCorrectIds.has(id)); cb.classList.toggle('ai-check', this.aiCorrectIds.has(id)); }
        }
      });
    });
  },

  async renderList(container) {
    const rawWords = DB.getWords();
    const words = this._sortWords(rawWords);
    const dm = this.deleteMode; const sel = this.selectedIds;
    const acm = this.aiCorrectMode; const acs = this.aiCorrectIds;
    const ecdictMeta = null;
    const ecdictLoaded = false;
    container.innerHTML = `
      <div class="section-header">
        <h1 class="section-title">資料庫</h1>
        <span class="word-count-badge">${words.length} 個單字</span>
      </div>
      <div class="lookup-card">
        <!-- Card header -->
        <div class="lookup-card-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          <span>AI 日語辭典</span>
        </div>
        <!-- Segmented tab control -->
        <div class="lookup-seg-wrap">
          <div class="lookup-seg">
            <button class="lookup-seg-btn" data-tab="ecdict">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;flex-shrink:0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              <span class="lookup-seg-label">ECDICT</span>
              ${ecdictLoaded
                ? `<span class="lookup-seg-sub">${Math.round(ecdictMeta.count/10000)}萬字</span>`
                : `<span class="lookup-seg-sub unloaded">未載入</span>`}
            </button>
            <button class="lookup-seg-btn active" data-tab="ai">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;flex-shrink:0"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>
              <span class="lookup-seg-label">AI 查詢</span>
              <span class="lookup-seg-sub">${(Gemini.AVAILABLE_MODELS.find(m=>m.id===DB.getModel())?.id || DB.getModel()).replace('gemini-','').replace('-it','')}</span>
            </button>
          </div>
        </div>
        <!-- ECDICT pane -->
        <div class="lookup-pane" id="pane-ecdict" style="display:none">
          ${ecdictLoaded
            ? `<div class="ecdict-search-wrap">
                <div class="ecdict-search-row">
                  <input class="ecdict-search-input" id="ecdict-search" placeholder="搜尋 ECDICT 單字..." autocorrect="off" autocapitalize="off" spellcheck="false">
                  <button class="ecdict-clear-btn" id="ecdict-clear-btn" title="清除" style="display:none">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
                <div class="ecdict-results" id="ecdict-results"></div>
               </div>
               <div class="ecdict-actions"><button class="btn-icon btn-ecdict-reload" id="ecdict-reload-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>重新載入 CSV</button></div>`
            : `<div class="ecdict-intro"><p>載入 ECDICT.csv 後可快速搜尋單字並新增至練習庫。<br>資料儲存於本機，無需網路。</p><button class="btn-ecdict-load" id="ecdict-load-btn"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 7C2 5.9 2.9 5 4 5H10L12 7H20C21.1 7 22 7.9 22 9V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V7Z" fill="#f5a623" stroke="#d4891a" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 10H22V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V10Z" fill="#ffc84a" stroke="#d4891a" stroke-width="1.5" stroke-linejoin="round"/></svg>選擇 ECDICT.csv 檔案</button></div>`}
          <div id="ecdict-progress" style="display:none"><div class="ecdict-progress-bar"><div class="ecdict-progress-fill" id="ecdict-progress-fill"></div></div><div class="ecdict-progress-text" id="ecdict-progress-text">準備中...</div></div>
        </div>
        <!-- AI pane -->
        <div class="lookup-pane" id="pane-ai">
          ${DB.getApiKey()
            ? `<div class="ai-search-wrap">
                <div class="ecdict-search-row">
                  <div class="ai-input-wrap">
                    <input class="ecdict-search-input" id="ai-word-input" placeholder="輸入日文單字查詢..." autocorrect="off" autocapitalize="off" spellcheck="false">
                    <button class="ecdict-clear-btn ai-clear-btn" id="ai-word-clear-btn" title="清除" style="display:none">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                  <button class="ai-search-btn" id="ai-search-btn" title="查詢">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  </button>
                </div>
                <div id="ai-results"></div>
               </div>`
            : `<div class="ecdict-intro"><p>使用 Gemini AI 查詢日文語彙、假名讀音、羅馬拼音、詞性與繁體中文釋義。<br>請先在設定頁填入 Gemini API Key。</p><button class="btn-ecdict-load" id="ai-goto-settings-btn">前往設定</button></div>`}
        </div>
        <input type="file" id="ecdict-file-input" accept=".csv" style="display:none">
      </div>

      <div class="db-toolbar">
        <button class="btn-icon btn-add" id="add-word-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新增</button>
        <button class="btn-icon btn-export" id="export-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="2" fill="#5b8dd9" stroke="#3a6bc4"/><rect x="6" y="2" width="12" height="8" rx="1" fill="#a8c4f0" stroke="#3a6bc4" stroke-width="1.5"/><rect x="9" y="3.5" width="4" height="5" rx="0.5" fill="#3a6bc4" stroke="none"/><rect x="4" y="13" width="16" height="7" rx="1" fill="#d6e8ff" stroke="#3a6bc4" stroke-width="1.5"/></svg>匯出</button>
        <button class="btn-icon btn-import" id="import-btn"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 7C2 5.9 2.9 5 4 5H10L12 7H20C21.1 7 22 7.9 22 9V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V7Z" fill="#f5a623" stroke="#d4891a" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 10H22V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V10Z" fill="#ffc84a" stroke="#d4891a" stroke-width="1.5" stroke-linejoin="round"/></svg>匯入</button>
        <button class="btn-icon ${dm?'btn-delete-confirm':'btn-delete-toggle'}" id="delete-toggle-btn"${words.length===0?' disabled style="opacity:0.4;cursor:not-allowed"':''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>${dm?(sel.size>0?`確認(${sel.size})`:'確認'):'刪除'}</button>
        <button class="btn-icon ${acm?'btn-ai-correct-active':'btn-ai-correct'}" id="ai-correct-btn"${!DB.getApiKey()||words.length===0?' disabled style="opacity:0.4;cursor:not-allowed"':''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 9.5-9.5z"/></svg>${acm?'取消更正':'AI 更正'}</button>
        ${acm?`<button class="btn-icon btn-ai-correct-run" id="ai-correct-run-btn" style="background:var(--primary);color:#fff">${acs.size>0?`執行 AI 更正 (${acs.size})`:'執行 AI 更正'}</button>`:''}
      </div>
      <input type="file" id="csv-file-input" accept=".csv" style="display:none">
      <!-- 排序列 -->
      <div class="db-sort-bar">
        <span class="db-sort-label">排序：</span>
        <button class="db-sort-chip ${this.sortMode==='createdAt'?'active':''}" data-sort="createdAt">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          建立時間
        </button>
        <button class="db-sort-chip ${this.sortMode==='alpha'?'active':''}" data-sort="alpha">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l8-3 8 3"/><path d="M4 10h16"/><path d="M4 14h16"/><path d="M4 18h16"/></svg>
          五十音順
        </button>
        <button class="db-sort-chip ${this.sortMode==='wrongCount'?'active':''}" data-sort="wrongCount">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          錯誤次數
        </button>
      </div>
      ${dm ? `<button id="db-back-to-top" class="db-back-to-top" title="回到頂部"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg></button>` : ''}
      <div class="db-list-scroll"><div class="db-list" id="db-list">
        ${words.length === 0
          ? `<div class="db-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;margin:auto"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg><div class="db-empty-title">資料庫是空的</div><div class="db-empty-sub">點選「新增」或使用上方 AI 日語辭典加入語彙</div></div>`
          : words.map(w => {
              const boosted = DB.isBoosted(w.id);
              return `<div class="db-word-card ${dm?'delete-mode':acm?'ai-correct-mode':''}" data-id="${w.id}">
                <div class="db-checkbox ${dm&&sel.has(w.id)?'checked':acm&&acs.has(w.id)?'checked ai-check':''}" data-id="${w.id}"></div>
                <div class="db-word-main">
                  <div class="db-word-en">${w.english}${w.partOfSpeech ? `<span class="db-word-pos">${w.partOfSpeech}</span>` : ''}${boosted?'<span class="boost-badge">⚡</span>':''}</div>
                  ${w.phonetic?`<div class="db-word-phonetic">${escapeHTML(w.phonetic)}${w.romaji ? `・${escapeHTML(w.romaji)}` : ''}</div>`:''}
                  <div class="db-word-zh">${w.chinese}</div>
                  <div class="db-word-meta"><span>${w.createdAt||'—'}</span><span>答錯 ${w.wrongCount||0}次</span>${(w.frequencyWeight||1)>1?`<span>加權${w.frequencyWeight}x</span>`:''}</div>
                </div>
                <div class="db-word-actions">
                  <button class="db-tts-btn" data-tts="${w.english}" title="播放發音"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></button>
                  ${(!dm&&!acm)?`<button class="db-word-edit-btn" data-edit="${w.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`:''}
                </div>
              </div>`;
            }).join('')}
      </div></div>
      <div style="height:20px"></div>
    `;
    // TTS buttons in word list
    container.querySelectorAll('.db-tts-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        TTS.speakWhenReady(btn.dataset.tts, 0.82);
        btn.classList.add('tts-playing');
        setTimeout(() => btn.classList.remove('tts-playing'), 1200);
      });
    });
    // ── Tab switching ──
    document.querySelectorAll('.lookup-seg-btn').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.lookup-seg-btn').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const pane = tab.dataset.tab;
        document.getElementById('pane-ecdict').style.display = pane === 'ecdict' ? '' : 'none';
        document.getElementById('pane-ai').style.display = pane === 'ai' ? '' : 'none';
        if (pane === 'ai') setTimeout(() => document.getElementById('ai-word-input')?.focus(), 50);
      });
    });

    // ── Go to settings (when no API key) ──
    document.getElementById('ai-goto-settings-btn')?.addEventListener('click', () => Router.navigate('settings'));

    // ── AI word lookup ──
    const aiWordInput = document.getElementById('ai-word-input');
    const aiSearchBtn = document.getElementById('ai-search-btn');
    const aiResults   = document.getElementById('ai-results');

    const existingWordsSet = () => new Set(DB.getWords().map(w => w.english.toLowerCase()));

    const renderAIResults = (entries) => {
      if (!aiResults) return;
      if (!entries.length) {
        aiResults.innerHTML = '<div class="ecdict-no-result">查無結果，請確認單字拼寫</div>';
        return;
      }
      const existing = existingWordsSet();
      aiResults.innerHTML = entries.map((e, idx) => {
        const alreadyIn = existing.has((e.english||'').toLowerCase());
        return `<div class="ai-result-card" data-idx="${idx}">
          <div class="ai-result-top">
            <span class="ai-result-word">${escapeHTML(e.english)}</span>
            ${e.phonetic ? `<span class="ai-result-phonetic">${escapeHTML(e.phonetic)}${e.romaji ? `・${escapeHTML(e.romaji)}` : ''}</span>` : ''}
            <span class="ai-result-pos-badge">${escapeHTML(e.pos||'')}</span>
            ${e.jlpt ? `<span class="ai-result-pos-badge">${escapeHTML(e.jlpt)}</span>` : ''}
          </div>
          <div class="ai-result-zh">${escapeHTML(e.chinese||'')}</div>
          ${e.example ? `<div class="ai-result-example">${escapeHTML(e.example)}${e.exampleReading ? `<small>${escapeHTML(e.exampleReading)}</small>` : ''}</div>` : ''}
          ${alreadyIn
            ? `<button class="ecdict-add-btn added" disabled>✓ 已在詞庫</button>`
            : `<button class="ecdict-add-btn ai-add-btn" data-idx="${idx}">＋ 加入詞庫</button>`}
        </div>`;
      }).join('');

      // Bind add buttons
      aiResults.querySelectorAll('.ai-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const entry = entries[parseInt(btn.dataset.idx)];
          DB.addWord({
            english:      entry.english,
            partOfSpeech: entry.pos || '',
            chinese:      entry.chinese || '',
            phonetic:     entry.phonetic || '',
            reading:      entry.reading || entry.phonetic || '',
            romaji:       entry.romaji || '',
            example:      entry.example || '',
            exampleReading: entry.exampleReading || '',
            jlpt:         entry.jlpt || '未分級'
          });
          btn.textContent = '✓ 已在詞庫';
          btn.classList.add('added');
          btn.disabled = true;
          showToast(`✓ 已加入「${entry.english}」${entry.pos ? ' ' + entry.pos : ''}`);
          // Clear the search input and hide ✕ button
          const _inp = document.getElementById('ai-word-input');
          const _clr = document.getElementById('ai-word-clear-btn');
          if (_inp) _inp.value = '';
          if (_clr) _clr.style.display = 'none';
          // Instantly update the word list below without re-rendering the whole page
          this._refreshWordList(container);
        });
      });
    };

    const doAISearch = async () => {
      const word = aiWordInput?.value.trim();
      if (!word) return;
      if (!aiResults) return;
      aiResults.innerHTML = '<div class="ai-loading"><span class="ai-spinner"></span>AI 查詢中...</div>';
      aiSearchBtn && (aiSearchBtn.disabled = true);
      try {
        const entries = await Gemini.lookupWord(word);
        renderAIResults(entries);
      } catch(err) {
        let msg = '查詢失敗，請稍後再試';
        const detail = String(err?.message || '');
        if (detail === 'NO_API_KEY') msg = '請先在設定頁填入 Gemini API Key';
        else if (detail === 'NETWORK_ERROR') msg = '網路錯誤，請確認連線';
        else if (/api key|apikey|invalid|permission|authentication/i.test(detail)) msg = 'API Key 無效或權限不足，請至設定頁確認';
        else if (/quota|rate limit/i.test(detail)) msg = '模型配額或速率限制已滿，請稍後再試或更換模型';
        else if (/user location is not supported|region|location|failed_precondition|REGION_UNSUPPORTED/i.test(detail)) msg = 'Gemini API 受目前網路或地區限制，請改用可支援 Gemini API 的網路，或至設定頁確認 API Key';
        else if (/model|not found|not supported|deprecated/i.test(detail)) msg = '目前模型不可用，已嘗試 fallback；請到設定頁改選其他模型';
        aiResults.innerHTML = `<div class="ecdict-no-result">${msg}${detail && detail !== msg ? `<br><span style="font-size:11px;opacity:.65">${escapeHTML(detail)}</span>` : ''}</div>`;
      } finally {
        aiSearchBtn && (aiSearchBtn.disabled = false);
      }
    };

    aiSearchBtn?.addEventListener('click', doAISearch);
    aiWordInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doAISearch(); });

    // X clear button for ai-word-input
    const aiWordClearBtn = document.getElementById('ai-word-clear-btn');
    aiWordInput?.addEventListener('input', () => {
      if (aiWordClearBtn) aiWordClearBtn.style.display = aiWordInput.value ? '' : 'none';
    });
    aiWordClearBtn?.addEventListener('click', () => {
      if (aiWordInput) { aiWordInput.value = ''; aiWordInput.focus(); }
      if (aiResults)   aiResults.innerHTML = '';
      if (aiWordClearBtn) aiWordClearBtn.style.display = 'none';
    });

    // ECDICT events
    const ecdictFileInput = document.getElementById('ecdict-file-input');
    const handleEcdictFile = async (file) => {
      if (!file) return;
      const progressEl = document.getElementById('ecdict-progress');
      const progressFill = document.getElementById('ecdict-progress-fill');
      const progressText = document.getElementById('ecdict-progress-text');
      if (progressEl) progressEl.style.display = 'block';
      const text = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = e => resolve(e.target.result); reader.onerror = reject; if(progressText) progressText.textContent='讀取檔案中...'; reader.readAsText(file, 'UTF-8'); });
      if(progressText) progressText.textContent = '解析中，請稍候...';
      try {
        const count = await ECDICT.importCSV(text, (loaded, total) => {
          const pct = Math.round((loaded/total)*100);
          if (progressFill) progressFill.style.width = pct+'%';
          if (progressText) progressText.textContent = `已處理 ${loaded.toLocaleString()} / ${total.toLocaleString()} 筆...`;
        });
        showToast(`✓ ECDICT 已載入 ${count.toLocaleString()} 個單字`, 3000);
        this.renderList(container);
      } catch(err) { console.error(err); showToast('載入失敗，請確認檔案格式'); if(progressEl) progressEl.style.display='none'; }
    };
    ecdictFileInput?.addEventListener('change', async (e) => { const file = e.target.files[0]; e.target.value=''; await handleEcdictFile(file); });
    document.getElementById('ecdict-load-btn')?.addEventListener('click', () => ecdictFileInput.click());
    document.getElementById('ecdict-reload-btn')?.addEventListener('click', () => ecdictFileInput.click());
    // ECDICT search
    const ecdictSearchInput = document.getElementById('ecdict-search');
    const ecdictResults = document.getElementById('ecdict-results');
    const ecdictClearBtn = document.getElementById('ecdict-clear-btn');
    const clearEcdictSearch = () => {
      if (ecdictSearchInput) { ecdictSearchInput.value = ''; ecdictSearchInput.focus(); }
      if (ecdictResults) ecdictResults.innerHTML = '';
      if (ecdictClearBtn) ecdictClearBtn.style.display = 'none';
    };
    ecdictClearBtn?.addEventListener('click', clearEcdictSearch);

    let searchTimer = null;
    ecdictSearchInput?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = ecdictSearchInput.value.trim();
      if (ecdictClearBtn) ecdictClearBtn.style.display = ecdictSearchInput.value ? 'flex' : 'none';
      if (!q) { ecdictResults.innerHTML=''; return; }
      searchTimer = setTimeout(async () => {
        const results = await ECDICT.search(q, 15);
        if (!ecdictResults) return;
        if (!results.length) { ecdictResults.innerHTML=`<div class="ecdict-no-result">查無結果</div>`; return; }
        const existingWords = new Set(DB.getWords().map(w => w.english));
        ecdictResults.innerHTML = results.map(r => `
          <div class="ecdict-result-item" data-word="${escapeAttr(r.word)}" data-pos="${escapeAttr(r.pos)}" data-zh="${encodeURIComponent(r.chinese||'')}" data-phonetic="${escapeAttr(r.phonetic||'')}">
            <div class="ecdict-result-word">${escapeHTML(r.word)}${r.phonetic?`<span class="ecdict-result-phonetic">/${escapeHTML(r.phonetic)}/</span>`:''}</div>
            <div class="ecdict-result-zh">${escapeHTML(r.chinese)}</div>
            ${existingWords.has(r.word)?`<button class="ecdict-add-btn added" disabled>✓ 已在詞庫</button>`:`<button class="ecdict-add-btn" data-add="${escapeAttr(r.word)}">＋ 加入詞庫</button>`}
          </div>`).join('');
        const POS_OPTIONS = [
          { code:'n.',     label:'n.     名詞' },
          { code:'v.',     label:'v.     動詞' },
          { code:'adj.',   label:'adj.  形容詞' },
          { code:'adv.',   label:'adv.  副詞' },
          { code:'prep.',  label:'prep. 介系詞' },
          { code:'conj.',  label:'conj. 連接詞' },
          { code:'pron.',  label:'pron. 代名詞' },
          { code:'aux.',   label:'aux.  助動詞' },
          { code:'num.',   label:'num.  數詞' },
          { code:'interj.',label:'interj. 感嘆詞' },
          { code:'',       label:'（不設定）' },
        ];
        ecdictResults.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', () => {
          const item = btn.closest('.ecdict-result-item');
          // If picker already open, close it
          if (item.querySelector('.ecdict-pos-picker')) {
            item.querySelector('.ecdict-pos-picker').remove();
            btn.style.display = '';
            return;
          }
          // Hide the add button and show pos picker
          btn.style.display = 'none';
          const suggested = item.dataset.pos || '';
          const picker = document.createElement('div');
          picker.className = 'ecdict-pos-picker';
          picker.innerHTML = `
            <div class="ecdict-pos-picker-label">選擇詞性後加入詞庫：</div>
            <div class="ecdict-pos-chips">
              ${POS_OPTIONS.map(o => `<button class="ecdict-pos-chip${o.code === suggested ? ' suggested' : ''}" data-pos="${o.code}">${o.label}</button>`).join('')}
            </div>
            <button class="ecdict-pos-cancel">取消</button>
          `;
          item.appendChild(picker);
          // Cancel
          picker.querySelector('.ecdict-pos-cancel').addEventListener('click', () => {
            picker.remove();
            btn.style.display = '';
          });
          // Select pos and add
          picker.querySelectorAll('.ecdict-pos-chip').forEach(chip => {
            chip.addEventListener('click', () => {
              const chosenPos = chip.dataset.pos;
              DB.addWord({ english: item.dataset.word, partOfSpeech: chosenPos, chinese: decodeURIComponent(item.dataset.zh), phonetic: item.dataset.phonetic });
              // Update button to "已在詞庫"
              picker.remove();
              btn.style.display = '';
              btn.textContent = '✓ 已在詞庫'; btn.classList.add('added'); btn.disabled = true;
              showToast(`✓ 已加入「${item.dataset.word}」${chosenPos ? ' ' + chosenPos : ''}`);
              // 清除搜尋欄並隱藏結果
              const si = document.getElementById('ecdict-search');
              const cb = document.getElementById('ecdict-clear-btn');
              const er = document.getElementById('ecdict-results');
              if (si) si.value = '';
              if (cb) cb.style.display = 'none';
              if (er) er.innerHTML = '';
              this._refreshWordList(container);
            });
          });
        }));
      }, 300);
    });
    // Back-to-top button (delete mode)
    document.getElementById('db-back-to-top')?.addEventListener('click', () => {
      // Scroll the main content area to top
      const scroller = document.getElementById('view-container');
      if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    });
    // Sort chips
    container.querySelectorAll('.db-sort-chip').forEach(btn => btn.addEventListener('click', () => {
      this.sortMode = btn.dataset.sort;
      AppStorage.setItem('dbSortMode', this.sortMode);
      this.renderList(container);
    }));
    // Toolbar events
    document.getElementById('add-word-btn')?.addEventListener('click', () => this.showAddModal(container));
    document.getElementById('export-btn')?.addEventListener('click', () => {
      if (!words.length) { showToast('資料庫是空的'); return; }
      const blob = new Blob(['\uFEFF'+DB.exportCSV()], {type:'text/csv;charset=utf-8;'});
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href=url; a.download=`japanese_vocab_${todayStr().replace(/\//g,'-')}.csv`; a.click(); URL.revokeObjectURL(url);
      showToast('✓ CSV 已匯出');
    });
    document.getElementById('import-btn')?.addEventListener('click', () => document.getElementById('csv-file-input').click());
    document.getElementById('csv-file-input')?.addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try { const result = DB.importCSV(ev.target.result); showToast(`✓ 已匯入 ${result.added} 個新單字${result.skipped>0?`，略過 ${result.skipped} 筆`:''}`); this.renderList(container); }
        catch(err) { showToast(err.message==='FORMAT_MISMATCH_VOCAB' ? '❌ 格式錯誤：請使用單字庫 CSV（可先匯出取得範本）' : '匯入失敗，請確認 CSV 格式', 3500); }
        e.target.value = '';
      };
      reader.readAsText(file, 'UTF-8');
    });
    const svgTrash = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
    document.getElementById('delete-toggle-btn')?.addEventListener('click', () => {
      if (dm && sel.size > 0) this.confirmDelete(container);
      else if (dm) { this.deleteMode=false; this.selectedIds.clear(); this.renderList(container); }
      else { this.deleteMode=true; this.aiCorrectMode=false; this.aiCorrectIds.clear(); this.renderList(container); }
    });
    document.getElementById('ai-correct-btn')?.addEventListener('click', () => {
      if (!DB.getApiKey()) { showToast('請先在設定頁填入 Gemini API Key'); return; }
      if (acm) { this.aiCorrectMode=false; this.aiCorrectIds.clear(); this.renderList(container); }
      else { this.aiCorrectMode=true; this.deleteMode=false; this.selectedIds.clear(); this.renderList(container); }
    });
    document.getElementById('ai-correct-run-btn')?.addEventListener('click', () => {
      if (this.aiCorrectIds.size === 0) { showToast('請先勾選要更正的單字'); return; }
      this.runAiCorrect(container);
    });
    container.querySelectorAll('.db-checkbox').forEach(cb => cb.addEventListener('click', () => {
      const id = cb.dataset.id;
      if (this.deleteMode) {
        this.selectedIds.has(id) ? this.selectedIds.delete(id) : this.selectedIds.add(id);
        cb.classList.toggle('checked', this.selectedIds.has(id));
        cb.classList.remove('ai-check');
        const btn = document.getElementById('delete-toggle-btn');
        if (btn) btn.innerHTML = svgTrash + (this.selectedIds.size > 0 ? `確認(${this.selectedIds.size})` : '確認');
      } else if (this.aiCorrectMode) {
        this.aiCorrectIds.has(id) ? this.aiCorrectIds.delete(id) : this.aiCorrectIds.add(id);
        cb.classList.toggle('checked', this.aiCorrectIds.has(id));
        cb.classList.toggle('ai-check', this.aiCorrectIds.has(id));
        const btn = document.getElementById('ai-correct-run-btn');
        if (btn) btn.textContent = this.aiCorrectIds.size > 0 ? `執行 AI 更正 (${this.aiCorrectIds.size})` : '執行 AI 更正';
      }
    }));
    container.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
      const word = DB.getWords().find(w => w.id === btn.dataset.edit);
      if (word) this.showEditModal(word, container);
    }));
  },
  async runAiCorrect(container) {
    const ids = [...this.aiCorrectIds];
    const words = DB.getWords().filter(w => ids.includes(w.id));
    if (!words.length) return;

    // Show progress modal
    Modal.show(`<div class="modal-handle"></div>
      <div class="modal-title">AI 查詢中…</div>
      <div style="text-align:center;padding:20px 0">
        <span class="ai-spinner" style="width:32px;height:32px;border-width:3px;display:inline-block"></span>
        <div id="ai-correct-status" style="margin-top:12px;color:var(--text-secondary);font-size:14px">正在查詢 ${words.length} 個單字…</div>
      </div>`);

    const results = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const statusEl = document.getElementById('ai-correct-status');
      if (statusEl) statusEl.textContent = `查詢中 ${i+1} / ${words.length}：${w.english}`;
      try {
        const entries = await Gemini.lookupWord(w.english);
        results.push({ original: w, entries: (entries && entries.length) ? entries : null, error: null });
      } catch(e) {
        results.push({ original: w, entries: null, error: e.message || '查詢失敗' });
      }
    }
    Modal.hide();
    this.showAiCorrectConfirmModal(results, container);
  },

  showAiCorrectConfirmModal(results, container) {
    const hasData = results.filter(r => r.entries && r.entries.length);
    const noData  = results.filter(r => !r.entries);
    const POS_OPTS = ['n.','v.','adj.','adv.','prep.','conj.','pron.','aux.','num.','interj.'];

    Modal.show(`<div class="modal-handle"></div>
      <div class="modal-title">確認 AI 更正</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">
        取得 ${hasData.length} 筆建議${noData.length ? `，${noData.length} 筆查無結果` : ''}。
        可修改中文後按「確認修正」套用。
      </div>
      <div id="ai-correct-list" style="max-height:55vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px">
        ${results.map(r => {
          if (!r.entries || !r.entries.length) {
            return `<div style="padding:10px;background:var(--surface);border-radius:8px;border:1px solid var(--border);opacity:0.6">
              <span style="font-weight:600;color:var(--text-primary)">${r.original.english}</span>
              <span style="margin-left:8px;font-size:12px;color:var(--danger)">❌ ${r.error || '查無結果'}</span>
            </div>`;
          }
          const rawPhonetic = (r.entries[0].phonetic || '').replace(/^\/+|\/+$/g, '');
          // Default to entry matching original pos, else first
          const defIdx = Math.max(0, r.entries.findIndex(e => e.pos === r.original.partOfSpeech));
          return `<div class="ai-correct-item" data-word-id="${r.original.id}" data-phonetic="${rawPhonetic}" style="padding:12px;background:var(--surface);border-radius:10px;border:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
              <span style="font-weight:700;font-size:15px;color:var(--text-primary)">${r.entries[0].english}</span>
              ${rawPhonetic ? `<span style="font-size:12px;color:var(--text-secondary)">/${rawPhonetic}/</span>` : ''}
              <span style="font-size:11px;color:var(--text-muted);margin-left:auto">原：${r.original.partOfSpeech||'—'} ${r.original.chinese}</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
              <span style="font-size:12px;color:var(--text-secondary);white-space:nowrap">詞性</span>
              <select class="ai-correct-pos" style="flex:1;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text-primary)"
                data-all-entries="${encodeURIComponent(JSON.stringify(r.entries))}">
                ${r.entries.map((e, i) => `<option value="${i}" ${i===defIdx?'selected':''}>${escapeHTML(e.pos)}</option>`).join('')}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <span style="font-size:12px;color:var(--text-secondary);white-space:nowrap">中文</span>
              <input class="ai-correct-zh" type="text"
                style="flex:1;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text-primary)"
                value="${escapeAttr(r.entries[defIdx].chinese)}">
            </div>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="modal-btn-cancel" id="ai-cc-cancel" style="flex:1">取消</button>
        <button class="modal-btn-confirm" id="ai-cc-confirm" style="flex:2${!hasData.length?' opacity:0.4;pointer-events:none':''}">確認修正 ${hasData.length} 個</button>
      </div>`);

    // Wire: when pos changes, update chinese field
    document.querySelectorAll('.ai-correct-pos').forEach(sel => {
      sel.addEventListener('change', () => {
        const entries = JSON.parse(decodeURIComponent(sel.dataset.allEntries));
        const idx = parseInt(sel.value);
        const zhInput = sel.closest('.ai-correct-item').querySelector('.ai-correct-zh');
        if (zhInput && entries[idx]) zhInput.value = entries[idx].chinese;
      });
    });

    document.getElementById('ai-cc-cancel').addEventListener('click', () => {
      Modal.hide();
      this.aiCorrectMode = false; this.aiCorrectIds.clear();
      this.renderList(container);
    });

    document.getElementById('ai-cc-confirm').addEventListener('click', () => {
      let updated = 0;
      document.querySelectorAll('.ai-correct-item[data-word-id]').forEach(item => {
        const id = item.dataset.wordId;
        const phonetic = item.dataset.phonetic || '';
        const posSel = item.querySelector('.ai-correct-pos');
        const zhInput = item.querySelector('.ai-correct-zh');
        if (!posSel || !zhInput) return;
        const posText = posSel.options[posSel.selectedIndex]?.text || '';
        const chinese = zhInput.value.trim();
        if (!chinese) return;
        DB.updateWord(id, { phonetic, partOfSpeech: posText, chinese });
        updated++;
      });
      Modal.hide();
      this.aiCorrectMode = false; this.aiCorrectIds.clear();
      showToast(`✓ 已更正 ${updated} 個單字`);
      this.renderList(container);
    });
  },
  confirmDelete(container) {
    const count = this.selectedIds.size;
    Modal.show(`<div class="modal-handle"></div><div class="modal-title">確認刪除</div><p style="color:var(--text-muted);font-size:14px;margin-bottom:16px">確定要刪除這 <strong style="color:var(--danger)">${count}</strong> 個單字嗎？</p><div class="modal-actions"><button class="modal-btn-cancel" id="cancel-del">取消</button><button class="modal-btn-delete" id="confirm-del">確認刪除 ${count} 個</button></div>`);
    document.getElementById('cancel-del').addEventListener('click', () => Modal.hide());
    document.getElementById('confirm-del').addEventListener('click', () => {
      DB.deleteWords([...this.selectedIds]); this.deleteMode=false; this.selectedIds.clear();
      Modal.hide(); showToast(`已刪除 ${count} 個單字`); this.renderList(container);
    });
  },
  showAddModal(container) {
    const posOptions = ['名詞','五段動詞','一段動詞','不規則動詞','い形容詞','な形容詞','副詞','助詞','接續詞','慣用語'];
    Modal.show(`<div class="modal-handle"></div><div class="modal-title">新增日文語彙</div>
      <div class="form-group"><label class="form-label">日文語彙 *</label><input class="form-input" id="new-en" placeholder="例：食べる" lang="ja" autocorrect="off" autocapitalize="off" spellcheck="false" inputmode="text"></div>
      <div class="form-group"><label class="form-label">詞性 *</label><select class="form-select" id="new-pos">${posOptions.map(p=>`<option>${p}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">繁體中文意思 *</label><input class="form-input" id="new-zh" placeholder="例：吃；食用"></div>
      <div class="form-group"><label class="form-label">假名讀音（可選）</label><input class="form-input" id="new-phonetic" placeholder="例：たべる" lang="ja" autocorrect="off" autocapitalize="off"></div>
      <div class="form-group"><label class="form-label">羅馬拼音（可選）</label><input class="form-input" id="new-romaji" placeholder="例：taberu" autocorrect="off" autocapitalize="off"></div>
      <div class="form-group"><label class="form-label">JLPT 等級</label><select class="form-select" id="new-jlpt">${['N5','N4','N3','N2','N1','未分級'].map(level=>`<option>${level}</option>`).join('')}</select></div>
      <div class="modal-actions"><button class="modal-btn-cancel" id="cancel-add">取消</button><button class="modal-btn-confirm" id="confirm-add">新增</button></div>`);
    document.getElementById('cancel-add').addEventListener('click', () => Modal.hide());
    document.getElementById('confirm-add').addEventListener('click', () => {
      const en=document.getElementById('new-en').value.trim(); const pos=document.getElementById('new-pos').value;
      const zh=document.getElementById('new-zh').value.trim(); const phonetic=document.getElementById('new-phonetic').value.trim();
      const romaji=document.getElementById('new-romaji').value.trim(); const jlpt=document.getElementById('new-jlpt').value;
      if (!en||!zh) { showToast('請填入日文語彙和繁體中文意思'); return; }
      DB.addWord({english:en,partOfSpeech:pos,chinese:zh,phonetic,reading:phonetic,romaji,jlpt}); Modal.hide(); showToast('✓ 日文語彙已新增'); this.renderList(container);
    });
    setTimeout(() => document.getElementById('new-en')?.focus(), 100);
  },
  showEditModal(word, container) {
    const posOptions = ['名詞','五段動詞','一段動詞','不規則動詞','い形容詞','な形容詞','副詞','助詞','接續詞','慣用語'];
    if (word.partOfSpeech && !posOptions.includes(word.partOfSpeech)) posOptions.unshift(word.partOfSpeech);
    Modal.show(`<div class="modal-handle"></div><div class="modal-title">編輯日文語彙</div>
      <div class="form-group"><label class="form-label">日文語彙</label><input class="form-input" id="edit-en" value="${escapeAttr(word.english)}" lang="ja" autocorrect="off" autocapitalize="off" spellcheck="false"></div>
      <div class="form-group"><label class="form-label">詞性</label><select class="form-select" id="edit-pos">${posOptions.map(p=>`<option ${p===word.partOfSpeech?'selected':''}>${p}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">中文意思</label><input class="form-input" id="edit-zh" value="${escapeAttr(word.chinese)}"></div>
      <div class="form-group"><label class="form-label">假名讀音（可選）</label><input class="form-input" id="edit-phonetic" value="${escapeAttr(word.phonetic||'')}" lang="ja" autocorrect="off" autocapitalize="off"></div>
      <div class="form-group"><label class="form-label">羅馬拼音（可選）</label><input class="form-input" id="edit-romaji" value="${escapeAttr(word.romaji||'')}" autocorrect="off" autocapitalize="off"></div>
      <div class="form-group"><label class="form-label">JLPT 等級</label><select class="form-select" id="edit-jlpt">${['N5','N4','N3','N2','N1','未分級'].map(level=>`<option ${level===(word.jlpt||'未分級')?'selected':''}>${level}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">頻率加權</label><select class="form-select" id="edit-weight">${[1,2,3,5].map(n=>`<option value="${n}" ${n===(word.frequencyWeight||1)?'selected':''}>${n}x${n===1?' (預設)':''}</option>`).join('')}</select></div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">答錯次數：${word.wrongCount||0} 次</div>
      <div class="modal-actions"><button class="modal-btn-cancel" id="cancel-edit">取消</button><button class="modal-btn-confirm" id="confirm-edit">儲存</button></div>`);
    document.getElementById('cancel-edit').addEventListener('click', () => Modal.hide());
    document.getElementById('confirm-edit').addEventListener('click', () => {
      const en=document.getElementById('edit-en').value.trim(); const pos=document.getElementById('edit-pos').value;
      const zh=document.getElementById('edit-zh').value.trim(); const phonetic=document.getElementById('edit-phonetic').value.trim();
      const romaji=document.getElementById('edit-romaji').value.trim(); const jlpt=document.getElementById('edit-jlpt').value;
      const weight=parseInt(document.getElementById('edit-weight').value);
      if (!en||!zh) { showToast('請填入日文語彙和繁體中文意思'); return; }
      DB.updateWord(word.id,{english:en,japanese:en,partOfSpeech:pos,chinese:zh,phonetic,reading:phonetic,romaji,jlpt,frequencyWeight:weight});
      Modal.hide(); showToast('✓ 已儲存'); this.renderList(container);
    });
  }
};

// ===========================
// STATS VIEW — statistics display; CSV export lives in Settings
// ===========================

// ===========================
// ESSAY VIEW
// ===========================
Views.essay = {
  _mode: 'vocab',   // 'vocab' | 'ai'
  _topic: '',       // topic string (Japanese)
  _topicZh: '',     // topic string (Chinese)
  _pool: [],        // selected vocab words

  render(container, keepMode) {
    if (!keepMode) { this._mode = 'vocab'; this._topic = ''; }
    const words  = DB.getWords();
    const hasKey = !!DB.getApiKey();
    this._pool = [...words].sort(() => Math.random() - 0.5).slice(0, 3);

    const modeVocabActive = this._mode === 'vocab';

    container.innerHTML = `
      <div class="practice-compact-page essay-practice-page">
      <div class="section-header practice-page-header">
        <button class="back-link" id="essay-back-btn">← 返回</button>
        <h1 class="section-title">文章撰寫</h1>
      </div>
      ${renderPracticeModeSelector('essay')}
      <section class="practice-compact-card essay-practice-card">
      <div class="practice-compact-heading">
        <div class="practice-compact-mark" aria-hidden="true">文</div>
        <div><h2>日文文章撰寫</h2><p>選擇單字題目或 AI 出題，在同一頁完成寫作並送出批改。</p></div>
      </div>
      ${!hasKey ? '<div class="no-api-warning">請先在設定頁填入 Gemini API Key</div>' : ''}

      <div class="essay-mode-toggle">
        <button class="essay-mode-btn ${modeVocabActive?'active':''}" id="essay-mode-vocab">📚 單字題目</button>
        <button class="essay-mode-btn ${!modeVocabActive?'active':''}" id="essay-mode-ai">🤖 AI 出題</button>
      </div>

      <div id="essay-prompt-area">
        ${modeVocabActive ? this._buildVocabPrompt(words) : this._buildAiTopicArea()}
      </div>

      <div class="essay-input-card">
        <div class="essay-input-label">
          <span>撰寫文章</span>
          <span class="essay-char-count" id="essay-char-count">0 / 500</span>
        </div>
        <textarea class="essay-textarea" id="essay-textarea"
          placeholder="${modeVocabActive ? '請以上方 3 個單字為主題，撰寫一篇 500 字以內的日文文章...' : '請依照 AI 出題撰寫日文文章（500 字以內）...'}"
          maxlength="500"
          ${(modeVocabActive && words.length < 3) || !hasKey ? 'disabled' : ''}></textarea>
      </div>
      <button class="btn-primary" id="essay-submit-btn"
        ${(modeVocabActive && words.length < 3) || !hasKey || (!modeVocabActive && !this._topic) ? 'disabled' : ''}
        style="margin-top:8px">
        送出文章給 AI 批改
      </button>
      </section>
      <div id="essay-result-area" style="margin-top:16px"></div>
      <div style="height:20px"></div>
      </div>
    `;

    bindPracticeModeSelector(container, 'essay');

    // Mode toggle
    document.getElementById('essay-mode-vocab')?.addEventListener('click', () => {
      this._mode = 'vocab'; this._topic = ''; this._topicZh = '';
      Router.essayActive = false;
      this.render(container, true);
    });
    document.getElementById('essay-mode-ai')?.addEventListener('click', () => {
      this._mode = 'ai';
      Router.essayActive = false;
      this.render(container, true);
    });

    document.getElementById('essay-back-btn').addEventListener('click', () => { Router.essayActive = false; Views.practice.render(container); });

    // Vocab mode: reroll
    document.getElementById('essay-reroll')?.addEventListener('click', () => {
      Router.essayActive = false;
      this._mode = 'vocab'; this._topic = '';
      this.render(container, false);
    });

    // AI mode: generate topic
    document.getElementById('essay-gen-topic-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('essay-gen-topic-btn');
      const topicBox = document.getElementById('ai-topic-box');
      const submitBtn = document.getElementById('essay-submit-btn');
      const textarea = document.getElementById('essay-textarea');
      btn.disabled = true; btn.textContent = '⏳ 生成中...';
      if (topicBox) topicBox.textContent = '正在請 AI 出題...';
      // Built-in Japanese/Traditional-Chinese topic list — no API call needed.
      const _TOPICS = [
        {en:'子どものころの楽しい思い出について書いてください。',zh:'請寫一段童年時的快樂回憶。'},
        {en:'あなたの理想の週末はどんな週末ですか。',zh:'你理想中的週末是什麼樣子？'},
        {en:'好きな食べ物と、その理由を説明してください。',zh:'請介紹你喜歡的食物及原因。'},
        {en:'毎日の生活で大切にしている習慣は何ですか。',zh:'日常生活中你重視哪一項習慣？'},
        {en:'行ってみたい日本の場所と、その理由を書いてください。',zh:'請寫下想去的日本景點及原因。'},
        {en:'あなたの趣味は生活にどんな影響を与えていますか。',zh:'你的興趣對生活帶來什麼影響？'},
        {en:'最近がんばったことについて書いてください。',zh:'請寫下最近努力完成的一件事。'},
        {en:'家族や友だちとの大切な思い出を紹介してください。',zh:'請介紹與家人或朋友的一段珍貴回憶。'},
        {en:'都会と田舎では、どちらに住みたいですか。理由も書いてください。',zh:'你想住都市還是鄉下？請說明原因。'},
        {en:'健康のためにしていることは何ですか。',zh:'你為健康做了哪些事？'},
        {en:'日本語を勉強して、できるようになったことを書いてください。',zh:'請寫下學習日文後學會或做到的事。'},
        {en:'好きな本、映画、またはドラマを紹介してください。',zh:'請介紹你喜歡的書、電影或戲劇。'},
        {en:'失敗から学んだ大切なことについて書いてください。',zh:'請寫下你從失敗中學到的重要事情。'},
        {en:'もし一年間外国に住めるなら、どこに住みたいですか。',zh:'如果能在國外住一年，你想住哪裡？'},
        {en:'あなたにとって「幸せ」とは何ですか。',zh:'對你而言，「幸福」是什麼？'},
        {en:'環境を守るために、私たちができることを書いてください。',zh:'請寫下我們能為環境保護做的事。'},
        {en:'音楽はあなたの気持ちにどんな影響を与えますか。',zh:'音樂如何影響你的心情？'},
        {en:'将来身につけたい技能と、その理由を説明してください。',zh:'請說明未來想學會的技能及原因。'},
        {en:'忙しいとき、どのように気分転換をしますか。',zh:'忙碌時你如何轉換心情？'},
        {en:'二十年後の生活はどう変わると思いますか。',zh:'你認為二十年後的生活會如何改變？'}
      ];
      // Pick a topic that hasn't been used recently (avoid repeats)
      if (!Views.essay._usedTopicIdxs) Views.essay._usedTopicIdxs = [];
      const available = _TOPICS.map((_,i)=>i).filter(i => !Views.essay._usedTopicIdxs.includes(i));
      if (available.length === 0) Views.essay._usedTopicIdxs = [];
      const pool2 = available.length > 0 ? available : _TOPICS.map((_,i)=>i);
      const idx = pool2[Math.floor(Math.random() * pool2.length)];
      Views.essay._usedTopicIdxs.push(idx);
      if (Views.essay._usedTopicIdxs.length > 10) Views.essay._usedTopicIdxs.shift();

      const picked = _TOPICS[idx];
      this._topic = picked.en;
      this._topicZh = picked.zh;
      if (topicBox) {
        topicBox.innerHTML =
          `<div style="font-weight:700;color:var(--text-primary);line-height:1.5;margin-bottom:5px">${escapeHTML(picked.en)}</div>` +
          `<div style="font-size:13px;color:var(--text-secondary);line-height:1.5">${escapeHTML(picked.zh)}</div>`;
      }
      if (textarea) textarea.disabled = false;
      if (submitBtn) submitBtn.disabled = false;
      btn.textContent = '🔄 換一題';
      btn.disabled = false;
    });

    const textarea = document.getElementById('essay-textarea');
    const charCount = document.getElementById('essay-char-count');
    textarea?.addEventListener('input', () => {
      const len = textarea.value.length;
      charCount.textContent = `${len} / 500`;
      charCount.style.color = len > 450 ? 'var(--danger)' : 'var(--text-muted)';
      Router.essayActive = len > 0;
    });

    document.getElementById('essay-submit-btn')?.addEventListener('click', async () => {
      const essay = textarea?.value.trim();
      if (!essay || essay.length < 30) { showToast('文章太短，請至少寫 30 個字元'); return; }
      const resultArea = document.getElementById('essay-result-area');
      const submitBtn = document.getElementById('essay-submit-btn');
      submitBtn.disabled = true; submitBtn.textContent = '⏳ AI 批改中...';
      resultArea.innerHTML = '<div class="essay-loading"><div class="loading-dots"><span></span><span></span><span></span></div><span>AI 正在批改您的文章，請稍候...</span></div>';

      const isAiMode = this._mode === 'ai';
      const topic    = this._topic;
      const pool     = isAiMode ? [] : this._pool;

      try {
        const feedback = isAiMode
          ? await Gemini.reviewEssayFree(essay, topic)
          : await Gemini.reviewEssay(essay, pool);
        Router.essayActive = false;
        this._renderFeedback(resultArea, feedback, essay, pool, container);
        const annotatedHtml = Views.essay._buildAnnotatedEssay(essay, (feedback.grammar||[]).map((g,i)=>({...g,idx:i})));
        DB.addEssaySession({ date: todayStr(), words: pool, essay, feedback: JSON.stringify(feedback), score: feedback.score, annotatedHtml, essayMode: isAiMode?'ai':'vocab', topic: isAiMode?topic:'' });
      } catch(e) {
        const raw = e.message || '';
        let msg = '❌ 批改失敗', detail = '';
        if (raw === 'NO_API_KEY')          msg = '🔑 請先在設定頁填入 Gemini API Key';
        else if (raw === 'NETWORK_ERROR')  msg = '🌐 網路連線失敗，請確認網路後重試';
        else if (raw.startsWith('PARSE_ERROR')) { msg = '⚠️ AI 回應格式無法解析'; detail = raw.replace('PARSE_ERROR: ',''); }
        else if (raw === 'EMPTY_RESPONSE') msg = '⚠️ AI 回傳空白回應，請重試';
        else if (raw.includes('quota') || raw.includes('RESOURCE_EXHAUSTED')) msg = '⏳ API 配額已用盡，請稍後再試';
        else if (raw.includes('API_KEY_INVALID') || raw.includes('invalid')) msg = '🔑 API Key 無效';
        else if (raw.includes('429')) msg = '⏳ 請求過於頻繁，請稍候再試';
        resultArea.innerHTML = `<div class="essay-error">${msg}${detail?`<div class="essay-error-detail">${detail}</div>`:''}<div class="essay-error-retry">請點下方按鈕重試</div></div>`;
        submitBtn.disabled = false; submitBtn.textContent = '重新送出';
      }
    });
  },

  _buildVocabPrompt(words) {
    if (words.length < 3) return '<div class="no-api-warning">單字庫需至少 3 個單字才能進行文章撰寫練習</div>';
    return `<div class="essay-words-card">
        <div class="essay-words-top">
          <div class="essay-words-label">請使用以下 3 個單字撰寫文章：</div>
          <button class="essay-reroll-inline" id="essay-reroll">🔀 換一組</button>
        </div>
        <div class="essay-chips-row">
          ${this._pool.map(w => `<div class="essay-chip-pill">
            <div class="essay-chip-top">
              <span class="essay-chip-en">${w.english}</span>
              ${w.partOfSpeech ? `<span class="essay-chip-pos">${w.partOfSpeech}</span>` : ''}
            </div>
            <div class="essay-chip-zh">${w.chinese}</div>
          </div>`).join('')}
        </div>
      </div>`;
  },

  _buildAiTopicArea() {
    const hasTopic = !!this._topic;
    return `<div class="essay-ai-topic-card">
        <div class="essay-ai-topic-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;flex-shrink:0"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>
          AI 出題
        </div>
        <div id="ai-topic-box" class="essay-ai-topic-box">
          ${hasTopic
            ? `<div style="font-weight:700;color:var(--text-primary);line-height:1.5;margin-bottom:5px">${escapeHTML(this._topic)}</div>`
              + (this._topicZh ? `<div style="font-size:13px;color:var(--text-secondary);line-height:1.5">${escapeHTML(this._topicZh)}</div>` : '')
            : '<span style="color:var(--text-muted)">點擊下方按鈕隨機出一道日文寫作題目</span>'}
        </div>
        <button class="btn-secondary" id="essay-gen-topic-btn" style="margin-top:8px;width:100%">
          ${hasTopic ? '🔄 換一題' : '🎲 隨機出題'}
        </button>
      </div>`;
  },

  _buildAnnotatedEssay(essay, grammar) {
    // Build annotated essay: replace each exact error with red-highlight + green correction
    // Process errors from longest to shortest to avoid overlap issues
    const errors = (grammar || []).filter(g => g.exact && essay.includes(g.exact));
    // Sort by position in essay (first occurrence)
    const sorted = errors.map((g, idx) => ({ ...g, idx, pos: essay.indexOf(g.exact) }))
                         .sort((a, b) => a.pos - b.pos);
    // Build HTML by scanning through essay
    let result = '';
    let cursor = 0;
    for (const g of sorted) {
      const pos = essay.indexOf(g.exact, cursor);
      if (pos < cursor) continue; // already consumed or not found
      // Plain text before this error
      result += this._escapeHtml(essay.slice(cursor, pos));
      // Annotated error
      result += `<a class="err-anchor" href="#err-detail-${g.idx}" id="err-text-${g.idx}">` +
        `<span class="err-orig">${this._escapeHtml(g.exact)}</span>` +
        `<span class="err-fix">${this._escapeHtml(g.corrected)}</span>` +
        `</a>`;
      cursor = pos + g.exact.length;
    }
    result += this._escapeHtml(essay.slice(cursor));
    return result;
  },

  _escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
              .replace(/"/g,'&quot;').replace(/\n/g,'<br>');
  },

  _renderFeedback(container, fb, essay, words, pageContainer) {
    const scoreColor = fb.score >= 8 ? 'var(--correct)' : fb.score >= 5 ? '#f5a623' : 'var(--danger)';
    const grammar = (fb.grammar || []).map((g, idx) => ({ ...g, idx }));

    // ── Word check badges ──
    const wordCheckHtml = (fb.wordCheck || words.map(w => ({ word: w.english, used: false, correct: false, note: '' }))).map(w =>
      `<span class="fb-badge ${w.used && w.correct ? 'fb-ok' : w.used ? 'fb-warn' : 'fb-missing'}">
        ${w.used && w.correct ? '✓' : w.used ? '△' : '✗'} ${this._escapeHtml(w.word || '')}
        ${w.note ? `<span class="fb-badge-note"> — ${this._escapeHtml(w.note)}</span>` : ''}
      </span>`).join('');

    // ── Annotated essay ──
    const annotatedEssay = this._buildAnnotatedEssay(essay, grammar);
    const hasErrors = grammar.filter(g => g.exact && essay.includes(g.exact)).length > 0;

    // ── Grammar detail cards (below essay) ──
    const grammarDetailHtml = grammar.length === 0
      ? '<div class="fb-ok-msg">✓ 未發現明顯文法錯誤</div>'
      : grammar.map(g => `
        <div class="err-detail-card" id="err-detail-${g.idx}">
          <div class="err-detail-header">
            <span class="err-detail-num">#${g.idx + 1}</span>
            <a class="err-back-link" href="#err-text-${g.idx}">↑ 回到文章</a>
          </div>
          <div class="err-detail-row">
            <span class="err-detail-label err-label-wrong">✗ 原文</span>
            <span class="err-detail-orig">${this._escapeHtml(g.exact || g.original || '')}</span>
          </div>
          <div class="err-detail-row">
            <span class="err-detail-label err-label-fix">✓ 修正</span>
            <span class="err-detail-fixed">${this._escapeHtml(g.corrected || '')}</span>
          </div>
          ${g.explanation ? `<div class="err-detail-exp">${this._escapeHtml(g.explanation)}</div>` : ''}
        </div>`).join('');

    // ── Suggestions ──
    const suggestHtml = (fb.suggestions || []).map(s => `<div class="essay-fb-suggest">💡 ${this._escapeHtml(s)}</div>`).join('');

    container.innerHTML = `
      <div class="essay-fb-card">
        <div class="essay-fb-score-row-top">
          <div class="essay-fb-score" style="color:${scoreColor}">${fb.score}<span class="essay-score-denom">/10</span></div>
          <div class="essay-fb-comment">${this._escapeHtml(fb.comment || '')}</div>
        </div>

        <div class="essay-fb-section-title">📋 單字使用</div>
        <div class="essay-fb-badges">${wordCheckHtml}</div>

        <div class="essay-fb-section-title">
          📄 批改文章
          ${hasErrors ? '<span class="err-legend"><span class="err-legend-r">紅字</span>=錯誤　<span class="err-legend-g">綠字</span>=修正（點紅字看詳解）</span>' : ''}
        </div>
        <div class="annotated-essay" id="annotated-essay">${annotatedEssay}</div>

        ${grammar.length > 0 ? `
        <div class="essay-fb-section-title" style="margin-top:20px">📝 文法詳解（${grammar.length} 處）</div>
        <div class="grammar-detail-list">${grammarDetailHtml}</div>` : `
        <div class="fb-ok-msg" style="margin-top:12px">✓ 未發現明顯文法錯誤</div>`}

        <div class="essay-fb-section-title" style="margin-top:20px">💬 文章建議</div>
        <div class="essay-fb-suggest-list">${suggestHtml}</div>

        <button class="btn-secondary" id="essay-retry-btn" style="margin-top:20px">再寫一篇</button>
      </div>
    `;
    document.getElementById('essay-retry-btn').addEventListener('click', () => { Router.essayActive = false; this.render(pageContainer, true); });

    // Smooth scroll for anchor links inside the feedback card
    container.querySelectorAll('a.err-anchor, a.err-back-link').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const target = document.querySelector(a.getAttribute('href'));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }
};

// ===========================
// AI ASK VIEW
// ===========================
Views.aiAsk = {
  // Generate YYMMDDHHMM id
  _makeId() {
    const d = new Date();
    const yy = String(d.getFullYear()).slice(2).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    const hh = String(d.getHours()).padStart(2,'0');
    const mn = String(d.getMinutes()).padStart(2,'0');
    return yy + mm + dd + hh + mn;
  },

  render(container) {
    const history = DB.getAiAskHistory();
    const hasKey  = !!DB.getApiKey();
    const model   = DB.getModel();
    const modelLabel = (Gemini.AVAILABLE_MODELS.find(m => m.id === model)?.label) || model;

    container.innerHTML = `
      <div class="practice-compact-page aiask-practice-page">
      <div class="section-header practice-page-header">
        <button class="back-link" id="aiask-back-btn">← 返回</button>
        <h1 class="section-title">AI 詢問</h1>
      </div>
      ${renderPracticeModeSelector('aiask')}

      ${!hasKey ? '<div class="no-api-warning">請先在設定頁填入 Gemini API Key 才能使用 AI 詢問</div>' : ''}

      <section class="settings-card practice-compact-card aiask-practice-card" style="margin-bottom:10px">
        <div class="practice-compact-heading">
          <div class="practice-compact-mark" aria-hidden="true">問</div>
          <div><h2>AI 日文老師</h2><p>詢問日文文法、句子修改或單字用法，並保留查詢記錄。</p></div>
        </div>
        <div class="aiask-input-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;flex-shrink:0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          提問（日文文法、句子修改、單字用法…）
        </div>
        <div class="aiask-model-hint">模型：${escapeHTML(modelLabel)}</div>
        <textarea class="aiask-textarea" id="aiask-textarea"
          placeholder="e.g. How do I use 'however' correctly? &#10;Or: Please correct my sentence: I goed to the store yesterday."
          ${!hasKey ? 'disabled' : ''}></textarea>
        <div class="aiask-char-row">
          <span class="aiask-char-count" id="aiask-char-count">0 / 800</span>
          <button class="btn-primary" id="aiask-submit-btn" style="padding:8px 20px;font-size:13px" ${!hasKey ? 'disabled' : ''}>
            送出
          </button>
        </div>
        <div id="aiask-result-area" style="margin-top:10px"></div>
      </section>

      <div style="display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px;padding:0 2px">
        <span style="font-size:13px;font-weight:700;color:var(--text-primary)">詢問記錄 <span style="font-weight:400;color:var(--text-muted)">${history.length} 筆</span></span>
        ${history.length > 1 ? `<button class="btn-sort-toggle" id="aiask-sort-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><path d="M3 6h18M7 12h10M11 18h2"/></svg>
          新→舊
        </button>` : ''}
      </div>
      <div id="aiask-history-list"></div>
      <div style="height:20px"></div>
      </div>
    `;

    bindPracticeModeSelector(container, 'aiask');

    document.getElementById('aiask-back-btn')?.addEventListener('click', () => {
      Router.essayActive = false;
      Views.practice.render(container);
    });

    const textarea  = document.getElementById('aiask-textarea');
    const charCount = document.getElementById('aiask-char-count');
    const resultArea= document.getElementById('aiask-result-area');
    const submitBtn = document.getElementById('aiask-submit-btn');

    textarea?.addEventListener('input', () => {
      const len = textarea.value.length;
      charCount.textContent = `${len} / 800`;
      charCount.style.color = len > 720 ? 'var(--danger)' : 'var(--text-muted)';
    });

    submitBtn?.addEventListener('click', async () => {
      const q = (textarea?.value || '').trim();
      if (!q) { showToast('請輸入問題'); return; }
      if (q.length > 800) { showToast('問題最多 800 字'); return; }

      submitBtn.disabled = true;
      resultArea.innerHTML = '<div class="ai-loading"><span class="ai-spinner"></span>AI 回覆中...</div>';

      try {
        const systemPrompt = `You are a Japanese language tutor for a Traditional Chinese learner. Answer Japanese-learning questions clearly in Traditional Chinese (繁體中文). Include kana readings for uncommon kanji when useful. When correcting Japanese, show the corrected Japanese sentence, explain particles, conjugation, kanji/kana spelling and naturalness, and preserve the learner's intended meaning. Be concise but thorough.`;
        const apiKey = DB.getApiKey();
        if (!apiKey) throw new Error('NO_API_KEY');
        const fullPrompt = systemPrompt + '\n\nUser question:\n' + q;
        const body = JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 8192 }
        });
        let answer = ''; let lastErr = null;
        for (const model of Gemini._getModelList()) {
          try {
            const raw = await Gemini._callModel(model, body, apiKey);
            if (!raw) { lastErr = new Error('EMPTY_RESPONSE'); continue; }
            // Strip thinking tags if any
            answer = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
            break;
          } catch(err) {
            if (err.message === 'NETWORK_ERROR') throw err;
            if (err.fallback) { lastErr = err; continue; }
            throw err;
          }
        }
        if (!answer) throw (lastErr || new Error('API_ERROR'));
        const id = this._makeId();
        DB.addAiAskEntry({ id, question: q, answer, ts: Date.now() });

        resultArea.innerHTML = `
          <div class="aiask-answer-box">
            <div class="aiask-answer-label">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;flex-shrink:0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              AI 回覆
            </div>
            <div class="aiask-answer-text">${nl2br(answer)}</div>
          </div>`;

        if (textarea) textarea.value = '';
        if (charCount) { charCount.textContent = '0 / 800'; charCount.style.color = ''; }

        // Refresh history list
        this._renderHistoryList(container, DB.getAiAskHistory(), 'new');
      } catch(err) {
        let msg = 'AI 回覆失敗，請稍後再試';
        if (err.message === 'NO_API_KEY') msg = '請先在設定頁填入 API Key';
        else if (err.message?.includes('NETWORK_ERROR')) msg = '網路錯誤';
        resultArea.innerHTML = `<div class="ecdict-no-result">${escapeHTML(msg)}</div>`;
      } finally {
        submitBtn.disabled = false;
      }
    });

    // Sort button
    let sortOrder = 'new';
    document.getElementById('aiask-sort-btn')?.addEventListener('click', () => {
      const btn = document.getElementById('aiask-sort-btn');
      sortOrder = sortOrder === 'new' ? 'old' : 'new';
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><path d="M3 6h18M7 12h10M11 18h2"/></svg> ${sortOrder === 'new' ? '新→舊' : '舊→新'}`;
      this._renderHistoryList(container, DB.getAiAskHistory(), sortOrder);
    });

    this._renderHistoryList(container, history, sortOrder);
  },

  _renderHistoryList(container, history, sortOrder) {
    const listEl = document.getElementById('aiask-history-list');
    if (!listEl) return;
    if (!history.length) {
      listEl.innerHTML = '<div style="text-align:center;padding:24px 0;color:var(--text-muted);font-size:13px">尚無詢問記錄</div>';
      return;
    }
    const items = sortOrder === 'old' ? [...history].reverse() : [...history];
    listEl.innerHTML = items.map((e, i) => {
      const id = e.id || '';
      const dateStr = id.length >= 10
        ? `20${id.slice(0,2)}/${id.slice(2,4)}/${id.slice(4,6)} ${id.slice(6,8)}:${id.slice(8,10)}`
        : '—';
      const preview = (e.question||'').slice(0, 70) + ((e.question||'').length > 70 ? '...' : '');
      return `<div class="essay-session-card aiask-card" data-idx="${i}" style="cursor:pointer">
        <div class="essay-session-date">${dateStr}</div>
        <div style="margin-top:4px;font-size:13px;color:var(--text-primary);line-height:1.5">${escapeHTML(preview)}</div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.aiask-card').forEach((card, i) => {
      card.addEventListener('click', () => {
        const item = sortOrder === 'old' ? [...history].reverse()[i] : history[i];
        this._showDetail(container, item);
      });
    });
  },

  _showDetail(container, item) {
    const id = item.id || '';
    const dateStr = id.length >= 10
      ? `20${id.slice(0,2)}/${id.slice(2,4)}/${id.slice(4,6)} ${id.slice(6,8)}:${id.slice(8,10)}`
      : '—';
    container.innerHTML = `
      <div class="section-header">
        <button class="back-link" id="aiask-detail-back2">← 返回</button>
        <h1 class="section-title">AI 詢問記錄</h1>
      </div>
      <div style="margin-bottom:12px">
        <span style="font-size:13px;color:var(--text-muted)">📅 ${dateStr}</span>
      </div>
      <div class="settings-section-label" style="margin-top:0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        問題
      </div>
      <div class="settings-card" style="white-space:pre-wrap;font-size:14px;line-height:1.7;margin-bottom:0">${escapeHTML(item.question||'')}</div>
      <div class="settings-section-label" style="margin-top:12px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        AI 回覆
      </div>
      <div class="settings-card" style="font-size:14px;line-height:1.8;margin-bottom:0">${nl2br(item.answer||'')}</div>
      <div style="height:20px"></div>`;
    document.getElementById('aiask-detail-back2')?.addEventListener('click', () => this.render(container));
  }
};

Views.stats = {
  period: 7, chartInstance: null, mode: 'quiz',
  render(container) { this.period = 7; this.mode = 'quiz'; this.renderStats(container); },
  renderStats(container) {
    const allHistory = DB.getHistory();
    const totalSessions = allHistory.length;
    const totalAnswered = allHistory.reduce((s,h)=>s+(h.total||0),0);
    const totalCorrect  = allHistory.reduce((s,h)=>s+(h.correct||0),0);
    const overallPct    = totalAnswered > 0 ? Math.round(totalCorrect/totalAnswered*100) : 0;

    container.innerHTML = `
      <div class="section-header"><h1 class="section-title">練習統計</h1></div>
      <div class="stats-mode-bar">
        <select class="stats-mode-select" id="stats-mode-select">
          <option value="quiz" ${this.mode==="quiz"?"selected":""}>📝 單字練習</option>
          <option value="essay" ${this.mode==="essay"?"selected":""}>✍️ 文章撰寫</option>
          <option value="reading" ${this.mode==="reading"?"selected":""}>📖 文章閱讀測驗</option>
          <option value="kana" ${this.mode==="kana"?"selected":""}>🖌️ 五十音手寫</option>
          <option value="kanaReading" ${this.mode==="kanaReading"?"selected":""}>🔤 五十音讀音</option>
          <option value="aiask" ${this.mode==="aiask"?"selected":""}>💬 AI 詢問</option>
        </select>
      </div>
      <div class="stats-period-chips">${[7,14,21,30].map(d=>`<button class="chip ${d===this.period?'selected':''}" data-period="${d}">${d===30?'本月':d+'天'}</button>`).join('')}</div>
      <div class="chart-card"><div class="card-header">答題趨勢</div><div class="chart-wrapper"><canvas id="stats-chart"></canvas></div></div>
      <div class="stats-table-card">
        <div class="stats-table-hint">點擊錯誤數字可查看答錯單字</div>
        <div class="stats-table-scroll">
          <table class="stats-table"><thead><tr><th>日期</th><th>總題數</th><th>正確</th><th>錯誤</th><th>正確率</th></tr></thead><tbody id="stats-tbody"></tbody></table>
        </div>
      </div>

      <!-- ★ 統計摘要：CSV 匯出功能已移至設定頁 -->
      <div class="stats-summary-card">
        <div class="stats-export-summary">
          <div class="stats-export-item"><div class="stats-export-num">${totalSessions}</div><div class="stats-export-label">練習次數</div></div>
          <div class="stats-export-sep"></div>
          <div class="stats-export-item"><div class="stats-export-num">${totalAnswered}</div><div class="stats-export-label">總答題數</div></div>
          <div class="stats-export-sep"></div>
          <div class="stats-export-item"><div class="stats-export-num" style="color:var(--primary)">${overallPct}%</div><div class="stats-export-label">整體正確率</div></div>
        </div>
        <div class="stats-export-note">CSV 匯出請至「設定 → 匯出統計資料」。</div>
      </div>

      <div style="height:20px"></div>
    `;
    document.getElementById('stats-mode-select')?.addEventListener('change', (e) => {
      this.mode = e.target.value;
      if (this.mode === 'essay') this.renderEssayStats(container);
      else if (this.mode === 'reading') this.renderReadingStats(container);
      else if (this.mode === 'kana') this.renderKanaStats(container);
      else if (this.mode === 'kanaReading') this.renderKanaReadingStats(container);
      else if (this.mode === 'aiask') this.renderAiAskStats(container);
      else this.renderStats(container);
    });
    // Hide period chips and chart when in essay mode (they'll be shown only for quiz)
    container.querySelectorAll('[data-period]').forEach(btn => btn.addEventListener('click', () => {
      this.period=parseInt(btn.dataset.period);
      container.querySelectorAll('[data-period]').forEach(b=>b.classList.remove('selected'));
      btn.classList.add('selected'); this.updateChart(allHistory);
    }));
    this.updateChart(allHistory);

  },
  updateChart(allHistory) {
    const labels=[]; const now=new Date();
    for(let i=this.period-1;i>=0;i--){ const d=new Date(now); d.setDate(d.getDate()-i); labels.push(`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`); }
    const dataMap={}; allHistory.forEach(h=>{dataMap[h.date]=h;});
    const totalData=labels.map(d=>dataMap[d]?.total||0); const correctData=labels.map(d=>dataMap[d]?.correct||0); const wrongData=labels.map(d=>dataMap[d]?.wrong||0);
    const accuracyData=labels.map((d,i)=>totalData[i]>0?Math.round((correctData[i]/totalData[i])*100):null);
    const shortLabels=labels.map(d=>d.slice(5));
    const tbody=document.getElementById('stats-tbody');
    if(tbody){
      // Reverse for display: newest date on top; chart keeps chronological order
      const revLabels=[...labels].reverse(); const revShort=revLabels.map(d=>d.slice(5));
      tbody.innerHTML=revLabels.map((d,i)=>{ const tot=dataMap[d]?.total||0; const cor=dataMap[d]?.correct||0; const wrg=dataMap[d]?.wrong||0; const pct=tot>0?Math.round((cor/tot)*100):'—'; const rec=dataMap[d]; const hasDetails=rec?.wrongWordDetails?.length>0; return `<tr><td class="date-cell">${revShort[i]}</td><td>${tot||'—'}</td><td class="correct-cell">${tot?cor:'—'}</td><td class="wrong-cell">${tot?(hasDetails?`<span class="wrong-clickable" data-date="${d}">${wrg} ▸</span>`:wrg):'—'}</td><td>${pct==='—'?'—':pct+'%'}</td></tr>`; }).join('');
      tbody.querySelectorAll('.wrong-clickable').forEach(el=>el.addEventListener('click',()=>{const rec=dataMap[el.dataset.date]; if(rec?.wrongWordDetails) this.showWrongModal(el.dataset.date,rec.wrongWordDetails);}));
    }
    if(this.chartInstance) this.chartInstance.destroy();
    const ctx=document.getElementById('stats-chart'); if(!ctx) return;
    this.chartInstance = TrendChart.create(ctx, {
      labels: shortLabels,
      correctData,
      wrongData,
      accuracyData
    });
  },
  renderEssayStats(container) {
    const history = DB.getEssayHistory();

    // Flatten all sessions into a single ordered list (newest first)
    const flatSessions = [];
    history.forEach(h => {
      (h.sessions || []).forEach((s, si) => {
        // Count how many sessions on the same date to label "1st / 2nd ..."
        const dayCount = (h.sessions||[]).length;
        flatSessions.push({ date: h.date, s, si, dayCount });
      });
    });
    // Sort oldest first (ascending by ts / date+si)
    flatSessions.sort((a, b) => {
      const ta = a.s.ts || 0, tb = b.s.ts || 0;
      if (ta !== tb) return tb - ta;
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return b.si - a.si;
    });

    const ordinals = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th'];
    const ord = n => ordinals[n] || `${n+1}th`;

    container.innerHTML = `
      <div class="section-header"><h1 class="section-title">練習統計</h1></div>
      <div class="stats-mode-bar">
        <select class="stats-mode-select" id="stats-mode-select">
          <option value="quiz">📝 單字練習</option>
          <option value="essay" selected>✍️ 文章撰寫</option>
          <option value="reading">📖 文章閱讀測驗</option>
          <option value="kana">🖌️ 五十音手寫</option>
          <option value="kanaReading">🔤 五十音讀音</option>
          <option value="aiask">💬 AI 詢問</option>
        </select>
      </div>
      ${flatSessions.length > 0 ? `<div class="rec-header-styled">
        <div style="text-align:center">日期 / 時間</div>
        <div style="text-align:center">次序</div>
        <div class="rec-header-content" style="text-align:center">題目</div>
        <div class="rec-header-score" style="text-align:center">分數</div>
        <div></div>
      </div>` : ''}
      <div class="rec-list-scroll"><div class="rec-list">
        ${flatSessions.length === 0
          ? '<div class="essay-stats-empty">尚無文章撰寫記錄<br><span style="font-size:12px;opacity:0.6">前往練習 → 文章撰寫開始練習</span></div>'
          : flatSessions.map((item, fi) => {
              const { date, s, si } = item;
              let score = null;
              try { const f = s.feedback ? JSON.parse(s.feedback) : null; score = f?.score ?? null; } catch {}
              const scoreColor = score !== null ? (score>=8?'var(--correct)':score>=5?'#f5a623':'var(--danger)') : 'var(--text-muted)';
              const timeStr = s.ts ? new Date(s.ts).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
              const isAiMode  = (s.essayMode === 'ai');
              const wordList  = (s.words||[]).map(w=>w.english).join('、');
              // Build a meaningful display: show words + topic if available
              let promptStr, promptStyle;
              if (isAiMode) {
                const topicPart = s.topic ? s.topic.slice(0, 50) + (s.topic.length > 50 ? '…' : '') : '';
                const wordPart  = wordList ? `[${wordList}]` : '';
                promptStr = [topicPart, wordPart].filter(Boolean).join(' ') || '— AI 出題 —';
                promptStyle = 'font-style:italic;color:var(--primary)';
              } else {
                promptStr = wordList || '—';
                promptStyle = '';
              }
              const dateShort = date.replace(/\//g,'/');
              return `<div class="rec-row" data-fi="${fi}">
                <div class="rec-date">${dateShort}<br>${timeStr||'—'}</div>
                <div class="rec-ord">${ord(si)}${isAiMode?'<br><span class="essay-mode-tag">AI</span>':''}</div>
                <div class="rec-content" style="${promptStyle}">${promptStr}</div>
                <div class="rec-score" style="color:${scoreColor}">${score !== null ? score+'/10' : '—'}</div>
                <div class="rec-arrow">▸</div>
              </div>`;
            }).join('')}
      </div></div>
      <div style="height:20px"></div>
    `;

    document.getElementById('stats-mode-select')?.addEventListener('change', (e) => {
      this.mode = e.target.value;
      if (this.mode === 'quiz') this.renderStats(container);
      else if (this.mode === 'reading') this.renderReadingStats(container);
      else if (this.mode === 'kana') this.renderKanaStats(container);
      else if (this.mode === 'kanaReading') this.renderKanaReadingStats(container);
      else if (this.mode === 'aiask') this.renderAiAskStats(container);
    });

    container.querySelectorAll('.rec-row').forEach(row => {
      row.addEventListener('click', () => {
        const item = flatSessions[parseInt(row.dataset.fi)];
        if (item) this.renderEssaySessionDetail(container, item, flatSessions);
      });
    });
  },

  renderEssaySessionDetail(container, item, flatSessions) {
    const { date, s, si } = item;
    const ordinals = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th'];
    const ord = n => ordinals[n] || `${n+1}th`;
    const wordList = (s.words||[]).map(w=>w.english).join('、');

    let fb = null; try { fb = s.feedback ? JSON.parse(s.feedback) : null; } catch {}
    const grammar = (fb?.grammar || []).map((g, i) => ({ ...g, idx: i }));
    const annotatedHtml = s.essay && grammar.length
      ? Views.essay._buildAnnotatedEssay(s.essay, grammar)
      : nl2br(s.essay || '');

    const scoreColor = fb?.score >= 8 ? 'var(--correct)' : fb?.score >= 5 ? '#f5a623' : 'var(--danger)';
    const wordCheckHtml = (fb?.wordCheck || (s.words||[]).map(w=>({word:w.english,used:false,correct:false}))).map(w =>
      `<span class="fb-badge ${w.used&&w.correct?'fb-ok':w.used?'fb-warn':'fb-missing'}">${w.used&&w.correct?'✓':'✗'} ${escapeHTML(w.word || '')}</span>`
    ).join('');
    const hasErrors = grammar.some(g => g.exact && (s.essay||'').includes(g.exact));
    const grammarHtml = grammar.length === 0
      ? '<div class="fb-ok-msg">✓ 未發現明顯文法錯誤</div>'
      : grammar.map(g => `
          <div class="err-detail-card" id="err-detail-${g.idx}">
            <div class="err-detail-header">
              <span class="err-detail-num">#${g.idx+1}</span>
              <a class="err-back-link" href="#err-text-${g.idx}">↑ 回到文章</a>
            </div>
            <div class="err-detail-row"><span class="err-detail-label err-label-wrong">✗ 原文</span><span class="err-detail-orig">${escapeHTML(g.exact||g.original||'')}</span></div>
            <div class="err-detail-row"><span class="err-detail-label err-label-fix">✓ 修正</span><span class="err-detail-fixed">${escapeHTML(g.corrected||'')}</span></div>
            ${g.explanation?`<div class="err-detail-exp">${nl2br(g.explanation)}</div>`:''}
          </div>`).join('');
    const suggestHtml = (fb?.suggestions||[]).map(sg => `<div class="essay-fb-suggest">💡 ${nl2br(sg)}</div>`).join('');
    const timeStr = s.ts ? new Date(s.ts).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';

    container.innerHTML = `
      <div class="section-header">
        <button class="back-link" id="essay-detail-back">← 返回列表</button>
        <h1 class="section-title" style="font-size:16px">${date} ${ord(si)}${timeStr ? ' · '+timeStr : ''}</h1>
      </div>
      <div class="essay-detail-card">
        ${s.essayMode === 'ai'
          ? '<div class="essay-detail-section-title">📌 題目</div>'
            + '<div style="font-size:14px;line-height:1.7;color:var(--text-primary);margin-bottom:4px;font-style:italic">'
            + escapeHTML(s.topic||'AI 出題') + '</div>'
            + (wordList ? '<div class="essay-detail-section-title">📖 使用單字</div>'
              + '<div class="essay-fb-badges">' + wordCheckHtml + '</div>' : '')
          : '<div class="essay-detail-section-title">📖 使用單字</div>'
            + '<div class="essay-fb-badges">' + wordCheckHtml + '</div>'}

        <div class="essay-detail-section-title">
          📝 撰寫的文章（含批改標注）
          ${hasErrors ? '<span class="err-legend"><span class="err-legend-r">紅字</span>=錯誤　<span class="err-legend-g">綠字</span>=修正（點紅字看詳解）</span>' : ''}
        </div>
        <div class="annotated-essay history-annotated">${annotatedHtml}</div>

        ${fb ? `
          <div class="essay-fb-score-row">
            <span>AI 評分</span>
            <span class="essay-detail-score" style="color:${scoreColor}">${fb.score}/10</span>
          </div>
          <div class="essay-fb-comment">${nl2br(fb.comment||'')}</div>
          ${grammar.length > 0 ? `
            <div class="essay-detail-section-title">📋 文法詳解（${grammar.length} 處）</div>
            <div class="grammar-detail-list">${grammarHtml}</div>` : '<div class="fb-ok-msg" style="margin-top:12px">✓ 未發現明顯文法錯誤</div>'}
          <div class="essay-detail-section-title">💬 文章建議</div>
          <div class="essay-fb-suggest-list">${suggestHtml}</div>
        ` : '<div class="essay-no-fb">無 AI 批改記錄</div>'}
      </div>
      <div style="height:20px"></div>
    `;

    document.getElementById('essay-detail-back').addEventListener('click', () => this.renderEssayStats(container));
    container.querySelectorAll('a.err-anchor, a.err-back-link').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const target = document.querySelector(a.getAttribute('href'));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  },

  renderAiAskStats(container) {
    const history = DB.getAiAskHistory();
    const statsModeSel = `
      <div class="stats-mode-bar">
        <select class="stats-mode-select" id="stats-mode-select">
          <option value="quiz">📝 單字練習</option>
          <option value="essay">✍️ 文章撰寫</option>
          <option value="reading">📖 文章閱讀測驗</option>
          <option value="kana">🖌️ 五十音手寫</option>
          <option value="kanaReading">🔤 五十音讀音</option>
          <option value="aiask" selected>💬 AI 詢問</option>
        </select>
      </div>`;

    if (history.length === 0) {
      container.innerHTML = `
        <div class="section-header"><h1 class="section-title">練習統計</h1></div>
        ${statsModeSel}
        <div class="db-empty" style="margin-top:32px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;margin:auto;width:40px;height:40px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <div class="db-empty-title" style="margin-top:10px">尚無 AI 詢問記錄</div>
          <div class="db-empty-sub">前往練習頁的「💬 AI 詢問」開始提問</div>
        </div>
        <div style="height:20px"></div>`;
      document.getElementById('stats-mode-select')?.addEventListener('change', (e) => {
        this.mode = e.target.value;
        if (this.mode === 'quiz') this.renderStats(container);
        else if (this.mode === 'essay') this.renderEssayStats(container);
        else if (this.mode === 'reading') this.renderReadingStats(container);
        else if (this.mode === 'kana') this.renderKanaStats(container);
        else if (this.mode === 'kanaReading') this.renderKanaReadingStats(container);
      });
      return;
    }

    container.innerHTML = `
      <div class="section-header"><h1 class="section-title">練習統計</h1></div>
      ${statsModeSel}
      <div style="display:flex;align-items:center;justify-content:space-between;margin:12px 0 8px;padding:0 2px">
        <span style="font-size:13px;color:var(--text-secondary)">共 ${history.length} 筆詢問</span>
        <button class="btn-sort-toggle" id="aiask-sort-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><path d="M3 6h18M7 12h10M11 18h2"/></svg>
          新→舊
        </button>
      </div>
      <div class="rec-header-styled" id="aiask-list-header" style="display:none">
        <div style="text-align:center">日期 / 時間</div>
        <div style="text-align:center">次序</div>
        <div class="rec-header-content" style="text-align:center">問題</div>
        <div class="rec-header-score" style="text-align:center">類別</div>
        <div></div>
      </div>
      <div class="rec-list-scroll"><div id="aiask-list" class="rec-list"></div></div>
      <div style="height:20px"></div>`;

    document.getElementById('stats-mode-select')?.addEventListener('change', (e) => {
      this.mode = e.target.value;
      if (this.mode === 'quiz') this.renderStats(container);
      else if (this.mode === 'essay') this.renderEssayStats(container);
      else if (this.mode === 'reading') this.renderReadingStats(container);
      else if (this.mode === 'kana') this.renderKanaStats(container);
      else if (this.mode === 'kanaReading') this.renderKanaReadingStats(container);
    });

    let sortOrder = 'new';
    const renderList = () => {
      const listEl = document.getElementById('aiask-list');
      const headerEl = document.getElementById('aiask-list-header');
      if (!listEl) return;
      const items = sortOrder === 'new' ? [...history] : [...history].reverse();
      listEl.innerHTML = items.map((e, i) => {
        const preview = (e.question||'').slice(0, 70) + ((e.question||'').length > 70 ? '...' : '');
        const id2 = e.id || '';
        const d2 = id2.length >= 10 ? '20' + id2.slice(0,2) + '/' + id2.slice(2,4) + '/' + id2.slice(4,6) : '—';
        const t2 = id2.length >= 10 ? id2.slice(6,8) + ':' + id2.slice(8,10) : '';
        return '<div class="rec-row aiask-card" data-idx="' + i + '">'
          + '<div class="rec-date">' + d2 + '<br>' + t2 + '</div>'
          + '<div class="rec-ord" style="color:var(--text-muted)">—</div>'
          + '<div class="rec-content">' + escapeHTML(preview) + '</div>'
          + '<div class="rec-score" style="color:var(--text-muted)">—</div>'
          + '<div class="rec-arrow">▸</div>'
          + '</div>';
      }).join('');

      if (headerEl) headerEl.style.display = items.length > 0 ? '' : 'none';
      listEl.querySelectorAll('.aiask-card').forEach((card, i) => {
        card.addEventListener('click', () => {
          const item = sortOrder === 'new' ? history[i] : [...history].reverse()[i];
          this.renderAiAskDetail(container, item);
        });
      });
    };

    document.getElementById('aiask-sort-btn')?.addEventListener('click', () => {
      const btn = document.getElementById('aiask-sort-btn');
      sortOrder = sortOrder === 'new' ? 'old' : 'new';
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><path d="M3 6h18M7 12h10M11 18h2"/></svg> ' + (sortOrder === 'new' ? '新→舊' : '舊→新');
      renderList();
    });

    renderList();
  },

  renderAiAskDetail(container, item) {
    const id = item.id || '';
    const dateStr = id.length >= 10
      ? '20' + id.slice(0,2) + '/' + id.slice(2,4) + '/' + id.slice(4,6) + ' ' + id.slice(6,8) + ':' + id.slice(8,10)
      : '—';
    container.innerHTML = `
      <div class="section-header">
        <button class="back-link" id="aiask-detail-back">← 返回</button>
        <h1 class="section-title">AI 詢問記錄</h1>
      </div>
      <div style="margin-bottom:12px">
        <span style="font-size:13px;color:var(--text-muted)">📅 ${dateStr}</span>
      </div>
      <div class="settings-section-label" style="margin-top:0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        問題
      </div>
      <div class="settings-card" style="white-space:pre-wrap;font-size:14px;line-height:1.7;margin-bottom:0">${escapeHTML(item.question||'')}</div>
      <div class="settings-section-label" style="margin-top:12px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        AI 回覆
      </div>
      <div class="settings-card" style="font-size:14px;line-height:1.8;margin-bottom:0">${nl2br(item.answer||'')}</div>
      <div style="height:20px"></div>`;
    document.getElementById('aiask-detail-back')?.addEventListener('click', () => this.renderAiAskStats(container));
  },


  renderReadingStats(container) {
    const history = DB.getReadingQuizHistory();
    const flatSessions = [];
    history.forEach(h => (h.sessions || []).forEach((session, si) => flatSessions.push({ date: h.date, s: session, si })));
    flatSessions.sort((a, b) => (b.s.ts || 0) - (a.s.ts || 0) || b.date.localeCompare(a.date));
    const total = flatSessions.length;
    const avg = total ? Math.round(flatSessions.reduce((sum, x) => sum + (Number(x.s.score) || 0), 0) / total) : 0;

    container.innerHTML = `
      <div class="section-header"><h1 class="section-title">練習統計</h1></div>
      <div class="stats-mode-bar">
        <select class="stats-mode-select" id="stats-mode-select">
          <option value="quiz">📝 單字練習</option>
          <option value="essay">✍️ 文章撰寫</option>
          <option value="reading" selected>📖 文章閱讀測驗</option>
          <option value="kana">🖌️ 五十音手寫</option>
          <option value="kanaReading">🔤 五十音讀音</option>
          <option value="aiask">💬 AI 詢問</option>
        </select>
      </div>
      <div class="reading-stats-summary">
        <div><strong>${total}</strong><span>測驗次數</span></div>
        <div><strong>${avg}</strong><span>平均分數</span></div>
      </div>
      ${flatSessions.length > 0 ? `<div class="rec-header-styled">
        <div style="text-align:center">日期 / 時間</div>
        <div style="text-align:center">正確</div>
        <div class="rec-header-content" style="text-align:center">使用單字</div>
        <div class="rec-header-score" style="text-align:center">分數</div>
        <div></div>
      </div>` : ''}
      <div class="rec-list-scroll"><div class="rec-list">
        ${flatSessions.length === 0
          ? '<div class="essay-stats-empty">尚無文章閱讀測驗記錄<br><span style="font-size:12px;opacity:0.6">前往練習 → 文章閱讀測驗開始練習</span></div>'
          : flatSessions.map((item, i) => {
              const s = item.s;
              const timeStr = s.ts ? new Date(s.ts).toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '';
              const words = (s.words || []).map(w => w.english || w.word || '').filter(Boolean).join('、') || '—';
              const score = Number(s.score) || 0;
              const scoreColor = score >= 80 ? 'var(--correct)' : score >= 60 ? '#f5a623' : 'var(--danger)';
              return `<div class="rec-row reading-stat-row" data-idx="${i}">
                <div class="rec-date">${escapeHTML(item.date)}<br>${escapeHTML(timeStr || '—')}</div>
                <div class="rec-ord">${Number(s.correct)||0}/${Number(s.total)||5}</div>
                <div class="rec-content">${escapeHTML(words)}</div>
                <div class="rec-score" style="color:${scoreColor}">${score}/100</div>
                <div class="rec-arrow">▸</div>
              </div>`;
            }).join('')}
      </div></div>
      <div style="height:20px"></div>
    `;

    document.getElementById('stats-mode-select')?.addEventListener('change', (e) => {
      this.mode = e.target.value;
      if (this.mode === 'quiz') this.renderStats(container);
      else if (this.mode === 'essay') this.renderEssayStats(container);
      else if (this.mode === 'kana') this.renderKanaStats(container);
      else if (this.mode === 'kanaReading') this.renderKanaReadingStats(container);
      else if (this.mode === 'aiask') this.renderAiAskStats(container);
      else this.renderReadingStats(container);
    });
    container.querySelectorAll('.reading-stat-row').forEach(row => {
      row.addEventListener('click', () => {
        const item = flatSessions[parseInt(row.dataset.idx)];
        if (item) this.renderReadingSessionDetail(container, item);
      });
    });
  },

  renderReadingSessionDetail(container, item) {
    const s = item.s || {};
    const score = Number(s.score) || 0;
    const scoreColor = score >= 80 ? 'var(--correct)' : score >= 60 ? '#f5a623' : 'var(--danger)';
    const timeStr = s.ts ? new Date(s.ts).toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '';
    const answers = s.answers || {};
    const questions = s.questions || [];
    const baseWords = (Array.isArray(s.words) && s.words.length ? s.words : questions.map(q => ({ english: q.word || '', chinese: q.chinese || '', partOfSpeech: q.partOfSpeech || '' })));
    const readingWords = baseWords.map((w, i) => {
      const q = questions[i] || {};
      return {
        ...w,
        english: w.english || w.word || q.word || '',
        word: w.word || w.english || q.word || '',
        chinese: w.chinese || q.chinese || '',
        partOfSpeech: w.partOfSpeech || q.partOfSpeech || ''
      };
    });
    const wordSummary = readingWords.map(w => w.english || w.word || '').filter(Boolean).join('、');
    container.innerHTML = `
      <div class="section-header">
        <button class="back-link" id="reading-detail-back">← 返回列表</button>
        <h1 class="section-title" style="font-size:16px">${escapeHTML(item.date)} ${escapeHTML(timeStr ? ' · ' + timeStr : '')}</h1>
      </div>
      <div class="reading-detail-card">
        <div class="reading-result-score" style="color:${scoreColor}">${score}<span>/100</span></div>
        <div class="reading-result-text">答對 ${Number(s.correct)||0} / ${Number(s.total)||5} 題</div>
        ${wordSummary ? `<div class="essay-detail-section-title">📖 使用單字</div><div class="essay-fb-badges">${wordSummary.split('、').map(w => `<span class="fb-badge fb-ok">${escapeHTML(w)}</span>`).join('')}</div>` : ''}
        <div class="reading-section-title-row reading-history-article-title-row">
          <div class="essay-detail-section-title">AI 生成文章</div>
          <button class="reading-article-zh-btn" id="reading-stat-article-zh-btn" aria-expanded="false">顯示中文</button>
        </div>
        <div class="reading-article history-annotated">${Views.readingQuiz._buildArticleHtml(s.article || '', readingWords, { interactive: false })}</div>
        <div class="reading-article-zh-panel" id="reading-stat-article-zh-panel" hidden>
          <div class="reading-article-zh-panel-head">
            <span>中文翻譯</span>
            <span>可與上方日文文章對照閱讀</span>
          </div>
          <div class="reading-article reading-article-zh" id="reading-stat-article-zh-content"></div>
        </div>
        <div class="essay-detail-section-title">作答結果</div>
        <div class="reading-history-q-list">
          ${questions.map((q, i) => {
            const selected = answers[i] || '';
            const correct = String(q.correctSynonym || '');
            const ok = selected && selected.toLowerCase() === correct.toLowerCase();
            return `<div class="reading-history-q ${ok ? 'ok' : 'ng'}">
              <div class="reading-history-q-head"><strong>Q${i + 1}. ${escapeHTML(q.word || '')}</strong><span>${ok ? '✓ 20分' : '✗ 0分'}</span></div>
              <div class="reading-history-q-line">你的答案：${escapeHTML(selected || '—')}</div>
              <div class="reading-history-q-line">正確答案：${escapeHTML(correct || '—')}</div>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div style="height:20px"></div>
    `;
    document.getElementById('reading-detail-back')?.addEventListener('click', () => this.renderReadingStats(container));
    document.getElementById('reading-stat-article-zh-btn')?.addEventListener('click', () => this.showReadingStatTranslation(item, readingWords));
  },

  _setReadingStatTranslationPanel({ open, html = '', loading = false, errorHtml = '' } = {}) {
    const panel = document.getElementById('reading-stat-article-zh-panel');
    const content = document.getElementById('reading-stat-article-zh-content');
    const btn = document.getElementById('reading-stat-article-zh-btn');
    if (!panel || !content || !btn) return;
    panel.hidden = !open;
    panel.classList.toggle('show', !!open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? '收合中文' : '顯示中文';
    if (loading) {
      content.innerHTML = `<div class="reading-loading"><div class="loading-dots"><span></span><span></span><span></span></div><span>AI 正在翻譯文章...</span></div>`;
    } else if (errorHtml) {
      content.innerHTML = errorHtml;
    } else if (html) {
      content.innerHTML = html;
    }
  },

  async showReadingStatTranslation(item, readingWords) {
    const s = item?.s || {};
    const panel = document.getElementById('reading-stat-article-zh-panel');
    const btn = document.getElementById('reading-stat-article-zh-btn');
    if (!panel || !btn) return;
    if (!panel.hidden && panel.classList.contains('show')) {
      this._setReadingStatTranslationPanel({ open: false });
      return;
    }
    if (!s.article) {
      this._setReadingStatTranslationPanel({ open: true, errorHtml: '<div class="essay-error">此筆紀錄沒有文章內容，無法翻譯。</div>' });
      return;
    }
    if (s.articleZh) {
      this._setReadingStatTranslationPanel({
        open: true,
        html: Views.readingQuiz._buildArticleZhHtml(s.articleZh, readingWords)
      });
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    this._setReadingStatTranslationPanel({ open: true, loading: true });
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (btn) btn.disabled = true;
    try {
      const zh = await Gemini.translateReadingArticle(s.article, readingWords);
      s.articleZh = zh;
      const history = DB.getReadingQuizHistory();
      const day = history.find(h => h.date === item.date);
      const target = day?.sessions?.find(x => String(x.id || x.ts || '') === String(s.id || s.ts || '') || (x.ts && s.ts && Number(x.ts) === Number(s.ts)));
      if (target) {
        target.articleZh = zh;
        DB.saveReadingQuizHistory(history);
      }
      this._setReadingStatTranslationPanel({
        open: true,
        html: Views.readingQuiz._buildArticleZhHtml(zh, readingWords)
      });
    } catch (err) {
      let msg = '文章翻譯失敗，請稍後重試';
      if (err.message === 'NO_API_KEY') msg = '請先在設定頁填入 Gemini API Key';
      else if (err.message === 'NETWORK_ERROR') msg = '網路連線失敗，請確認連線後重試';
      this._setReadingStatTranslationPanel({
        open: true,
        errorHtml: `<div class="essay-error">${escapeHTML(msg)}<div class="essay-error-detail">${escapeHTML(err.message || '')}</div></div>`
      });
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  renderKanaStats(container) {
    const summary = KanaProgress.getSummary();
    const progressMap = new Map(KanaProgress.getProgress().map(item => [item.key, item]));
    const renderGrid = script => BASIC_KANA.filter(item => item.script === script).map(kana => {
      const item = progressMap.get(kana.id);
      const best = item?.bestScore || 0;
      return `<div class="kana-stat-item ${best >= 80 ? 'is-mastered' : item ? 'is-practiced' : ''}" title="${kana.romaji}・${item?.attempts || 0} 次">
        <b>${kana.character}</b><span>${escapeHTML(kana.romaji)}</span><strong>${item ? best : '—'}</strong>
      </div>`;
    }).join('');
    container.innerHTML = `
      <div class="section-header"><h1 class="section-title">練習統計</h1></div>
      <div class="stats-mode-bar"><select class="stats-mode-select" id="stats-mode-select">
        <option value="quiz">📝 單字練習</option>
        <option value="essay">✍️ 文章撰寫</option>
        <option value="reading">📖 文章閱讀測驗</option>
        <option value="kana" selected>🖌️ 五十音手寫</option>
        <option value="kanaReading">🔤 五十音讀音</option>
        <option value="aiask">💬 AI 詢問</option>
      </select></div>
      <div class="reading-stats-summary kana-stats-summary">
        <div><strong>${summary.practiced}/92</strong><span>已練假名</span></div>
        <div><strong>${summary.mastered}/92</strong><span>已熟練（80 分）</span></div>
        <div><strong>${summary.averageScore}</strong><span>平均分數</span></div>
        <div><strong>${summary.attempts}</strong><span>總練習次數</span></div>
      </div>
      <section class="kana-stat-card"><header><h2>平假名</h2><span>熟練 ${summary.hiraganaMastered} / 46</span></header><div class="kana-stat-grid">${renderGrid('hiragana')}</div></section>
      <section class="kana-stat-card"><header><h2>片假名</h2><span>熟練 ${summary.katakanaMastered} / 46</span></header><div class="kana-stat-grid">${renderGrid('katakana')}</div></section>
      <button class="btn-primary" id="kana-stats-practice-btn">開始五十音手寫</button><div style="height:20px"></div>`;
    document.getElementById('stats-mode-select')?.addEventListener('change', event => {
      this.mode = event.target.value;
      if (this.mode === 'quiz') this.renderStats(container);
      else if (this.mode === 'essay') this.renderEssayStats(container);
      else if (this.mode === 'reading') this.renderReadingStats(container);
      else if (this.mode === 'kanaReading') this.renderKanaReadingStats(container);
      else if (this.mode === 'aiask') this.renderAiAskStats(container);
    });
    document.getElementById('kana-stats-practice-btn')?.addEventListener('click', () => Router.navigate('kanaPractice'));
  },

  renderKanaReadingStats(container) {
    const summary = KanaReadingProgress.getSummary();
    const progressMap = new Map(KanaReadingProgress.getProgress().map(item => [item.key, item]));
    const renderGrid = script => BASIC_KANA.filter(item => item.script === script).map(kana => {
      const item = progressMap.get(kana.id);
      const accuracy = item?.accuracy || 0;
      return `<div class="kana-stat-item ${accuracy >= 80 ? 'is-mastered' : item ? 'is-practiced' : ''}" title="${escapeAttr(kana.romaji)}・${item?.correct || 0}/${item?.attempts || 0}">
        <b>${kana.character}</b><span>${escapeHTML(kana.romaji)}</span><strong>${item ? accuracy + '%' : '—'}</strong>
      </div>`;
    }).join('');
    container.innerHTML = `
      <div class="section-header"><h1 class="section-title">練習統計</h1></div>
      <div class="stats-mode-bar"><select class="stats-mode-select" id="stats-mode-select">
        <option value="quiz">📝 單字練習</option>
        <option value="essay">✍️ 文章撰寫</option>
        <option value="reading">📖 文章閱讀測驗</option>
        <option value="kana">🖌️ 五十音手寫</option>
        <option value="kanaReading" selected>🔤 五十音讀音</option>
        <option value="aiask">💬 AI 詢問</option>
      </select></div>
      <div class="reading-stats-summary kana-stats-summary">
        <div><strong>${summary.practiced}/92</strong><span>已練假名</span></div>
        <div><strong>${summary.correct}</strong><span>答對題數</span></div>
        <div><strong>${summary.accuracy}%</strong><span>整體正確率</span></div>
        <div><strong>${summary.attempts}</strong><span>總答題數</span></div>
      </div>
      <div class="kana-reading-stat-note">每格顯示該假名的累積正確率；綠色代表正確率達 80%。</div>
      <section class="kana-stat-card"><header><h2>平假名</h2><span>已練 ${summary.hiraganaPracticed} / 46</span></header><div class="kana-stat-grid">${renderGrid('hiragana')}</div></section>
      <section class="kana-stat-card"><header><h2>片假名</h2><span>已練 ${summary.katakanaPracticed} / 46</span></header><div class="kana-stat-grid">${renderGrid('katakana')}</div></section>
      <button class="btn-primary" id="kana-reading-stats-practice-btn">開始五十音讀音練習</button><div style="height:20px"></div>`;
    document.getElementById('stats-mode-select')?.addEventListener('change', event => {
      this.mode = event.target.value;
      if (this.mode === 'quiz') this.renderStats(container);
      else if (this.mode === 'essay') this.renderEssayStats(container);
      else if (this.mode === 'reading') this.renderReadingStats(container);
      else if (this.mode === 'kana') this.renderKanaStats(container);
      else if (this.mode === 'aiask') this.renderAiAskStats(container);
    });
    document.getElementById('kana-reading-stats-practice-btn')?.addEventListener('click', () => {
      DB.saveLastPracticeMode('kanaReading');
      Router.navigate('practice', { restoreLast: true });
    });
  },

  showWrongModal(date, wrongWordDetails) {
    Modal.show(`<div class="modal-handle"></div><div class="modal-title">${escapeHTML(date)} 答錯的單字</div><div style="font-size:13px;color:var(--text-muted);margin-bottom:12px">共 ${wrongWordDetails.length} 個</div><div style="max-height:55vh;overflow-y:auto;">${wrongWordDetails.map(w=>`<div class="wrong-word-card" style="margin-bottom:8px"><div class="wrong-word-en">${escapeHTML(w.english)}</div><div class="wrong-word-meta"><span class="wrong-word-pos">${escapeHTML(w.partOfSpeech)}</span><span class="wrong-word-zh">${escapeHTML(w.chinese)}</span></div></div>`).join('')}</div><div style="margin-top:16px"><button class="modal-btn-cancel" id="close-wrong-modal" style="width:100%">關閉</button></div>`);
    document.getElementById('close-wrong-modal').addEventListener('click', () => Modal.hide());
  }
};

// ===========================
// SETTINGS VIEW — v1.4 layout
// ===========================
Views.settings = {
  render(container) {
    const savedKey    = DB.getApiKey();
    const hasKey      = !!savedKey;
    const savedModel  = DB.getModel();
    const clientId    = DB.getGDriveClientId();
    const folderId    = DB.getGDriveFolderId();
    const signedIn    = GDrive.isSignedIn();
    const sessionStatus = GDrive.getSessionStatus();
    const remembered  = sessionStatus === 'remembered';
    const email       = GDrive.getUserEmail();
    const lastSync    = DB.getGDriveLastSync();
    const autoSync    = DB.getGDriveAutoSync();
    const versionState = AppUpdater.getState();
    const storageState = AppStorage.getStatus();
    const soundState = Sound.getStatus();
    const reminderSettings = DailyReminder.getSettings();
    const reminderCapabilities = DailyReminder.getCapabilities();
    const reminderStatusClass = reminderSettings.enabled && reminderCapabilities.permission === 'granted'
      ? 'is-enabled'
      : reminderCapabilities.permission === 'denied' ? 'has-error' : '';
    const reminderStatusText = !reminderCapabilities.supported
      ? '此瀏覽器不支援 Web Push'
      : reminderCapabilities.needsInstall
        ? '請先加入 iPhone 主畫面，再由主畫面開啟'
        : !reminderCapabilities.backendConfigured
          ? '推播後端尚未設定'
          : reminderCapabilities.permission === 'denied'
            ? 'iOS 通知權限已關閉'
            : reminderSettings.enabled
              ? `已啟用，每日 ${reminderSettings.time} 提醒`
              : '尚未啟用每日提醒';

    const svgG  = '<svg viewBox="0 0 24 24" width="16" height="16" style="flex-shrink:0"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>';
    const svgUp = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>';
    const svgDn = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>';

    const importedSentences = DB.getImportedSentences();
    const aiSentences       = DB.getSentenceLog();
    const totalSentences    = DB.getCombinedSentenceLog().length;
    const totalWords        = DB.getWords().length;
    const totalStats        = DB.getHistory().length;
    const readingHistoryAll = DB.getReadingQuizHistory();
    const totalReading      = readingHistoryAll.reduce((s,h) => s + (h.sessions||[]).length, 0);
    const readingAvg        = totalReading ? Math.round(readingHistoryAll.reduce((sum,h) => sum + (h.sessions||[]).reduce((ss,x)=>ss+(Number(x.score)||0),0),0) / totalReading) : 0;
    const essayHistoryAll   = DB.getEssayHistory();
    const totalEssay        = essayHistoryAll.reduce((s,h) => s + (h.sessions||[]).length, 0);
    const totalAiAsk        = DB.getAiAskHistory().length;
    const handwritingHistory = KanaProgress.getHistory();
    const kanaSummary       = KanaProgress.getSummary();
    const kanaReadingHistory = KanaReadingProgress.getHistory();
    const kanaReadingSummary = KanaReadingProgress.getSummary();
    const jlptLevel         = DB.getJlptLevel();
    const dailyLearningPreferences = DB.getDailyLearningPreferences();
    const studyDays         = StudyStreak.getDays();
    const streakSummary     = StudyStreak.getSummary();
    const streakSyncState   = StudyStreak.getSyncState();
    const dateTag           = todayStr().replace(/\//g,'-');
    const compactDateTag    = todayStr().replace(/\D/g,'');

    container.innerHTML = `
      <div class="section-header"><h1 class="section-title">設定</h1></div>
      <div class="settings-wrap">

        <!-- ★ 1. Google Drive 同步狀態（最上方） -->
        <div class="settings-section-label" style="margin-top:0">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Google Drive 雲端同步
        </div>
        <div class="settings-card">
          ${(signedIn || remembered) ? `
            <div class="fb-status-row">
              <div class="fb-status-dot ${signedIn ? 'connected' : 'disconnected'}"></div>
              <span class="fb-status-text">${signedIn ? '已登入' : '帳號已記住，雲端功能會自動續權'}：${escapeHTML(email || 'Google 帳戶')}</span>
            </div>
            ${lastSync ? '<div class="fb-last-sync" style="margin-bottom:10px">上次同步：' + lastSync + '</div>' : ''}
            <div class="settings-btn-row" style="margin-bottom:10px">
              <button class="btn-fb-upload" id="gd-upload-btn" style="flex:1">${svgUp} 上傳備份</button>
              <button class="btn-fb-download" id="gd-download-btn" style="flex:1">${svgDn} 還原備份</button>
            </div>
            <div class="drive-operation-status" id="gd-operation-status" role="status" aria-live="polite" hidden>
              <span class="drive-operation-spinner" aria-hidden="true"></span>
              <span id="gd-operation-text">準備中…</span>
              <span id="gd-operation-percent"></span>
            </div>
            <label class="fb-auto-sync-row">
              <input type="checkbox" id="gd-auto-sync"${autoSync ? ' checked' : ''}>
              <span>每次開啟 APP 自動同步（雲端資料較多才自動還原）</span>
            </label>
            <div class="study-streak-sync-row">
              <div class="study-streak-sync-copy">
                <strong>跨裝置練習天數</strong>
                <small id="study-streak-sync-status">${streakSyncState.pending ? '本機有待同步的練習天數' : streakSyncState.lastSync ? '練習天數已同步：' + escapeHTML(new Date(streakSyncState.lastSync).toLocaleString('zh-TW')) : '練習天數尚未同步'}</small>
              </div>
              <button class="btn-secondary" id="gd-streak-sync-btn" type="button">立即同步</button>
            </div>
            <button class="btn-secondary" id="local-recovery-btn" style="width:100%;margin-top:9px">本機復原點</button>
            ${remembered ? '<div class="settings-tip" style="margin-top:8px">開啟程式會直接進入主畫面，並在背景無提示恢復 Google 登入。只有 Google 工作階段失效或權限被撤銷時，下一次使用雲端功能才需要重新授權。</div>' : ''}
            <button class="btn-fb-signout-bottom" id="gd-signout-btn" style="margin-top:10px">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              登出 Google（${escapeHTML(email || '目前帳戶')}）
            </button>
          ` : `
            <div class="fb-status-row" style="margin-bottom:8px">
              <div class="fb-status-dot disconnected"></div>
              <span class="fb-status-text">${clientId ? '尚未登入 Google' : '請先在下方填入 OAuth Client ID'}</span>
            </div>
            ${clientId ? '<button class="btn-fb-signin" id="gd-signin-btn" style="width:100%;padding:9px 12px;font-size:13px">' + svgG + ' 首次連結 Google 帳號</button>' : ''}
            <div class="settings-tip" style="margin-top:8px;margin-bottom:0">首次連結並完成授權後，程式會記住帳號；之後開啟會直接進入主畫面並在背景恢復登入。</div>
          `}
        </div>

        <!-- 2. 一鍵匯出全部 -->
        <div class="settings-section-label" style="margin-top:16px">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:15px;height:15px"><rect x="2" y="2" width="20" height="20" rx="2" fill="#5b8dd9" stroke="#3a6bc4" stroke-width="1.5"/><rect x="6" y="2" width="12" height="8" rx="1" fill="#a8c4f0" stroke="#3a6bc4" stroke-width="1.2"/><rect x="9" y="3.5" width="4" height="5" rx="0.5" fill="#3a6bc4"/><rect x="4" y="13" width="16" height="7" rx="1" fill="#d6e8ff" stroke="#3a6bc4" stroke-width="1.2"/></svg>
          一鍵匯出全部
        </div>
        <div class="settings-card">
          <div class="one-click-export-desc">同時匯出日文語彙、例句、測驗、練習天數、五十音手寫、五十音讀音、文章與 AI 詢問記錄，方便備份或跨裝置移轉。</div>
          <div class="one-click-summary-grid one-click-summary-grid-compact">
            <div class="oc-stat-cell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
              <div class="oc-stat-num">${totalWords}</div><div class="oc-stat-label">單字</div>
            </div>
            <div class="oc-stat-cell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <div class="oc-stat-num">${totalSentences}</div><div class="oc-stat-label">例句</div>
            </div>
            <div class="oc-stat-cell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
              <div class="oc-stat-num">${totalStats}</div><div class="oc-stat-label">統計</div>
            </div>
            <div class="oc-stat-cell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4h20v14H6l-4 4V4z"/><path d="M7 9h10"/><path d="M7 13h6"/></svg>
              <div class="oc-stat-num">${totalReading}</div><div class="oc-stat-label">閱讀測驗</div>
            </div>
            <div class="oc-stat-cell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 9.5-9.5z"/></svg>
              <div class="oc-stat-num">${totalEssay}</div><div class="oc-stat-label">文章</div>
            </div>
            <div class="oc-stat-cell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <div class="oc-stat-num">${totalAiAsk}</div><div class="oc-stat-label">AI 詢問</div>
            </div>
            <div class="oc-stat-cell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2s1 4-2 6c-2 1-3-1-3-1s-4 4-2 9a6 6 0 0 0 12 0c1-4-2-7-5-8 1-2 0-4 0-6z"/></svg>
              <div class="oc-stat-num" id="settings-streak-total">${streakSummary.totalDays}</div><div class="oc-stat-label">練習天數</div>
            </div>
            <div class="oc-stat-cell">
              <div style="font-size:22px;font-weight:900;color:var(--primary)">あ</div>
              <div class="oc-stat-num">${handwritingHistory.length}</div><div class="oc-stat-label">手寫記錄</div>
            </div>
            <div class="oc-stat-cell">
              <div style="font-size:20px;font-weight:900;color:var(--primary)">あ→a</div>
              <div class="oc-stat-num">${kanaReadingHistory.length}</div><div class="oc-stat-label">讀音答題</div>
            </div>
          </div>
          <button class="btn-one-click-export" id="one-click-export-btn">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px"><rect x="2" y="2" width="20" height="20" rx="2" fill="#5b8dd9" stroke="#3a6bc4" stroke-width="1.5"/><rect x="6" y="2" width="12" height="8" rx="1" fill="#a8c4f0" stroke="#3a6bc4" stroke-width="1.2"/><rect x="9" y="3.5" width="4" height="5" rx="0.5" fill="#3a6bc4"/><rect x="4" y="13" width="16" height="7" rx="1" fill="#d6e8ff" stroke="#3a6bc4" stroke-width="1.2"/></svg>
            一鍵匯出全部資料
          </button>
          <div class="one-click-divider-h"></div>
          <button class="btn-one-click-import" id="one-click-import-btn">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px"><path d="M2 7C2 5.9 2.9 5 4 5H10L12 7H20C21.1 7 22 7.9 22 9V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V7Z" fill="#f5a623" stroke="#d4891a" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 10H22V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V10Z" fill="#ffc84a" stroke="#d4891a" stroke-width="1.5" stroke-linejoin="round"/></svg>
            一鍵匯入（CSV / ZIP）
          </button>
          <div class="one-click-import-hint">可選取各類資料 CSV（包含練習天數），或直接選取備份 ZIP 檔一鍵還原</div>
        </div>

        <!-- 3. 折疊資訊：預設收合 -->
        <div class="settings-section-label settings-collapse-group-label" style="margin-top:16px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M3 4h18"/><path d="M3 10h18"/><path d="M3 16h18"/><path d="M3 22h18"/></svg>
          資料狀態與管理
        </div>

        <details class="settings-collapsible-card">
          <summary class="settings-collapse-summary">
            <span class="settings-collapse-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
              單字資料庫
            </span>
            <span class="settings-collapse-count">${totalWords} 個</span>
            <span class="settings-collapse-chevron">⌄</span>
          </summary>
          <div class="settings-card settings-collapse-body">
            <div class="settings-stat-row">
              <div class="settings-stat-num">${totalWords}</div>
              <div class="settings-stat-label">個單字</div>
            </div>
            <div class="settings-btn-row">
              <button class="btn-icon btn-export" id="export-vocab-btn" style="flex:1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="2" fill="#5b8dd9" stroke="#3a6bc4"/><rect x="6" y="2" width="12" height="8" rx="1" fill="#a8c4f0" stroke="#3a6bc4" stroke-width="1.5"/><rect x="9" y="3.5" width="4" height="5" rx="0.5" fill="#3a6bc4" stroke="none"/><rect x="4" y="13" width="16" height="7" rx="1" fill="#d6e8ff" stroke="#3a6bc4" stroke-width="1.5"/></svg>匯出 CSV
              </button>
              <button class="btn-danger-sm" id="clear-vocab-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>清除全部
              </button>
            </div>
          </div>
        </details>

        <details class="settings-collapsible-card">
          <summary class="settings-collapse-summary">
            <span class="settings-collapse-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              每日例句
            </span>
            <span class="settings-collapse-count">${totalSentences} 筆</span>
            <span class="settings-collapse-chevron">⌄</span>
          </summary>
          <div class="settings-card settings-collapse-body">
            <div class="sentence-stats-row">
              <div class="sentence-stat-box">
                <div class="sentence-stat-num">${aiSentences.length}</div>
                <div class="sentence-stat-label">AI 生成</div>
              </div>
              <div class="sentence-stat-box">
                <div class="sentence-stat-num" style="color:#3366cc">${importedSentences.length}</div>
                <div class="sentence-stat-label">CSV 匯入</div>
              </div>
              <div class="sentence-stat-box">
                <div class="sentence-stat-num" style="color:#e67e00">${totalSentences}</div>
                <div class="sentence-stat-label">合計（去重）</div>
              </div>
            </div>
            <div class="settings-btn-row">
              <button class="btn-icon btn-export" id="export-sentences-btn" style="flex:1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="2" fill="#5b8dd9" stroke="#3a6bc4"/><rect x="6" y="2" width="12" height="8" rx="1" fill="#a8c4f0" stroke="#3a6bc4" stroke-width="1.5"/><rect x="9" y="3.5" width="4" height="5" rx="0.5" fill="#3a6bc4" stroke="none"/><rect x="4" y="13" width="16" height="7" rx="1" fill="#d6e8ff" stroke="#3a6bc4" stroke-width="1.5"/></svg>匯出 CSV
              </button>
              <button class="btn-danger-sm" id="clear-sentences-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>清除全部
              </button>
            </div>
          </div>
        </details>

        <details class="settings-collapsible-card">
          <summary class="settings-collapse-summary">
            <span class="settings-collapse-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
              練習統計
            </span>
            <span class="settings-collapse-count">${totalStats} 筆</span>
            <span class="settings-collapse-chevron">⌄</span>
          </summary>
          <div class="settings-card settings-collapse-body">
            <div class="settings-stat-row">
              <div class="settings-stat-num">${totalStats}</div>
              <div class="settings-stat-label">筆練習記錄</div>
            </div>
            <div class="settings-btn-row">
              <button class="btn-icon btn-export" id="export-stats-settings-btn" style="flex:1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="2" fill="#5b8dd9" stroke="#3a6bc4"/><rect x="6" y="2" width="12" height="8" rx="1" fill="#a8c4f0" stroke="#3a6bc4" stroke-width="1.5"/><rect x="9" y="3.5" width="4" height="5" rx="0.5" fill="#3a6bc4" stroke="none"/><rect x="4" y="13" width="16" height="7" rx="1" fill="#d6e8ff" stroke="#3a6bc4" stroke-width="1.5"/></svg>匯出 CSV
              </button>
              <button class="btn-danger-sm" id="clear-stats-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>清除全部
              </button>
            </div>
          </div>
        </details>

        <details class="settings-collapsible-card">
          <summary class="settings-collapse-summary">
            <span class="settings-collapse-title"><span style="font-size:19px;font-weight:900;color:var(--primary)">あ</span>五十音手寫記錄</span>
            <span class="settings-collapse-count">${handwritingHistory.length} 次</span>
            <span class="settings-collapse-chevron">⌄</span>
          </summary>
          <div class="settings-card settings-collapse-body">
            <div class="sentence-stats-row">
              <div class="sentence-stat-box"><div class="sentence-stat-num">${kanaSummary.practiced}</div><div class="sentence-stat-label">已練假名</div></div>
              <div class="sentence-stat-box"><div class="sentence-stat-num" style="color:var(--primary)">${kanaSummary.mastered}</div><div class="sentence-stat-label">已熟練</div></div>
              <div class="sentence-stat-box"><div class="sentence-stat-num">${kanaSummary.averageScore}</div><div class="sentence-stat-label">平均分數</div></div>
            </div>
            <div class="settings-btn-row">
              <button class="btn-icon btn-export" id="export-handwriting-btn" style="flex:1">匯出 CSV</button>
              <button class="btn-danger-sm" id="clear-handwriting-btn">清除全部</button>
            </div>
            <div class="settings-tip" style="margin-top:9px;margin-bottom:0">手寫嘗試、分數與熟練度會納入 ZIP、完整備份及 Google Drive 跨裝置同步。</div>
          </div>
        </details>

        <details class="settings-collapsible-card">
          <summary class="settings-collapse-summary">
            <span class="settings-collapse-title"><span style="font-size:16px;font-weight:900;color:var(--primary)">あ→a</span>五十音讀音記錄</span>
            <span class="settings-collapse-count">${kanaReadingHistory.length} 題</span>
            <span class="settings-collapse-chevron">⌄</span>
          </summary>
          <div class="settings-card settings-collapse-body">
            <div class="sentence-stats-row">
              <div class="sentence-stat-box"><div class="sentence-stat-num">${kanaReadingSummary.practiced}</div><div class="sentence-stat-label">已練假名</div></div>
              <div class="sentence-stat-box"><div class="sentence-stat-num" style="color:var(--primary)">${kanaReadingSummary.correct}</div><div class="sentence-stat-label">答對題數</div></div>
              <div class="sentence-stat-box"><div class="sentence-stat-num">${kanaReadingSummary.accuracy}%</div><div class="sentence-stat-label">正確率</div></div>
            </div>
            <div class="settings-btn-row">
              <button class="btn-icon btn-export" id="export-kana-reading-btn" style="flex:1">匯出 CSV</button>
              <button class="btn-danger-sm" id="clear-kana-reading-btn">清除全部</button>
            </div>
            <div class="settings-tip" style="margin-top:9px;margin-bottom:0">讀音作答記錄、正確率與模式選擇會納入 ZIP、完整備份及 Google Drive 還原。</div>
          </div>
        </details>

        <details class="settings-collapsible-card">
          <summary class="settings-collapse-summary">
            <span class="settings-collapse-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2s1 4-2 6c-2 1-3-1-3-1s-4 4-2 9a6 6 0 0 0 12 0c1-4-2-7-5-8 1-2 0-4 0-6z"/></svg>
              累積練習天數
            </span>
            <span class="settings-collapse-count">${streakSummary.totalDays} 天</span>
            <span class="settings-collapse-chevron">⌄</span>
          </summary>
          <div class="settings-card settings-collapse-body">
            <div class="sentence-stats-row">
              <div class="sentence-stat-box">
                <div class="sentence-stat-num" id="settings-streak-current">${streakSummary.current}</div>
                <div class="sentence-stat-label">目前連續</div>
              </div>
              <div class="sentence-stat-box">
                <div class="sentence-stat-num" id="settings-streak-longest" style="color:#e67e00">${streakSummary.longest}</div>
                <div class="sentence-stat-label">歷史最久</div>
              </div>
              <div class="sentence-stat-box">
                <div class="sentence-stat-num">${studyDays.reduce((sum, day) => sum + (Number(day.sessionCount) || 0), 0)}</div>
                <div class="sentence-stat-label">練習事件</div>
              </div>
            </div>
            <div class="settings-btn-row">
              <button class="btn-icon btn-export" id="export-study-days-btn" style="flex:1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M6 19h12"/></svg>匯出 CSV
              </button>
            </div>
            <div class="settings-tip" style="margin-top:9px;margin-bottom:0">完成語彙測驗、五十音手寫、閱讀測驗、文章 AI 批改或 AI 詢問即記錄；同一天只計為 1 個練習日。</div>
          </div>
        </details>

        <details class="settings-collapsible-card">
          <summary class="settings-collapse-summary">
            <span class="settings-collapse-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4h20v14H6l-4 4V4z"/><path d="M7 9h10"/><path d="M7 13h6"/></svg>
              文章閱讀測驗
            </span>
            <span class="settings-collapse-count">${totalReading} 次</span>
            <span class="settings-collapse-chevron">⌄</span>
          </summary>
          <div class="settings-card settings-collapse-body">
            <div class="sentence-stats-row">
              <div class="sentence-stat-box">
                <div class="sentence-stat-num">${totalReading}</div>
                <div class="sentence-stat-label">測驗次數</div>
              </div>
              <div class="sentence-stat-box">
                <div class="sentence-stat-num" style="color:#e67e00">${readingAvg}</div>
                <div class="sentence-stat-label">平均分數</div>
              </div>
            </div>
            <div class="settings-btn-row">
              <button class="btn-icon btn-export" id="export-reading-btn" style="flex:1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="2" fill="#5b8dd9" stroke="#3a6bc4"/><rect x="6" y="2" width="12" height="8" rx="1" fill="#a8c4f0" stroke="#3a6bc4" stroke-width="1.5"/><rect x="9" y="3.5" width="4" height="5" rx="0.5" fill="#3a6bc4" stroke="none"/><rect x="4" y="13" width="16" height="7" rx="1" fill="#d6e8ff" stroke="#3a6bc4" stroke-width="1.5"/></svg>匯出 CSV
              </button>
              <button class="btn-danger-sm" id="clear-reading-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>清除全部
              </button>
            </div>
          </div>
        </details>

        <details class="settings-collapsible-card">
          <summary class="settings-collapse-summary">
            <span class="settings-collapse-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 9.5-9.5z"/></svg>
              文章撰寫
            </span>
            <span class="settings-collapse-count">${totalEssay} 篇</span>
            <span class="settings-collapse-chevron">⌄</span>
          </summary>
          <div class="settings-card settings-collapse-body">
            <div class="settings-stat-row">
              <div class="settings-stat-num">${totalEssay}</div>
              <div class="settings-stat-label">篇練習記錄</div>
            </div>
            <div class="settings-btn-row">
              <button class="btn-icon btn-export" id="export-essay-btn" style="flex:1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="2" fill="#5b8dd9" stroke="#3a6bc4"/><rect x="6" y="2" width="12" height="8" rx="1" fill="#a8c4f0" stroke="#3a6bc4" stroke-width="1.5"/><rect x="9" y="3.5" width="4" height="5" rx="0.5" fill="#3a6bc4" stroke="none"/><rect x="4" y="13" width="16" height="7" rx="1" fill="#d6e8ff" stroke="#3a6bc4" stroke-width="1.5"/></svg>匯出 CSV
              </button>
              <button class="btn-danger-sm" id="clear-essay-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>清除全部
              </button>
            </div>
          </div>
        </details>

        <details class="settings-collapsible-card">
          <summary class="settings-collapse-summary">
            <span class="settings-collapse-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              AI 詢問
            </span>
            <span class="settings-collapse-count">${totalAiAsk} 筆</span>
            <span class="settings-collapse-chevron">⌄</span>
          </summary>
          <div class="settings-card settings-collapse-body">
            <div class="settings-stat-row">
              <div class="settings-stat-num">${totalAiAsk}</div>
              <div class="settings-stat-label">筆詢問記錄</div>
            </div>
            <div class="settings-btn-row">
              <button class="btn-icon btn-export" id="export-aiask-btn" style="flex:1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="2" fill="#5b8dd9" stroke="#3a6bc4"/><rect x="6" y="2" width="12" height="8" rx="1" fill="#a8c4f0" stroke="#3a6bc4" stroke-width="1.5"/><rect x="9" y="3.5" width="4" height="5" rx="0.5" fill="#3a6bc4" stroke="none"/><rect x="4" y="13" width="16" height="7" rx="1" fill="#d6e8ff" stroke="#3a6bc4" stroke-width="1.5"/></svg>匯出 CSV
              </button>
              <button class="btn-danger-sm" id="clear-aiask-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>清除全部
              </button>
            </div>
          </div>
        </details>

        <!-- 6. Google Drive 設定（Client ID / Folder ID） -->
        <div class="settings-section-label" style="margin-top:16px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
          Google Drive 設定
        </div>
        <div class="settings-card">
          <div class="api-subsection-label" style="margin-bottom:4px">OAuth Client ID</div>
          <div class="form-group" style="margin-bottom:8px">
            <input type="text" class="form-input" id="gd-client-id-input" value="${escapeAttr(clientId)}" placeholder="xxxxxx.apps.googleusercontent.com" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
          </div>
          <div class="api-subsection-label" style="margin-bottom:4px">Google Drive 資料夾 ID（選填）</div>
          <div class="form-group" style="margin-bottom:8px">
            <input type="text" class="form-input" id="gd-folder-id-input" value="${escapeAttr(folderId)}" placeholder="留空則儲存到 Drive 根目錄" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
          </div>
          <div class="settings-btn-row">
            <button class="btn-primary" id="gd-save-cfg-btn" style="flex:1">儲存 Drive 設定</button>
          </div>
          <div class="settings-tip" style="margin-top:10px;margin-bottom:0">需在 Google Cloud Console 建立 OAuth 2.0 用戶端 ID（類型：網頁應用程式），並將本站網址加入授權來源。資料夾 ID 可從 Drive 資料夾網址中取得（/folders/ 後面的部分）。</div>
        </div>

        <!-- 7. 每日推薦學習設定 -->
        <div class="settings-section-label" style="margin-top:16px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M12 2l2.4 6.1L21 9l-5 4.3 1.5 6.5L12 16.4 6.5 19.8 8 13.3 3 9l6.6-.9L12 2z"/></svg>
          每日推薦學習設定
        </div>
        <div class="settings-card daily-learning-settings-card">
          <div class="model-dropdown-row">
            <label class="model-dropdown-label">今日學習來源</label>
            <select class="model-dropdown-select" id="daily-learning-source-select">
              <option value="database" ${dailyLearningPreferences.source===DAILY_LEARNING_SOURCES.DATABASE?'selected':''}>單字庫（原模式）</option>
              <option value="level" ${dailyLearningPreferences.source===DAILY_LEARNING_SOURCES.LEVEL?'selected':''}>依等級學習（AI 每日推薦）</option>
            </select>
          </div>
          <div class="model-dropdown-row">
            <label class="model-dropdown-label">目前日文等級</label>
            <select class="model-dropdown-select" id="jlpt-level-select">
              ${['N5','N4','N3','N2','N1'].map(level => `<option value="${level}" ${jlptLevel===level?'selected':''}>JLPT ${level}</option>`).join('')}
            </select>
          </div>
          <div class="daily-learning-row-section ${dailyLearningPreferences.source===DAILY_LEARNING_SOURCES.LEVEL?'':'is-disabled'}" id="daily-learning-row-section">
            <div class="daily-learning-row-head">
              <strong>想學習的五十音行</strong>
              <small>可同時選擇多行；推薦單字的假名讀音會從所選行開始</small>
            </div>
            <div class="kana-row-grid daily-learning-row-grid" role="group" aria-label="選擇推薦單字的五十音行">
              <button class="kana-row-chip ${dailyLearningPreferences.rows.includes('all')?'selected':''}" type="button" data-learning-row="all" aria-pressed="${dailyLearningPreferences.rows.includes('all')}">全部行</button>
              ${LEARNING_KANA_ROWS.map(row => `<button class="kana-row-chip ${dailyLearningPreferences.rows.includes(row.id)?'selected':''}" type="button" data-learning-row="${row.id}" aria-pressed="${dailyLearningPreferences.rows.includes(row.id)}">${row.label}</button>`).join('')}
            </div>
            <div class="kana-row-summary" id="daily-learning-row-summary">目前選擇：${escapeHTML(selectedLearningRowLabel(dailyLearningPreferences.rows))}</div>
          </div>
          <div class="settings-tip" style="margin-bottom:0">「單字庫」保留原本從資料庫抽字並生成例句的方式；「依等級學習」每天依 JLPT 等級與所選五十音行推薦 5 個單字，包含假名、羅馬拼音、詞性及中文。</div>
        </div>

        <!-- 8. Gemini API 金鑰設定 -->
        <div class="settings-section-label" style="margin-top:16px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
          Gemini API 金鑰設定
        </div>
        <div class="settings-card">
          <div class="key-status" style="margin-bottom:6px">
            <div class="key-status-dot ${hasKey?'saved':'unsaved'}"></div>
            <span>${hasKey?'已儲存 Gemini Key':'尚未設定 Gemini Key'}</span>
          </div>
          <div class="form-group">
            <div class="input-with-toggle">
              <input type="password" class="form-input" id="api-key-input" value="${escapeAttr(savedKey)}" placeholder="AIza...（Google AI Studio）">
              <button class="toggle-visibility" id="toggle-vis"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
            </div>
          </div>
          <div class="settings-btn-row">
            <button class="btn-primary" id="save-key-btn" style="flex:1">儲存</button>
            ${hasKey?'<button class="btn-secondary" id="clear-key-btn" style="flex:1">清除</button>':''}
          </div>
          <div class="model-dropdown-row">
            <label class="model-dropdown-label">AI 模型</label>
            <select class="model-dropdown-select" id="gemini-model-select">
              ${Gemini.AVAILABLE_MODELS.map(m =>
                `<option value="${escapeHTML(m.id)}" ${savedModel===m.id?'selected':''}>${escapeHTML(m.label)}${m.tag ? '（' + escapeHTML(m.tag) + '）' : ''}</option>`
              ).join('')}
            </select>
          </div>
          <a class="api-link" href="https://aistudio.google.com/app/apikey" target="_blank">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            取得 Gemini Key（Google AI Studio）
          </a>
          <div class="settings-tip" style="margin-bottom:0">目前日文等級會套用到每日推薦單字、AI 例句與閱讀文章。免費方案每天有配額限制；Gemini Key 僅儲存於本機裝置。</div>
        </div>

        <!-- 每日學習提醒 -->
        <div class="settings-section-label" style="margin-top:16px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>
          每日學習提醒
        </div>
        <div class="settings-card reminder-card">
          <div class="reminder-status ${reminderStatusClass}" id="reminder-status" role="status" aria-live="polite">
            <span class="reminder-status-dot"></span>
            <span id="reminder-status-text">${escapeHTML(reminderStatusText)}</span>
          </div>
          <label class="reminder-time-row" for="daily-reminder-time">
            <span>
              <strong>每日提醒時間</strong>
              <small>使用目前裝置時區：${escapeHTML(reminderSettings.timeZone)}</small>
            </span>
            <input type="time" id="daily-reminder-time" class="reminder-time-input" value="${escapeAttr(reminderSettings.time)}" step="60">
          </label>
          <div class="reminder-next-row">
            <span>下次提醒</span>
            <strong id="reminder-next-time">${escapeHTML(DailyReminder.getNextReminderLabel())}</strong>
          </div>
          <div class="reminder-actions">
            <button class="btn-primary" id="enable-reminder-btn" type="button">儲存並啟用</button>
            <button class="btn-secondary" id="test-reminder-btn" type="button"${(!reminderSettings.enabled || reminderCapabilities.permission !== 'granted') ? ' disabled' : ''}>傳送測試通知</button>
            <button class="btn-secondary reminder-disable-btn" id="disable-reminder-btn" type="button"${!reminderSettings.enabled ? ' disabled' : ''}>關閉提醒</button>
          </div>
          ${!reminderCapabilities.backendConfigured ? '<div class="reminder-warning">部署完成後，請先在 <code>push-config.js</code> 填入 Worker 網址。</div>' : ''}
          ${reminderCapabilities.needsInstall ? '<div class="reminder-warning">iPhone 必須先從瀏覽器分享選單選擇「加入主畫面」，再由主畫面圖示開啟。</div>' : ''}
          <div class="settings-tip reminder-tip">設定會綁定這台裝置，不會跟著 Google Drive 備份移轉。PWA 關閉後仍可通知；實際顯示時間可能受網路、專注模式或通知摘要影響。</div>
        </div>

        <!-- 版本號 + 檢查更新 -->
        <div class="settings-section-label" style="margin-top:16px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          版本資訊
        </div>
        <div class="settings-card" style="text-align:center">
          <div class="version-info-grid">
            <div><span>當前版本</span><strong>${APP_DISPLAY_VERSION}</strong></div>
            <div><span>最新版本</span><strong id="latest-version-value">${escapeHTML(versionState.latestVersion)}</strong></div>
            <div><span>資料儲存</span><strong>${storageState.mode === 'indexeddb' ? 'IndexedDB V8' : '相容模式'}</strong></div>
          </div>
          <div id="version-last-check" class="version-last-check">${versionState.lastCheckedAt ? '最後檢查：' + new Date(versionState.lastCheckedAt).toLocaleString('zh-TW') : '尚未檢查更新'}</div>
          <button class="btn-secondary" id="check-update-btn" style="width:100%;margin-bottom:8px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:6px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            檢查更新
          </button>
          <div id="update-status" style="font-size:12px;color:var(--text-muted);min-height:16px"></div>
        </div>

        <!-- 8. 音效測試（設定頁最下方） -->
        <div class="settings-section-label" style="margin-top:16px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          音效測試
        </div>
        <div class="settings-card sound-test-card">
          <div class="sound-test-status ${soundState.state === 'running' ? 'is-running' : ''}" id="sound-test-status" role="status" aria-live="polite">
            ${!soundState.supported ? '此瀏覽器不支援 Web Audio API' : soundState.state === 'running' ? '音效已啟用（AudioContext：running）' : '音效尚未啟用，請點擊下方任一測試按鈕'}
          </div>
          <div class="sound-test-grid">
            <button class="btn-secondary sound-test-btn" id="test-correct-sound-btn" type="button">✓ 答對音效</button>
            <button class="btn-secondary sound-test-btn" id="test-wrong-sound-btn" type="button">✕ 答錯音效</button>
            <button class="btn-primary sound-test-btn sound-test-wide" id="test-result-sound-btn" type="button">♫ 總結音效（100%）</button>
          </div>
          <div class="settings-tip sound-test-tip">請先將 iPhone 的媒體音量調高，再逐一點擊測試。iOS 會自動切換為 playback 音訊工作階段，避免靜音模式關閉學習提示音。</div>
        </div>

        <div style="height:12px"></div>
      </div>

      <input type="file" id="one-click-import-input" accept=".csv,.zip" multiple style="display:none">
    `;

    // ── 每日 Web Push 提醒 ──
    const reminderStatusEl = document.getElementById('reminder-status');
    const reminderStatusTextEl = document.getElementById('reminder-status-text');
    const setReminderStatus = (text, state = '') => {
      if (reminderStatusTextEl) reminderStatusTextEl.textContent = text;
      reminderStatusEl?.classList.toggle('is-enabled', state === 'enabled');
      reminderStatusEl?.classList.toggle('is-pending', state === 'pending');
      reminderStatusEl?.classList.toggle('has-error', state === 'error');
    };

    document.getElementById('enable-reminder-btn')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const time = document.getElementById('daily-reminder-time')?.value || '';
      button.disabled = true;
      button.textContent = '設定中…';
      setReminderStatus('正在向 iOS 建立通知訂閱…', 'pending');
      try {
        const saved = await DailyReminder.enable(time);
        setReminderStatus(`已啟用，每日 ${saved.time} 提醒`, 'enabled');
        showToast(`✓ 每日 ${saved.time} 提醒已啟用`, 3000);
        this.render(container);
      } catch (error) {
        const message = reminderErrorMessage(error);
        setReminderStatus(message, 'error');
        showToast(message, 4500);
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = '儲存並啟用';
        }
      }
    });

    document.getElementById('test-reminder-btn')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = '傳送中…';
      setReminderStatus('正在傳送測試通知…', 'pending');
      try {
        await DailyReminder.sendTest();
        setReminderStatus(`已啟用，每日 ${DailyReminder.getSettings().time} 提醒`, 'enabled');
        showToast('✓ 測試通知已送出，通常會在數秒內顯示', 3500);
      } catch (error) {
        const message = reminderErrorMessage(error);
        setReminderStatus(message, 'error');
        showToast(message, 4500);
      } finally {
        button.disabled = false;
        button.textContent = '傳送測試通知';
      }
    });

    document.getElementById('disable-reminder-btn')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = '關閉中…';
      try {
        await DailyReminder.disable();
        showToast('每日提醒已關閉');
        this.render(container);
      } catch (error) {
        const message = reminderErrorMessage(error);
        setReminderStatus(message, 'error');
        showToast(message, 4500);
        button.disabled = false;
        button.textContent = '關閉提醒';
      }
    });

    // ── 音效測試 ──
    const soundStatusEl = document.getElementById('sound-test-status');
    const updateSoundTestStatus = (prefix = '') => {
      if (!soundStatusEl) return;
      const status = Sound.getStatus();
      const stateText = status.state === 'running' ? 'running（已啟用）'
        : status.state === 'suspended' ? 'suspended（等待啟用）'
        : status.state === 'interrupted' ? 'interrupted（被系統中斷）'
        : status.state === 'not-created' ? '尚未建立'
        : status.state;
      const recent = status.lastPlayed ? `；最近播放：${status.lastPlayed}` : '';
      const audioSession = status.audioSessionType !== 'unavailable' ? `；AudioSession：${status.audioSessionType}` : '';
      const error = status.lastError ? `；錯誤：${status.lastError}` : '';
      soundStatusEl.textContent = `${prefix}${prefix ? '｜' : ''}AudioContext：${stateText}${audioSession}${recent}${error}`;
      soundStatusEl.classList.toggle('is-running', status.state === 'running' && !status.lastError);
      soundStatusEl.classList.toggle('has-error', !!status.lastError || !status.supported);
    };

    const runSoundTest = async (type, button) => {
      const originalText = button?.textContent || '';
      if (button) { button.disabled = true; button.textContent = '播放中…'; }
      try {
        // playCorrect/playWrong/playResult invoke resume() synchronously from this
        // click event, which is required by iOS standalone PWA audio policy.
        const played = type === 'correct' ? await Sound.playCorrect()
          : type === 'wrong' ? await Sound.playWrong()
          : await Sound.playResult(100);
        updateSoundTestStatus(played ? '已送出音效' : '未能播放');
        showToast(played ? '🔊 已播放音效，請確認是否聽見' : '音效啟用失敗，請查看狀態', 2800);
      } catch (error) {
        Sound.lastError = error?.message || '測試播放失敗';
        updateSoundTestStatus('播放失敗');
        showToast('音效測試失敗');
      } finally {
        setTimeout(() => {
          if (button) { button.disabled = false; button.textContent = originalText; }
          updateSoundTestStatus();
        }, type === 'result' ? 900 : 550);
      }
    };

    document.getElementById('test-correct-sound-btn')?.addEventListener('click', e => runSoundTest('correct', e.currentTarget));
    document.getElementById('test-wrong-sound-btn')?.addEventListener('click', e => runSoundTest('wrong', e.currentTarget));
    document.getElementById('test-result-sound-btn')?.addEventListener('click', e => runSoundTest('result', e.currentTarget));
    updateSoundTestStatus();

    // ── 1. API Key ──
    const input = document.getElementById('api-key-input');
    document.getElementById('toggle-vis').addEventListener('click', () => { input.type = input.type==='password'?'text':'password'; });
    document.getElementById('save-key-btn').addEventListener('click', () => {
      const key = input.value.trim(); if (!key) { showToast('請輸入 API Key'); return; }
      DB.saveApiKey(key); showToast('✓ API Key 已儲存'); this.render(container);
    });
    document.getElementById('clear-key-btn')?.addEventListener('click', () => { DB.saveApiKey(''); showToast('已清除 API Key'); this.render(container); });

    // ── 模型選擇（下拉選單） ──
    document.getElementById('gemini-model-select')?.addEventListener('change', (e) => {
      DB.saveModel(e.target.value);
      showToast('✓ 模型：' + (Gemini.AVAILABLE_MODELS.find(m=>m.id===e.target.value)?.label || e.target.value));
    });
    document.getElementById('jlpt-level-select')?.addEventListener('change', event => {
      DB.saveDailyLearningPreferences({ level: event.target.value });
      showToast(`✓ 學習等級：JLPT ${event.target.value}`);
    });
    document.getElementById('daily-learning-source-select')?.addEventListener('change', event => {
      const preferences = DB.saveDailyLearningPreferences({ source: event.target.value });
      const rowSection = document.getElementById('daily-learning-row-section');
      rowSection?.classList.toggle('is-disabled', preferences.source !== DAILY_LEARNING_SOURCES.LEVEL);
      showToast(preferences.source === DAILY_LEARNING_SOURCES.LEVEL ? '✓ 首頁改為依等級推薦單字' : '✓ 首頁改為從單字庫產生例句');
    });
    const refreshDailyLearningRowUI = preferences => {
      document.querySelectorAll('[data-learning-row]').forEach(button => {
        const selected = preferences.rows.includes(button.dataset.learningRow);
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      const summary = document.getElementById('daily-learning-row-summary');
      if (summary) summary.textContent = `目前選擇：${selectedLearningRowLabel(preferences.rows)}`;
    };
    document.querySelectorAll('[data-learning-row]').forEach(button => {
      button.addEventListener('click', () => {
        const row = button.dataset.learningRow;
        const current = DB.getDailyLearningPreferences();
        let rows;
        if (row === 'all') rows = ['all'];
        else {
          const selected = new Set(current.rows.includes('all') ? [] : current.rows);
          if (selected.has(row)) selected.delete(row); else selected.add(row);
          rows = selected.size ? [...selected] : ['all'];
          if (rows.length === LEARNING_KANA_ROWS.length) rows = ['all'];
        }
        const saved = DB.saveDailyLearningPreferences({ rows });
        refreshDailyLearningRowUI(saved);
      });
    });

    // ── helper: confirm-clear modal ──
    const confirmClear = (title, desc, onConfirm) => {
      Modal.show(`<div class="modal-handle"></div><div class="modal-title">${title}</div><p style="color:var(--text-muted);font-size:14px;margin-bottom:16px">${desc}</p><div class="modal-actions"><button class="modal-btn-cancel" id="cc-cancel">取消</button><button class="modal-btn-delete" id="cc-confirm">確認清除</button></div>`);
      document.getElementById('cc-cancel').addEventListener('click', () => Modal.hide());
      document.getElementById('cc-confirm').addEventListener('click', () => { Modal.hide(); onConfirm(); });
    };

    // ── 2. 單字庫 ──
    document.getElementById('export-vocab-btn').addEventListener('click', () => {
      if (!DB.getWords().length) { showToast('資料庫是空的'); return; }
      downloadCSV(DB.exportCSV(), `japanese_vocab_${dateTag}.csv`);
      showToast('✓ 單字 CSV 已匯出');
    });
    document.getElementById('clear-vocab-btn')?.addEventListener('click', () => {
      confirmClear('清除單字資料庫',
        `確定要清除全部 ${totalWords} 個單字嗎？此操作無法復原，建議先匯出備份。`,
        () => { DB.saveWords([]); AppStorage.removeItem('boostedWords'); showToast('已清除單字資料庫'); this.render(container); });
    });

    // ── 3. 例句 ──
    document.getElementById('export-sentences-btn').addEventListener('click', () => {
      const csv = DB.exportSentencesCSV();
      if (!csv.includes('\n')) { showToast('尚無例句可匯出'); return; }
      downloadCSV(csv, `sentences_${dateTag}.csv`);
      showToast('✓ 例句 CSV 已匯出');
    });
    document.getElementById('clear-sentences-btn')?.addEventListener('click', () => {
      confirmClear('清除所有例句',
        `確定要清除全部 ${totalSentences} 筆例句嗎（AI 生成 + CSV 匯入）？此操作無法復原。`,
        () => { DB.saveSentenceLog([]); DB.saveImportedSentences([]); showToast('已清除所有例句'); this.render(container); });
    });

    // ── 4. 練習統計 ──
    document.getElementById('export-stats-settings-btn').addEventListener('click', () => {
      if (!DB.getHistory().length) { showToast('尚無統計資料'); return; }
      downloadCSV(DB.exportStatsCSV(), `stats_${dateTag}.csv`);
      showToast('✓ 統計 CSV 已匯出');
    });
    document.getElementById('clear-stats-btn')?.addEventListener('click', () => {
      confirmClear('清除練習統計',
        `確定要清除全部 ${totalStats} 筆練習記錄嗎？此操作無法復原。`,
        () => { DB.saveHistory([]); showToast('已清除練習統計'); this.render(container); });
    });

    // ── 五十音手寫 ──
    document.getElementById('export-handwriting-btn')?.addEventListener('click', () => {
      if (!handwritingHistory.length) { showToast('尚無五十音手寫記錄'); return; }
      downloadCSV(KanaProgress.exportCSV(), `kana_handwriting_${dateTag}.csv`);
      showToast('✓ 五十音手寫 CSV 已匯出');
    });
    document.getElementById('clear-handwriting-btn')?.addEventListener('click', () => {
      confirmClear('清除五十音手寫記錄', `確定要清除全部 ${handwritingHistory.length} 次手寫記錄嗎？此操作無法復原。`, () => {
        KanaProgress.saveHistory([]); showToast('已清除五十音手寫記錄'); this.render(container);
      });
    });

    // ── 五十音讀音 ──
    document.getElementById('export-kana-reading-btn')?.addEventListener('click', () => {
      if (!kanaReadingHistory.length) { showToast('尚無五十音讀音記錄'); return; }
      downloadCSV(KanaReadingProgress.exportCSV(), `kana_reading_${dateTag}.csv`);
      showToast('✓ 五十音讀音 CSV 已匯出');
    });
    document.getElementById('clear-kana-reading-btn')?.addEventListener('click', () => {
      confirmClear('清除五十音讀音記錄', `確定要清除全部 ${kanaReadingHistory.length} 題讀音記錄嗎？此操作無法復原。`, () => {
        KanaReadingProgress.saveHistory([]); showToast('已清除五十音讀音記錄'); this.render(container);
      });
    });

    // ── 累積練習天數 ──
    document.getElementById('export-study-days-btn')?.addEventListener('click', () => {
      if (!studyDays.length) { showToast('尚無累積練習天數'); return; }
      downloadCSV(DB.exportStudyDaysCSV(), `study_days_${compactDateTag}.csv`);
      showToast('✓ 練習天數 CSV 已匯出');
    });
    // ── 4a. 文章閱讀測驗 ──
    document.getElementById('export-reading-btn')?.addEventListener('click', () => {
      if (!totalReading) { showToast('尚無文章閱讀測驗記錄'); return; }
      downloadCSV(DB.exportReadingQuizCSV(), `reading_${dateTag}.csv`);
      showToast('✓ 文章閱讀測驗 CSV 已匯出');
    });
    document.getElementById('clear-reading-btn')?.addEventListener('click', () => {
      confirmClear('清除文章閱讀測驗記錄',
        `確定要清除全部 ${totalReading} 次文章閱讀測驗記錄嗎？此操作無法復原。`,
        () => { DB.saveReadingQuizHistory([]); showToast('已清除文章閱讀測驗記錄'); this.render(container); });
    });

    // ── 4b. 文章撰寫 ──
    document.getElementById('export-essay-btn')?.addEventListener('click', () => {
      if (!totalEssay) { showToast('尚無文章記錄'); return; }
      downloadCSV(DB.exportEssayCSV(), `essay_${dateTag}.csv`);
      showToast('✓ 文章 CSV 已匯出');
    });
    document.getElementById('clear-essay-btn')?.addEventListener('click', () => {
      confirmClear('清除文章撰寫記錄',
        `確定要清除全部 ${totalEssay} 篇文章記錄嗎？此操作無法復原。`,
        () => { DB.saveEssayHistory([]); showToast('已清除文章撰寫記錄'); this.render(container); });
    });

    // ── 4c. AI 詢問 ──
    document.getElementById('export-aiask-btn')?.addEventListener('click', () => {
      if (!totalAiAsk) { showToast('尚無詢問記錄'); return; }
      downloadCSV(DB.exportAiAskCSV(), `aiask_${dateTag}.csv`);
      showToast('✓ AI 詢問 CSV 已匯出');
    });
    document.getElementById('clear-aiask-btn')?.addEventListener('click', () => {
      confirmClear('清除 AI 詢問記錄',
        `確定要清除全部 ${totalAiAsk} 筆詢問記錄嗎？此操作無法復原。`,
        () => { DB.saveAiAskHistory([]); showToast('已清除 AI 詢問記錄'); this.render(container); });
    });

    // ── 5. 一鍵匯出：打包成單一 ZIP 一次下載 ──
    document.getElementById('one-click-export-btn').addEventListener('click', async () => {
      const words = DB.getWords(); const sentCsv = DB.exportSentencesCSV(); const statHistory = DB.getHistory(); const readingHistory = DB.getReadingQuizHistory();
      if (!words.length && !sentCsv.includes('\n') && !statHistory.length && !readingHistory.length && !DB.getEssayHistory().length && !DB.getAiAskHistory().length && !studyDays.length && !handwritingHistory.length && !kanaReadingHistory.length) { showToast('尚無資料可匯出'); return; }
      showToast('⏳ 正在打包...', 1800);
      try {
        const zip = new window.JSZip();
        if (words.length)           zip.file(`japanese_vocab_${dateTag}.csv`, '\uFEFF' + DB.exportCSV());
        if (sentCsv.includes('\n')) zip.file(`sentences_${dateTag}.csv`, '\uFEFF' + sentCsv);
        if (statHistory.length)     zip.file(`stats_${dateTag}.csv`,     '\uFEFF' + DB.exportStatsCSV());
        if (readingHistory.length)  zip.file(`reading_${dateTag}.csv`,   '\uFEFF' + DB.exportReadingQuizCSV());
        const essayHistory = DB.getEssayHistory();
        if (essayHistory.length)    zip.file(`essay_${dateTag}.csv`,     '\uFEFF' + DB.exportEssayCSV());
        const aiAskHistory = DB.getAiAskHistory();
        if (aiAskHistory.length)    zip.file(`aiask_${dateTag}.csv`,     '\uFEFF' + DB.exportAiAskCSV());
        if (studyDays.length)       zip.file(`study_days_${compactDateTag}.csv`, '\uFEFF' + DB.exportStudyDaysCSV());
        if (handwritingHistory.length) zip.file(`kana_handwriting_${dateTag}.csv`, '\uFEFF' + KanaProgress.exportCSV());
        if (kanaReadingHistory.length) zip.file(`kana_reading_${dateTag}.csv`, '\uFEFF' + KanaReadingProgress.exportCSV());
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a');
        a.href = url; a.download = `japanese-learning-backup_${dateTag}.zip`; a.click(); URL.revokeObjectURL(url);
        const count = [words.length, sentCsv.includes('\n'), statHistory.length, readingHistory.length, essayHistory.length, aiAskHistory.length, studyDays.length, handwritingHistory.length, kanaReadingHistory.length].filter(Boolean).length;
        showToast(`✓ 已匯出 ${count} 個檔案（ZIP）`, 3000);
      } catch(err) {
        showToast('匯出失敗，請重試');
      }
    });

    // ── 一鍵匯入（自動識別類型）──
    const oneClickImportInput = document.getElementById('one-click-import-input');
    document.getElementById('one-click-import-btn').addEventListener('click', () => oneClickImportInput.click());
    oneClickImportInput.addEventListener('change', async (e) => {
      const files = [...e.target.files]; e.target.value = '';
      if (!files.length) return;

      const results = []; const errors = []; const unknown = [];

      // Helper: process a single CSV text entry
      const processCSV = (name, text) => {
        const type = DB.detectCSVType(text);
        if (!type) { unknown.push(name); return; }
        try {
          if (type === 'vocab') {
            const r = DB.importCSV(text);
            results.push(`📚 單字庫（${name}）：新增 ${r.added} 個${r.skipped > 0 ? `，略過 ${r.skipped} 筆` : ''}`);
          } else if (type === 'sentences') {
            const r = DB.importSentencesCSV(text);
            results.push(`💬 例句（${name}）：新增 ${r.added} 筆`);
          } else if (type === 'stats') {
            const r = DB.importStatsCSV(text);
            results.push(`📊 統計（${name}）：新增 ${r.added} 筆，更新 ${r.updated} 筆`);
          } else if (type === 'reading') {
            const r = DB.importReadingQuizCSV(text);
            results.push(`📖 文章閱讀測驗（${name}）：新增 ${r.added} 筆`);
          } else if (type === 'essay') {
            const r = DB.importEssayCSV(text);
            results.push(`✍️ 文章記錄（${name}）：新增 ${r.added} 筆`);
          } else if (type === 'aiask') {
            const r = DB.importAiAskCSV(text);
            results.push(`💬 AI 詢問（${name}）：新增 ${r.added} 筆`);
          } else if (type === 'studyDays') {
            const r = DB.importStudyDaysCSV(text);
            results.push(`🔥 練習天數（${name}）：新增 ${r.added} 天，共 ${r.total} 天`);
          } else if (type === 'handwriting') {
            const r = KanaProgress.importCSV(text);
            results.push(`🖌️ 五十音手寫（${name}）：新增 ${r.added} 筆，共 ${r.total} 筆`);
          } else if (type === 'kanaReading') {
            const r = KanaReadingProgress.importCSV(text);
            results.push(`🔤 五十音讀音（${name}）：新增 ${r.added} 筆，共 ${r.total} 筆`);
          }
        } catch(err) {
          errors.push(`${name}（${err.message||'格式錯誤'}）`);
        }
      };

      // Helper: read file as text
      const readAsText = (file) => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target.result);
        reader.readAsText(file, 'UTF-8');
      });

      // Helper: read file as ArrayBuffer (for ZIP)
      const readAsBuffer = (file) => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target.result);
        reader.readAsArrayBuffer(file);
      });

      showToast('⏳ 正在匯入...', 2000);

      for (const file of files) {
        const isZip = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
        if (isZip) {
          // ── ZIP: extract all CSV files inside ──
          try {
            const buffer = await readAsBuffer(file);
            const zip = await window.JSZip.loadAsync(buffer);
            const csvFiles = Object.values(zip.files).filter(f => !f.dir && f.name.toLowerCase().endsWith('.csv'));
            if (csvFiles.length === 0) { unknown.push(file.name + '（ZIP 內無 CSV）'); continue; }
            for (const csvFile of csvFiles) {
              const text = await csvFile.async('text');
              // Strip BOM if present
              const clean = text.replace(/^\uFEFF/, '');
              processCSV(csvFile.name.split('/').pop(), clean);
            }
          } catch(err) {
            errors.push(`${file.name}（ZIP 解析失敗）`);
          }
        } else {
          // ── Single CSV file ──
          const text = await readAsText(file);
          processCSV(file.name, text.replace(/^\uFEFF/, ''));
        }
      }

      if (results.length > 0) {
        StudyStreak.migrateFromHistories(getStudyHistorySources(), { markPending: true });
        GDrive.scheduleStudyStreakSync(300);
        refreshStudyStreakUI();
      }

      // Show result modal
      const lines = [
        ...results.map(r => `<div class="batch-result-ok">✓ ${r}</div>`),
        ...unknown.map(n => `<div class="batch-result-warn">⚠ 無法識別：${n}</div>`),
        ...errors.map(n => `<div class="batch-result-err">✗ 匯入失敗：${n}</div>`)
      ].join('');

      if (results.length === 0 && errors.length === 0 && unknown.length > 0) {
        showToast('無法識別檔案格式，請確認 CSV 標頭');
      } else {
        Modal.show(`
          <div class="modal-handle"></div>
          <div class="modal-title">一鍵匯入結果</div>
          <div class="batch-result-list">${lines || '<div style="color:var(--text-muted);font-size:13px">無資料被匯入</div>'}</div>
          ${unknown.length > 0 ? `<div class="batch-unknown-hint">無法識別的檔案請確認 CSV 標頭格式是否正確</div>` : ''}
          <div style="margin-top:16px"><button class="modal-btn-cancel" id="close-batch-modal" style="width:100%">完成</button></div>
        `);
        document.getElementById('close-batch-modal').addEventListener('click', () => {
          Modal.hide(); this.render(container);
        });
      }
      if (results.length > 0) this.render(container);
    });

    const setDriveOperation = (message = '', percent = 0, state = 'busy') => {
      const status = document.getElementById('gd-operation-status');
      const text = document.getElementById('gd-operation-text');
      const value = document.getElementById('gd-operation-percent');
      if (!status) return;
      status.hidden = !message;
      status.classList.toggle('is-done', state === 'done');
      status.classList.toggle('has-error', state === 'error');
      if (text) text.textContent = message;
      if (value) value.textContent = percent > 0 ? `${Math.min(100, Math.round(percent))}%` : '';
    };
    const driveProgress = ({ message, percent }) => setDriveOperation(message, percent, percent >= 100 ? 'done' : 'busy');

    // ── Google Drive 設定儲存 ──
    document.getElementById('gd-save-cfg-btn')?.addEventListener('click', () => {
      const cid = document.getElementById('gd-client-id-input').value.trim();
      const fid = document.getElementById('gd-folder-id-input').value.trim();
      DB.setGDriveClientId(cid);
      DB.setGDriveFolderId(fid);
      showToast('✓ Google Drive 設定已儲存');
      // If signed in with old token, sign out since client ID may have changed
      if (GDrive.hasRememberedSession()) { GDrive.signOut(); this.render(container); }
    });

    // ── Google 登入 ──
    document.getElementById('gd-signin-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const original = btn.innerHTML;
      btn.disabled = true; btn.textContent = '正在開啟 Google 登入…';
      try {
        await GDrive.signIn();
        showToast('✓ Google 登入成功，雲端資料將在背景同步', 3000);
        GDrive.scheduleStudyStreakSync(250);
        this.render(container);
      } catch(err) {
        let msg = '登入失敗，請稍後再試';
        if (err.message === 'NO_CLIENT_ID')    msg = '請先填入並儲存 OAuth Client ID';
        if (['GIS_LOAD_FAILED', 'GIS_LOAD_TIMEOUT'].includes(err.message)) msg = 'Google 登入元件載入失敗，請確認網路連線';
        if (['popup_closed_by_user', 'popup_closed'].includes(err.message)) msg = '登入視窗已關閉';
        if (err.message === 'popup_failed_to_open') msg = '登入視窗被阻擋，請由設定頁重新點擊登入';
        if (err.message === 'AUTH_TIMEOUT') msg = 'Google 登入逾時，請確認網路後重試';
        if (err.message === 'access_denied')   msg = '授權被拒絕，請確認 Client ID 設定';
        showToast(msg, 3500);
        btn.disabled = false; btn.innerHTML = original;
      }
    });

    document.getElementById('gd-streak-sync-btn')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = '同步中…';
      try {
        setDriveOperation('正在同步練習天數…', 10);
        const result = await GDrive.syncStudyStreak({ interactive: true, onProgress: driveProgress });
        showToast(`✓ 練習天數已同步，共 ${result.summary.totalDays} 天`, 3000);
        this.render(container);
      } catch (error) {
        StudyStreak.markPending();
        setDriveOperation('練習天數同步失敗', 0, 'error');
        showToast('練習天數同步失敗：' + error.message, 3500);
        button.disabled = false;
        button.textContent = '立即同步';
      }
    });

    // ── Google 登出 ──
    document.getElementById('gd-signout-btn')?.addEventListener('click', () => {
      GDrive.signOut();
      showToast('已登出 Google');
      this.render(container);
    });

    // ── 上傳備份 ──
    document.getElementById('gd-upload-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('gd-upload-btn');
      const original = btn?.innerHTML || '';
      if (btn) { btn.disabled = true; btn.textContent = '準備備份…'; }
      setDriveOperation('準備備份…', 5);
      try {
        const ts = await GDrive.upload({ interactive: true, onProgress: driveProgress });
        showToast('✓ 備份已上傳至 Google Drive（' + ts + '）');
        this.render(container);
      } catch(err) {
        setDriveOperation(err.message === 'DRIVE_TIMEOUT' ? 'Google Drive 連線逾時' : '備份上傳失敗', 0, 'error');
        if (err.message === 'NOT_SIGNED_IN')  showToast('請先登入 Google', 3000);
        else if (err.message === 'TOKEN_EXPIRED') { showToast('需要 Google 重新確認授權，請再按一次操作', 3500); this.render(container); }
        else if (err.message === 'DRIVE_TIMEOUT') showToast('Google Drive 上傳逾時，請確認網路後重試', 3500);
        else showToast('上傳失敗：' + err.message, 3000);
      }
      if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = original; }
    });

    // ── 還原備份（選擇 10 個檔案之一） ──
    document.getElementById('gd-download-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('gd-download-btn');
      const original = btn?.innerHTML || '';
      if (btn) { btn.disabled = true; btn.textContent = '讀取清單…'; }
      setDriveOperation('正在讀取雲端備份清單…', 10);
      try {
        const files = await GDrive.listBackups({ interactive: true, onProgress: driveProgress });
        if (!files.length) { showToast('雲端尚無備份，請先上傳', 3000); if (btn) btn.disabled=false; return; }
        const rows = files.map((f, i) => {
          const ts  = f.createdTime ? new Date(f.createdTime).toLocaleString('zh-TW') : '—';
          const tag = i === 0 ? '<span style="font-size:10px;font-weight:800;color:var(--primary);background:color-mix(in srgb,var(--primary) 12%,transparent);padding:1px 6px;border-radius:10px;margin-left:6px">最新</span>' : '';
          let meta = '';
          try {
            const sm = JSON.parse(f.description || '{}');
            const parts = [];
            if (sm.words     != null) parts.push('單字 ' + sm.words + ' 個');
            if (sm.sentences != null) parts.push('例句 ' + sm.sentences + ' 筆');
            if (sm.stats     != null) parts.push('統計 ' + sm.stats + ' 筆');
            if (sm.essay     != null) parts.push('文章 ' + sm.essay + ' 篇');
            if (sm.studyDays != null) parts.push('練習天數 ' + sm.studyDays + ' 天');
            meta = parts.join('・');
          } catch {}
          return `<button class="fb-slot-btn" data-fid="${f.id}" style="width:100%;text-align:left;padding:10px 12px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg);cursor:pointer;margin-bottom:6px">
            <div style="font-weight:700;font-size:13px;color:var(--text-primary)">${escapeHTML(ts)}${tag}</div>
            ${meta ? '<div style="font-size:12px;color:var(--primary);margin-top:2px">' + escapeHTML(meta) + '</div>' : ''}
          </button>`;
        }).join('');
        Modal.show(`<div class="modal-handle"></div>
          <div class="modal-title">選擇備份版本</div>
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">由新到舊，最多顯示 10 份。</p>
          <div id="gd-slot-list">${rows}</div>
          <button class="modal-btn-cancel" id="gd-dl-cancel" style="width:100%;margin-top:4px">取消</button>`);
        document.getElementById('gd-dl-cancel').addEventListener('click', () => Modal.hide());
        document.querySelectorAll('.fb-slot-btn').forEach(b => {
          b.addEventListener('click', async () => {
            const fileId = b.dataset.fid;
            document.querySelectorAll('.fb-slot-btn').forEach(x => x.disabled = true);
            const originalRow = b.innerHTML;
            b.textContent = '正在下載此備份…';
            try {
              const data = await GDrive.downloadFile(fileId, { interactive: true, onProgress: driveProgress });
              Modal.show(`<div class="modal-handle"></div>
                <div class="modal-title">套用備份</div>
                <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">
                  單字 ${(data.words||[]).length} 個・統計 ${(data.history||[]).length} 筆・練習天數 ${Array.isArray(data.studyDays) ? data.studyDays.length + ' 天' : '舊版自動換算'}<br>
                  備份時間：${data.updatedAt ? new Date(data.updatedAt).toLocaleString('zh-TW') : '—'}
                </p>
                <div style="display:flex;flex-direction:column;gap:8px">
                  <button class="btn-primary" id="gd-dl-overwrite" style="width:100%">覆蓋本機（以此備份為主）</button>
                  <button class="btn-secondary" id="gd-dl-merge" style="width:100%">合併（保留本機 + 備份全部）</button>
                  <button class="modal-btn-cancel" id="gd-dl-cancel2" style="width:100%;margin-top:4px">取消</button>
                </div>`);
              const apply = async (mode) => {
                const buttons = document.querySelectorAll('#gd-dl-overwrite, #gd-dl-merge, #gd-dl-cancel2');
                buttons.forEach(button => { button.disabled = true; });
                const title = document.querySelector('#modal-content .modal-title');
                if (title) title.textContent = '正在還原備份…';
                await new Promise(resolve => requestAnimationFrame(() => resolve()));
                GDrive.applyDownload(data, mode);
                await AppStorage.flush();
                Modal.hide();
                showToast('✓ 備份已還原至本機');
                this.render(container);
              };
              document.getElementById('gd-dl-overwrite').addEventListener('click', () => apply('overwrite'));
              document.getElementById('gd-dl-merge').addEventListener('click',     () => apply('merge'));
              document.getElementById('gd-dl-cancel2').addEventListener('click',   () => Modal.hide());
            } catch(err) {
              b.innerHTML = originalRow;
              if (err.message === 'TOKEN_EXPIRED') { Modal.hide(); showToast('需要 Google 重新確認授權，請再按一次操作', 3500); this.render(container); }
              else if (err.message === 'DRIVE_TIMEOUT') { showToast('Google Drive 下載逾時，請確認網路後重試', 3500); Modal.hide(); }
              else { showToast('下載失敗：' + err.message, 3000); Modal.hide(); }
            }
          });
        });
      } catch(err) {
        setDriveOperation(err.message === 'DRIVE_TIMEOUT' ? 'Google Drive 連線逾時' : '備份清單讀取失敗', 0, 'error');
        if (err.message === 'NOT_SIGNED_IN')   showToast('請先登入 Google');
        else if (err.message === 'TOKEN_EXPIRED') { showToast('需要 Google 重新確認授權，請再按一次操作', 3500); this.render(container); }
        else if (err.message === 'DRIVE_TIMEOUT') showToast('Google Drive 讀取逾時，請確認網路後重試', 3500);
        else showToast('讀取失敗：' + err.message, 3000);
      }
      if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = original; }
    });

    // ── 自動同步開關 ──
    document.getElementById('gd-auto-sync')?.addEventListener('change', (e) => {
      DB.setGDriveAutoSync(e.target.checked);
      showToast(e.target.checked ? '✓ 已開啟自動同步：雲端資料較多時會自動還原' : '已關閉自動同步');
    });

    // ── 本機復原點（雲端覆寫前自動建立，最多保留 5 份） ──
    document.getElementById('local-recovery-btn')?.addEventListener('click', async () => {
      const snapshots = await AppStorage.listRecoverySnapshots();
      if (!snapshots.length) { showToast('目前尚無本機復原點'); return; }
      const rows = snapshots.map((item, index) => {
        const counts = BackupSchema.counts(item.payload || {});
        const when = item.createdAt ? new Date(item.createdAt).toLocaleString('zh-TW') : '—';
        return `<button class="local-recovery-item" data-snapshot-id="${escapeAttr(item.id)}">
          <strong>${escapeHTML(when)}${index === 0 ? '（最新）' : ''}</strong>
          <span>${escapeHTML(item.reason || 'restore')}・單字 ${counts.words}・例句 ${counts.examples}・練習 ${counts.practice}</span>
        </button>`;
      }).join('');
      Modal.show(`<div class="modal-handle"></div><div class="modal-title">本機復原點</div>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">雲端覆寫前會自動建立，最多保留 5 份。</p>
        <div class="local-recovery-list">${rows}</div>
        <button class="modal-btn-cancel" id="recovery-close" style="width:100%;margin-top:10px">取消</button>`);
      document.getElementById('recovery-close')?.addEventListener('click', () => Modal.hide());
      document.querySelectorAll('.local-recovery-item').forEach(button => {
        button.addEventListener('click', () => {
          const item = snapshots.find(snapshot => snapshot.id === button.dataset.snapshotId);
          if (!item) return;
          GDrive.applyDownload(item.payload, 'overwrite');
          Modal.hide();
          showToast('✓ 已還原本機復原點');
          this.render(container);
        });
      });
    });

    // ── 檢查更新 ──
    document.getElementById('check-update-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('check-update-btn');
      const status = document.getElementById('update-status');
      const latest = document.getElementById('latest-version-value');
      const lastCheck = document.getElementById('version-last-check');
      if (!btn || !status) return;
      btn.disabled = true;
      status.textContent = '檢查中…';
      try {
        const result = await AppUpdater.check({ autoApply: false });
        if (latest) latest.textContent = result.remoteDisplay;
        if (lastCheck) lastCheck.textContent = '最後檢查：' + new Date(result.checkedAt).toLocaleString('zh-TW');
        if (!result.hasUpdate) {
          status.textContent = '✓ 已是最新版本（' + APP_DISPLAY_VERSION + '）';
        } else {
          status.innerHTML = '發現新版本：<strong>' + escapeHTML(result.remoteDisplay) + '</strong>　<button id="do-update-btn" class="inline-update-btn">立即更新</button>';
          document.getElementById('do-update-btn')?.addEventListener('click', async () => {
            status.textContent = '更新中，完成後將自動重新載入…';
            await AppUpdater.applyUpdate();
          });
        }
      } catch (error) {
        status.textContent = '檢查失敗，請確認網路連線';
      } finally {
        btn.disabled = false;
      }
    });
  }
};
// ===========================
// INIT
// ===========================
document.addEventListener('DOMContentLoaded', async () => {
  await AppStorage.init();
  StudyStreak.migrateFromHistories(getStudyHistorySources(), { markPending: true });
  // Service Worker registration may touch the network on iOS. It must not delay
  // the first render or make app entry look like it is waiting for Google login.
  void AppUpdater.register();

  // Keep the device subscription, time zone and next trigger in sync whenever
  // the PWA is opened. Permission is requested only from the Settings button.
  setTimeout(() => { void DailyReminder.reconcile(); }, 1800);
  try { await navigator.clearAppBadge?.(); } catch {}

  const offlineBanner = document.getElementById('offline-banner');
  const updateNetworkState = () => {
    if (!offlineBanner) return;
    offlineBanner.hidden = navigator.onLine;
    document.documentElement.classList.toggle('is-offline', !navigator.onLine);
  };
  window.addEventListener('online', () => {
    updateNetworkState();
    GDrive.scheduleStudyStreakSync(150);
  });
  window.addEventListener('offline', updateNetworkState);
  updateNetworkState();

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.view;
      Router.navigate(target, target === 'practice' ? { restoreLast: true } : {});
    });
  });

  // Google authorization and Drive comparison are deliberately deferred until
  // after the first screen is painted. Network latency must never block app entry.
  const runCloudStartup = async () => {
    try {
      const restored = await GDrive.tryRestoreToken();
      if (restored && DB.getGDriveAutoSync()) {
        showToast('☁️ 正在背景檢查雲端備份…', 1800);
        try {
          const syncResult = await GDrive.autoRestoreIfCloudHasMore();
          if (syncResult.status === 'restored') {
            showToast('✓ 已自動同步雲端最新備份', 2800);
            if (Router.currentView === 'home' || Router.currentView === 'settings') Router._doNavigate(Router.currentView);
          } else if (syncResult.status === 'conflict') {
            console.warn('[GDrive] Auto-sync conflict detected.', syncResult);
            showToast('雲端與本機資料各有差異，為保護資料未自動覆寫', 3800);
          } else if (syncResult.status === 'same') {
            console.info('[GDrive] Local and cloud backup are identical.');
          } else if (syncResult.status === 'safety_blocked') {
            showToast('本機復原點無法使用，為保護資料未自動覆寫', 3600);
          } else if (syncResult.status === 'skipped') {
            console.info('[GDrive] Auto-sync skipped. Local:', GDrive._formatCounts(syncResult.localCounts), 'Cloud:', GDrive._formatCounts(syncResult.cloudCounts));
          }
        } catch (error) {
          console.warn('[GDrive] Background auto-sync skipped:', error.message);
        }
      }
      if (restored) GDrive.scheduleStudyStreakSync(250);
    } catch (error) {
      console.warn('[GDrive] Background login restore skipped:', error.message);
    }
  };

  // ── Global quick-scroll FABs (all pages except active spelling / essay; bottom button is Settings + Reading quiz) ──
  const _backTopBtn = document.getElementById('global-back-top');
  const _goBottomBtn = document.getElementById('global-go-bottom');
  const _scroller   = document.getElementById('view-container');
  if (_scroller) {
    const updateScrollFabs = () => {
      const inQuiz  = !!document.getElementById('letter-wrap');
      const inEssay = !!document.querySelector('.essay-textarea');
      const inReading = !!document.querySelector('.reading-quiz-shell');
      const blocked = inQuiz || inEssay;
      const maxScroll = Math.max(0, _scroller.scrollHeight - _scroller.clientHeight);
      const nearBottom = (maxScroll - _scroller.scrollTop) < 220;
      if (_backTopBtn) {
        _backTopBtn.style.display = (!blocked && _scroller.scrollTop > 200) ? 'flex' : 'none';
      }
      if (_goBottomBtn) {
        _goBottomBtn.style.display = (!blocked && (Router.currentView === 'settings' || inReading) && maxScroll > 260 && !nearBottom) ? 'flex' : 'none';
      }
    };
    window.updateScrollFabs = updateScrollFabs;
    let _ticking = false;
    _scroller.addEventListener('scroll', () => {
      if (_ticking) return;
      _ticking = true;
      requestAnimationFrame(() => {
        updateScrollFabs();
        _ticking = false;
      });
    }, { passive: true });
    _backTopBtn?.addEventListener('click', () => {
      _scroller.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(updateScrollFabs, 320);
    });
    _goBottomBtn?.addEventListener('click', () => {
      _scroller.scrollTo({ top: _scroller.scrollHeight, behavior: 'smooth' });
      setTimeout(updateScrollFabs, 320);
    });
  }

  Router._doNavigate('home');
  GDrive.preload();
  setTimeout(() => { void runCloudStartup(); }, 350);

  // Check during idle time and never install/reload while an exercise is active.
  const checkForStartupUpdate = async () => {
    if (Router.quizActive || Router.essayActive) return;
    try {
      const result = await AppUpdater.check({ autoApply: false });
      if (result.hasUpdate) {
        if (Router.quizActive || Router.essayActive) {
          showToast('已發現新版本，將於下次開啟時更新', 2800);
          return;
        }
        showToast('發現新版本 ' + result.remoteDisplay + '，正在自動更新…', 3200);
        await AppUpdater.applyUpdate();
      }
    } catch (error) {
      console.info('[VersionManager] Startup update check skipped:', error.message);
    }
  };
  if ('requestIdleCallback' in window) requestIdleCallback(checkForStartupUpdate, { timeout: 4000 });
  else setTimeout(checkForStartupUpdate, 1500);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      Views.practice?._persistPendingSession?.();
      Views.practice?._flushWrongCounts?.();
      AppStorage.flush();
    }
  });
});
