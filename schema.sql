-- 日文版使用獨立資料表。即使與英文版共用同一個 D1 Database，
-- 兩個 Worker 也不會讀取或重複傳送彼此的提醒。
CREATE TABLE IF NOT EXISTS japanese_reminders (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  reminder_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_fire_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_japanese_reminders_due
  ON japanese_reminders (enabled, next_fire_at);

-- 提醒訂閱對應的匿名裝置範圍；隨機原值只存在該裝置，資料庫不保存 Email。
CREATE TABLE IF NOT EXISTS japanese_reminder_scopes (
  reminder_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  scheduled_for INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_japanese_reminder_scopes_scope
  ON japanese_reminder_scopes (scope_key);

-- 僅保留「哪一天已完成練習」所需的最少資訊，供排程發送前判斷。
CREATE TABLE IF NOT EXISTS japanese_practice_days (
  scope_key TEXT NOT NULL,
  practice_date TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  activity_type TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_key, practice_date)
);

CREATE INDEX IF NOT EXISTS idx_japanese_practice_days_updated
  ON japanese_practice_days (updated_at);
