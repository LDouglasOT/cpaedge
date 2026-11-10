import React, { useEffect, useState } from 'react'
import { api, money } from '../api.js'
import { Modal, Stat, TxTable, useLoad } from '../components.jsx'

function WithdrawModal({ available, currency, onClose, onDone }) {
  const [f, setF] = useState({ amount: '', phone: '', method: 'mobile_money', note: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('')
    try { await api('/funds/withdraw', { method: 'POST', body: f }); onDone() }
    catch (e2) { setErr(e2.message); setBusy(false) }
  }
  return (
    <Modal title="Withdraw funds" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted" style={{ margin: 0 }}>Available: <b>{money(available, currency)}</b></p>
        <label className="f"><span>Amount ({currency})</span><input type="number" min="1" max={available} value={f.amount} onChange={set('amount')} autoFocus /></label>
        <label className="f"><span>Pay out to</span>
          <select value={f.method} onChange={set('method')}>
            <option value="mobile_money">Mobile money</option>
            <option value="bank">Bank account</option>
          </select>
        </label>
        <label className="f"><span>{f.method === 'bank' ? 'Account number' : 'Mobile money number'}</span><input type="text" value={f.phone} onChange={set('phone')} placeholder={f.method === 'bank' ? '' : '0771234567'} /></label>
        <label className="f"><span>Note <small>(optional)</small></span><input type="text" value={f.note} onChange={set('note')} /></label>
        <p className="muted" style={{ margin: 0 }}>The withdrawal is recorded as pending and set aside from your balance. Mark it paid out once the transfer is done.</p>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Request withdrawal'}</button>
        </div>
      </form>
    </Modal>
  )
}

function Settings() {
  const { data, reload } = useLoad(() => api('/settings'))
  const [f, setF] = useState(null)
  const [msg, setMsg] = useState({ ok: '', err: '' })
  useEffect(() => { if (data && !f) setF(data) }, [data, f])
  if (!f) return null
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const save = async (e) => {
    e.preventDefault()
    try { await api('/settings', { method: 'PUT', body: f }); setMsg({ ok: 'Saved. New students see this straight away.', err: '' }); reload() }
    catch (e2) { setMsg({ ok: '', err: e2.message }) }
  }
  return (
    <form className="card form" onSubmit={save}>
      <div><h2>Bot &amp; payment settings</h2><p className="sub" style={{ margin: 0 }}>The premium price is what students are asked to pay after their free trial.</p></div>
      <div className="grid" style={{ gridTemplateColumns: '1fr 110px 1fr' }}>
        <label className="f"><span>Premium price</span><input type="number" min="500" max="10000000" step="1" value={f.premium_price} onChange={set('premium_price')} /></label>
        <label className="f"><span>Currency</span><input type="text" value={f.currency} onChange={set('currency')} maxLength={4} /></label>
        <label className="f"><span>Free trial questions</span><input type="number" min="0" value={f.trial_limit} onChange={set('trial_limit')} /></label>
      </div>
      <label className="f"><span>Bot name</span><input type="text" value={f.bot_name} onChange={set('bot_name')} /></label>
      <label className="f"><span>Welcome message <small>(use {'{bot}'} and {'{trials}'})</small></span><textarea rows={4} value={f.welcome_message} onChange={set('welcome_message')} /></label>
      {msg.err && <div className="err">{msg.err}</div>}
      {msg.ok && <div className="pill ok" style={{ justifySelf: 'start' }}>{msg.ok}</div>}
      <div><button className="btn primary">Save settings</button></div>
    </form>
  )
}

export default function Funds() {
  const [filter, setFilter] = useState('')
  const { data: d, error, loading, reload } = useLoad(() => api(`/funds${filter ? `?type=${filter}` : ''}`), [filter], 15000)
  const { data: settings } = useLoad(() => api('/settings'))
  const [withdrawing, setWithdrawing] = useState(false)
  const [msg, setMsg] = useState('')
  const cur = settings?.currency || 'UGX'

  const resolve = async (t, outcome) => {
    const label = outcome === 'failed' ? 'mark this as failed' : t.type === 'payment' ? 'confirm this payment and upgrade the student' : 'mark this withdrawal as paid out'
    if (!confirm(`Are you sure you want to ${label}?`)) return
    try { await api(`/transactions/${t.id}/resolve`, { method: 'POST', body: { outcome } }); reload() } catch (e) { setMsg(e.message) }
  }

  if (loading) return <p className="muted">Loading…</p>
  if (error && !d) return <div className="err">{error}</div>

  return (
    <>
      <div className="head">
        <div><h1>Funds</h1><p>Payments from students and your withdrawals.</p></div>
        <button className="btn primary" onClick={() => setWithdrawing(true)} disabled={!(d.available > 0)}>Withdraw</button>
      </div>
      {msg && <div className="err" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="grid g4">
        <Stat label="Available balance" value={money(d.available, cur)} />
        <Stat label="Total revenue" value={money(d.revenue, cur)} note={`${d.counts.payments || 0} successful payment${d.counts.payments === 1 ? '' : 's'}`} />
        <Stat label="Withdrawn" value={money(d.withdrawn, cur)} note={d.pending_withdrawals ? `${money(d.pending_withdrawals, cur)} pending payout` : 'Nothing pending'} />
        <Stat label="Awaiting payment" value={money(d.pending_payments, cur)} note="Prompts students haven't approved yet" />
      </div>

      <div className="card section">
        <div className="row between">
          <div><h2>Transactions</h2><p className="sub">Newest first</p></div>
          <div className="tabs">
            {[['', 'All'], ['payment', 'Payments'], ['withdrawal', 'Withdrawals']].map(([v, l]) => (
              <button key={v} className={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>{l}</button>
            ))}
          </div>
        </div>
        <TxTable rows={d.transactions} onResolve={resolve} />
      </div>

      <div className="section"><Settings /></div>

      {withdrawing && <WithdrawModal available={d.available} currency={cur} onClose={() => setWithdrawing(false)} onDone={() => { setWithdrawing(false); reload() }} />}
    </>
  )
}
