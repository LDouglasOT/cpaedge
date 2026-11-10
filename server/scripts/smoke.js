// Drives the bot with a fake WhatsApp socket and prints what it would send. Run: npm run smoke
process.env.DATA_DIR = process.env.DATA_DIR || './data-smoke'
process.env.MOCK_CONFIRM_MS = '50'
process.env.PAYMENT_PROVIDER = 'mock'
import fs from 'node:fs'
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true })

const { run, get } = await import('../src/db.js')
const { handleMessage, notifyPaid } = await import('../src/whatsapp/bot.js')
const { setNotifier } = await import('../src/payments.js')
const { dashboard } = await import('../src/stats.js')

const out = []
const sock = { sendMessage: async (_j, c) => out.push({ type: 'msg', ...c }) }
const x = {
  sendButton: async (_j, c) => out.push({ type: 'buttons', text: c.text, buttons: c.buttons.map((b) => `${b.id} «${b.text}»`) }),
  sendList: async (_j, c) => out.push({ type: 'list', text: c.text, rows: c.sections[0].rows.map((r) => `${r.rowId} «${r.title}»`) }),
}
const ctx = { sessionId: 'smoke', sock, x }
setNotifier(async (s) => notifyPaid(ctx, s))

const c = run("INSERT INTO courses(name, description) VALUES ('Mathematics', 'S4')").lastInsertRowid
const t = run('INSERT INTO topics(course_id, name) VALUES (?, ?)', c, 'Algebra').lastInsertRowid
for (let i = 1; i <= 7; i++)
  run('INSERT INTO questions(topic_id, text, options, correct, explanation) VALUES (?, ?, ?, ?, ?)', t, `Q${i}: what is ${i}+${i}?`, JSON.stringify([`${i * 2}`, `${i * 2 + 1}`, `${i}`]), 0, `Because ${i}+${i}=${i * 2}`)

let n = 0
const send = async (input) => {
  out.length = 0
  const message = typeof input === 'string'
    ? { conversation: input }
    : { buttonsResponseMessage: { selectedButtonId: input.id, selectedDisplayText: 'x' } }
  handleMessage(ctx, { key: { remoteJid: '256771234567@s.whatsapp.net', fromMe: false, id: String(++n) }, pushName: 'Doug Test', message })
  await new Promise((r) => setTimeout(r, 40))
  console.log(`\n> ${typeof input === 'string' ? input : input.id}`)
  for (const o of out) console.log('  <', o.type, JSON.stringify(o.text ?? o.caption ?? '').slice(0, 90), o.buttons || o.rows || '')
  return [...out]
}
const ok = (cond, msg) => { console.log(cond ? `  ✔ ${msg}` : `  ✘ FAIL: ${msg}`); if (!cond) process.exitCode = 1 }

let r = await send('hi')
ok(r[0].type === 'msg' && r[1].type === 'list', 'greeting + welcome + course list')
r = await send({ id: `course:${c}` })
ok(r[0].rows.some((x) => x.startsWith('topic:')), 'topic list')
r = await send({ id: `topic:${t}` })
ok(r[0].buttons.length === 3 && r[0].buttons[0].startsWith('ans:'), 'question with 3 answer buttons')
let q = get('SELECT * FROM questions ORDER BY id').id
r = await send({ id: `ans:${q}:1` })
ok(r[0].text.includes('Wrong') && r[0].buttons.length === 3, 'wrong answer → explain / re-attempt / next')
r = await send({ id: `retry:${q}` })
ok(r[0].text.includes('Q1'), 're-attempt shows same question')
r = await send({ id: `ans:${q}:0` })
ok(r[0].text.includes('Correct'), 'correct answer feedback')
r = await send({ id: `explain:${q}` })
ok(r[0].text.includes('Because 1+1=2'), 'explain shows the explanation')
for (let i = 2; i <= 5; i++) {
  r = await send({ id: `next:${i - 1}` })
  ok(r[0].text.includes(`Q${i}`), `next → Q${i}`)
  r = await send({ id: `ans:${i}:0` })
}
ok(r.length === 2 && r[1].buttons.length === 1 && r[1].buttons[0].startsWith('pay'), '5th answer → feedback then single payment button')
r = await send({ id: 'next:5' })
ok(r[0].buttons?.length === 1 && r[0].buttons[0].startsWith('pay'), 'next after trials → paywall, no question')
r = await send('rank')
ok(r[0].text.includes('#1') && r[0].text.includes('Accuracy'), 'rank stats')
await send({ id: 'pay' })
r = await send('0771234567')
ok(r[0].text.includes('256771234567'), 'payment prompt sent to normalised number')
await new Promise((r) => setTimeout(r, 300))
ok(out.some((o) => /Premium/.test(o.text || '')), 'payment confirmation delivered over WhatsApp')
ok(get('SELECT premium FROM students').premium === 1, 'student upgraded to premium')
r = await send({ id: 'next:5' })
ok(r[0].text.includes('Q6'), 'premium student gets more questions')
const d = dashboard()
console.log('\ndashboard:', JSON.stringify({ ...d.totals, accuracy: d.performance.accuracy, recent: d.recentTransactions.length }))
ok(d.totals.revenue === 5000 && d.totals.premium === 1, 'dashboard revenue + premium count')
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true })
process.exit()
