import React, { useState } from 'react'
import { api } from '../api.js'
import { Modal, useLoad } from '../components.jsx'

const LABEL = {
  starting: ['Starting…', ''],
  qr: ['Waiting for scan', 'warn'],
  connected: ['Connected', 'ok'],
  reconnecting: ['Reconnecting…', 'warn'],
  logged_out: ['Logged out', 'bad'],
}

function AddModal({ onClose, onDone }) {
  const [label, setLabel] = useState('')
  const [phone, setPhone] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('')
    try { await api('/whatsapp/sessions', { method: 'POST', body: { label, phone: phone.trim() || undefined } }); onDone() }
    catch (e2) { setErr(e2.message); setBusy(false) }
  }
  return (
    <Modal title="Add WhatsApp account" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="f"><span>Name</span><input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Main line" autoFocus /></label>
        <label className="f"><span>Phone number <small>(optional, to link with a pairing code instead of a QR)</small></span>
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="256771234567" />
        </label>
        <p className="muted" style={{ margin: 0 }}>A QR code will appear on the new account's card. On the phone open WhatsApp → Linked devices → Link a device.</p>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Starting…' : 'Add account'}</button>
        </div>
      </form>
    </Modal>
  )
}

export default function WhatsApp() {
  const { data: sessions, error, loading, reload } = useLoad(() => api('/whatsapp/sessions'), [], 2500)
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState('')

  const act = async (fn) => { setMsg(''); try { await fn(); reload() } catch (e) { setMsg(e.message) } }
  const terminate = (s) => {
    if (!confirm(`Terminate "${s.label}"? It will be logged out of WhatsApp and its saved session deleted. Students stay in the system.`)) return
    act(() => api(`/whatsapp/sessions/${s.id}`, { method: 'DELETE' }))
  }

  return (
    <>
      <div className="head">
        <div><h1>WhatsApp accounts</h1><p>Every connected account answers students automatically. Sessions are saved, so they survive restarts.</p></div>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Add account</button>
      </div>
      {(error || msg) && <div className="err" style={{ marginBottom: 12 }}>{error || msg}</div>}
      {loading ? <p className="muted">Loading…</p> : !sessions?.length ? (
        <div className="card empty">No WhatsApp accounts yet. Add one to start receiving students.</div>
      ) : (
        <div className="sessions">
          {sessions.map((s) => {
            const [text, tone] = LABEL[s.status] || [s.status, '']
            return (
              <div className="card" key={s.id}>
                <div className="row between">
                  <h2>{s.label}</h2>
                  <span className={`pill ${tone}`}>{text}</span>
                </div>
                <div className="muted">{s.phone ? `+${s.phone}` : 'Not linked yet'} · {s.students} student{s.students === 1 ? '' : 's'}</div>
                {s.status === 'qr' && s.pairingCode && (<><div className="code">{s.pairingCode}</div><p className="muted" style={{ margin: 0 }}>On the phone: WhatsApp → Linked devices → Link with phone number, then enter this code.</p></>)}
                {s.status === 'qr' && s.qr && !s.pairingCode && (<><div className="qr"><img src={s.qr} alt={`QR code for ${s.label}`} /></div><p className="muted" style={{ margin: 0 }}>Scan from WhatsApp → Linked devices. The code refreshes automatically.</p></>)}
                {(s.status === 'starting' || s.status === 'reconnecting') && <p className="muted">Working on it…</p>}
                {s.status === 'logged_out' && <p className="muted">This account was logged out from the phone. Reconnect to scan a new QR, or remove it.</p>}
                <div className="row" style={{ marginTop: 12 }}>
                  {(s.status === 'logged_out' || s.status === 'reconnecting') && <button className="btn sm" onClick={() => act(() => api(`/whatsapp/sessions/${s.id}/reconnect`, { method: 'POST' }))}>Reconnect</button>}
                  <button className="btn sm danger" onClick={() => terminate(s)}>Terminate session</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {adding && <AddModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload() }} />}
    </>
  )
}
