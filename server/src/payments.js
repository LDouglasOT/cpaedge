import crypto from 'node:crypto'
import { prisma, getSetting } from './db.js'

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
    const form = new FormData()
    form.set('amount', String(amount))
    form.set('phone_number', `+${msisdn}`)
    form.set('country', 'UG')
    form.set('reference', reference)
    form.set('description', 'Premium access - 1 month subscription')
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

export async function checkMarzPayStatus(providerRef) {
  const key = process.env.MARZPAY_API_KEY
  const secret = process.env.MARZPAY_API_SECRET
  if (!key || !secret) throw new Error('MARZPAY_API_KEY / MARZPAY_API_SECRET are not set')
  const res = await fetch(`${baseUrl()}/transactions/${providerRef}`, {
    method: 'GET',
    headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`MarzPay status check: ${json.message || res.status}`)
  }
  return json.data || json
}

export async function pollPaymentStatus(reference) {
  const tx = await prisma.transaction.findFirst({
    where: { reference, type: 'payment', status: 'pending' },
    include: { student: true }
  })
  if (!tx) return null
  if (!tx.providerRef) return { status: 'pending', transaction: tx }

  try {
    const statusData = await checkMarzPayStatus(tx.providerRef)
    const status = statusData?.status || statusData?.transaction?.status
    if (status === 'completed' || status === 'success' || status === 'paid') {
      return { status: 'success', transaction: tx, providerData: statusData }
    }
    if (status === 'failed' || status === 'cancelled' || status === 'declined') {
      return { status: 'failed', transaction: tx, providerData: statusData }
    }
    return { status: 'pending', transaction: tx, providerData: statusData }
  } catch (err) {
    console.error('[pollPaymentStatus] error:', err.message)
    return { status: 'error', transaction: tx, error: err.message }
  }
}

export async function startPaymentPolling(reference, intervalMs = 10000, maxAttempts = 30) {
  let attempts = 0
  const poll = async () => {
    attempts++
    const result = await pollPaymentStatus(reference)
    if (!result) return
    if (result.status === 'success') {
      await confirmPayment(reference)
      return
    }
    if (result.status === 'failed') {
      await failPayment(reference, result.providerData?.message || 'Payment failed or declined')
      return
    }
    if (attempts < maxAttempts) {
      setTimeout(poll, intervalMs)
    } else {
      await failPayment(reference, 'Payment timed out after 5 minutes')
    }
  }
  setTimeout(poll, intervalMs)
}

export async function initiatePayment({ student, msisdn }) {
  const amount = Number(await getSetting('premium_price'))
  const currency = await getSetting('currency')
  const reference = crypto.randomUUID()
  await prisma.transaction.create({
    data: {
      studentId: student.id,
      phone: msisdn,
      type: 'payment',
      amount,
      currency,
      status: 'pending',
      method: 'mobile_money',
      reference,
    }
  })
  const name = (process.env.PAYMENT_PROVIDER || 'marzpay').toLowerCase()
  const provider = providers[name]
  if (!provider) throw new Error(`Unknown PAYMENT_PROVIDER "${name}"`)
  try {
    const { providerRef } = await provider({ reference, amount, msisdn, student })
    await prisma.transaction.update({ where: { reference }, data: { providerRef } })
    startPaymentPolling(reference)
    return { reference, amount, currency }
  } catch (err) {
    await prisma.transaction.update({ where: { reference }, data: { status: 'failed', note: String(err.message).slice(0, 200) } })
    throw err
  }
}

export async function initiateWithdrawal({ amount, phone, method, note, createdById }) {
  const currency = await getSetting('currency')
  const reference = `WD-${crypto.randomUUID()}`
  await prisma.transaction.create({
    data: {
      phone,
      type: 'withdrawal',
      amount,
      currency,
      status: 'pending',
      method,
      note,
      reference,
      createdById,
    }
  })
  const name = (process.env.PAYMENT_PROVIDER || 'marzpay').toLowerCase()
  const provider = providers[name === 'marzpay' ? 'marzpayPayout' : 'mock']
  if (!provider) throw new Error(`Unknown PAYMENT_PROVIDER "${name}"`)
  try {
    const { providerRef } = await provider({ reference, amount, msisdn: phone })
    await prisma.transaction.update({ where: { reference }, data: { providerRef } })
    return { reference, amount, currency }
  } catch (err) {
    await prisma.transaction.update({ where: { reference }, data: { status: 'failed', note: String(err.message).slice(0, 200) } })
    throw err
  }
}

export async function confirmPayment(reference) {
  const tx = await prisma.transaction.findFirst({
    where: { reference, type: 'payment' },
    include: { student: true }
  })
  if (!tx || tx.status === 'success') return tx
  await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'success' } })
  if (tx.studentId) {
    const premiumUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await prisma.student.update({
      where: { id: tx.studentId },
      data: { premium: true, premiumSince: new Date(), premiumUntil }
    })
    const student = await prisma.student.findUnique({ where: { id: tx.studentId } })
    await notifier(student, tx).catch((e) => console.error('notify failed', e.message))
    await sendReceipt(student, tx)
  }
  return prisma.transaction.findUnique({ where: { id: tx.id } })
}

async function sendReceipt(student, tx) {
  if (!student.jid) return
  try {
    const { default: WA } = await import('@sasa-dev/void-baileys')
    const sock = WA.getSocket?.(student.sessionId)
    if (!sock) return
    const receipt = `🧾 *Payment Receipt*\n\n` +
      `Transaction ID: ${tx.reference}\n` +
      `Amount: ${tx.currency} ${Number(tx.amount).toLocaleString('en-US')}\n` +
      `Date: ${new Date().toLocaleString()}\n` +
      `Status: ✅ Completed\n\n` +
      `🎉 *Premium Activated*\n` +
      `Duration: 1 Month (30 days)\n` +
      `Expires: ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}\n\n` +
      `Thank you for subscribing to CPA Edge!`
    await sock.sendMessage(student.jid, { text: receipt })
  } catch (err) {
    console.error('[sendReceipt] failed:', err.message)
  }
}

export async function failPayment(reference, note = '') {
  const tx = await prisma.transaction.findFirst({
    where: { reference, type: 'payment', status: 'pending' },
    include: { student: true }
  })
  if (!tx) return
  await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'failed', note } })
  const student = tx.student
  if (student && !student.premium) await failNotifier(student, tx).catch((e) => console.error('notify failed', e.message))
}

export async function confirmWithdrawal(reference) {
  const tx = await prisma.transaction.findFirst({ where: { reference, type: 'withdrawal' } })
  if (!tx || tx.status === 'success') return tx
  await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'success' } })
  return prisma.transaction.findUnique({ where: { id: tx.id } })
}

export async function failWithdrawal(reference, note = '') {
  const tx = await prisma.transaction.findFirst({ where: { reference, type: 'withdrawal', status: 'pending' } })
  if (!tx) return
  await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'failed', note } })
}

export const balance = async () => {
  const [payments, withdrawals, pendingWithdrawals, pendingPayments] = await Promise.all([
    prisma.transaction.aggregate({
      where: { type: 'payment', status: 'success' },
      _sum: { amount: true }
    }),
    prisma.transaction.aggregate({
      where: { type: 'withdrawal', status: 'success' },
      _sum: { amount: true }
    }),
    prisma.transaction.aggregate({
      where: { type: 'withdrawal', status: 'pending' },
      _sum: { amount: true }
    }),
    prisma.transaction.aggregate({
      where: { type: 'payment', status: 'pending' },
      _sum: { amount: true }
    })
  ])
  
  const revenue = Number(payments._sum.amount || 0)
  const withdrawn = Number(withdrawals._sum.amount || 0)
  const pendingWithdrawalsAmount = Number(pendingWithdrawals._sum.amount || 0)
  const pendingPaymentsAmount = Number(pendingPayments._sum.amount || 0)
  
  return {
    revenue,
    withdrawn,
    pending_withdrawals: pendingWithdrawalsAmount,
    pending_payments: pendingPaymentsAmount,
    available: revenue - withdrawn - pendingWithdrawalsAmount,
    counts: { payments: pendingPaymentsAmount },
  }
}