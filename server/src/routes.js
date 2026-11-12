import express from 'express'
import multer from 'multer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { prisma, allSettings, setSetting, getSetting, loadSettings, UPLOAD_DIR } from './db.js'
import { uploadToS3, deleteFromS3, getS3Url } from './storage.js'
import { checkPassword, issueToken, requireAuth, requireRole, authenticateAdmin, bootstrapAdmin, hashPassword } from './auth.js'
import { dashboard, leaderboard, studentStats } from './stats.js'
import { balance, confirmPayment, failPayment, confirmWithdrawal, failWithdrawal, initiatePayment, initiateWithdrawal, pollPaymentStatus } from './payments.js'
import { createSession, listSessions, reconnectSession, terminateSession } from './whatsapp/manager.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const bad = (res, msg) => res.status(400).json({ error: msg })
const rmFile = async (name) => { if (name) await deleteFromS3(name) }

export const publicRouter = express.Router()
export const api = express.Router()

/* ---------- bootstrap + auth (no token) ---------- */
publicRouter.post('/login', wrap(async (req, res) => {
  await bootstrapAdmin()
  const phone = String(req.body?.phone || req.body?.email || 'admin@local')
  const password = String(req.body?.password || '')
  const admin = await authenticateAdmin(phone, password)
  if (!admin) return res.status(401).json({ error: 'Wrong credentials' })
  res.json({ token: issueToken(admin.id), admin: { id: admin.id, phone: admin.phone, name: admin.name, role: admin.role } })
}))

api.use(requireAuth)

/* ---------- admin management ---------- */
api.get('/admins', wrap(async (_req, res) => {
  const admins = await prisma.admin.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { invites: true } }
    }
  })
  res.json(admins.map(a => ({
    id: a.id,
    email: a.email,
    name: a.name,
    role: a.role,
    active: a.active,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    invite_count: a._count.invited
  })))
}))

api.post('/admins/invite', wrap(async (req, res) => {
  const { email, role = 'admin' } = req.body || {}
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return bad(res, 'Valid email is required')
  if (!['admin', 'owner'].includes(role)) return bad(res, 'Invalid role')
  const existing = await prisma.admin.findUnique({ where: { email: String(email) } })
  if (existing) return bad(res, 'An admin with this email already exists')
  const token = crypto.randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
  await prisma.adminInvite.create({
    data: {
      id: crypto.randomBytes(8).toString('hex'),
      email: String(email),
      token,
      role,
      invitedById: req.admin.id,
      expiresAt
    }
  })
  res.status(201).json({ email, role, token, expiresAt, invitedBy: { name: req.admin.name, email: req.admin.email } })
}))

api.post('/admins/invite/accept', wrap(async (req, res) => {
  const { token, password, name } = req.body || {}
  if (!token || !password || password.length < 8) return bad(res, 'Token and a password (8+ chars) are required')
  const invite = await prisma.adminInvite.findUnique({ where: { token } })
  if (!invite || invite.accepted) return res.status(400).json({ error: 'Invalid or already used invitation' })
  if (new Date(invite.expiresAt) < new Date()) return res.status(400).json({ error: 'Invitation has expired' })
  const hash = await hashPassword(String(password))
  await prisma.$transaction(async (tx) => {
    await tx.admin.create({
      data: {
        id: crypto.randomBytes(8).toString('hex'),
        email: invite.email,
        name: name || null,
        role: invite.role,
        passwordHash: hash
      }
    })
    await tx.adminInvite.update({ where: { id: invite.id }, data: { accepted: true } })
  })
  res.json({ ok: true })
}))

api.put('/admins/:id', wrap(async (req, res) => {
  const { role, active, name } = req.body || {}
  if (req.params.id === req.admin.id && active === false) return bad(res, 'You cannot deactivate yourself')
  const data = {}
  if (role !== undefined) { if (!['admin', 'owner'].includes(role)) return bad(res, 'Invalid role'); data.role = role }
  if (active !== undefined) data.active = Boolean(active)
  if (name !== undefined) data.name = name
  if (Object.keys(data).length === 0) return bad(res, 'Nothing to update')
  const admin = await prisma.admin.update({
    where: { id: req.params.id },
    data,
    select: { id: true, email: true, name: true, role: true, active: true }
  })
  res.json(admin)
}))

api.delete('/admins/:id', wrap(async (req, res) => {
  if (req.params.id === req.admin.id) return bad(res, 'You cannot delete yourself')
  await prisma.admin.delete({ where: { id: req.params.id } })
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
  const where = {}
  if (type) where.type = type
  if (status) where.status = status
  const [transactions, b] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { id: 'desc' },
      take: 500,
      include: { student: { select: { name: true } } }
    }),
    balance(),
  ])
  res.json({ ...b, transactions: transactions.map(t => ({ ...t, student_name: t.student?.name || null })) })
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
  const tx = await prisma.transaction.create({
    data: {
      phone,
      type: 'withdrawal',
      amount,
      currency,
      status: 'pending',
      method,
      note,
      reference,
      createdById: req.admin.id
    },
    select: { id: true }
  })
  try {
    const { providerRef } = await initiateWithdrawal({ amount, phone, method, note, createdById: req.admin.id })
    await prisma.transaction.update({ where: { id: tx.id }, data: { providerRef } })
  } catch (err) {
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'failed', note: String(err.message).slice(0, 200) } })
    throw err
  }
  res.status(201).json({ reference, ...(await balance()) })
}))

api.post('/transactions/:id/resolve', wrap(async (req, res) => {
  const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } })
  if (!tx) return res.status(404).json({ error: 'Not found' })
  if (tx.status !== 'pending') return bad(res, 'Transaction is not pending')
  const outcome = req.body?.outcome === 'failed' ? 'failed' : 'success'
  if (tx.type === 'payment' && outcome === 'success') await confirmPayment(tx.reference)
  else if (tx.type === 'withdrawal' && outcome === 'success') await confirmWithdrawal(tx.reference)
  else await prisma.transaction.update({ where: { id: tx.id }, data: { status: outcome } })
  res.json({ ok: true, ...(await balance()) })
}))

/* ---------- payment status check (for polling) ---------- */
api.post('/payments/check-status', wrap(async (req, res) => {
  const { reference } = req.body || {}
  if (!reference) return bad(res, 'Reference is required')
  const result = await pollPaymentStatus(reference)
  if (!result) return res.status(404).json({ error: 'Transaction not found or not pending' })
  res.json({ status: result.status, transaction: result.transaction })
}))

/* ---------- students / accounts ---------- */
api.get('/students', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase()
  const status = String(req.query.status || 'all')
  const board = Object.fromEntries((await leaderboard()).map((r) => [r.id, r]))
  const trial = Number(await getSetting('trial_limit'))
  let students = await prisma.student.findMany({
    orderBy: { id: 'desc' },
    take: 1000,
    select: { id: true, phone: true, name: true, jid: true, premium: true, banned: true, trialsUsed: true, premiumSince: true, premiumUntil: true, createdAt: true, lastSeen: true }
  })
  students = students.map((s) => {
    const b = board[s.id] || {}
    const exhausted = !s.premium && s.trialsUsed >= trial
    const accountStatus = s.banned ? 'banned' : s.premium ? 'premium' : exhausted ? 'trial_exhausted' : 'active'
    return { ...s, rank: b.rank ?? null, attempted: b.attempted ?? 0, correct: b.correct ?? 0, accuracy: b.accuracy ?? 0, exhausted, status: accountStatus }
  })
  if (q) students = students.filter((s) => (s.name || '').toLowerCase().includes(q) || String(s.phone || '').includes(q))
  if (status === 'banned') students = students.filter((s) => s.banned)
  else if (status === 'premium') students = students.filter((s) => s.premium)
  else if (status === 'free') students = students.filter((s) => !s.premium)
  else if (status === 'active') students = students.filter((s) => !s.banned)
  else if (status === 'trial_exhausted') students = students.filter((s) => s.exhausted)
  res.json(students)
}))

api.put('/students/:id', wrap(async (req, res) => {
  const s = await prisma.student.findUnique({ where: { id: req.params.id } })
  if (!s) return res.status(404).json({ error: 'Student not found' })
  const data = {}
  if (req.body?.name !== undefined) data.name = String(req.body.name || '').trim()
  if (req.body?.banned !== undefined) data.banned = !!req.body.banned
  if (req.body?.trialsUsed !== undefined) {
    const n = Number(req.body.trialsUsed)
    if (!Number.isInteger(n) || n < 0) return bad(res, 'Trials used must be a non-negative integer')
    data.trialsUsed = n
  }
  if (req.body?.premium !== undefined) {
    data.premium = !!req.body.premium
    if (data.premium && !s.premium) data.premiumSince = new Date()
    if (!data.premium) { data.premiumSince = null; data.premiumUntil = null }
  }
  if (req.body?.premiumUntil !== undefined) data.premiumUntil = req.body.premiumUntil ? new Date(req.body.premiumUntil) : null
  const updated = await prisma.student.update({ where: { id: s.id }, data })
  res.json({ ok: true, student: updated })
}))

/* ---------- question bank ---------- */
api.get('/courses', wrap(async (_req, res) => {
  const courses = await prisma.course.findMany({
    orderBy: { name: 'asc' },
    include: {
      topics: { select: { id: true } },
      _count: { select: { topics: true } }
    }
  })
  
  const courseData = await Promise.all(courses.map(async (c) => {
    const questionCount = await prisma.question.count({
      where: { topic: { courseId: c.id } }
    })
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      created_at: c.createdAt,
      topic_count: c._count.topics,
      question_count: questionCount
    }
  }))
  
  res.json(courseData)
}))

api.post('/courses', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Course name is required')
  const c = await prisma.course.create({
    data: { name, description: String(req.body?.description || '').trim() }
  })
  res.status(201).json(c)
}))

api.put('/courses/:id', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Course name is required')
  const c = await prisma.course.update({
    where: { id: req.params.id },
    data: { name, description: String(req.body?.description || '').trim() }
  })
  res.json(c)
}))

api.delete('/courses/:id', wrap(async (req, res) => {
  const questions = await prisma.question.findMany({
    where: { topic: { courseId: req.params.id } },
    select: { documentFile: true }
  })
  await prisma.course.delete({ where: { id: req.params.id } })
  questions.forEach((r) => rmFile(r.documentFile))
  res.json({ ok: true })
}))

api.get('/courses/:id/topics', wrap(async (req, res) => {
  const topics = await prisma.topic.findMany({
    where: { courseId: req.params.id },
    orderBy: { name: 'asc' },
    include: { _count: { select: { questions: true } }, children: { select: { id: true } } }
  })
  res.json(topics.map(t => ({ ...t, question_count: t._count.questions, hasChildren: t.children.length > 0 })))
}))

api.get('/courses/:id/topics/tree', wrap(async (req, res) => {
  const topics = await prisma.topic.findMany({
    where: { courseId: req.params.id },
    orderBy: { name: 'asc' },
    include: { 
      _count: { select: { questions: true } },
      children: { 
        orderBy: { name: 'asc' },
        include: {
          _count: { select: { questions: true } },
          children: {
            orderBy: { name: 'asc' },
            include: {
              _count: { select: { questions: true } },
              children: {
                orderBy: { name: 'asc' },
                include: { _count: { select: { questions: true } } }
              }
            }
          }
        }
      }
    }
  })
  
  const buildTree = (list, parentId = null) => 
    list.filter(t => t.parentId === parentId).map(t => ({
      ...t,
      question_count: t._count.questions,
      children: buildTree(list, t.id)
    }))
  
  res.json(buildTree(topics))
}))

api.post('/courses/:id/topics', upload.single('headerImage'), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Sub topic name is required')
  const course = await prisma.course.findUnique({ where: { id: req.params.id } })
  if (!course) return res.status(404).json({ error: 'Course not found' })
  const parentId = req.body?.parentId || null
  if (parentId) {
    const parent = await prisma.topic.findUnique({ where: { id: parentId } })
    if (!parent || parent.courseId !== req.params.id) return bad(res, 'Invalid parent topic')
  }
  const f = req.file
  let headerResult = null
  if (f) headerResult = await uploadToS3(f)
  const t = await prisma.topic.create({
    data: {
      courseId: req.params.id,
      name,
      parentId,
      headerImage: headerResult?.filename ?? null,
      headerMime: headerResult?.mimetype ?? null
    }
  })
  res.status(201).json(t)
}))

api.post('/courses/:id/topics/bulk', wrap(async (req, res) => {
  const course = await prisma.course.findUnique({ where: { id: req.params.id } })
  if (!course) return res.status(404).json({ error: 'Course not found' })
  const { text } = req.body || {}
  if (!text) return bad(res, 'Paste your topics to import')
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const topics = []
  const errors = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const parts = line.split('|').map((p) => p.trim())
    if (parts.length < 1) { errors.push(`Line ${i + 1}: expected name|parentName|headerImageUrl`); continue }
    const name = parts[0]
    const parentName = parts[1] || null
    if (!name) { errors.push(`Line ${i + 1}: topic name is required`); continue }
    let parentId = null
    if (parentName) {
      const parent = await prisma.topic.findFirst({ where: { courseId: req.params.id, name: parentName } })
      if (!parent) { errors.push(`Line ${i + 1}: parent topic "${parentName}" not found`); continue }
      parentId = parent.id
    }
    topics.push({ name, parentId })
  }
  if (errors.length) return bad(res, `Import errors: ${errors.slice(0, 10).join('; ')}`)
  if (topics.length === 0) return bad(res, 'No valid topics found')
  const created = []
  for (const t of topics) {
    const r = await prisma.topic.create({
      data: {
        courseId: req.params.id,
        name: t.name,
        parentId: t.parentId
      }
    })
    created.push(r)
  }
  res.status(201).json({ imported: created.length, topics: created })
}))

api.put('/topics/:id', upload.single('headerImage'), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'Sub topic name is required')
  const existing = await prisma.topic.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ error: 'Topic not found' })
  
  let { headerImage: img, headerMime: mime } = existing
  if (req.file) {
    await rmFile(img)
    const result = await uploadToS3(req.file)
    img = result.filename
    mime = result.mimetype
  } else if (req.body?.remove_header === 'true') {
    await rmFile(img)
    img = mime = null
  }
  
  const t = await prisma.topic.update({
    where: { id: req.params.id },
    data: { name, headerImage: img, headerMime: mime }
  })
  res.json(t)
}))

api.delete('/topics/:id', wrap(async (req, res) => {
  const questions = await prisma.question.findMany({
    where: { topicId: req.params.id },
    select: { documentFile: true, headerImage: true }
  })
  const topic = await prisma.topic.findUnique({ where: { id: req.params.id }, select: { headerImage: true } })
  await rmFile(topic?.headerImage)
  await prisma.topic.delete({ where: { id: req.params.id } })
  for (const r of questions) {
    await rmFile(r.documentFile)
    await rmFile(r.headerImage)
  }
  res.json({ ok: true })
}))

const parseJson = (v, fallback) => { try { return JSON.parse(v || '') ?? fallback } catch { return fallback } }
const shape = (q) => {
  const questionImages = parseJson(q.questionImages, []).map((img) => (img?.file ? { ...img, url: getS3Url(img.file) } : img))
  const modelAnswerImages = parseJson(q.modelAnswerImages, []).map((img) => (img?.file ? { ...img, url: getS3Url(img.file) } : img))
  return {
    ...q,
    options: parseJson(q.options, []),
    question_images: questionImages,
    model_answer_images: modelAnswerImages,
    document_url: q.documentFile ? getS3Url(q.documentFile) : null,
    header_url: q.headerImage ? getS3Url(q.headerImage) : null,
  }
}

api.get('/topics/:id/questions', wrap(async (req, res) => {
  const questions = await prisma.question.findMany({
    where: { topicId: req.params.id },
    orderBy: { createdAt: 'asc' }
  })
  res.json(questions.map(shape))
}))

const DEFAULT_OPTIONS = ['A', 'B', 'C']

function readQuestion(req) {
  const type = String(req.body?.type || 'objective') === 'long' ? 'long' : 'objective'
  const explanation = String(req.body?.explanation || '').trim()

  if (type === 'objective') {
    const text = String(req.body?.text || '').trim()
    let options
    try { options = JSON.parse(req.body?.options || '[]') } catch { options = [] }
    options = (Array.isArray(options) ? options : []).map((o) => String(o).trim())
    if (options.length === 0) options = [...DEFAULT_OPTIONS]
    if (options.length !== 3 || options.some((o) => !o)) return { error: 'Provide text for options A, B, and C' }
    const correct = Number(req.body?.correct)
    if (!text) return { error: 'Question text is required' }
    if (options.some((o) => o.length > 200)) return { error: 'Options must be 200 characters or fewer' }
    if (!Number.isInteger(correct) || correct < 0 || correct >= 3) return { error: 'Select the correct answer (A, B, or C)' }
    return { type: 'objective', text, options, correct, explanation, questionImages: [], promptType: 'text', answerType: 'text', modelAnswer: '', modelAnswerImages: [] }
  }

  const isImageQuestion = String(req.body?.is_image_question || 'false') === 'true'
  const promptType = isImageQuestion ? 'image' : 'text'
  const text = String(req.body?.text || '').trim()
  const modelAnswer = String(req.body?.model_answer || '').trim()
  if (!isImageQuestion && !text) return { error: 'Question text is required' }
  if (isImageQuestion) {
    const count = Number(req.body?.question_image_count || 0)
    if (!Number.isInteger(count) || count < 1 || count > 3) return { error: 'Image questions require 1 to 3 question pages' }
  }
  const answerCount = Number(req.body?.answer_image_count || 0)
  if (isImageQuestion && (!Number.isInteger(answerCount) || answerCount < 1 || answerCount > 3)) return { error: 'Image questions require 1 to 3 answer pages' }
  if (isImageQuestion && !modelAnswer && answerCount === 0) return { error: 'Provide a model answer (text and/or answer images)' }

  return {
    type: 'long',
    text: text || '(Image question)',
    options: [],
    correct: -1,
    explanation,
    promptType,
    answerType: isImageQuestion ? 'image' : 'text',
    modelAnswer,
    isImageQuestion,
  }
}

function readBulkQuestions(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const questions = []
  const errors = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const parts = line.split('|').map((p) => p.trim())
    if (parts.length < 4) { errors.push(`Line ${i + 1}: expected text|optA|optB|optC|correct(A/B/C or 0-2)|explanation`); continue }
    const qText = parts[0]
    const correctRaw = String(parts[parts.length - 2] || '').trim().toUpperCase()
    const explanation = parts[parts.length - 1]
    const optionList = parts.slice(1, -2).filter(Boolean)
    if (optionList.length !== 3) { errors.push(`Line ${i + 1}: needs exactly 3 options (A, B, C)`); continue }
    const correctIndex = /^[ABC]$/.test(correctRaw) ? 'ABC'.indexOf(correctRaw) : Number(correctRaw)
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 2) { errors.push(`Line ${i + 1}: correct answer must be A, B, C or 0-2`); continue }
    questions.push({ text: qText, options: optionList, correct: correctIndex, explanation: explanation || '' })
  }
  return { questions, errors }
}

function readBulkQuestionsFromExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return { questions: [], errors: ['Excel file has no sheets'] }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  if (!rows.length) return { questions: [], errors: ['Excel sheet is empty'] }

  const norm = (v) => String(v ?? '').trim()
  const lower = (v) => norm(v).toLowerCase()
  const header = rows[0].map(lower)
  const hasHeader = header.some((h) => ['question', 'first answer', 'answer a', 'option a', 'correct answer', 'correct'].includes(h))

  let idx = { q: 0, a: 1, b: 2, c: 3, correct: 4, explanation: 5 }
  let dataRows = rows
  if (hasHeader) {
    const find = (...names) => header.findIndex((h) => names.map((n) => n.toLowerCase()).includes(h))
    const q = find('question', 'questions', 'question text')
    const a = find('first answer', 'answer a', 'option a', 'a', '1st answer')
    const b = find('second answer', 'answer b', 'option b', 'b', '2nd answer')
    const c = find('third answer', 'answer c', 'option c', 'c', '3rd answer')
    const correct = find('correct answer', 'correct', 'answer', 'correct option')
    const explanation = find('explanation', 'reason', 'why')
    if ([q, a, b, c, correct].some((i) => i === -1)) {
      return { questions: [], errors: ['Excel must have columns: question, first answer, second answer, third answer, correct answer (A/B/C)'] }
    }
    idx = { q, a, b, c, correct, explanation }
    dataRows = rows.slice(1)
  }

  const questions = []
  const errors = []
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i] || []
    const qText = norm(row[idx.q])
    const optA = norm(row[idx.a])
    const optB = norm(row[idx.b])
    const optC = norm(row[idx.c])
    const correctRaw = norm(row[idx.correct]).toUpperCase()
    const explanation = idx.explanation >= 0 ? norm(row[idx.explanation]) : ''
    if (!qText && !optA && !optB && !optC && !correctRaw) continue
    const rowNum = i + (hasHeader ? 2 : 1)
    if (!qText) { errors.push(`Row ${rowNum}: question text is required`); continue }
    if (!optA || !optB || !optC) { errors.push(`Row ${rowNum}: all three answers (A, B, C) are required`); continue }
    let correctIndex = -1
    if (/^[ABC]$/.test(correctRaw)) correctIndex = 'ABC'.indexOf(correctRaw)
    else if (/^[123]$/.test(correctRaw)) correctIndex = Number(correctRaw) - 1
    if (correctIndex < 0 || correctIndex > 2) { errors.push(`Row ${rowNum}: correct answer must be A, B, or C`); continue }
    questions.push({ text: qText, options: [optA, optB, optC], correct: correctIndex, explanation })
  }
  return { questions, errors }
}

const QUESTION_UPLOAD_FIELDS = [
  { name: 'document', maxCount: 1 },
  { name: 'headerImage', maxCount: 1 },
  { name: 'questionImage1', maxCount: 1 },
  { name: 'questionImage2', maxCount: 1 },
  { name: 'questionImage3', maxCount: 1 },
  { name: 'modelAnswerImage1', maxCount: 1 },
  { name: 'modelAnswerImage2', maxCount: 1 },
  { name: 'modelAnswerImage3', maxCount: 1 },
]

async function uploadQuestionImages(req, prefix, count) {
  const out = []
  for (let i = 1; i <= count; i++) {
    const f = req.files?.[prefix + i]?.[0]
    if (!f) return { error: `Missing ${prefix} page ${i}` }
    const up = await uploadToS3(f)
    out.push({ file: up.filename, mime: up.mimetype, name: up.originalname || null, page: i })
  }
  return { images: out }
}

async function resolveQuestionImages(req, existingJson, prefix, count) {
  const prev = parseJson(existingJson, [])
  const keep = parseJson(req.body?.['keep_' + prefix + 's'], [])
  const out = []
  for (let i = 1; i <= count; i++) {
    const f = req.files?.[prefix + i]?.[0]
    if (f) {
      const up = await uploadToS3(f)
      out.push({ file: up.filename, mime: up.mimetype, name: up.originalname || null, page: i })
      continue
    }
    const kept = keep.find((k) => Number(k.page) === i) || prev[i - 1]
    if (kept?.file) out.push({ file: kept.file, mime: kept.mime || null, name: kept.name || null, page: i })
    else return { error: `Provide image for ${prefix} page ${i}` }
  }
  const keptFiles = new Set(out.map((x) => x.file))
  for (const p of prev) if (p?.file && !keptFiles.has(p.file)) await rmFile(p.file)
  return { images: out }
}

api.post('/topics/:id/questions', upload.fields(QUESTION_UPLOAD_FIELDS), wrap(async (req, res) => {
  const cleanupAll = async () => { for (const arr of Object.values(req.files || {})) for (const f of arr || []) await rmFile(f?.filename) }
  const q = readQuestion(req)
  if (q.error) { await cleanupAll(); return bad(res, q.error) }
  const topic = await prisma.topic.findUnique({ where: { id: req.params.id } })
  if (!topic) { await cleanupAll(); return res.status(404).json({ error: 'Sub topic not found' }) }

  const docFile = req.files?.document?.[0]
  const headerFile = req.files?.headerImage?.[0]
  let docResult = null
  let headerResult = null
  if (docFile) docResult = await uploadToS3(docFile)
  if (headerFile) headerResult = await uploadToS3(headerFile)

  let questionImages = []
  let modelAnswerImages = []
  if (q.type === 'long' && q.isImageQuestion) {
    const qCount = Number(req.body?.question_image_count || 0)
    const aCount = Number(req.body?.answer_image_count || 0)
    const qi = await uploadQuestionImages(req, 'questionImage', qCount)
    if (qi.error) { await cleanupAll(); if (docResult?.filename) await rmFile(docResult.filename); if (headerResult?.filename) await rmFile(headerResult.filename); return bad(res, qi.error) }
    const ai = await uploadQuestionImages(req, 'modelAnswerImage', aCount)
    if (ai.error) { await cleanupAll(); for (const x of qi.images || []) await rmFile(x.file); if (docResult?.filename) await rmFile(docResult.filename); if (headerResult?.filename) await rmFile(headerResult.filename); return bad(res, ai.error) }
    questionImages = qi.images || []
    modelAnswerImages = ai.images || []
  }

  const r = await prisma.question.create({
    data: {
      topicId: req.params.id,
      text: q.text,
      type: q.type,
      options: JSON.stringify(q.options),
      correct: q.correct,
      explanation: q.explanation,
      documentFile: docResult?.filename ?? null,
      documentName: docResult?.originalname ?? null,
      documentMime: docResult?.mimetype ?? null,
      headerImage: headerResult?.filename ?? null,
      headerMime: headerResult?.mimetype ?? null,
      questionImages: questionImages.length ? JSON.stringify(questionImages) : null,
      promptType: q.promptType || 'text',
      answerType: q.answerType || 'text',
      modelAnswer: q.modelAnswer || '',
      modelAnswerImages: modelAnswerImages.length ? JSON.stringify(modelAnswerImages) : null,
      modelAnswerMime: modelAnswerImages[0]?.mime ?? null,
    }
  })
  res.status(201).json(shape(r))
}))

api.post('/topics/:id/questions/bulk', upload.single('file'), wrap(async (req, res) => {
  const topic = await prisma.topic.findUnique({ where: { id: req.params.id } })
  if (!topic) return res.status(404).json({ error: 'Sub topic not found' })
  const MAX = 2000
  let parsed
  if (req.file) {
    try { parsed = readBulkQuestionsFromExcel(req.file.buffer) }
    catch (e) { return bad(res, `Could not read Excel file: ${e.message}`) }
  } else {
    const { text } = req.body || {}
    if (!text) return bad(res, 'Upload an Excel file or paste questions to import')
    parsed = readBulkQuestions(text)
  }
  const { questions, errors } = parsed
  if (errors.length) return bad(res, `Import errors: ${errors.slice(0, 10).join('; ')}`)
  if (questions.length === 0) return bad(res, 'No valid questions found')
  if (questions.length > MAX) return bad(res, `You can import at most ${MAX} questions at once`)
  const existing = await prisma.question.count({ where: { topicId: req.params.id } })
  if (existing + questions.length > MAX) return bad(res, `This topic would exceed ${MAX} questions (currently ${existing})`)
  const created = await prisma.$transaction(
    questions.map((q) => prisma.question.create({
      data: {
        topicId: req.params.id,
        text: q.text,
        options: JSON.stringify(q.options),
        correct: q.correct,
        explanation: q.explanation || ''
      }
    }))
  )
  res.status(201).json({ imported: created.length, questions: created.map(shape) })
}))

api.put('/questions/:id', upload.fields(QUESTION_UPLOAD_FIELDS), wrap(async (req, res) => {
  const cleanupAll = async () => { for (const arr of Object.values(req.files || {})) for (const f of arr || []) await rmFile(f?.filename) }
  const id = req.params.id
  const existing = await prisma.question.findUnique({ where: { id } })
  const q = readQuestion(req)
  if (!existing) { await cleanupAll(); return res.status(404).json({ error: 'Not found' }) }
  if (q.error) { await cleanupAll(); return bad(res, q.error) }

  let { documentFile: file, documentName: name, documentMime: mime, headerImage: hImg, headerMime: hMime } = existing
  if (req.files?.document?.[0] || req.body?.remove_document === 'true') { await rmFile(file); file = name = mime = null }
  if (req.files?.document?.[0]) { const result = await uploadToS3(req.files.document[0]); file = result.filename; name = result.originalname; mime = result.mimetype }
  if (req.files?.headerImage?.[0] || req.body?.remove_header === 'true') { await rmFile(hImg); hImg = hMime = null }
  if (req.files?.headerImage?.[0]) { const result = await uploadToS3(req.files.headerImage[0]); hImg = result.filename; hMime = result.mimetype }

  let questionImages = null
  let modelAnswerImages = null
  const prevQImgs = parseJson(existing.questionImages, [])
  const prevAImgs = parseJson(existing.modelAnswerImages, [])
  if (q.type === 'long' && q.isImageQuestion) {
    const qCount = Number(req.body?.question_image_count || 0)
    const aCount = Number(req.body?.answer_image_count || 0)
    const qi = await resolveQuestionImages(req, existing.questionImages, 'questionImage', qCount)
    if (qi.error) { await cleanupAll(); return bad(res, qi.error) }
    const ai = await resolveQuestionImages(req, existing.modelAnswerImages, 'modelAnswerImage', aCount)
    if (ai.error) { await cleanupAll(); for (const x of qi.images || []) await rmFile(x.file); return bad(res, ai.error) }
    questionImages = JSON.stringify(qi.images || [])
    modelAnswerImages = JSON.stringify(ai.images || [])
  } else {
    for (const p of [...prevQImgs, ...prevAImgs]) if (p?.file) await rmFile(p.file)
  }

  const r = await prisma.question.update({
    where: { id },
    data: {
      text: q.text,
      type: q.type,
      options: JSON.stringify(q.options),
      correct: q.correct,
      explanation: q.explanation,
      documentFile: file,
      documentName: name,
      documentMime: mime,
      headerImage: hImg,
      headerMime: hMime,
      questionImages,
      promptType: q.promptType || 'text',
      answerType: q.answerType || 'text',
      modelAnswer: q.modelAnswer || '',
      modelAnswerImages,
      modelAnswerMime: parseJson(modelAnswerImages, [])[0]?.mime ?? null,
    }
  })
  res.json(shape(r))
}))

api.delete('/questions/:id', wrap(async (req, res) => {
  const q = await prisma.question.findUnique({ where: { id: req.params.id }, select: { documentFile: true, headerImage: true, questionImages: true, modelAnswerImages: true } })
  await prisma.question.delete({ where: { id: req.params.id } })
  rmFile(q?.documentFile)
  rmFile(q?.headerImage)
  for (const p of parseJson(q?.questionImages, [])) if (p?.file) rmFile(p.file)
  for (const p of parseJson(q?.modelAnswerImages, [])) if (p?.file) rmFile(p.file)
  res.json({ ok: true })
}))