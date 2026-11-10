import express from 'express'
import multer from 'multer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { all, get, run, allSettings, setSetting, getSetting, loadSettings, UPLOAD_DIR } from './db.js'
import { checkPassword, issueToken, requireAuth, requireRole, authenticateAdmin, bootstrapAdmin, hashPassword } from './auth.js'
import { dashboard, leaderboard, studentStats } from './stats.js'
import { balance, confirmPayment, failPayment, confirmWithdrawal, failWithdrawal, initiatePayment, initiateWithdrawal } from './payments.js'
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

/* ---------- bootstrap + auth (no token) ---------- */
publicRouter.post('/login', wrap(async (req, res) => {
  await bootstrapAdmin()
  const email = String(req.body?.email || 'admin@local')
  const password = String(req.body?.password || '')
  const admin = await authenticateAdmin(email, password)
  if (!admin) return res.status(401).json({ error: 'Wrong credentials' })
  res.json({ token: issueToken(admin.id), admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } })
}))

publicRouter.post('/payments/webhook/marzpay', wrap(async (req, res) => {
  const secret = process.env.MARZPAY_WEBHOOK_SECRET
  if (!secret) {
    console.error('[marzpay] webhook rejected: MARZPAY_WEBHOOK_SECRET is not set')
    return res.sendStatus(503)
  }
  const header = String(req.headers['x-marzpay-signature'] || '')
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=')))
  const ts = String(req.headers['x-marzpay-timestamp'] || parts.t || '')
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${req.rawBody || ''}`).digest('hex')
  const given = String(parts.v1 || '')
  const okSig = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 600
  if (!okSig || !fresh) return res.sendStatus(401)

  const { event_type: event, transaction: t = {} } = req.body || {}
  const reference = t.reference
  if (!reference) return res.sendStatus(200)

  const tx = await get('SELECT * FROM transactions WHERE reference = $1', reference)
  if (!tx) return res.sendStatus(200)

  if (tx.type === 'payment') {
    if (event === 'collection.completed') {
      const paid = Number(t.amount?.raw ?? tx.amount)
      if (paid + 0.01 < tx.amount) console.error(`[marzpay] ${reference}: paid ${paid} but expected ${tx.amount}; left pending for manual review`)
      else await confirmPayment(reference)
    } else if (event === 'collection.failed') {
      await failPayment(reference, 'Payment declined or timed out')
    }
  } else if (tx.type === 'withdrawal') {
    if (event === 'disbursement.completed') {
      await confirmWithdrawal(reference)
    } else if (event === 'disbursement.failed' || event === 'disbursement.cancelled') {
      await failWithdrawal(reference, `Disbursement ${event}`)
    }
  }
  res.sendStatus(200)
}))

api.use(requireAuth)

/* ---------- admin management ---------- */
api.get('/admins', wrap(async (_req, res) => {
  const admins = await all(`SELECT a.id, a.email, a.name, a.role, a.active, a.created_at, a.updated_at,
       (SELECT COUNT(*) FROM admin_invites i WHERE i.invited_by_id = a.id) invite_count
     FROM admins a ORDER BY a.created_at DESC`)
  res.json(admins)
}))

api.post('/admins/invite', wrap(async (req, res) => {
  const { email, role = 'admin' } = req.body || {}
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return bad(res, 'Valid email is required')
  if (!['admin', 'owner'].includes(role)) return bad(res, 'Invalid role')
  const existing = await get('SELECT 1 FROM admins WHERE email = $1', String(email))
  if (existing) return bad(res, 'An admin with this email already exists')
  const token = crypto.randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()
  await run(
    `INSERT INTO admin_invites(id, email, token, role, invited_by_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    crypto.randomBytes(8).toString('hex'), String(email), token, role, req.admin.id, expiresAt,
  )
  res.status(201).json({ email, role, token, expiresAt, invitedBy: { name: req.admin.name, email: req.admin.email } })
}))

api.post('/admins/invite/accept', wrap(async (req, res) => {
  const { token, password, name } = req.body || {}
  if (!token || !password || password.length < 8) return bad(res, 'Token and a password (8+ chars) are required')
  const invite = await get('SELECT * FROM admin_invites WHERE token = $1', token)
  if (!invite || invite.accepted) return res.status(400).json({ error: 'Invalid or already used invitation' })
  if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'Invitation has expired' })
  const hash = await hashPassword(String(password))
  await run('BEGIN')
  try {
    await run('INSERT INTO admins(id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)', crypto.randomBytes(8).toString('hex'), invite.email, name || null, invite.role, hash)
    await run('UPDATE admin_invites SET accepted = true WHERE id = $1', invite.id)
    await run('COMMIT')
  } catch (e) {
    await run('ROLLBACK')
    throw e
  }
  res.json({ ok: true })
}))

api.put('/admins/:id', wrap(async (req, res) => {
  const { role, active, name } = req.body || {}
  if (req.params.id === req.admin.id && active === false) return bad(res, 'You cannot deactivate yourself')
  const sets = []
  const params = []
  let i = 1
  if (role !== undefined) { if (!['admin', 'owner'].includes(role)) return bad(res, 'Invalid role'); sets.push(`role = $${i++}`); params.push(role) }
  if (active !== undefined) { sets.push(`active = $${i++}`); params.push(Boolean(active)) }
  if (name !== undefined) { sets.push(`name = $${i++}`); params.push(name) }
  if (sets.length === 0) return bad(res, 'Nothing to update')
  params.push(req.params.id)
  const admin = await get(`UPDATE admins SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, email, name, role, active`, ...params)
  res.json(admin)
}))

api.delete('/admins/:id', wrap(async (req, res) => {
  if (req.params.id === req.admin.id) return bad(res, 'You cannot delete yourself')
  await run('DELETE FROM admins WHERE id = $1', req.params.id)
  res.json({ ok: true })
}))

/* ---------- dashboard / settings ---------- */
api.get('/dashboard', wrap(async (_req, res) => res.json(await dashboard())))
api.get('/settings', wrap(async (_req, res) => res.json(await allSettings())))
api.put('/settings', wrap(async (req, res) => {
  const b = req.body || {}
  if (b.premium_price !== undefined && !(Number.isInteger(Number(b.premium_price)) && Number(b.premium_price) >= 500 && Number(b.premium_price) <= 10000000)) return bad(res, 'Premium price must be a whole number between 500 and 10,000,000 (MarzPay limits)')
  if (b.trial_limit !== undefined && !(Number.isInteger(Number(b.trial_limit)) && Number(b.trial_limit) >= 0)) return bad(res, 'Trial limit must be a whole number')
  for (const k of ['premium_price', 'currency', 'trial_limit', 'bot_name', 'welcome_message']) if (b[k] !== undefined) await setSetting(k, b[k])
  loadSettings()
  res.json(await allSettings())
}))

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
api.get('/funds', wrap(async (req, res) => {
  const { type, status } = req.query
  const where = []
  const params = []
  let i = 1
  if (type) { where.push(`type = $${i++}`); params.push(type) }
  if (status) { where.push(`status = $${i++}`); params.push(status) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [transactions, b] = await Promise.all([
    all(`SELECT t.*, s.name student_name FROM transactions t LEFT JOIN students s ON s.id = t.student_id
      ${whereSql} ORDER BY t.id DESC LIMIT 500`, ...params),
    balance(),
  ])
  res.json({ ...b, transactions })
}))

api.post('/funds/withdraw', wrap(async (req, res) => {
  const amount = Number(req.body?.amount)
  const phone = String(req.body?.phone || '').trim()
  const method = String(req.body?.method || 'mobile_money')
  const note = String(req.body?.note || '')
  if (!(amount > 0)) return bad(res, 'Enter a valid amount')
  if (!phone) return bad(res, 'Enter the mobile money number to pay out to')
  const b = await balance()
  if (amount > b.available) return bad(res, 'Amount is more than your available balance')
  const reference = `WD-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const currency = await getSetting('currency')
  const tx = await get(`INSERT INTO transactions(phone, type, amount, currency, status, method, note, reference, created_by_id)
    VALUES ($1, 'withdrawal', $2, $3, 'pending', $4, $5, $6, $7) RETURNING id`,
    phone, amount, currency, method, note, reference, req.admin.id)
  try {
    const { providerRef } = await initiateWithdrawal({ amount, phone, method, note, createdById: req.admin.id })
    await run('UPDATE transactions SET provider_ref = $1 WHERE id = $2', providerRef, tx.id)
  } catch (err) {
    await run('UPDATE transactions SET status = $1, note = $2 WHERE id = $3', 'failed', String(err.message).slice(0, 200), tx.id)
    throw err
  }
  res.status(201).json({ reference, ...(await balance()) })
}))

api.post('/transactions/:id/resolve', wrap(async (req, res) => {
  const tx = await get('SELECT * FROM transactions WHERE id = $1', req.params.id)
  if (!tx) return res.status(404).json({ error: 'Not found' })
  if (tx.status !== 'pending') return bad(res, 'Transaction is not pending')
  const outcome = req.body?.outcome === 'failed' ? 'failed' : 'success'
  if (tx.type === 'payment' && outcome === 'success') await confirmPayment(tx.reference)
  else if (tx.type === 'withdrawal' && outcome === 'success') await confirmWithdrawal(tx.reference)
  else await run('UPDATE transactions SET status = $1 WHERE id = $2', outcome, tx.id)
  res.json({ ok: true, ...(await balance()) })
}))

/* ---------- students ---------- */
api.get('/students', wrap(async (_req, res) => {
  const board = Object.fromEntries((await leaderboard()).map((r) => [r.id, r]))
  const students = await all('SELECT id, phone, name, premium, trials_used, created_at, last_seen FROM students ORDER BY id DESC LIMIT 500')
  res.json(students.map((s) => ({ ...s, rank: board[s.id]?.rank ?? null, attempted: board[s.id]?.attempted ?? 0, correct: board[s.id]?.correct ?? 0, accuracy: board[s.id]?.accuracy ?? 0 })))
}))

/* ---------- question bank ---------- */
api.get('/courses', wrap(async (_req, res) => {
  const rows = await all(`
    SELECT c.id, c.name, c.description, c.created_at,
      (SELECT COUNT(*) FROM topics t WHERE t.course_id = c.id) topic_count,
      (SELECT COUNT(*) FROM questions q JOIN topics t ON t.id = q.topic_id WHERE t.course_id = c.id) question_count
    FROM courses c ORDER BY c.name`)
  res.json(rows)
}))
api.post('/courses', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Course name is required')
  const c = await get(`INSERT INTO courses(name, description) VALUES ($1, $2) RETURNING *`, name, String(req.body?.description || '').trim())
  res.status(201).json(c)
}))
api.put('/courses/:id', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Course name is required')
  const c = await get(`UPDATE courses SET name = $1, description = $2 WHERE id = $3 RETURNING *`, name, String(req.body?.description || '').trim(), req.params.id)
  res.json(c)
}))
api.delete('/courses/:id', wrap(async (req, res) => {
  const files = await all('SELECT q.document_file f FROM questions q JOIN topics t ON t.id = q.topic_id WHERE t.course_id = $1', req.params.id)
  await run('DELETE FROM courses WHERE id = $1', req.params.id)
  files.forEach((r) => rmFile(r.f))
  res.json({ ok: true })
}))

api.get('/courses/:id/topics', wrap(async (req, res) => {
  const topics = await all(`SELECT t.*, (SELECT COUNT(*) FROM questions q WHERE q.topic_id = t.id) question_count
    FROM topics t WHERE t.course_id = $1 ORDER BY t.name`, req.params.id)
  res.json(topics)
}))
api.post('/courses/:id/topics', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Sub topic name is required')
  const course = await get('SELECT 1 x FROM courses WHERE id = $1', req.params.id)
  if (!course) return res.status(404).json({ error: 'Course not found' })
  const t = await get('INSERT INTO topics(course_id, name) VALUES ($1, $2) RETURNING *', req.params.id, name)
  res.status(201).json(t)
}))
api.put('/topics/:id', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Sub topic name is required')
  const t = await get('UPDATE topics SET name = $1 WHERE id = $2 RETURNING *', name, req.params.id)
  res.json(t)
}))
api.delete('/topics/:id', wrap(async (req, res) => {
  const files = await all('SELECT document_file f FROM questions WHERE topic_id = $1', req.params.id)
  await run('DELETE FROM topics WHERE id = $1', req.params.id)
  files.forEach((r) => rmFile(r.f))
  res.json({ ok: true })
}))

const shape = (q) => ({ ...q, options: JSON.parse(q.options || '[]'), document_url: q.document_file ? `/uploads/${q.document_file}` : null })

api.get('/topics/:id/questions', wrap(async (req, res) => {
  const questions = await all('SELECT * FROM questions WHERE topic_id = $1 ORDER BY created_at', req.params.id)
  res.json(questions.map(shape))
}))

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

function readBulkQuestions(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const questions = []
  const errors = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const parts = line.split('|').map((p) => p.trim())
    if (parts.length < 4) { errors.push(`Line ${i + 1}: expected text|optA|optB|optC|correctIndex|explanation`); continue }
    const qText = parts[0]
    const correctIndex = Number(parts[parts.length - 2])
    const explanation = parts[parts.length - 1]
    const optionList = parts.slice(1, -2)
    if (optionList.length < 2) { errors.push(`Line ${i + 1}: needs at least 2 options`); continue }
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= optionList.length) { errors.push(`Line ${i + 1}: invalid correct index`); continue }
    questions.push({ text: qText, options: optionList, correct: correctIndex, explanation: explanation || '' })
  }
  return { questions, errors }
}

api.post('/topics/:id/questions', upload.single('document'), wrap(async (req, res) => {
  const q = readQuestion(req)
  if (q.error) { if (req.file) rmFile(req.file.filename); return bad(res, q.error) }
  const topic = await get('SELECT 1 x FROM topics WHERE id = $1', req.params.id)
  if (!topic) { if (req.file) rmFile(req.file.filename); return res.status(404).json({ error: 'Sub topic not found' }) }
  const f = req.file
  const r = await get(`INSERT INTO questions(topic_id, text, options, correct, explanation, document_file, document_name, document_mime)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    req.params.id, q.text, JSON.stringify(q.options), q.correct, q.explanation, f?.filename ?? null, f?.originalname ?? null, f?.mimetype ?? null)
  res.status(201).json(shape(r))
}))

api.post('/topics/:id/questions/bulk', wrap(async (req, res) => {
  const topic = await get('SELECT 1 x FROM topics WHERE id = $1', req.params.id)
  if (!topic) return res.status(404).json({ error: 'Sub topic not found' })
  const { text } = req.body || {}
  if (!text) return bad(res, 'Paste your questions to import')
  const MAX = 2000
  const { questions, errors } = readBulkQuestions(text)
  if (errors.length) return bad(res, `Import errors: ${errors.slice(0, 10).join('; ')}`)
  if (questions.length === 0) return bad(res, 'No valid questions found')
  if (questions.length > MAX) return bad(res, `You can import at most ${MAX} questions at once`)
  const existing = await get('SELECT COUNT(*) c FROM questions WHERE topic_id = $1', req.params.id)
  if (Number(existing.c) + questions.length > MAX) return bad(res, `This topic would exceed ${MAX} questions (currently ${existing.c})`)
  const created = []
  for (const q of questions) {
    const r = await get(`INSERT INTO questions(topic_id, text, options, correct, explanation)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`, req.params.id, q.text, JSON.stringify(q.options), q.correct, q.explanation)
    created.push(shape(r))
  }
  res.status(201).json({ imported: created.length, questions: created })
}))

api.put('/questions/:id', upload.single('document'), wrap(async (req, res) => {
  const id = req.params.id
  const existing = await get('SELECT * FROM questions WHERE id = $1', id)
  const q = readQuestion(req)
  if (!existing) { if (req.file) rmFile(req.file.filename); return res.status(404).json({ error: 'Not found' }) }
  if (q.error) { if (req.file) rmFile(req.file.filename); return bad(res, q.error) }
  let { document_file: file, document_name: name, document_mime: mime } = existing
  if (req.file || req.body?.remove_document === 'true') {
    rmFile(file)
    file = name = mime = null
  }
  if (req.file) ({ filename: file, originalname: name, mimetype: mime } = req.file)
  const r = await get(`UPDATE questions SET text=$1, options=$2, correct=$3, explanation=$4, document_file=$5, document_name=$6, document_mime=$7 WHERE id=$8 RETURNING *`,
    q.text, JSON.stringify(q.options), q.correct, q.explanation, file, name, mime, id)
  res.json(shape(r))
}))

api.delete('/questions/:id', wrap(async (req, res) => {
  const q = await get('SELECT document_file FROM questions WHERE id = $1', req.params.id)
  await run('DELETE FROM questions WHERE id = $1', req.params.id)
  rmFile(q?.document_file)
  res.json({ ok: true })
}))
