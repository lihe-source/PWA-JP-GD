import { BackupSchema } from './backup-schema.js?v=V1_5_6';

// Heavy pure work is isolated from the input/drawing thread. No credentials are sent to the worker.
export function executeBackgroundJob(type, payload) {
  if (type === 'prepare-backup') {
    const data = BackupSchema.attach(payload.collections, payload.metadata);
    const serialized = JSON.stringify(data);
    if (new TextEncoder().encode(serialized).byteLength > BackupSchema.maxBytes) throw new Error('BACKUP_TOO_LARGE');
    return { data, serialized };
  }
  if (type === 'parse-backup') {
    if (new TextEncoder().encode(payload.raw).byteLength > BackupSchema.maxBytes) throw new Error('BACKUP_TOO_LARGE');
    let data;
    try { data = JSON.parse(payload.raw.replace(/^\uFEFF/, '')); }
    catch { throw new Error('BACKUP_INVALID_JSON'); }
    const validation = BackupSchema.validate(data);
    if (!validation.valid) throw new Error('BACKUP_INVALID_' + validation.reason);
    return data;
  }
  if (type === 'validate-backup') return BackupSchema.validate(payload);
  if (type === 'compare-backups') return BackupSchema.compare(payload.local, payload.cloud);
  throw new Error('UNKNOWN_BACKGROUND_JOB');
}

export class BackgroundJobRunner {
  constructor({ workerFactory, timeoutMs = 45000 } = {}) {
    this._customFactory = !!workerFactory;
    this.workerFactory = workerFactory || (() => new Worker(new URL('./data-worker.js?v=V1_5_6', import.meta.url), { type: 'module' }));
    this.timeoutMs = timeoutMs;
    this.active = new Set();
  }
  get busy() { return this.active.size > 0; }
  async run(type, payload, { signal, onStage } = {}) {
    if (signal?.aborted) throw new Error('OPERATION_CANCELLED');
    onStage?.(type === 'prepare-backup' ? '整理並驗證備份…' : '驗證備份資料…');
    // Let operation status paint before cloning input data to the worker.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (signal?.aborted) throw new Error('OPERATION_CANCELLED');
    if (typeof Worker === 'undefined' && !this._customFactory) return executeBackgroundJob(type, payload);
    let worker;
    try { worker = this.workerFactory(); }
    catch { return executeBackgroundJob(type, payload); }
    this.active.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        worker.terminate(); this.active.delete(worker);
        error ? reject(error) : resolve(result);
      };
      const cancel = () => finish(new Error('OPERATION_CANCELLED'));
      const timer = setTimeout(() => finish(new Error('BACKGROUND_JOB_TIMEOUT')), this.timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      worker.onmessage = event => event.data?.ok
        ? finish(null, event.data.result) : finish(new Error(event.data?.error || 'BACKGROUND_JOB_FAILED'));
      worker.onerror = () => finish(new Error('BACKGROUND_JOB_FAILED'));
      try { worker.postMessage({ type, payload }); } catch (error) { finish(error); }
    });
  }
}

export const BackgroundJobs = new BackgroundJobRunner();
