import express from 'express'
import multer from 'multer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { all, get, run, allSettings, setSetting, UPLOAD_DIR } from './db.js'
import { checkPassword, issueToken, requireAuth } from './auth.js'
import { dashboard, leaderboard } from './stats.js'
import { balance, confirmPayment, failPayment } from './payments.js'
import { createSession, listSessions, reconnectSession, terminateSession } from './whatsapp/manager.js'

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).slice(0, 10)),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
})

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const bad = (res, msg) => res.status(400).json({ error: msg })
const rmFile = (name) => name && fs.rmSync(path.join(UPLOAD_DIR, name), { force: true })

export const publicRouter = express.Router()
export const api = express.Router()

/* ---------- auth + payment webhooks (no token) ---------- */
publicRouter.post('/login', (req, res) => {
  if (!checkPassword(req.body?.password)) return res.status(401).json({ error: 'Wrong password' })
  res.json({ token: issueToken() })
})

publicRouter.post('/payments/webhook/marzpay', wrap(async (req, res) => {
  const secret = process.env.MARZPAY_WEBHOOK_SECRET
  if (!secret) {
    console.error('[marzpay] webhook rejected: MARZPAY_WEBHOOK_SECRET is not set')
    return res.sendStatus(503)
  }
  // Signature header looks like "t=<unix seconds>,v1=<hex hmac of "<t>.<raw body>">"
  const header = String(req.headers['x-marzpay-signature'] || '')
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=')))
  const ts = String(req.headers['x-marzpay-timestamp'] || parts.t || '')
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${req.rawBody || ''}`).digest('hex')
  const given = String(parts.v1 || '')
  const okSig = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 600
  if (!okSig || !fresh) return res.sendStatus(401)

  const { event_type: event, transaction: t = {} } = req.body || {}
  const tx = t.reference && get("SELECT * FROM transactions WHERE reference = ? AND type = 'payment'", t.reference)
  if (tx) {
    if (event === 'collection.completed') {
      const paid = Number(t.amount?.raw ?? tx.amount)
      if (paid + 0.01 < tx.amount) console.error(`[marzpay] ${t.reference}: paid ${paid} but expected ${tx.amount}; left pending for manual review`)
      else await confirmPayment(t.reference)
    } else if (event === 'collection.failed') {
      await failPayment(t.reference, 'Payment declined or timed out')
    }
  }
  res.sendStatus(200)
}))

api.use(requireAuth)

/* ---------- dashboard / settings ---------- */
api.get('/dashboard', (_req, res) => res.json(dashboard()))
api.get('/settings', (_req, res) => res.json(allSettings()))
api.put('/settings', (req, res) => {
  const b = req.body || {}
  if (b.premium_price !== undefined && !(Number.isInteger(Number(b.premium_price)) && Number(b.premium_price) >= 500 && Number(b.premium_price) <= 10000000)) return bad(res, 'Premium price must be a whole number between 500 and 10,000,000 (MarzPay limits)')
  if (b.trial_limit !== undefined && !(Number.isInteger(Number(b.trial_limit)) && Number(b.trial_limit) >= 0)) return bad(res, 'Trial limit must be a whole number')
  for (const k of ['premium_price', 'currency', 'trial_limit', 'bot_name', 'welcome_message']) if (b[k] !== undefined) setSetting(k, b[k])
  res.json(allSettings())
})

/* ---------- WhatsApp ---------- */
api.get('/whatsapp/sessions', wrap(async (_req, res) => res.json(await listSessions())))
api.post('/whatsapp/sessions', wrap(async (req, res) => {
  const { label, phone } = req.body || {}
  const id = await createSession(String(label || '').trim(), phone ? String(phone) : undefined)
  res.status(201).json({ id })
}))
api.post('/whatsapp/sessions/:id/reconnect', wrap(async (req, res) => {
  (await reconnectSession(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })
}))
api.delete('/whatsapp/sessions/:id', wrap(async (req, res) => {
  await terminateSession(req.params.id)
  res.json({ ok: true })
}))

/* ---------- funds ---------- */
api.get('/funds', (req, res) => {
  const { type, status } = req.query
  const where = [], params = []
  if (type) { where.push('t.type = ?'); params.push(type) }
  if (status) { where.push('t.status = ?'); params.push(status) }
  const transactions = all(
    `SELECT t.*, s.name student_name FROM transactions t LEFT JOIN students s ON s.id = t.student_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.id DESC LIMIT 500`, ...params)
  const counts = get(`SELECT
      SUM(type='payment' AND status='success') payments,
      SUM(type='withdrawal') withdrawals,
      SUM(status='pending') pending
    FROM transactions`)
  res.json({ ...balance(), counts, transactions })
})

api.post('/funds/withdraw', (req, res) => {
  const amount = Number(req.body?.amount)
  const phone = String(req.body?.phone || '').trim()
  const method = String(req.body?.method || 'mobile_money')
  if (!(amount > 0)) return bad(res, 'Enter a valid amount')
  if (!phone) return bad(res, 'Enter the account or mobile money number to pay out to')
  if (amount > balance().available) return bad(res, 'Amount is more than your available balance')
  const reference = `WD-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  run(`INSERT INTO transactions(phone, type, amount, currency, status, method, reference, note)
       VALUES (?, 'withdrawal', ?, ?, 'pending', ?, ?, ?)`, phone, amount, allSettings().currency, method, reference, String(req.body?.note || ''))
  res.status(201).json({ reference, ...balance() })
})

// Mark a pending withdrawal as paid out (or failed), or confirm a pending payment by hand.
api.post('/transactions/:id/resolve', wrap(async (req, res) => {
  const tx = get('SELECT * FROM transactions WHERE id = ?', Number(req.params.id))
  if (!tx) return res.status(404).json({ error: 'Not found' })
  if (tx.status !== 'pending') return bad(res, 'Transaction is not pending')
  const outcome = req.body?.outcome === 'failed' ? 'failed' : 'success'
  if (tx.type === 'payment' && outcome === 'success') await confirmPayment(tx.reference)
  else run('UPDATE transactions SET status = ? WHERE id = ?', outcome, tx.id)
  res.json({ ok: true, ...balance() })
}))

/* ---------- students ---------- */
api.get('/students', (_req, res) => {
  const board = Object.fromEntries(leaderboard().map((r) => [r.id, r]))
  res.json(all('SELECT id, phone, name, premium, trials_used, created_at, last_seen FROM students ORDER BY id DESC LIMIT 500')
    .map((s) => ({ ...s, rank: board[s.id]?.rank ?? null, attempted: board[s.id]?.attempted ?? 0, correct: board[s.id]?.correct ?? 0, accuracy: board[s.id]?.accuracy ?? 0 })))
})

/* ---------- question bank ---------- */
api.get('/courses', (_req, res) => {
  res.json(all(`SELECT c.*,
      (SELECT COUNT(*) FROM topics t WHERE t.course_id = c.id) topic_count,
      (SELECT COUNT(*) FROM questions q JOIN topics t ON t.id = q.topic_id WHERE t.course_id = c.id) question_count
    FROM courses c ORDER BY c.name`))
})
api.post('/courses', (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Course name is required')
  const r = run('INSERT INTO courses(name, description) VALUES (?, ?)', name, String(req.body?.description || '').trim())
  res.status(201).json(get('SELECT * FROM courses WHERE id = ?', r.lastInsertRowid))
})
api.put('/courses/:id', (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Course name is required')
  run('UPDATE courses SET name = ?, description = ? WHERE id = ?', name, String(req.body?.description || '').trim(), Number(req.params.id))
  res.json(get('SELECT * FROM courses WHERE id = ?', Number(req.params.id)))
})
api.delete('/courses/:id', (req, res) => {
  const files = all('SELECT q.document_file f FROM questions q JOIN topics t ON t.id = q.topic_id WHERE t.course_id = ?', Number(req.params.id))
  run('DELETE FROM courses WHERE id = ?', Number(req.params.id))
  files.forEach((r) => rmFile(r.f))
  res.json({ ok: true })
})

api.get('/courses/:id/topics', (req, res) => {
  res.json(all('SELECT t.*, (SELECT COUNT(*) FROM questions q WHERE q.topic_id = t.id) question_count FROM topics t WHERE t.course_id = ? ORDER BY t.name', Number(req.params.id)))
})
api.post('/courses/:id/topics', (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Sub topic name is required')
  if (!get('SELECT 1 x FROM courses WHERE id = ?', Number(req.params.id))) return res.status(404).json({ error: 'Course not found' })
  const r = run('INSERT INTO topics(course_id, name) VALUES (?, ?)', Number(req.params.id), name)
  res.status(201).json(get('SELECT * FROM topics WHERE id = ?', r.lastInsertRowid))
})
api.put('/topics/:id', (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Sub topic name is required')
  run('UPDATE topics SET name = ? WHERE id = ?', name, Number(req.params.id))
  res.json(get('SELECT * FROM topics WHERE id = ?', Number(req.params.id)))
})
api.delete('/topics/:id', (req, res) => {
  const files = all('SELECT document_file f FROM questions WHERE topic_id = ?', Number(req.params.id))
  run('DELETE FROM topics WHERE id = ?', Number(req.params.id))
  files.forEach((r) => rmFile(r.f))
  res.json({ ok: true })
})

const shape = (q) => ({ ...q, options: JSON.parse(q.options), document_url: q.document_file ? `/uploads/${q.document_file}` : null })

api.get('/topics/:id/questions', (req, res) => {
  res.json(all('SELECT * FROM questions WHERE topic_id = ? ORDER BY id', Number(req.params.id)).map(shape))
})

function readQuestion(req) {
  const text = String(req.body?.text || '').trim()
  let options
  try { options = JSON.parse(req.body?.options || '[]') } catch { options = [] }
  options = (Array.isArray(options) ? options : []).map((o) => String(o).trim()).filter(Boolean)
  const correct = Number(req.body?.correct)
  if (!text) return { error: 'Question text is required' }
  if (options.length < 2) return { error: 'Add at least 2 answer options' }
  if (options.length > 3) return { error: 'A question can have at most 3 options' }
  if (options.some((o) => o.length > 200)) return { error: 'Options must be 200 characters or fewer' }
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) return { error: 'Mark the correct answer' }
  return { text, options, correct, explanation: String(req.body?.explanation || '').trim() }
}

api.post('/topics/:id/questions', upload.single('document'), (req, res) => {
  const q = readQuestion(req)
  if (q.error) { if (req.file) rmFile(req.file.filename); return bad(res, q.error) }
  if (!get('SELECT 1 x FROM topics WHERE id = ?', Number(req.params.id))) { if (req.file) rmFile(req.file.filename); return res.status(404).json({ error: 'Sub topic not found' }) }
  const f = req.file
  const r = run(`INSERT INTO questions(topic_id, text, options, correct, explanation, document_file, document_name, document_mime)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, Number(req.params.id), q.text, JSON.stringify(q.options), q.correct, q.explanation, f?.filename ?? null, f?.originalname ?? null, f?.mimetype ?? null)
  res.status(201).json(shape(get('SELECT * FROM questions WHERE id = ?', r.lastInsertRowid)))
})

api.put('/questions/:id', upload.single('document'), (req, res) => {
  const id = Number(req.params.id)
  const existing = get('SELECT * FROM questions WHERE id = ?', id)
  const q = readQuestion(req)
  if (!existing) { if (req.file) rmFile(req.file.filename); return res.status(404).json({ error: 'Not found' }) }
  if (q.error) { if (req.file) rmFile(req.file.filename); return bad(res, q.error) }
  let { document_file: file, document_name: name, document_mime: mime } = existing
  if (req.file || req.body?.remove_document === 'true') {
    rmFile(file)
    file = name = mime = null
  }
  if (req.file) ({ filename: file, originalname: name, mimetype: mime } = req.file)
  run('UPDATE questions SET text=?, options=?, correct=?, explanation=?, document_file=?, document_name=?, document_mime=? WHERE id=?',
    q.text, JSON.stringify(q.options), q.correct, q.explanation, file, name, mime, id)
  res.json(shape(get('SELECT * FROM questions WHERE id = ?', id)))
})

api.delete('/questions/:id', (req, res) => {
  const q = get('SELECT document_file FROM questions WHERE id = ?', Number(req.params.id))
  run('DELETE FROM questions WHERE id = ?', Number(req.params.id))
  rmFile(q?.document_file)
  res.json({ ok: true })
})
