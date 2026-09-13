// Public configuration for the daily Web Push reminder.
// After deploying worker.js, replace apiBaseUrl with your workers.dev URL.
// Never place the VAPID private key or Cloudflare API token in this file.
export const PUSH_CONFIG = Object.freeze({
  apiBaseUrl: 'https://vocabulary-daily-reminder.rexchre.workers.dev',
  defaultTime: '22:00',
  defaultTitle: '英文單字複習時間到了',
  defaultBody: '每天複習一點點，保持英文學習節奏！',
  requestTimeoutMs: 15000
});
