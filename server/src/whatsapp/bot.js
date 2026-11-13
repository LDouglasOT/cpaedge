import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma, getSetting } from '../db.js'
import { initiatePayment, normalizeMsisdn } from '../payments.js'
import { studentStats } from '../stats.js'
import { downloadMediaMessage } from '@sasa-dev/void-baileys/lib/Utils/messages.js'
import { gradeLongAnswer, generateExplanation } from '../groq.js'
import crypto from 'node:crypto'

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

async function uploadToS3(buffer, mime, originalName = "image.png") {
  const filename = crypto.randomBytes(12).toString("hex") + "." + (mime?.split("/")[1] || "png")
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: filename,
    Body: buffer,
    ContentType: mime || "image/png"
  })
  await getS3Client().send(cmd)
  return filename
}

/* ---------- long question helpers ---------- */

function parseJsonSafe(v, fallback) {
  try { return JSON.parse(v || "") ?? fallback } catch { return fallback }
}

async function sendQuestionImage(ctx, jid, q, pageIndex, topicName) {
  const qImgs = parseJsonSafe(q.questionImages, [])
  if (!qImgs.length) return false
  const img = qImgs[pageIndex]
  if (!img?.file) return false
  const buffer = await fetchFromS3(img.file)
  if (!buffer) return false
  const mime = img.mime || "image/jpeg"
  const total = qImgs.length
  const caption = total > 1 ? "*" + topicName + "* - Question " + (pageIndex + 1) + " of " + total : "*" + topicName + "*"
  const buttonsList = []
  if (pageIndex > 0) buttonsList.push({ id: "qimg:" + q.id + ":" + (pageIndex - 1), text: "Previous" })
  if (pageIndex < total - 1) buttonsList.push({ id: "qimg:" + q.id + ":" + (pageIndex + 1), text: "Next" })
  buttonsList.push({ id: "submit_answer:" + q.id, text: "Submit Answer" })
  if (q.type === "long" && q.modelAnswerImages && parseJsonSafe(q.modelAnswerImages, []).length) {
    buttonsList.push({ id: "get_answer:" + q.id + ":0", text: "Get Answer" })
  }
  buttonsList.push({ id: "explain:" + q.id, text: "Get Explanation" })
  await buttons(ctx, jid, caption, buttonsList)
  return true
}

async function sendModelAnswerImage(ctx, jid, q, pageIndex, topicName) {
  const aImgs = parseJsonSafe(q.modelAnswerImages, [])
  if (!aImgs.length) return false
  const img = aImgs[pageIndex]
  if (!img?.file) return false
  const buffer = await fetchFromS3(img.file)
  if (!buffer) return false
  const mime = img.mime || "image/jpeg"
  const total = aImgs.length
  const caption = total > 1 ? "*" + topicName + "* - Model Answer " + (pageIndex + 1) + " of " + total : "*" + topicName + "* - Model Answer"
  const buttonsList = []
  if (pageIndex > 0) buttonsList.push({ id: "get_answer:" + q.id + ":" + (pageIndex - 1), text: "Previous" })
  if (pageIndex < total - 1) buttonsList.push({ id: "get_answer:" + q.id + ":" + (pageIndex + 1), text: "Next" })
  buttonsList.push({ id: "submit_answer:" + q.id, text: "Submit Answer" })
  buttonsList.push({ id: "explain:" + q.id, text: "Get Explanation" })
  await buttons(ctx, jid, caption, buttonsList)
  return true
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
        await ctx.sock.sendMessage(jid, { image: buffer, mimetype: mime, caption: '*' + topic.name + '*' })
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

  // Long/image questions: send first question image page with paging controls
  if (q.type === 'long') {
    const qImgs = parseJsonSafe(q.questionImages, [])
    if (qImgs.length > 0) {
      await sendQuestionImage(ctx, jid, q, 0, topic.name)
      return
    }
    // Text-only long question: show text with submit/get answer/explanation buttons
    const body = (completed ? 'You have answered every question in this topic - cycling through them again.\n\n' : '') + '*' + topic.name + '*\n\n' + (q.text || '(Image question)')
    const btns = [{ id: 'submit_answer:' + q.id, text: 'Submit Answer' }]
    if (q.modelAnswerImages && parseJsonSafe(q.modelAnswerImages, []).length) btns.push({ id: 'get_answer:' + q.id + ':0', text: 'Get Answer' })
    btns.push({ id: 'explain:' + q.id, text: 'Get Explanation' })
    const footer = s.premium ? 'Premium' : 'Trial ' + Math.min(s.trialsUsed + (await hasAttempted(s.id, q.id) ? 0 : 1), await trialLimit()) + ' of ' + await trialLimit()
    await buttons(ctx, jid, body, btns, footer)
    return
  }

  // Objective questions (existing flow)
  const opts = JSON.parse(q.options || '[]')
  const note = completed ? 'You have answered every question in this topic - cycling through them again.\n\n' : ''
  const body = note + '*' + topic.name + '*\n\n' + q.text
  const footer = s.premium ? 'Premium' : 'Trial ' + Math.min(s.trialsUsed + (await hasAttempted(s.id, q.id) ? 0 : 1), await trialLimit()) + ' of ' + await trialLimit()
  await buttons(ctx, jid, body, opts.map((o, i) => ({ id: 'ans:' + q.id + ':' + i, text: LETTERS[i] + '. ' + o })), footer)
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
  
  // Long questions: use AI to generate explanation
  if (q.type === 'long') {
    await sendTyping(ctx, jid)
    const qImgs = parseJsonSafe(q.questionImages, [])
    const aImgs = parseJsonSafe(q.modelAnswerImages, [])
    const qImgBuffers = []
    for (const img of qImgs) {
      const buf = await fetchFromS3(img.file)
      if (buf) qImgBuffers.push({ buffer: buf, mime: img.mime || 'image/jpeg' })
    }
    const aImgBuffers = []
    for (const img of aImgs) {
      const buf = await fetchFromS3(img.file)
      if (buf) aImgBuffers.push({ buffer: buf, mime: img.mime || 'image/jpeg' })
    }
    const explanation = await generateExplanation({
      questionText: q.text || '',
      questionImages: qImgBuffers,
      modelAnswer: q.modelAnswer || '',
      modelAnswerImages: aImgBuffers
    })
    const body = '💡 *Explanation*\n\n' + explanation
    s = await fresh(s)
    if (await exhausted(s)) { await text(ctx, jid, body); return sendPaywall(ctx, s, jid) }
    await buttons(ctx, jid, body, [{ id: 'submit_answer:' + q.id, text: 'Submit Answer' }, { id: 'next:' + q.id, text: 'Next question' }, { id: 'retry:' + q.id, text: 'Re-attempt' }])
    return
  }
  
  // Objective questions (existing flow)
  const opts = JSON.parse(q.options || '[]')
  const body = '💡 *Explanation*\n\n' + q.text + '\n\n✅ Correct answer: *' + LETTERS[q.correct] + '. ' + opts[q.correct] + '*\n\n' + (q.explanation?.trim() || 'No explanation has been added for this question yet.')
  s = await fresh(s)
  if (await exhausted(s)) { await text(ctx, jid, body); return sendPaywall(ctx, s, jid) }
  await buttons(ctx, jid, body, [{ id: 'next:' + qid, text: 'Next question' }, { id: 'retry:' + qid, text: 'Re-attempt' }])
}


async function handleSubmitAnswer(ctx, s, jid, qid) {
  const q = await prisma.question.findUnique({ where: { id: qid } })
  if (!q) return showMenu(ctx, s, jid)
  await setState(s, { step: 'awaiting_answer_image_1', questionId: qid, studentAnswerImages: [], studentAnswerText: '' })
  await text(ctx, jid, '📸 Please take a photo of your answer and send it here (page 1 of 3 — first image is required). You can also type your answer as text.')
}


async function handleStudentAnswer(ctx, s, jid, msg, qid) {
  console.log('[bot] handleStudentAnswer called, qid:', qid)
  const q = await prisma.question.findUnique({ where: { id: qid } })
  if (!q) return showMenu(ctx, s, jid)
  
  const state = getState(s)
  console.log('[bot] state:', JSON.stringify(state))
  const currentStep = state.step || ''
  const isAwaitingImage = currentStep.startsWith('awaiting_answer_image_')
  
  if (!isAwaitingImage) {
    await buttons(ctx, jid, 'Please use the "Submit Answer" button first.', [{ id: 'topic:' + q.topicId, text: 'Cancel ❌' }])
    return
  }
  
  await sendTyping(ctx, jid)
  
  const imageNum = parseInt(currentStep.split('_').pop()) || 1
  const studentAnswerImages = state.studentAnswerImages || []
  let studentAnswerText = state.studentAnswerText || ''
  console.log('[bot] loaded images:', studentAnswerImages.length, 'text:', studentAnswerText)
  
  // Handle image message
  const m = msg.message
  if (m?.imageMessage || m?.documentWithCaptionMessage?.message?.imageMessage) {
    console.log('[bot] image message detected')
    const imgMsg = m.imageMessage || m.documentWithCaptionMessage.message.imageMessage
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console, reuploadRequest: ctx.sock.reuploadRequest })
      const mime = imgMsg.mimetype || 'image/jpeg'
      const filename = await uploadToS3(buffer, mime)
      studentAnswerImages.push({ file: filename, mime, name: 'answer_' + Date.now() + '.jpg' })
      console.log('[bot] image uploaded, total:', studentAnswerImages.length)
    } catch (e) {
      console.error('[bot] failed to download student answer image:', e.message)
      await text(ctx, jid, 'Failed to download your image. Please try again.')
      return
    }
  }
  
  // Handle text message (append to answer text)
  const input = parseIncoming(msg)
  console.log('[bot] parseIncoming result:', JSON.stringify(input))
  // Ignore button display text - only process actual user text/image messages
  const isButtonResponse = !!input?.id
  if (!isButtonResponse && input?.text) {
    const txt = input.text.trim()
    console.log('[bot] input text:', txt)
    if (txt && !['done', 'finish', 'submit'].includes(txt.toLowerCase())) {
      studentAnswerText = studentAnswerText ? studentAnswerText + '\n' + txt : txt
    }
  }
  
  // Check if student wants to finish (typed "done" or reached max images)
  // Only check for text commands if NOT a button response
  const wantsToFinish = !isButtonResponse && input?.text?.toLowerCase()?.includes('done') || 
                        !isButtonResponse && input?.text?.toLowerCase()?.includes('finish') || 
                        !isButtonResponse && input?.text?.toLowerCase()?.includes('submit') ||
                        studentAnswerImages.length >= 3
  console.log('[bot] wantsToFinish:', wantsToFinish, 'images:', studentAnswerImages.length)
  
  // Enforce: at least 1 image is mandatory before submission
  if ((wantsToFinish || studentAnswerImages.length >= 3) && studentAnswerImages.length === 0) {
    await text(ctx, jid, '❌ You must submit at least 1 image of your answer before finishing. Please send a photo of your work.')
    return
  }
  
  if (wantsToFinish || studentAnswerImages.length >= 3) {
    // Proceed to grading
    console.log('[bot] proceeding to grading with', studentAnswerImages.length, 'images')
    await gradeAndSendResult(ctx, s, jid, q, studentAnswerText, studentAnswerImages)
    return
  }
  
  // Ask for next image
  const nextNum = imageNum + 1
  if (nextNum <= 3) {
    await setState(s, { 
      ...state, 
      step: 'awaiting_answer_image_' + nextNum, 
      studentAnswerImages, 
      studentAnswerText 
    })
    const btns = [
      { id: 'finish_answer:' + qid, text: 'Done ✅' }
    ]
    const optional = imageNum >= 1 ? ' (optional)' : ''
    await buttons(ctx, jid, 
      '📸 Page ' + imageNum + ' received. Send page ' + nextNum + optional + ' or tap "Done" to submit.', 
      btns
    )
  } else {
    // Max reached, auto-grade
    await gradeAndSendResult(ctx, s, jid, q, studentAnswerText, studentAnswerImages)
  }
}


async function gradeAndSendResult(ctx, s, jid, q, studentAnswerText, studentAnswerImages) {
  await sendTyping(ctx, jid)
  
  // Fetch question images
  const qImgs = parseJsonSafe(q.questionImages, [])
  const qImgBuffers = []
  for (const img of qImgs) {
    const buf = await fetchFromS3(img.file)
    if (buf) qImgBuffers.push({ buffer: buf, mime: img.mime || 'image/jpeg' })
  }
  
  // Fetch model answer images
  const aImgs = parseJsonSafe(q.modelAnswerImages, [])
  const aImgBuffers = []
  for (const img of aImgs) {
    const buf = await fetchFromS3(img.file)
    if (buf) aImgBuffers.push({ buffer: buf, mime: img.mime || 'image/jpeg' })
  }
  
  // Fetch student answer images from S3
  const studentImgBuffers = []
  for (const img of studentAnswerImages) {
    const buf = await fetchFromS3(img.file)
    if (buf) studentImgBuffers.push({ buffer: buf, mime: img.mime || 'image/jpeg' })
  }
  
  // Grade with AI (include question explanation)
  const { score, feedback } = await gradeLongAnswer({
    questionText: q.text || '',
    modelAnswer: q.modelAnswer || '',
    modelAnswerImages: aImgBuffers,
    studentAnswerText: studentAnswerText,
    studentAnswerImages: studentImgBuffers,
    explanation: q.explanation || ''
  })
  
  // Save attempt
  const attempt = await prisma.attempt.create({
    data: {
      studentId: s.id,
      questionId: q.id,
      selected: -1,
      isCorrect: score >= 50,
      answerText: studentAnswerText || null,
      answerImages: studentAnswerImages.length ? JSON.stringify(studentAnswerImages) : null,
      answerMime: studentAnswerImages[0]?.mime || null,
      score,
      feedback,
      graded: true
    }
  })
  
  if (!s.premium) {
    const first = !(await hasAttempted(s.id, q.id))
    if (first) await prisma.student.update({ where: { id: s.id }, data: { trialsUsed: { increment: 1 } } })
  }
  
  // Clear awaiting state
  await setState(s, { ...getState(s), step: 'feedback', questionId: q.id, studentAnswerImages: [], studentAnswerText: '' })
  
  // Send result
  const isCorrect = score >= 50
  const head = isCorrect 
    ? '✅ *Correct!* Your answer scored ' + score + '%.'
    : '❌ *Needs improvement.* Your answer scored ' + score + '%.'
  const body = head + '\n\n📝 *Feedback:* ' + feedback
  
  s = await fresh(s)
  const done = await exhausted(s)
  const btns = done
    ? [{ id: 'explain:' + q.id, text: 'Get Explanation' }]
    : isCorrect
      ? [{ id: 'explain:' + q.id, text: 'Get Explanation' }, { id: 'next:' + q.id, text: 'Next question' }, { id: 'retry:' + q.id, text: 'Re-attempt' }]
      : [{ id: 'retry:' + q.id, text: 'Re-attempt' }, { id: 'explain:' + q.id, text: 'Get Explanation' }, { id: 'next:' + q.id, text: 'Next question' }]
  await buttons(ctx, jid, body, btns)
  if (done) await sendPaywall(ctx, s, jid)
}



async function handleRank(ctx, s, jid) {
  const { me, total, top } = await studentStats(s.id)
  if (!me) return text(ctx, jid, '📊 You have not answered any questions yet. Say *hi* to pick a course and start!')
  const left = s.premium ? 'Premium (unlimited)' : `${Math.max(0, await trialLimit() - s.trialsUsed)} free question(s) left`
  await text(ctx, jid,
    `📊 *Your Performance*\n\n` +
    `📝 Questions attempted: *${me.attempted}*\n` +
    `✅ Answered correctly: *${me.correct}*\n` +
    `🎯 Accuracy: *${me.accuracy}%* (${me.correct_attempts} of ${me.total_attempts} attempts)\n` +
    `🎁 Access: ${left}\n\n` +
    `Say *hi* to keep practising.`)
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
  if (s.banned) {
    await text(ctx, jid, 'Your account has been suspended. Please contact support if you think this is a mistake.')
    return
  }
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
        const topic = await prisma.topic.findUnique({ 
          where: { id: a }, 
          include: { _count: { select: { questions: true } } } 
        })
        if (!topic) return showMenu(ctx, s, jid)
        const childrenCount = await prisma.topic.count({ where: { parentId: a } })
        if (childrenCount > 0) {
          const course = await prisma.course.findUnique({ where: { id: topic.courseId } })
          return showTopics(ctx, s, jid, topic.courseId, a)
        }
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
      case 'qimg': return sendQuestionImage(ctx, s, jid, await prisma.question.findUnique({ where: { id: a } }), Number(b), (await prisma.topic.findUnique({ where: { id: (await prisma.question.findUnique({ where: { id: a } })).topicId }, select: { name: true } })).name)
      case 'get_answer': return sendModelAnswerImage(ctx, s, jid, await prisma.question.findUnique({ where: { id: a } }), Number(b), (await prisma.topic.findUnique({ where: { id: (await prisma.question.findUnique({ where: { id: a } })).topicId }, select: { name: true } })).name)
      case 'submit_answer': return handleSubmitAnswer(ctx, s, jid, a)
      case 'finish_answer': 
        console.log('[bot] finish_answer button clicked, qid:', a)
        // Directly proceed to grading when Done button is clicked
        const qForFinish = await prisma.question.findUnique({ where: { id: a } })
        if (!qForFinish) return showMenu(ctx, s, jid)
        const stateForFinish = getState(s)
        const studentAnswerImages = stateForFinish.studentAnswerImages || []
        const studentAnswerText = stateForFinish.studentAnswerText || ''
        if (studentAnswerImages.length === 0) {
          await text(ctx, jid, '❌ You must submit at least 1 image of your answer before finishing. Please send a photo of your work.')
          return
        }
        return gradeAndSendResult(ctx, s, jid, qForFinish, studentAnswerText, studentAnswerImages)
      case 'pay':
        await setState(s, { step: 'await_msisdn' })
        return text(ctx, jid, '💳 Which mobile money number should we charge *' + await money(await premiumPrice()) + '* to?\n\nReply with the number (e.g. 0771234567), or reply *same* to use this WhatsApp number.')
    }
  }

  if (/^(rank|ranking|my rank|stats|my stats|position)$/i.test(lower)) return handleRank(ctx, s, jid)

  if (state.step === 'await_msisdn') {
    const msisdn = normalizeMsisdn(lower === 'same' || lower === 'yes' ? phone : raw)
    if (!msisdn) return text(ctx, jid, "That doesn't look like a valid number. Send it like *0771234567*, or reply *same*.")
    return startPayment(ctx, s, jid, msisdn)
  }

  // Handle student answer submission (image or text) for long questions
  if (state.step && state.step.startsWith('awaiting_answer_image') && state.questionId) {
    return handleStudentAnswer(ctx, s, jid, msg, state.questionId)
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