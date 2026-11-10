import crypto from 'node:crypto'
import { get, run, getSetting } from './db.js'

/**
 * Mobile money payments through MarzPay (https://wallet.wearemarz.com/documentation).
 *
 * Collection: POST {base}/collect-money with HTTP Basic auth (API key : API secret).
 * Confirmation: MarzPay calls our webhook (POST /api/payments/webhook/marzpay) with a final
 * `collection.completed` / `collection.failed` event. Enable webhook signing in the MarzPay
 * dashboard and put the signing secret in MARZPAY_WEBHOOK_SECRET.
 *
 * PAYMENT_PROVIDER=mock is only for local testing and the smoke script.
 */

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

  async marzpay({ reference, amount, msisdn, student }) {
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
    form.set('metadata', JSON.stringify({ student_id: student.id }))

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
}

export function normalizeMsisdn(input) {
  const digits = String(input).replace(/\D/g, '')
  if (/^256\d{9}$/.test(digits)) return digits
  if (/^0\d{9}$/.test(digits)) return `256${digits.slice(1)}`
  if (/^\d{9}$/.test(digits)) return `256${digits}`
  return null
}

export async function initiatePayment({ student, msisdn }) {
  const amount = Number(getSetting('premium_price'))
  const currency = getSetting('currency')
  const reference = crypto.randomUUID() // MarzPay requires a unique UUID v4
  run(
    `INSERT INTO transactions(student_id, phone, type, amount, currency, status, method, reference)
     VALUES (?, ?, 'payment', ?, ?, 'pending', 'mobile_money', ?)`,
    student.id, msisdn, amount, currency, reference,
  )
  const name = (process.env.PAYMENT_PROVIDER || 'marzpay').toLowerCase()
  const provider = providers[name]
  if (!provider) throw new Error(`Unknown PAYMENT_PROVIDER "${name}"`)
  try {
    const { providerRef } = await provider({ reference, amount, currency, msisdn, student })
    run('UPDATE transactions SET provider_ref = ? WHERE reference = ?', providerRef, reference)
    return { reference, amount, currency }
  } catch (err) {
    run("UPDATE transactions SET status = 'failed', note = ? WHERE reference = ?", String(err.message).slice(0, 200), reference)
    throw err
  }
}

/** Marks a payment successful, upgrades the student and tells them on WhatsApp. Safe to call twice. */
export async function confirmPayment(reference) {
  const tx = get("SELECT * FROM transactions WHERE reference = ? AND type = 'payment'", reference)
  if (!tx || tx.status === 'success') return tx
  run("UPDATE transactions SET status = 'success' WHERE id = ?", tx.id)
  if (tx.student_id) {
    run("UPDATE students SET premium = 1, premium_since = datetime('now') WHERE id = ? AND premium = 0", tx.student_id)
    const student = get('SELECT * FROM students WHERE id = ?', tx.student_id)
    await notifier(student, tx).catch((e) => console.error('notify failed', e.message))
  }
  return get('SELECT * FROM transactions WHERE id = ?', tx.id)
}

export async function failPayment(reference, note = '') {
  const tx = get("SELECT * FROM transactions WHERE reference = ? AND type = 'payment' AND status = 'pending'", reference)
  if (!tx) return
  run("UPDATE transactions SET status = 'failed', note = ? WHERE id = ?", note, tx.id)
  const student = tx.student_id && get('SELECT * FROM students WHERE id = ?', tx.student_id)
  if (student && !student.premium) await failNotifier(student, tx).catch((e) => console.error('notify failed', e.message))
}

export const balance = () => {
  const r = get(`SELECT
      COALESCE(SUM(CASE WHEN type='payment' AND status='success' THEN amount END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN type='withdrawal' AND status='success' THEN amount END), 0) AS withdrawn,
      COALESCE(SUM(CASE WHEN type='withdrawal' AND status='pending' THEN amount END), 0) AS pending_withdrawals,
      COALESCE(SUM(CASE WHEN type='payment' AND status='pending' THEN amount END), 0) AS pending_payments
    FROM transactions`)
  return { ...r, available: r.revenue - r.withdrawn - r.pending_withdrawals }
}
