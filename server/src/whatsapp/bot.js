import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { prisma, getSetting } from '../db.js'
import { initiatePayment, normalizeMsisdn } from '../payments.js'
import { studentStats } from '../stats.js'

const PAGE = 9
const LETTERS = ['A', 'B', 'C']
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

const BUCKET = 'uploads'

let s3Client = null
function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'us-east-2',
      endpoint: 'https://br-odd-fog-bd2gd6jh.storage.c-8.us-east-2.aws.neon.tech',
      credentials: {
        accessKeyId: 'nak_live_e25ccdca30e14da8a7c2f8e0a04ccf08',
        secretAccessKey: 'nsk_live_ef0b31c3a90ed11f79c971c33b0c5a53a20256d07628891cd995cd6dfd148ca6'
      },
      forcePathStyle: true
    })
  }
  return s3Client
}

async function fetchFromS3(key) {
  if (!key) return null
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key })
  const result = await getS3Client().send(cmd).catch(() => null)
  if (!result?.Body) return null
  return Buffer.from(await result.Body.transformToByteArray())
}

/* ---------- inbound parsing ---------- */

export function parseIncoming(msg) {
  let m = msg.message
  if (!m) return null
  m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.documentWithCaptionMessage?.message || m

  if (m.buttonsResponseMessage) return { id: m.buttonsResponseMessage.selectedButtonId, text: m.buttonsResponseMessage.selectedDisplayText || '' }
  if (m.templateButtonReplyMessage) return { id: m.templateButtonReplyMessage.selectedId, text: m.templateButtonReplyMessage.selectedDisplayText || '' }
  if (m.listResponseMessage) return { id: m.listResponseMessage.singleSelectReply?.selectedRowId, text: m.listResponseMessage.title || '' }
  if (m.interactiveResponseMessage) {
    const ir = m.interactiveResponseMessage
    let id
    try {
      id = JSON.parse(ir.nativeFlowResponseMessage?.paramsJson || '{}').id
    } catch {}
    return { id, text: ir.body?.text || '' }
  }
  const text = m.conversation || m.extendedTextMessage?.text || ''
  return { id: null, text: text.trim() }
}

/* ---------- students ---------- */

async function upsertStudent({ phone, jid, name, sessionId }) {
  let s = await prisma.student.findUnique({ where: { phone } })
  if (!s) {
    s = await prisma.student.create({
      data: { phone, name: name || '', jid, sessionId }
    })
  } else {
    s = await prisma.student.update({
      where: { id: s.id },
      data: { 
        jid, 
        sessionId, 
        lastSeen: new Date(),
        name: s.name === '' ? name || '' : s.name
      }
    })
  }
  return s
}

const getState = (s) => { try { return JSON.parse(s.state || '{}') } catch { return {} } }
const setState = (s, state) => prisma.student.update({ where: { id: s.id }, data: { state: JSON.stringify(state) } })
const fresh = (s) => prisma.student.findUnique({ where: { id: s.id } })
const exhausted = async (s) => !s.premium && s.trialsUsed >= await trialLimit()
const hasAttempted = async (sid, qid) => !!await prisma.attempt.findFirst({ where: { studentId: sid, questionId: qid } })

const money = async (n) => `${await getSetting('currency')} ${Number(n).toLocaleString('en-US')}`
const trialLimit = async () => Number(await getSetting('trial_limit'))
const premiumPrice = async () => Number(await getSetting('premium_price'))
const welcomeMessage = async () => String(await getSetting('welcome_message'))
const botName = async () => String(await getSetting('bot_name'))

/* ---------- outbound helpers ---------- */

const text = (ctx, jid, body) => ctx.sock.sendMessage(jid, { text: body })

/* Send typing indicator immediately so user knows bot is alive */
const sendTyping = (ctx, jid) => ctx.sock.sendPresenceUpdate('composing', jid)

/* Mark message as seen (blue ticks) */
const markSeen = (ctx, msg) => ctx.sock.sendPresenceUpdate('read', msg.key.remoteJid, msg.key.id, msg.key.fromMe ? 'sender' : 'recipient')

async function buttons(ctx, jid, body, list, footer) {
  try {
    await ctx.x.sendButton(jid, { text: body, footer, buttons: list.map((b) => ({ id: b.id, text: clip(b.text, 20) })) })
  } catch (err) {
    console.error('[bot] buttons failed, using text fallback:', err.message)
    await text(ctx, jid, `${body}\n\n${list.map((b) => `• ${b.text}`).join('\n')}`)
  }
}

async function pagedList(ctx, jid, { title, body, button, items, prefix, page, moreId, extraRows = [] }) {
  const start = page * PAGE
  const slice = items.slice(start, start + PAGE)
  const rows = slice.map((i) => ({ title: clip(i.title, 24), description: i.description ? clip(i.description, 72) : undefined, rowId: `${prefix}:${i.id}` }))
  if (start + PAGE < items.length) rows.push({ title: '➡️ More', description: 'Show more options', rowId: `${moreId}:${page + 1}` })
  else rows.push(...extraRows)
  try {
    await ctx.x.sendList(jid, { title, text: body, buttonText: button, sections: [{ title: clip(title, 24), rows: rows.slice(0, 10) }] })
  } catch (err) {
    console.error('[bot] list failed, using text fallback:', err.message)
    await text(ctx, jid, `${body}\n\n${slice.map((i, n) => `${n + 1}. ${i.title}`).join('\n')}\n\n(Interactive lists aren't supported on your WhatsApp version. Type "menu" to retry.)`)
  }
}

async function sendHeaderImage(ctx, jid, topic) {
  if (!topic?.headerImage) return
  const buffer = await fetchFromS3(topic.headerImage)
  if (buffer) {
    const mime = topic.headerMime || 'image/jpeg'
    try {
      await ctx.sock.sendMessage(jid, { image: buffer, mimetype: mime, caption: `*${topic.name}*` })
    } catch (e) {
      console.error('[bot] header image send failed:', e.message)
    }
  }
}

function buildTopicTree(topics, parentId = null) {
  return topics.filter(t => t.parentId === parentId).map(t => ({
    id: t.id,
    title: t.name,
    qn: t._count?.questions || 0,
    headerImage: t.headerImage,
    headerMime: t.headerMime,
    children: buildTopicTree(topics, t.id)
  }))
}

function flattenTopics(topics) {
  const flat = []
  const traverse = (list, depth = 0) => {
    for (const t of list) {
      flat.push({ ...t, depth })
      if (t.children?.length) traverse(t.children, depth + 1)
    }
  }
  traverse(topics)
  return flat
}

/* ---------- flow ---------- */

async function showMenu(ctx, s, jid, { greet = false, page = 0 } = {}) {
  const courses = await prisma.course.findMany({
    orderBy: { name: 'asc' },
    include: {
      topics: {
        include: {
          questions: true
        }
      }
    }
  })
  
  const coursesWithCount = courses
    .map((c) => {
      const qn = c.topics.reduce((sum, t) => sum + t.questions.length, 0)
      return { 
        id: c.id, 
        name: c.name, 
        title: c.name, 
        description: c.description,
        qn,
        fullDescription: `${qn} question${qn === 1 ? '' : 's'}${c.description ? ' · ' + c.description : ''}` 
      }
    })
    // Show all levels, even empty ones
    .filter((c) => true)
  
  await setState(s, {})
  if (greet) {
    const name = (s.name || '').split(' ')[0]
    const welcome = (await welcomeMessage())
    .replaceAll('{bot}', await botName())
    .replaceAll('{trials}', String(await trialLimit()));
    await text(ctx, jid, `Hello${name ? ' ' + name : ''} 👋\n\n${welcome}`)
  }
  if (!coursesWithCount.length) return text(ctx, jid, 'No levels are available yet. Please check back soon.')
  const status = s.premium ? '⭐ Premium — unlimited practice' : `🎁 Free trial: ${Math.max(0, await trialLimit() - s.trialsUsed)} of ${await trialLimit()} questions left`
  await pagedList(ctx, jid, {
    title: 'Levels', body: `Choose what applies to you.\n${status}\n\nType *rank* any time to see your ranking.`,
    button: 'Select an option', items: coursesWithCount.map(c => ({ id: c.id, title: c.name, description: c.fullDescription })), prefix: 'course', page, moreId: 'courses',
  })
}

async function showTopics(ctx, s, jid, courseId, parentId = null, page = 0) {
  const course = await prisma.course.findUnique({ where: { id: courseId } })
  if (!course) return showMenu(ctx, s, jid)
  
  const allTopics = await prisma.topic.findMany({
    where: { courseId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { questions: true } } }
  })
  
  const tree = buildTopicTree(allTopics, parentId)
  
  const parentTopic = parentId ? await prisma.topic.findUnique({ where: { id: parentId } }) : null
  const title = parentTopic ? parentTopic.name : course.name
  const backId = parentTopic ? `topic_parent:${parentTopic.parentId}:${parentTopic.courseId}` : 'menu'
  const backLabel = parentTopic ? `⬅️ ${parentTopic.name}` : '⬅️ All levels'
  
  // Send header image if this is a parent topic view
  if (parentTopic && parentTopic.headerImage) {
    await sendHeaderImage(ctx, jid, parentTopic)
  }
  
  if (!tree.length) { 
    await text(ctx, jid, `*${title}* has no submenus yet.`); 
    return parentTopic ? showTopics(ctx, s, jid, courseId, parentTopic.parentId) : showMenu(ctx, s, jid) 
  }
  
  await setState(s, { courseId, parentTopicId: parentId })
  
  // Build items: show children as submenus (navigable) or as topics with questions (leaf)
  const items = tree.map(t => {
    const hasChildren = t.children && t.children.length > 0
    const hasQuestions = t.qn > 0
    
    if (hasChildren) {
      // This is a parent topic - navigate into it
      return {
        id: t.id,
        title: t.title,
        description: `${t.children.length} submenu${t.children.length === 1 ? '' : 's'}${hasQuestions ? ` · ${t.qn} question${t.qn === 1 ? '' : 's'}` : ''}`,
        isParent: true
      }
    } else if (hasQuestions) {
      // Leaf topic with questions - select to practice
      return {
        id: t.id,
        title: t.title,
        description: `${t.qn} question${t.qn === 1 ? '' : 's'}`,
        isParent: false
      }
    } else {
      // Empty leaf topic
      return {
        id: t.id,
        title: t.title,
        description: 'No questions yet',
        isParent: false
      }
    }
  })
  
  await pagedList(ctx, jid, {
    title: clip(title, 24), body: `*${title}*\nChoose what applies to you.`, button: 'Select an option',
    items: items.map(i => ({ id: i.id, title: i.title, description: i.description })),
    prefix: 'topic', page, moreId: `topics:${courseId}:${parentId || 'root'}`,
    extraRows: [{ title: backLabel, description: 'Go back', rowId: backId }],
  })
}

async function pickQuestion(s, topicId) {
  const questions = await prisma.question.findMany({
    where: { topicId },
    orderBy: { createdAt: 'asc' }
  })
  if (!questions.length) return { q: null }
  const state = getState(s)
  const sessionSeen = new Set(state.sessionSeen || [])
  const dbAttempts = await prisma.attempt.findMany({
    where: { studentId: s.id },
    select: { questionId: true }
  })
  const dbSeen = new Set(dbAttempts.map((r) => r.questionId))
  const allSeen = new Set([...sessionSeen, ...dbSeen])
  const unseen = questions.find((q) => !allSeen.has(q.id))
  if (unseen) return { q: unseen }
  return { q: questions[0], completed: true }
}

async function sendPaywall(ctx, s, jid) {
  await setState(s, { step: 'paywall' })
  const price = await money(await premiumPrice())
  await buttons(ctx, jid,
    `🔒 You've used all *${await trialLimit()} free trial questions*.\n\nUnlock unlimited questions, explanations and ranking with a one-time payment of *${price}*.`,
    [{ id: 'pay', text: 'Mobile Money Pay' }], 'Pay securely with MTN or Airtel Money')
}

async function serveQuestion(ctx, s, jid, q, { completed = false } = {}) {
  s = await fresh(s)
  if (!q) return text(ctx, jid, 'There are no questions in this topic yet.')
  if (await exhausted(s)) return sendPaywall(ctx, s, jid)
  const topic = await prisma.topic.findUnique({ where: { id: q.topicId }, select: { id: true, name: true, courseId: true } })
  const state = getState(s)
  const sessionSeen = [...(state.sessionSeen || []), q.id]
  await setState(s, { step: 'answering', courseId: topic.courseId, topicId: topic.id, questionId: q.id, sessionSeen })

  // Send question header image if present
  if (q.headerImage) {
    const buffer = await fetchFromS3(q.headerImage)
    if (buffer) {
      const mime = q.headerMime || 'image/jpeg'
      try {
        await ctx.sock.sendMessage(jid, { image: buffer, mimetype: mime, caption: `*${topic.name}*` })
      } catch (e) {
        console.error('[bot] question header image send failed:', e.message)
      }
    }
  }

  if (q.documentFile) {
    const buffer = await fetchFromS3(q.documentFile)
    if (buffer) {
      const mime = q.documentMime || 'application/octet-stream'
      const content = mime.startsWith('image/')
        ? { image: buffer, caption: q.documentName || '' }
        : { document: buffer, mimetype: mime, fileName: q.documentName || q.documentFile }
      await ctx.sock.sendMessage(jid, content).catch((e) => console.error('[bot] document send failed:', e.message))
    }
  }

  const opts = JSON.parse(q.options || '[]')
  const note = completed ? '🔁 You have answered every question in this topic — cycling through them again.\n\n' : ''
  const body = `${note}*${topic.name}*\n\n${q.text}`
  const footer = s.premium ? 'Premium' : `Trial ${Math.min(s.trialsUsed + (await hasAttempted(s.id, q.id) ? 0 : 1), await trialLimit())} of ${await trialLimit()}`
  await buttons(ctx, jid, body, opts.map((o, i) => ({ id: `ans:${q.id}:${i}`, text: `${LETTERS[i]}. ${o}` })), footer)
}

async function handleAnswer(ctx, s, jid, qid, idx) {
  const q = await prisma.question.findUnique({ where: { id: qid } })
  if (!q) return showMenu(ctx, s, jid)
  const opts = JSON.parse(q.options || '[]')
  if (!(idx >= 0 && idx < opts.length)) return
  if (await exhausted(await fresh(s)) && !(await hasAttempted(s.id, qid))) return sendPaywall(ctx, s, jid)

  const first = !(await hasAttempted(s.id, qid))
  const correct = idx === q.correct
  await prisma.attempt.create({
    data: { studentId: s.id, questionId: qid, selected: idx, isCorrect: correct }
  })
  if (first && !s.premium) await prisma.student.update({ where: { id: s.id }, data: { trialsUsed: { increment: 1 } } })
  s = await fresh(s)
  await setState(s, { ...getState(s), step: 'feedback', questionId: qid })

  const done = await exhausted(s)
  const head = correct
    ? `✅ *Correct!* ${LETTERS[idx]}. ${opts[idx]} is the right answer.`
    : `❌ *Wrong answer.* You chose ${LETTERS[idx]}. ${opts[idx]}.\nTap *Explain* to see the correct answer and why, or *Re-attempt* to try again.`
  const btns = done
    ? [{ id: `explain:${qid}`, text: 'Explain' }]
    : correct
      ? [{ id: `explain:${qid}`, text: 'Explain' }, { id: `next:${qid}`, text: 'Next question' }, { id: `retry:${qid}`, text: 'Re-attempt' }]
      : [{ id: `retry:${qid}`, text: 'Re-attempt' }, { id: `explain:${qid}`, text: 'Explain' }, { id: `next:${qid}`, text: 'Next question' }]
  await buttons(ctx, jid, head, btns)
  if (done) await sendPaywall(ctx, s, jid)
}

async function handleExplain(ctx, s, jid, qid) {
  const q = await prisma.question.findUnique({ where: { id: qid } })
  if (!q) return showMenu(ctx, s, jid)
  const opts = JSON.parse(q.options || '[]')
  const body = `💡 *Explanation*\n\n${q.text}\n\n✅ Correct answer: *${LETTERS[q.correct]}. ${opts[q.correct]}*\n\n${q.explanation?.trim() || 'No explanation has been added for this question yet.'}`
  s = await fresh(s)
  if (await exhausted(s)) { await text(ctx, jid, body); return sendPaywall(ctx, s, jid) }
  await buttons(ctx, jid, body, [{ id: `next:${qid}`, text: 'Next question' }, { id: `retry:${qid}`, text: 'Re-attempt' }])
}

async function handleRank(ctx, s, jid) {
  const { me, total, top } = await studentStats(s.id)
  if (!me) return text(ctx, jid, '📊 You have not answered any questions yet. Say *hi* to pick a course and start!')
  const mask = (r) => `${(r.name || 'Student').split(' ')[0]} …${r.phone.slice(-3)}`
  const medals = ['🥇', '🥈', '🥉']
  const left = s.premium ? 'Premium (unlimited)' : `${Math.max(0, await trialLimit() - s.trialsUsed)} free question(s) left`
  await text(ctx, jid,
    `📊 *Your stats*\n\n🏆 Rank: *#${me.rank}* of ${total} student${total === 1 ? '' : 's'}\n` +
    `📝 Questions attempted: *${me.attempted}*\n✅ Answered correctly: *${me.correct}*\n🎯 Accuracy: *${me.accuracy}%* (${me.correct_attempts} of ${me.total_attempts} attempts)\n🎁 Access: ${left}\n\n` +
    `*Top students*\n${top.map((r, i) => `${medals[i]} ${mask(r)} — ${r.correct} correct (${r.accuracy}%)`).join('\n')}\n\nSay *hi* to keep practising.`)
}

async function startPayment(ctx, s, jid, msisdn) {
  try {
    const { amount, currency } = await initiatePayment({ student: s, msisdn })
    await setState(s, { step: 'awaiting_payment' })
    await text(ctx, jid, `📲 A mobile money prompt for *${currency} ${amount.toLocaleString('en-US')}* has been sent to *${msisdn}*.\n\nApprove it on your phone with your PIN. I'll unlock your account the moment it's confirmed.`)
  } catch (err) {
    console.error('[bot] payment failed:', err.message)
    await setState(s, { step: 'paywall' })
    await buttons(ctx, jid, "⚠️ We couldn't start that payment. Please try again in a moment.", [{ id: 'pay', text: 'Mobile Money Pay' }])
  }
}

/* ---------- entry point ---------- */

const queues = new Map()

export function handleMessage(ctx, msg) {
  const jid = msg.key.remoteJid
  if (!jid || msg.key.fromMe || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return
  const prev = queues.get(jid) || Promise.resolve()
  const next = prev.then(() => process(ctx, msg, jid)).catch((e) => console.error('[bot] error:', e)).finally(() => { if (queues.get(jid) === next) queues.delete(jid) })
  queues.set(jid, next)
}

async function process(ctx, msg, jid) {
  /* Immediately show typing indicator so user knows bot is responding */
  sendTyping(ctx, jid)
  /* Mark message as seen (blue ticks) */
  markSeen(ctx, msg)

  const input = parseIncoming(msg)
  if (!input) return
  const realJid = msg.key.remoteJidAlt || msg.key.senderPn || jid
  const phone = realJid.split('@')[0].split(':')[0]
  let s = await upsertStudent({ phone, jid, name: msg.pushName, sessionId: ctx.sessionId })
  const state = getState(s)
  const { id } = input
  const raw = (input.text || '').trim()
  const lower = raw.toLowerCase()

  if (id) {
    const [kind, a, b, c] = id.split(':')
    switch (kind) {
      case 'menu': return showMenu(ctx, s, jid)
      case 'courses': return showMenu(ctx, s, jid, { page: Number(a) || 0 })
      case 'course': return showTopics(ctx, s, jid, a)
      case 'topics': return showTopics(ctx, s, jid, a, b || null, Number(c) || 0)
      case 'topic_parent': return showTopics(ctx, s, jid, b, a || null)
      case 'topic': {
        // Check if topic has children - if so, navigate into it
        const topic = await prisma.topic.findUnique({ 
          where: { id: a }, 
          include: { _count: { select: { questions: true } } } 
        })
        if (!topic) return showMenu(ctx, s, jid)
        
        const childrenCount = await prisma.topic.count({ where: { parentId: a } })
        if (childrenCount > 0) {
          // Has submenus - navigate into it
          const course = await prisma.course.findUnique({ where: { id: topic.courseId } })
          return showTopics(ctx, s, jid, topic.courseId, a)
        }
        // Leaf topic - serve questions
        const { q, completed } = await pickQuestion(s, a)
        return serveQuestion(ctx, s, jid, q, { completed })
      }
      case 'ans': return handleAnswer(ctx, s, jid, a, Number(b))
      case 'retry': return serveQuestion(ctx, s, jid, await prisma.question.findUnique({ where: { id: a } }))
      case 'explain': return handleExplain(ctx, s, jid, a)
      case 'next': {
        const cur = await prisma.question.findUnique({ where: { id: a } })
        if (!cur) return showMenu(ctx, s, jid)
        const { q, completed } = await pickQuestion(s, cur.topicId)
        return serveQuestion(ctx, s, jid, q, { completed })
      }
      case 'pay':
        await setState(s, { step: 'await_msisdn' })
        return text(ctx, jid, `💳 Which mobile money number should we charge *${await money(await premiumPrice())}* to?\n\nReply with the number (e.g. 0771234567), or reply *same* to use this WhatsApp number.`)
    }
  }

  if (/^(rank|ranking|my rank|stats|my stats|position)$/i.test(lower)) return handleRank(ctx, s, jid)

  if (state.step === 'await_msisdn') {
    const msisdn = normalizeMsisdn(lower === 'same' || lower === 'yes' ? phone : raw)
    if (!msisdn) return text(ctx, jid, "That doesn't look like a valid number. Send it like *0771234567*, or reply *same*.")
    return startPayment(ctx, s, jid, msisdn)
  }

  if (state.step === 'answering' && /^[abc]\.?$/.test(lower)) {
    return handleAnswer(ctx, s, jid, state.questionId, 'abc'.indexOf(lower[0]))
  }
  if (state.questionId && /^(next|next question)$/.test(lower)) {
    const cur = await prisma.question.findUnique({ where: { id: state.questionId } })
    if (cur) { const { q, completed } = await pickQuestion(s, cur.topicId); return serveQuestion(ctx, s, jid, q, { completed }) }
  }
  if (state.questionId && /^(retry|re-?attempt|try again)$/.test(lower)) return serveQuestion(ctx, s, jid, await prisma.question.findUnique({ where: { id: state.questionId } }))
  if (state.questionId && /^(explain|explanation)$/.test(lower)) return handleExplain(ctx, s, jid, state.questionId)
  if (state.step === 'paywall' && /^(pay|buy|upgrade)$/.test(lower)) {
    await setState(s, { step: 'await_msisdn' })
    return text(ctx, jid, 'Reply with the mobile money number to charge (e.g. 0771234567), or *same* to use this WhatsApp number.')
  }

  const attemptsCount = await prisma.attempt.count({ where: { studentId: s.id } })
  const isNew = !state.greeted && attemptsCount === 0
  const isGreeting = /^(hi+|hello+|hey+|hie|hola|start|menu|courses|good\s+(morning|afternoon|evening))\b/i.test(raw)
  if (isGreeting || isNew) {
    await showMenu(ctx, s, jid, { greet: true })
    return setState(await fresh(s), { greeted: true })
  }
  if (!state.step) return showMenu(ctx, s, jid)
  return text(ctx, jid, 'Say *hi* for the course menu, or *rank* to see your ranking.')
}

export async function notifyPaid(ctx, student) {
  const jid = student.jid
  if (!jid) return
  await buttons(ctx, jid, `🎉 Payment received — you're now *Premium*! You have unlimited questions, explanations and ranking.`, [{ id: 'menu', text: 'Choose a course' }])
}

export async function notifyPaymentFailed(ctx, student) {
  if (!student.jid) return
  await buttons(ctx, student.jid, "⚠️ Your mobile money payment wasn't completed (declined, cancelled or timed out). No money was taken. Tap below to try again.", [{ id: 'pay', text: 'Mobile Money Pay' }])
}