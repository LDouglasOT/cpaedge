import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import QRCode from 'qrcode'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeVoidExtrasSocket,
} from '@sasa-dev/void-baileys'
import { all, get, run, SESSION_DIR } from '../db.js'
import { handleMessage, notifyPaid, notifyPaymentFailed } from './bot.js'
import { setNotifier, setFailNotifier } from '../payments.js'

const live = new Map()
const authDir = (id) => path.join(SESSION_DIR, id)
const setStatus = (id, status, extra = {}) => {
  const l = live.get(id)
  if (l) { l.status = status; Object.assign(l, extra) }
  run('UPDATE wa_sessions SET status = $1, phone = COALESCE($2, phone) WHERE id = $3', status, extra.phone ?? null, id).catch(() => {})
}

async function connect(id, { pairPhone } = {}) {
  const entry = live.get(id)
  if (!entry || entry.stopped) return
  const { state, saveCreds } = await useMultiFileAuthState(authDir(id))
  let version
  try { version = (await fetchLatestBaileysVersion()).version } catch {}

  const sock = makeWASocket({ auth: state, printQRInTerminal: false, ...(version ? { version } : {}) })
  const x = makeVoidExtrasSocket(sock)
  entry.sock = sock
  entry.x = x

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    if (entry.stopped || entry.sock !== sock) return
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      entry.qr = qr
      setStatus(id, 'qr')
    }
    if (connection === 'open') {
      const phone = (sock.user?.id || '').split(':')[0].split('@')[0]
      entry.qr = null
      entry.pairingCode = null
      setStatus(id, 'connected', { phone })
      console.log(`[wa:${id}] connected as ${phone}`)
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log(`[wa:${id}] logged out from the phone`)
        entry.qr = null
        fs.rmSync(authDir(id), { recursive: true, force: true })
        setStatus(id, 'logged_out')
        return
      }
      setStatus(id, 'reconnecting')
      entry.timer = setTimeout(() => connect(id).catch((e) => console.error(`[wa:${id}]`, e.message)), 3000)
    }
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) handleMessage({ sessionId: id, sock, x }, msg)
  })

  if (pairPhone && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairPhone.replace(/\D/g, ''))
        entry.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code
      } catch (e) {
        console.error(`[wa:${id}] pairing code failed:`, e.message)
      }
    }, 2500)
  }
}

export async function createSession(label, pairPhone) {
  const id = crypto.randomBytes(5).toString('hex')
  const count = Number((await get('SELECT COUNT(*) c FROM wa_sessions')).c) + 1
  await run('INSERT INTO wa_sessions(id, label, status) VALUES ($1, $2, $3)', id, label || `Account ${count}`, 'starting')
  live.set(id, { status: 'starting', qr: null, pairingCode: null, stopped: false })
  await connect(id, { pairPhone })
  return id
}

export async function terminateSession(id) {
  const entry = live.get(id)
  if (entry) {
    entry.stopped = true
    clearTimeout(entry.timer)
    try { await entry.sock?.logout() } catch {}
    try { entry.sock?.end?.(undefined) } catch {}
    live.delete(id)
  }
  fs.rmSync(authDir(id), { recursive: true, force: true })
  await run('DELETE FROM wa_sessions WHERE id = $1', id).catch(() => {})
}

export async function reconnectSession(id) {
  const row = await get('SELECT * FROM wa_sessions WHERE id = $1', id)
  if (!row) return false
  const old = live.get(id)
  if (old) { clearTimeout(old.timer); try { old.sock?.end?.(undefined) } catch {} }
  live.set(id, { status: 'starting', qr: null, pairingCode: null, stopped: false })
  await run('UPDATE wa_sessions SET status = $1 WHERE id = $2', 'starting', id)
  await connect(id)
  return true
}

export async function listSessions() {
  const rows = await all('SELECT * FROM wa_sessions ORDER BY created_at DESC')
  return Promise.all(rows.map(async (r) => {
    const l = live.get(r.id)
    const studentCount = Number((await get('SELECT COUNT(*) c FROM students WHERE session_id = $1', r.id)).c)
    return {
      ...r,
      status: l?.status || r.status,
      qr: l?.qr ? await QRCode.toDataURL(l.qr, { margin: 1, width: 300 }) : null,
      pairingCode: l?.pairingCode || null,
      students: studentCount,
    }
  }))
}

export async function restoreSessions() {
  for (const r of await all('SELECT * FROM wa_sessions')) {
    if (r.status === 'logged_out' || !fs.existsSync(authDir(r.id))) {
      live.set(r.id, { status: r.status === 'connected' ? 'logged_out' : r.status, qr: null, pairingCode: null, stopped: false })
      continue
    }
    live.set(r.id, { status: 'starting', qr: null, pairingCode: null, stopped: false })
    connect(r.id).catch((e) => console.error(`[wa:${r.id}] restore failed:`, e.message))
  }
}

const sessionFor = (student) => live.get(student.session_id)?.sock ? live.get(student.session_id) : [...live.values()].find((l) => l.status === 'connected')
setNotifier(async (student) => {
  const entry = sessionFor(student)
  if (entry?.sock) await notifyPaid({ sock: entry.sock, x: entry.x, sessionId: student.session_id }, student)
})
setFailNotifier(async (student) => {
  const entry = sessionFor(student)
  if (entry?.sock) await notifyPaymentFailed({ sock: entry.sock, x: entry.x, sessionId: student.session_id }, student)
})
