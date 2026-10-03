// Speech is started synchronously in a Start / Next / Replay tap on iOS.
// Loading voices must never move that call outside the browser's user gesture.
export class SpeechManager {
  constructor({ storage, synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, onStatus = () => {} } = {}) {
    this.storage = storage; this._synth = synth; this.Utterance = Utterance; this.onStatus = onStatus;
    this._enabled = true; this._voices = []; this._utter = null; this._sequence = 0; this._timer = null;
    this.lastError = ''; this.state = 'idle'; this._listening = false;
  }
  init() {
    // IndexedDB must be hydrated before this is called.
    this._enabled = this.storage?.getItem('ttsEnabled') !== 'false';
    this._readVoices();
    if (!this._listening && this._synth?.addEventListener) {
      this._synth.addEventListener('voiceschanged', () => this._readVoices());
      this._listening = true;
    }
    return this;
  }
  get enabled() { return this._enabled; }
  set enabled(value) { this._enabled = !!value; this.storage?.setItem('ttsEnabled', this._enabled); }
  _readVoices() { try { this._voices = this._synth?.getVoices() || []; } catch { this._voices = []; } }
  _status(state, error = '') {
    this.state = state; this.lastError = error;
    try { this.onStatus({ state, error }); } catch {}
  }
  cancelPending() { this.stop(); }
  stop() {
    this._sequence++; clearTimeout(this._timer); this._timer = null;
    if (this._utter) this._utter.onstart = this._utter.onend = this._utter.onerror = null;
    this._utter = null;
    try { this._synth?.cancel(); } catch {}
    this._status('idle');
  }
  speak(text, rate = 0.85, { force = false } = {}) {
    if (!text || (!this.enabled && !force)) return false;
    if (!this._synth || !this.Utterance) { this._status('error', '此裝置不支援語音朗讀，可繼續書寫。'); return false; }
    this.stop(); this._readVoices();
    const sequence = this._sequence;
    const utter = new this.Utterance(String(text));
    // Retain the utterance until completion; Safari can otherwise lose callbacks.
    this._utter = utter;
    utter.lang = 'ja-JP'; utter.rate = rate; utter.pitch = 1; utter.volume = 1;
    const voice = this._voices.find(v => /^ja/i.test(v.lang) && /Kyoko|O-ren|Hattori|Google 日本語|Japanese/i.test(v.name)) ||
      this._voices.find(v => /^ja/i.test(v.lang));
    if (voice) utter.voice = voice;
    const current = () => sequence === this._sequence && this._utter === utter;
    const release = () => { clearTimeout(this._timer); this._timer = null; this._utter = null; };
    utter.onstart = () => { if (current()) { clearTimeout(this._timer); this._timer = null; this._status('speaking'); } };
    utter.onend = () => { if (current()) { release(); this._status('idle'); } };
    utter.onerror = event => {
      if (!current()) return;
      release();
      if (['canceled', 'interrupted'].includes(event.error)) this._status('idle');
      else this._status('error', '發音未播放，請按「發音」重播，並確認裝置媒體音量與日文語音。');
    };
    this._status('queued');
    try {
      // Use the system's ja-JP default even when getVoices() is still empty.
      this._synth.speak(utter);
      if (current() && this.state !== 'speaking') this._timer = setTimeout(() => {
        if (!current() || this.state === 'speaking') return;
        this.stop(); this._status('error', '發音尚未啟動，請按「發音」重播。');
      }, 6000);
      return true;
    } catch {
      release(); this._status('error', '發音未啟動，請按「發音」重播。'); return false;
    }
  }
  speakWhenReady(text, rate = 0.85, options = {}) { return this.speak(text, rate, options); }
  speakKana(text, rate = 0.62) { return this.speak(text, rate, { force: true }); }
}
