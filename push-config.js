// Public configuration for the daily Web Push reminder.
// After deploying worker.js, replace apiBaseUrl with your workers.dev URL.
// Never place the VAPID private key or Cloudflare API token in this file.
export const PUSH_CONFIG = Object.freeze({
  apiBaseUrl: 'https://japanese-daily-reminder.rexchre.workers.dev',
  defaultTime: '22:00',
  defaultTitle: '日本語練習時間到了',
  defaultBody: '每天複習一點點，保持日文學習節奏！',
  requestTimeoutMs: 15000
});
