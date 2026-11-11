import express from 'express'
import multer from 'multer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
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

/* ---------- students ---------- */
api.get('/students', wrap(async (_req, res) => {
  const board = Object.fromEntries((await leaderboard()).map((r) => [r.id, r]))
  const students = await prisma.student.findMany({
    orderBy: { id: 'desc' },
    take: 500,
    select: { id: true, phone: true, name: true, premium: true, trialsUsed: true, createdAt: true, lastSeen: true }
  })
  res.json(students.map((s) => ({ ...s, rank: board[s.id]?.rank ?? null, attempted: board[s.id]?.attempted ?? 0, correct: board[s.id]?.correct ?? 0, accuracy: board[s.id]?.accuracy ?? 0 })))
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

const shape = (q) => ({ ...q, options: JSON.parse(q.options || '[]'), document_url: q.documentFile ? getS3Url(q.documentFile) : null, header_url: q.headerImage ? getS3Url(q.headerImage) : null })

api.get('/topics/:id/questions', wrap(async (req, res) => {
  const questions = await prisma.question.findMany({
    where: { topicId: req.params.id },
    orderBy: { createdAt: 'asc' }
  })
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

api.post('/topics/:id/questions', upload.fields([{ name: 'document', maxCount: 1 }, { name: 'headerImage', maxCount: 1 }]), wrap(async (req, res) => {
  const q = readQuestion(req)
  if (q.error) { 
    if (req.files?.document?.[0]) await rmFile(req.files.document[0].filename)
    if (req.files?.headerImage?.[0]) await rmFile(req.files.headerImage[0].filename)
    return bad(res, q.error) 
  }
  const topic = await prisma.topic.findUnique({ where: { id: req.params.id } })
  if (!topic) { 
    if (req.files?.document?.[0]) await rmFile(req.files.document[0].filename)
    if (req.files?.headerImage?.[0]) await rmFile(req.files.headerImage[0].filename)
    return res.status(404).json({ error: 'Sub topic not found' }) 
  }
  const docFile = req.files?.document?.[0]
  const headerFile = req.files?.headerImage?.[0]
  let docResult = null
  let headerResult = null
  if (docFile) docResult = await uploadToS3(docFile)
  if (headerFile) headerResult = await uploadToS3(headerFile)
  const r = await prisma.question.create({
    data: {
      topicId: req.params.id,
      text: q.text,
      options: JSON.stringify(q.options),
      correct: q.correct,
      explanation: q.explanation,
      documentFile: docResult?.filename ?? null,
      documentName: docResult?.originalname ?? null,
      documentMime: docResult?.mimetype ?? null,
      headerImage: headerResult?.filename ?? null,
      headerMime: headerResult?.mimetype ?? null
    }
  })
  res.status(201).json(shape(r))
}))

api.post('/topics/:id/questions/bulk', wrap(async (req, res) => {
  const topic = await prisma.topic.findUnique({ where: { id: req.params.id } })
  if (!topic) return res.status(404).json({ error: 'Sub topic not found' })
  const { text } = req.body || {}
  if (!text) return bad(res, 'Paste your questions to import')
  const MAX = 2000
  const { questions, errors } = readBulkQuestions(text)
  if (errors.length) return bad(res, `Import errors: ${errors.slice(0, 10).join('; ')}`)
  if (questions.length === 0) return bad(res, 'No valid questions found')
  if (questions.length > MAX) return bad(res, `You can import at most ${MAX} questions at once`)
  const existing = await prisma.question.count({ where: { topicId: req.params.id } })
  if (existing + questions.length > MAX) return bad(res, `This topic would exceed ${MAX} questions (currently ${existing})`)
  const created = []
  for (const q of questions) {
    const r = await prisma.question.create({
      data: {
        topicId: req.params.id,
        text: q.text,
        options: JSON.stringify(q.options),
        correct: q.correct,
        explanation: q.explanation
      }
    })
    created.push(shape(r))
  }
  res.status(201).json({ imported: created.length, questions: created })
}))

api.put('/questions/:id', upload.fields([{ name: 'document', maxCount: 1 }, { name: 'headerImage', maxCount: 1 }]), wrap(async (req, res) => {
  const id = req.params.id
  const existing = await prisma.question.findUnique({ where: { id } })
  const q = readQuestion(req)
  if (!existing) { 
    if (req.files?.document?.[0]) await rmFile(req.files.document[0].filename)
    if (req.files?.headerImage?.[0]) await rmFile(req.files.headerImage[0].filename)
    return res.status(404).json({ error: 'Not found' }) 
  }
  if (q.error) { 
    if (req.files?.document?.[0]) await rmFile(req.files.document[0].filename)
    if (req.files?.headerImage?.[0]) await rmFile(req.files.headerImage[0].filename)
    return bad(res, q.error) 
  }
  let { documentFile: file, documentName: name, documentMime: mime, headerImage: hImg, headerMime: hMime } = existing
  if (req.files?.document?.[0] || req.body?.remove_document === 'true') {
    await rmFile(file)
    file = name = mime = null
  }
  if (req.files?.document?.[0]) {
    const result = await uploadToS3(req.files.document[0])
    file = result.filename
    name = result.originalname
    mime = result.mimetype
  }
  if (req.files?.headerImage?.[0] || req.body?.remove_header === 'true') {
    await rmFile(hImg)
    hImg = hMime = null
  }
  if (req.files?.headerImage?.[0]) {
    const result = await uploadToS3(req.files.headerImage[0])
    hImg = result.filename
    hMime = result.mimetype
  }
  const r = await prisma.question.update({
    where: { id },
    data: {
      text: q.text,
      options: JSON.stringify(q.options),
      correct: q.correct,
      explanation: q.explanation,
      documentFile: file,
      documentName: name,
      documentMime: mime,
      headerImage: hImg,
      headerMime: hMime
    }
  })
  res.json(shape(r))
}))

api.delete('/questions/:id', wrap(async (req, res) => {
  const q = await prisma.question.findUnique({ where: { id: req.params.id }, select: { documentFile: true, headerImage: true } })
  await prisma.question.delete({ where: { id: req.params.id } })
  rmFile(q?.documentFile)
  rmFile(q?.headerImage)
  res.json({ ok: true })
}))