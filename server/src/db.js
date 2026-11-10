import { Pool } from 'pg'
import fs from 'node:fs'
import path from 'node:path'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

pool.on('error', (err) => console.error('[pg] unexpected client error', err))

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data')
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
export const SESSION_DIR = path.join(DATA_DIR, 'sessions')
for (const d of [DATA_DIR, UPLOAD_DIR, SESSION_DIR]) fs.mkdirSync(d, { recursive: true })

export const query = (text, params) => pool.query(text, params)

export const all = async (sql, ...p) => (await query(sql, p)).rows
export const get = async (sql, ...p) => {
  const rows = (await query(sql, p)).rows
  return rows[0] ?? null
}
export const run = async (sql, ...p) => query(sql, p)

const DEFAULTS = {
  premium_price: '5000',
  currency: 'UGX',
  trial_limit: '5',
  bot_name: 'CPA Edge',
  welcome_message:
    'Welcome to *{bot}*! 🎓\nPractise past questions, get instant feedback with explanations, and see how you rank against other students.\n\nYou get *{trials} free trial questions*. Pick a course below to begin.',
}

let cache = null

export const getSetting = async (k) => {
  const s = await allSettings()
  return s[k] ?? DEFAULTS[k]
}

export const setSetting = async (k, v) => {
  await query(
    `INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [k, String(v)],
  )
  cache = null
}

export const allSettings = async () => {
  if (cache) return cache
  const rows = await all('SELECT key, value FROM settings')
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  for (const [k, v] of Object.entries(DEFAULTS)) if (cache[k] === undefined) cache[k] = v
  return cache
}

export const loadSettings = async () => {
  cache = await allSettings()
}

export const endPool = async () => pool.end()
