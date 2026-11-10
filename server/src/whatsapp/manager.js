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
import { prisma, SESSION_DIR } from '../db.js'
import { handleMessage, notifyPaid, notifyPaymentFailed } from './bot.js'
import { setNotifier, setFailNotifier } from '../payments.js'

const live = new Map()
const authDir = (id) => path.join(SESSION_DIR, id)
const setStatus = (id, status, extra = {}) => {
  const l = live.get(id)
  if (l) { l.status = status; Object.assign(l, extra) }
  prisma.wASession.update({ where: { id }, data: { status, phone: extra.phone ?? undefined } }).catch(() => {})
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
  const count = (await prisma.wASession.count()) + 1
  await prisma.wASession.create({ data: { id, label: label || `Account ${count}`, status: 'starting' } })
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
  await prisma.wASession.delete({ where: { id } }).catch(() => {})
}

export async function reconnectSession(id) {
  const row = await prisma.wASession.findUnique({ where: { id } })
  if (!row) return false
  const old = live.get(id)
  if (old) { clearTimeout(old.timer); try { old.sock?.end?.(undefined) } catch {} }
  live.set(id, { status: 'starting', qr: null, pairingCode: null, stopped: false })
  await prisma.wASession.update({ where: { id }, data: { status: 'starting' } })
  await connect(id)
  return true
}

export async function listSessions() {
  const rows = await prisma.wASession.findMany({ orderBy: { createdAt: 'desc' } })
  return Promise.all(rows.map(async (r) => {
    const l = live.get(r.id)
    const studentCount = await prisma.student.count({ where: { sessionId: r.id } })
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
  for (const r of await prisma.wASession.findMany()) {
    if (r.status === 'logged_out' || !fs.existsSync(authDir(r.id))) {
      live.set(r.id, { status: r.status === 'connected' ? 'logged_out' : r.status, qr: null, pairingCode: null, stopped: false })
      continue
    }
    live.set(r.id, { status: 'starting', qr: null, pairingCode: null, stopped: false })
    connect(r.id).catch((e) => console.error(`[wa:${r.id}] restore failed:`, e.message))
  }
}

const sessionFor = (student) => live.get(student.sessionId)?.sock ? live.get(student.sessionId) : [...live.values()].find((l) => l.status === 'connected')
setNotifier(async (student) => {
  const entry = sessionFor(student)
  if (entry?.sock) await notifyPaid({ sock: entry.sock, x: entry.x, sessionId: student.sessionId }, student)
})
setFailNotifier(async (student) => {
  const entry = sessionFor(student)
  if (entry?.sock) await notifyPaymentFailed({ sock: entry.sock, x: entry.x, sessionId: student.sessionId }, student)
})