import { executeBackgroundJob } from './background-jobs.js?v=V1_5_6';
self.onmessage = event => {
  try { self.postMessage({ ok: true, result: executeBackgroundJob(event.data.type, event.data.payload) }); }
  catch (error) { self.postMessage({ ok: false, error: error?.message || 'BACKGROUND_JOB_FAILED' }); }
};
