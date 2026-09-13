// Coordinates foreground work and update activation across this app's tabs.
export class TaskManager {
  constructor() {
    this.active = new Map();
    this.listeners = new Set();
    this.remote = new Map();
    this.exclusiveKey = null;
    this.id = globalThis.crypto?.randomUUID?.() || String(Math.random());
    if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('vocabulary-v7-tasks');
      this.channel.onmessage = ({data}) => {
        if (data?.id !== this.id) this.remote.set(data.id, {busy: !!data.busy, time: Date.now()});
      };
      this.timer = setInterval(() => this._emit(), 10000);
      window.addEventListener('pagehide', () => this.channel.postMessage({id:this.id,busy:false}));
    }
  }
  get busy() {
    return this.active.size > 0 || [...this.remote.values()].some(v => v.busy && Date.now()-v.time < 30000);
  }
  _emit() {
    this.channel?.postMessage({id:this.id,busy:this.active.size>0});
    for (const listener of this.listeners) listener(this);
  }
  start(label, {exclusive = false} = {}) {
    const remoteBusy = [...this.remote.values()].some(v => v.busy && Date.now()-v.time < 30000);
    if ((exclusive && (this.active.size > 0 || remoteBusy)) || this.exclusiveKey) throw new Error('TASK_ALREADY_RUNNING');
    const key = Symbol(label);
    this.active.set(key, label); this._emit();
    if (exclusive) this.exclusiveKey = key;
    let ended = false;
    return () => { if (!ended) { ended=true;this.active.delete(key);if(this.exclusiveKey===key)this.exclusiveKey=null;this._emit(); } };
  }
  async run(label, fn, options) {
    const end = this.start(label, options);
    try { return await fn(); } finally { end(); }
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
export const Tasks = new TaskManager();
