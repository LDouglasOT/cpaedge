import crypto from 'node:crypto'
import { get, run, getSetting } from './db.js'

let notifier = async () => {}
let failNotifier = async () => {}
export const setNotifier = (fn) => (notifier = fn)
export const setFailNotifier = (fn) => (failNotifier = fn)

const baseUrl = () => (process.env.MARZPAY_BASE_URL || 'https://wallet.wearemarz.com/api/v1').replace(/\/$/, '')

const providers = {
  async mock({ reference }) {
    const delay = Number(process.env.MOCK_CONFIRM_MS || 8000)
    if (delay >= 0) setTimeout(() => confirmPayment(reference).catch(console.error), delay)
    return { providerRef: `mock-${reference}` }
  },

  async marzpay({ reference, amount, msisdn }) {
    const key = process.env.MARZPAY_API_KEY
    const secret = process.env.MARZPAY_API_SECRET
    if (!key || !secret) throw new Error('MARZPAY_API_KEY / MARZPAY_API_SECRET are not set')
    if (!Number.isInteger(amount) || amount < 500 || amount > 10_000_000) {
      throw new Error('MarzPay accepts amounts between 500 and 10,000,000 UGX (whole numbers)')
    }
    const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '')
    const form = new FormData()
    form.set('amount', String(amount))
    form.set('phone_number', `+${msisdn}`)
    form.set('country', 'UG')
    form.set('reference', reference)
    form.set('description', 'Premium access')
    if (publicUrl) form.set('callback_url', `${publicUrl}/api/payments/webhook/marzpay`)
    const res = await fetch(`${baseUrl()}/collect-money`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
      body: form,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.status === 'error') {
      throw new Error(`MarzPay: ${json.message || json.error_code || res.status}`)
    }
    const d = json.data || {}
    return { providerRef: d.transaction?.uuid || d.collection_id || d.uuid || null }
  },

  async marzpayPayout({ reference, amount, msisdn }) {
    const key = process.env.MARZPAY_API_KEY
    const secret = process.env.MARZPAY_API_SECRET
    if (!key || !secret) throw new Error('MARZPAY_API_KEY / MARZPAY_API_SECRET are not set')
    if (!Number.isInteger(amount) || amount < 500 || amount > 10_000_000) {
      throw new Error('MarzPay accepts payouts between 500 and 10,000,000 UGX (whole numbers)')
    }
    const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '')
    const form = new FormData()
    form.set('amount', String(amount))
    form.set('phone_number', `+${msisdn}`)
    form.set('country', 'UG')
    form.set('reference', reference)
    form.set('description', 'Withdrawal to mobile wallet')
    if (publicUrl) form.set('callback_url', `${publicUrl}/api/payments/webhook/marzpay`)
    const res = await fetch(`${baseUrl()}/send-money`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
      body: form,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.status === 'error') {
      throw new Error(`MarzPay: ${json.message || json.error_code || res.status}`)
    }
    const d = json.data || {}
    return { providerRef: d.transaction?.uuid || d.disbursement?.uuid || d.uuid || null }
  },
}

export function normalizeMsisdn(input) {
  const digits = String(input).replace(/\D/g, '')
  if (/^256\d{9}$/.test(digits)) return digits
  if (/^0\d{9}$/.test(digits)) return `256${digits.slice(1)}`
  if (/^\d{9}$/.test(digits)) return `256${digits}`
  return null
}

export async function initiatePayment({ student, msisdn }) {
  const amount = Number(await getSetting('premium_price'))
  const currency = await getSetting('currency')
  const reference = crypto.randomUUID()
  await run(
    `INSERT INTO transactions(student_id, phone, type, amount, currency, status, method, reference)
     VALUES ($1, $2, 'payment', $3, $4, 'pending', 'mobile_money', $5)`,
    student.id, msisdn, amount, currency, reference,
  )
  const name = (process.env.PAYMENT_PROVIDER || 'marzpay').toLowerCase()
  const provider = providers[name]
  if (!provider) throw new Error(`Unknown PAYMENT_PROVIDER "${name}"`)
  try {
    const { providerRef } = await provider({ reference, amount, msisdn, student })
    await run('UPDATE transactions SET provider_ref = $1 WHERE reference = $2', providerRef, reference)
    return { reference, amount, currency }
  } catch (err) {
    await run("UPDATE transactions SET status = 'failed', note = $1 WHERE reference = $2", String(err.message).slice(0, 200), reference)
    throw err
  }
}

export async function initiateWithdrawal({ amount, phone, method, note, createdById }) {
  const currency = await getSetting('currency')
  const reference = `WD-${crypto.randomUUID()}`
  await run(
    `INSERT INTO transactions(phone, type, amount, currency, status, method, note, reference, created_by_id)
     VALUES ($1, 'withdrawal', $2, $3, 'pending', $4, $5, $6, $7)`,
    phone, amount, currency, method, note, reference, createdById,
  )
  const name = (process.env.PAYMENT_PROVIDER || 'marzpay').toLowerCase()
  const provider = providers[name === 'marzpay' ? 'marzpayPayout' : 'mock']
  if (!provider) throw new Error(`Unknown PAYMENT_PROVIDER "${name}"`)
  try {
    const { providerRef } = await provider({ reference, amount, msisdn: phone })
    await run('UPDATE transactions SET provider_ref = $1 WHERE reference = $2', providerRef, reference)
    return { reference, amount, currency }
  } catch (err) {
    await run("UPDATE transactions SET status = 'failed', note = $1 WHERE reference = $2", String(err.message).slice(0, 200), reference)
    throw err
  }
}

export async function confirmPayment(reference) {
  const tx = await get("SELECT * FROM transactions WHERE reference = $1 AND type = 'payment'", reference)
  if (!tx || tx.status === 'success') return tx
  await run("UPDATE transactions SET status = 'success' WHERE id = $1", tx.id)
  if (tx.studentId) {
    await run("UPDATE students SET premium = true, premium_since = NOW() WHERE id = $1 AND premium = false", tx.studentId)
    const student = await get('SELECT * FROM students WHERE id = $1', tx.studentId)
    await notifier(student, tx).catch((e) => console.error('notify failed', e.message))
  }
  return get('SELECT * FROM transactions WHERE id = $1', tx.id)
}

export async function failPayment(reference, note = '') {
  const tx = await get("SELECT * FROM transactions WHERE reference = $1 AND type = 'payment' AND status = 'pending'", reference)
  if (!tx) return
  await run("UPDATE transactions SET status = 'failed', note = $1 WHERE id = $2", note, tx.id)
  const student = tx.studentId && await get('SELECT * FROM students WHERE id = $1', tx.studentId)
  if (student && !student.premium) await failNotifier(student, tx).catch((e) => console.error('notify failed', e.message))
}

export async function confirmWithdrawal(reference) {
  const tx = await get("SELECT * FROM transactions WHERE reference = $1 AND type = 'withdrawal'", reference)
  if (!tx || tx.status === 'success') return tx
  await run("UPDATE transactions SET status = 'success' WHERE id = $1", tx.id)
  return get('SELECT * FROM transactions WHERE id = $1', tx.id)
}

export async function failWithdrawal(reference, note = '') {
  const tx = await get("SELECT * FROM transactions WHERE reference = $1 AND type = 'withdrawal' AND status = 'pending'", reference)
  if (!tx) return
  await run("UPDATE transactions SET status = 'failed', note = $1 WHERE id = $2", note, tx.id)
}

export const balance = async () => {
  const r = await get(`
    SELECT
      COALESCE(SUM(CASE WHEN type='payment' AND status='success' THEN amount END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN type='withdrawal' AND status='success' THEN amount END), 0) AS withdrawn,
      COALESCE(SUM(CASE WHEN type='withdrawal' AND status='pending' THEN amount END), 0) AS pending_withdrawals,
      COALESCE(SUM(CASE WHEN type='payment' AND status='pending' THEN amount END), 0) AS pending_payments
    FROM transactions`)
  const revenue = Number(r.revenue || 0)
  const withdrawn = Number(r.withdrawn || 0)
  const pendingWithdrawals = Number(r.pending_withdrawals || 0)
  const pendingPayments = Number(r.pending_payments || 0)
  return {
    revenue,
    withdrawn,
    pending_withdrawals: pendingWithdrawals,
    pending_payments: pendingPayments,
    available: revenue - withdrawn - pendingWithdrawals,
    counts: { payments: pendingPayments },
  }
}
