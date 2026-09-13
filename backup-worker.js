import { BackupSchema } from './backup-schema.js?v=V7_4_2';

self.onmessage = ({data}) => {
  const {id, action, payload} = data || {};
  try {
    if (action === 'prepare') {
      const attached = BackupSchema.attach(payload.collections, payload.metadata);
      self.postMessage({id, ok:true, result:{payload:attached, json:JSON.stringify(attached)}});
      return;
    }
    if (action === 'parse') {
      const parsed = JSON.parse(payload.text);
      const validation = BackupSchema.validate(parsed);
      if (!validation.valid) throw new Error('BACKUP_INVALID_' + validation.reason);
      self.postMessage({id, ok:true, result:parsed});
      return;
    }
    if (action === 'validate') {
      const validation = BackupSchema.validate(payload);
      if (!validation.valid) throw new Error('BACKUP_INVALID_' + validation.reason);
      self.postMessage({id, ok:true, result:validation});
      return;
    }
    throw new Error('WORKER_ACTION_INVALID');
  } catch (error) {
    self.postMessage({id, ok:false, error:error?.message || 'WORKER_ERROR'});
  }
};
