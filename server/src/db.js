import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data')
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
export const SESSION_DIR = path.join(DATA_DIR, 'sessions')
for (const d of [DATA_DIR, UPLOAD_DIR, SESSION_DIR]) fs.mkdirSync(d, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'quizbot.db'))
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  options TEXT NOT NULL,            -- JSON array, 2-3 strings
  correct INTEGER NOT NULL,         -- index into options
  explanation TEXT DEFAULT '',
  document_file TEXT,               -- stored file name in uploads/
  document_name TEXT,               -- original file name
  document_mime TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT DEFAULT '',
  jid TEXT,
  session_id TEXT,
  premium INTEGER NOT NULL DEFAULT 0,
  premium_since TEXT,
  trials_used INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  last_seen TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  selected INTEGER NOT NULL,
  is_correct INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  phone TEXT,
  type TEXT NOT NULL,               -- payment | withdrawal
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | success | failed
  method TEXT DEFAULT '',
  reference TEXT UNIQUE,
  provider_ref TEXT,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wa_sessions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'starting',
  created_at TEXT DEFAULT (datetime('now'))
);
`)

export const all = (sql, ...p) => db.prepare(sql).all(...p)
export const get = (sql, ...p) => db.prepare(sql).get(...p)
export const run = (sql, ...p) => db.prepare(sql).run(...p)

const DEFAULTS = {
  premium_price: '5000',
  currency: 'UGX',
  trial_limit: '5',
  bot_name: 'QuizBot',
  welcome_message:
    'Welcome to *{bot}*! 🎓\nPractise past questions, get instant feedback with explanations, and see how you rank against other students.\n\nYou get *{trials} free trial questions*. Pick a course below to begin.',
}
for (const [k, v] of Object.entries(DEFAULTS)) {
  run('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)', k, v)
}

export const getSetting = (k) => get('SELECT value FROM settings WHERE key = ?', k)?.value ?? DEFAULTS[k]
export const setSetting = (k, v) =>
  run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v))
export const allSettings = () => Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]))
