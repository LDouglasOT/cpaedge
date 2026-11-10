import crypto from 'node:crypto'

const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex')
const TTL_MS = 1000 * 60 * 60 * 24 * 7

export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('hex')

export function issueToken() {
  const exp = String(Date.now() + TTL_MS)
  return `${exp}.${sign(exp)}`
}

function valid(token) {
  if (!token) return false
  const [exp, sig] = token.split('.')
  if (!exp || !sig || Number(exp) < Date.now()) return false
  const expected = sign(exp)
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  if (valid(header.startsWith('Bearer ') ? header.slice(7) : null)) return next()
  res.status(401).json({ error: 'Unauthorized' })
}

export function checkPassword(pw) {
  const a = Buffer.from(String(pw || ''))
  const b = Buffer.from(ADMIN_PASSWORD)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
