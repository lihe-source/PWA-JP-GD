CREATE TABLE IF NOT EXISTS reminders (
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

CREATE INDEX IF NOT EXISTS idx_reminders_due
  ON reminders (enabled, next_fire_at);
