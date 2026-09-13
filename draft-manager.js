export class DraftManager {
  constructor({storage, delay=350, setTimer=setTimeout, clearTimer=clearTimeout}) {
    this.storage=storage;this.delay=delay;this.setTimer=setTimer;this.clearTimer=clearTimer;
    this.timers=new Map();this.pending=new Map();
  }
  all() { try { return JSON.parse(this.storage.getItem('vocabularyDrafts') || '{}'); } catch { return {}; } }
  get(key) { return this.pending.has(key) ? this.pending.get(key) : (this.all()[key] || ''); }
  save(key,value) {
    this.clearTimer(this.timers.get(key));
    this.pending.set(key,String(value || ''));
    this.timers.set(key,this.setTimer(()=>this.commit(key),this.delay));
  }
  remove(key) { this.save(key,''); }
  commit(key) {
    this.clearTimer(this.timers.get(key));this.timers.delete(key);
    if(!this.pending.has(key))return;
    const value=this.pending.get(key);this.pending.delete(key);
    const drafts=this.all();if(value)drafts[key]=value;else delete drafts[key];
    this.storage.setItem('vocabularyDrafts',JSON.stringify(drafts));
  }
  flush() { for(const key of [...this.pending.keys()])this.commit(key); }
}
