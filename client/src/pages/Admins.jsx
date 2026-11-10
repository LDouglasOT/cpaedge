import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Modal, StatusPill, useLoad } from '../components.jsx'

function InviteModal({ onClose, onDone }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('admin')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('')
    try { await api('/admins/invite', { method: 'POST', body: { email, role } }); onDone() }
    catch (e2) { setErr(e2.message); setBusy(false) }
  }
  return (
    <Modal title="Invite administrator" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="f"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
        <label className="f"><span>Role</span><select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="admin">Administrator</option>
          <option value="owner">Owner</option>
        </select></label>
        <p className="muted" style={{ margin: 0 }}>An invitation token is generated. Share it with the person so they can set a password and accept.</p>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !email.trim()}>{busy ? 'Inviting…' : 'Send invitation'}</button>
        </div>
      </form>
    </Modal>
  )
}

function AcceptInviteModal({ token, onClose, onDone }) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('')
    try { await api('/admins/invite/accept', { method: 'POST', body: { token, password, name } }); onDone() }
    catch (e2) { setErr(e2.message); setBusy(false) }
  }
  return (
    <Modal title="Accept invitation" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="f"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="f"><span>Password (8+ chars)</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></label>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || password.length < 8}>{busy ? 'Setting up…' : 'Set password &amp; join'}</button>
        </div>
      </form>
    </Modal>
  )
}

export default function Admins() {
  const { data: admins, error, loading, reload } = useLoad(() => api('/admins'), [], 15000)
  const [inviting, setInviting] = useState(false)
  const [acceptToken, setAcceptToken] = useState('')
  const [showAccept, setShowAccept] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const toggle = (id, active) => api(`/admins/${id}`, { method: 'PUT', body: { active } }).then(reload)
  const setRole = (id, role) => api(`/admins/${id}`, { method: 'PUT', body: { role } }).then(reload)
  const remove = (id) => {
    if (!confirm('Remove this administrator? They will no longer be able to sign in.')) return
    api(`/admins/${id}`, { method: 'DELETE' }).then(reload)
  }

  if (loading) return <p className="muted">Loading…</p>
  if (error && !admins) return <div className="err">{error}</div>

  return (
    <>
      <div className="head">
        <div><h1>Administrators</h1><p>Manage admin accounts and invite other administrators.</p></div>
        <button className="btn primary" onClick={() => setInviting(true)}>+ Invite administrator</button>
      </div>
      {(err || msg) && <div className="err" style={{ marginBottom: 12 }}>{err || msg}</div>}
      {!admins?.length ? <div className="card empty">No administrators yet.</div> : (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th className="num">Status</th><th className="num">Created</th><th /></tr></thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id}>
                  <td>{a.name || '—'}</td>
                  <td className="muted">{a.email}</td>
                  <td>
                    <select value={a.role} onChange={(e) => setRole(a.id, e.target.value)} style={{ background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer' }}>
                      <option value="admin">Administrator</option>
                      <option value="owner">Owner</option>
                    </select>
                  </td>
                  <td className="num"><StatusPill status={a.active ? 'ok' : 'bad'} /> {a.active ? 'Active' : 'Inactive'}</td>
                  <td className="num muted">{new Date(a.createdAt).toLocaleDateString()}</td>
                  <td className="num">
                    <button className="btn sm" onClick={() => toggle(a.id, !a.active)}>{a.active ? 'Deactivate' : 'Activate'}</button>
                    <button className="btn sm danger" onClick={() => remove(a.id)} disabled={!a.active}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {inviting && <InviteModal onClose={() => setInviting(false)} onDone={() => { setInviting(false); reload() }} />}
      {showAccept && <AcceptInviteModal token={acceptToken} onClose={() => setShowAccept(false)} onDone={() => { setShowAccept(false); setMsg('Invitation accepted. You can now sign in.'); reload() }} />}
      <p className="muted" style={{ marginTop: 10 }}>To accept an invitation, paste the invitation token you received.</p>
      <div className="card form" style={{ maxWidth: 420 }}>
        <label className="f"><span>Invitation token</span><input type="text" value={acceptToken} onChange={(e) => setAcceptToken(e.target.value)} placeholder="Paste invitation token" /></label>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn" onClick={() => setAcceptToken('')}>Clear</button>
          <button className="btn primary" disabled={!acceptToken.trim()} onClick={() => setShowAccept(true)}>Accept invitation</button>
        </div>
      </div>
    </>
  )
}
