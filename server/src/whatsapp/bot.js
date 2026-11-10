import fs from 'node:fs'
import path from 'node:path'
import { all, get, run, getSetting, UPLOAD_DIR } from '../db.js'
import { initiatePayment, normalizeMsisdn } from '../payments.js'
import { studentStats } from '../stats.js'

const PAGE = 9
const LETTERS = ['A', 'B', 'C']
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

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
  let s = await get('SELECT * FROM students WHERE phone = $1', phone)
  if (!s) {
    s = await get(`INSERT INTO students(phone, name, jid, session_id) VALUES ($1, $2, $3, $4) RETURNING *`, phone, name || '', jid, sessionId)
  } else {
    s = await get(`UPDATE students SET jid = $1, session_id = $2, last_seen = NOW(), name = CASE WHEN name = '' THEN $3 ELSE name END WHERE id = $4 RETURNING *`, jid, sessionId, name || '', s.id)
  }
  return s
}
const getState = (s) => { try { return JSON.parse(s.state || '{}') } catch { return {} } }
const setState = (s, state) => run('UPDATE students SET state = $1 WHERE id = $2', JSON.stringify(state), s.id)
const fresh = (s) => get('SELECT * FROM students WHERE id = $1', s.id)
const exhausted = async (s) => !s.premium && s.trialsUsed >= await trialLimit()
const hasAttempted = async (sid, qid) => !!await get('SELECT 1 FROM attempts WHERE student_id = $1 AND question_id = $2 LIMIT 1', sid, qid)

const money = async (n) => `${await getSetting('currency')} ${Number(n).toLocaleString('en-US')}`
const trialLimit = async () => Number(await getSetting('trial_limit'))
const premiumPrice = async () => Number(await getSetting('premium_price'))
const welcomeMessage = async () => await getSetting('welcome_message')
const botName = async () => await getSetting('bot_name')

/* ---------- outbound helpers ---------- */

const text = (ctx, jid, body) => ctx.sock.sendMessage(jid, { text: body })

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

/* ---------- flow ---------- */

async function showMenu(ctx, s, jid, { greet = false, page = 0 } = {}) {
  const courses = await all(`
    SELECT c.id, c.name title, c.description,
      (SELECT COUNT(*) FROM questions q JOIN topics t ON t.id = q.topic_id WHERE t.course_id = c.id) qn
    FROM courses c ORDER BY c.name`)
    .map((c) => ({ ...c, description: `${c.qn} question${c.qn === 1 ? '' : 's'}${c.description ? ' · ' + c.description : ''}` }))
    .filter((c) => c.qn > 0)
  await setState(s, {})
  if (greet) {
    const name = (s.name || '').split(' ')[0]
    const welcome = await welcomeMessage().replaceAll('{bot}', await botName()).replaceAll('{trials}', String(await trialLimit()))
    await text(ctx, jid, `Hello${name ? ' ' + name : ''} 👋\n\n${welcome}`)
  }
  if (!courses.length) return text(ctx, jid, 'No courses are available yet. Please check back soon.')
  const status = s.premium ? '⭐ Premium — unlimited practice' : `🎁 Free trial: ${Math.max(0, await trialLimit() - s.trialsUsed)} of ${await trialLimit()} questions left`
  await pagedList(ctx, jid, {
    title: 'Courses', body: `Select a course to attempt.\n${status}\n\nType *rank* any time to see your ranking.`,
    button: 'Choose course', items: courses, prefix: 'course', page, moreId: 'courses',
  })
}

async function showTopics(ctx, s, jid, courseId, page = 0) {
  const course = await get('SELECT * FROM courses WHERE id = $1', courseId)
  if (!course) return showMenu(ctx, s, jid)
  const topics = await all(`SELECT t.id, t.name title,
    (SELECT COUNT(*) FROM questions q WHERE q.topic_id = t.id) qn
    FROM topics t WHERE t.course_id = $1 ORDER BY t.name`, courseId)
    .filter((t) => t.qn > 0)
  if (!topics.length) { await text(ctx, jid, `*${course.name}* has no questions yet.`); return showMenu(ctx, s, jid) }
  await setState(s, { courseId })
  await pagedList(ctx, jid, {
    title: clip(course.name, 24), body: `*${course.name}*\nChoose a sub topic to practise.`, button: 'Choose topic',
    items: topics, prefix: 'topic', page, moreId: `topics:${courseId}`,
    extraRows: [{ title: '⬅️ All courses', description: 'Back to the course list', rowId: 'menu' }],
  })
}

async function pickQuestion(s, topicId) {
  const qs = await all('SELECT * FROM questions WHERE topic_id = $1 ORDER BY created_at', topicId)
  if (!qs.length) return { q: null }
  const seen = new Set((await all('SELECT question_id FROM attempts WHERE student_id = $1', s.id)).map((r) => r.question_id))
  const unseen = qs.find((q) => !seen.has(q.id))
  if (unseen) return { q: unseen }
  return { q: qs[0], completed: true }
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
  const topic = await get('SELECT t.id, t.name, t.course_id FROM topics t WHERE t.id = $1', q.topic_id)
  await setState(s, { step: 'answering', courseId: topic.course_id, topicId: topic.id, questionId: q.id })

  if (q.document_file) {
    const file = path.join(UPLOAD_DIR, q.document_file)
    if (fs.existsSync(file)) {
      const mime = q.document_mime || 'application/octet-stream'
      const content = mime.startsWith('image/')
        ? { image: fs.readFileSync(file), caption: q.document_name || '' }
        : { document: fs.readFileSync(file), mimetype: mime, fileName: q.document_name || q.document_file }
      await ctx.sock.sendMessage(jid, content).catch((e) => console.error('[bot] document send failed:', e.message))
    }
  }

  const opts = JSON.parse(q.options || '[]')
  const note = completed ? '🔁 You have answered every question in this topic — cycling through them again.\n\n' : ''
  const body = `${note}*${topic.name}*\n\n${q.text}\n\n${opts.map((o, i) => `*${LETTERS[i]}.* ${o}`).join('\n')}`
  const footer = s.premium ? 'Premium' : `Trial ${Math.min(s.trials_used + (await hasAttempted(s.id, q.id) ? 0 : 1), await trialLimit())} of ${await trialLimit()}`
  await buttons(ctx, jid, body, opts.map((o, i) => ({ id: `ans:${q.id}:${i}`, text: `${LETTERS[i]}. ${o}` })), footer)
}

async function handleAnswer(ctx, s, jid, qid, idx) {
  const q = await get('SELECT * FROM questions WHERE id = $1', qid)
  if (!q) return showMenu(ctx, s, jid)
  const opts = JSON.parse(q.options || '[]')
  if (!(idx >= 0 && idx < opts.length)) return
  if (await exhausted(await fresh(s)) && !(await hasAttempted(s.id, qid))) return sendPaywall(ctx, s, jid)

  const first = !(await hasAttempted(s.id, qid))
  const correct = idx === q.correct
  await run('INSERT INTO attempts(student_id, question_id, selected, is_correct) VALUES ($1, $2, $3, $4)', s.id, qid, idx, correct)
  if (first && !s.premium) await run('UPDATE students SET trials_used = trials_used + 1 WHERE id = $1', s.id)
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
  const q = await get('SELECT * FROM questions WHERE id = $1', qid)
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
  const left = s.premium ? 'Premium (unlimited)' : `${Math.max(0, await trialLimit() - s.trials_used)} free question(s) left`
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
    const [kind, a, b] = id.split(':')
    switch (kind) {
      case 'menu': return showMenu(ctx, s, jid)
      case 'courses': return showMenu(ctx, s, jid, { page: Number(a) || 0 })
      case 'course': return showTopics(ctx, s, jid, a)
      case 'topics': return showTopics(ctx, s, jid, a, Number(b) || 0)
      case 'topic': {
        const { q, completed } = await pickQuestion(s, a)
        return serveQuestion(ctx, s, jid, q, { completed })
      }
      case 'ans': return handleAnswer(ctx, s, jid, a, Number(b))
      case 'retry': return serveQuestion(ctx, s, jid, await get('SELECT * FROM questions WHERE id = $1', a))
      case 'explain': return handleExplain(ctx, s, jid, a)
      case 'next': {
        const cur = await get('SELECT * FROM questions WHERE id = $1', a)
        if (!cur) return showMenu(ctx, s, jid)
        const { q, completed } = await pickQuestion(s, cur.topic_id)
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
    return handleAnswer(ctx, s, jid, state.question_id, 'abc'.indexOf(lower[0]))
  }
  if (state.question_id && /^(next|next question)$/.test(lower)) {
    const cur = await get('SELECT * FROM questions WHERE id = $1', state.question_id)
    if (cur) { const { q, completed } = await pickQuestion(s, cur.topic_id); return serveQuestion(ctx, s, jid, q, { completed }) }
  }
  if (state.question_id && /^(retry|re-?attempt|try again)$/.test(lower)) return serveQuestion(ctx, s, jid, await get('SELECT * FROM questions WHERE id = $1', state.question_id))
  if (state.question_id && /^(explain|explanation)$/.test(lower)) return handleExplain(ctx, s, jid, state.question_id)
  if (state.step === 'paywall' && /^(pay|buy|upgrade)$/.test(lower)) {
    await setState(s, { step: 'await_msisdn' })
    return text(ctx, jid, 'Reply with the mobile money number to charge (e.g. 0771234567), or *same* to use this WhatsApp number.')
  }

  const isNew = !state.greeted && Number((await get('SELECT COUNT(*) c FROM attempts WHERE student_id = $1', s.id)).c) === 0
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
