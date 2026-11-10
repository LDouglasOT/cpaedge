import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { all, get, run } from './db.js'

const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex')
const TTL_MS = 1000 * 60 * 60 * 24 * 7
const DEFAULT_ADMIN_EMAIL = 'admin@local'

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('hex')

export function issueToken(adminId) {
  const exp = String(Date.now() + TTL_MS)
  const payload = `${adminId}.${exp}`
  return `${payload}.${sign(payload)}`
}

function parseToken(token) {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [adminId, exp, sig] = parts
  if (!adminId || !exp || !sig || Number(exp) < Date.now()) return null
  const expected = sign(`${adminId}.${exp}`)
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? adminId : null
}

export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'

export async function authenticateAdmin(email, password) {
  const admin = await get('SELECT * FROM admins WHERE email = $1', email)
  if (!admin || !admin.active) return null
  const ok = await bcrypt.compare(password, admin.password_hash)
  return ok ? admin : null
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const adminId = parseToken(header.startsWith('Bearer ') ? header.slice(7) : null)
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })
  const admin = await get('SELECT * FROM admins WHERE id = $1', adminId)
  if (!admin || !admin.active) return res.status(401).json({ error: 'Unauthorized' })
  req.admin = admin
  next()
}

export async function bootstrapAdmin() {
  const existing = await get('SELECT * FROM admins LIMIT 1')
  if (existing) return existing
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10)
  const id = crypto.randomBytes(8).toString('hex')
  await run('INSERT INTO admins(id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)', id, DEFAULT_ADMIN_EMAIL, 'Administrator', 'owner', hash)
  return { id, email: DEFAULT_ADMIN_EMAIL, name: 'Administrator', role: 'owner' }
}

export async function hashPassword(pw) {
  return bcrypt.hash(pw, 10)
}

export async function checkPassword(pw) {
  const a = Buffer.from(String(pw || ''))
  const b = Buffer.from(ADMIN_PASSWORD)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function requireRole(...roles) {
  return async (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'Unauthorized' })
    if (!roles.includes(req.admin.role)) return res.status(403).json({ error: 'Forbidden' })
    next()
  }
}

export const cryptoSign = sign
