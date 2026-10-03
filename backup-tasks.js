import { BackupSchema } from './backup-schema.js?v=V1_6_0';

export function runBackupJob(type, payload) {
  if (type === 'build') {
    const data = BackupSchema.attach(payload.collections, payload.metadata);
    const validation = BackupSchema.validate(data);
    if (!validation.valid) throw new Error('BACKUP_INVALID_' + validation.reason);
    return { data, text: JSON.stringify(data), counts: data.collectionCounts };
  }
  if (type === 'parse') {
    if (String(payload).length > 25 * 1024 * 1024) throw new Error('BACKUP_INVALID_BACKUP_TOO_LARGE');
    const data = JSON.parse(String(payload).replace(/^\uFEFF/, ''));
    const validation = BackupSchema.validate(data);
    if (!validation.valid) throw new Error('BACKUP_INVALID_' + validation.reason);
    return data;
  }
  if (type === 'validate') return BackupSchema.validate(payload);
  if (type === 'compare') return BackupSchema.compare(payload.local, payload.remote);
  throw new Error('UNKNOWN_BACKUP_JOB');
}

export class BackupTaskRunner {
  constructor({ WorkerClass = globalThis.Worker } = {}) { this.WorkerClass = WorkerClass; this.worker = null; this.jobs = new Map(); this.id = 0; }
  _start() {
    if (this.worker) return;
    this.worker = new this.WorkerClass(new URL('./backup-tasks.js?v=V1_6_0', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const job = this.jobs.get(data.id); if (!job) return;
      clearTimeout(job.timer); this.jobs.delete(data.id);
      if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
    };
    this.worker.onerror = () => this._fail(new Error('BACKUP_WORKER_FAILED'));
    this.worker.onmessageerror = () => this._fail(new Error('BACKUP_WORKER_FAILED'));
  }
  _fail(error) {
    this.worker?.terminate(); this.worker = null;
    this.jobs.forEach(job => { clearTimeout(job.timer); job.reject(error); }); this.jobs.clear();
  }
  run(type, payload) {
    if (!this.WorkerClass) return new Promise(resolve => setTimeout(resolve, 0)).then(() => runBackupJob(type, payload));
    try { this._start(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => this._fail(new Error('BACKUP_PROCESSING_TIMEOUT')), 30000);
      this.jobs.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, type, payload }); }
      catch (error) { clearTimeout(timer); this.jobs.delete(id); reject(error); }
    });
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = ({ data: { id, type, payload } }) => {
    try { globalThis.postMessage({ id, result: runBackupJob(type, payload) }); }
    catch (error) { globalThis.postMessage({ id, error: error.message || 'BACKUP_PROCESSING_FAILED' }); }
  };
}
