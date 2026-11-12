import React, { useEffect, useMemo, useState } from 'react'
import { api, when } from '../api.js'
import { Modal, StatusPill, useLoad } from '../components.jsx'

const STATUS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'premium', label: 'Premium' },
  { id: 'free', label: 'Free' },
  { id: 'trial_exhausted', label: 'Trial exhausted' },
  { id: 'banned', label: 'Banned' },
]

function EditModal({ student, onClose, onSaved }) {
  const [name, setName] = useState(student.name || '')
  const [premium, setPremium] = useState(!!student.premium)
  const [banned, setBanned] = useState(!!student.banned)
  const [trialsUsed, setTrialsUsed] = useState(Number(student.trialsUsed || 0))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      await api(`/students/${student.id}`, { method: 'PUT', body: { name, premium, banned, trialsUsed: Number(trialsUsed) } })
      onSaved()
    } catch (e2) { setErr(e2.message); setBusy(false) }
  }

  return (
    <Modal title="Edit account" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="muted" style={{ fontSize: 13 }}>Phone: <b>{student.phone}</b></div>
        <label className="f"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="f"><span>Trials used</span><input type="number" min="0" value={trialsUsed} onChange={(e) => setTrialsUsed(e.target.value)} /></label>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={premium} onChange={(e) => setPremium(e.target.checked)} /> Premium</label>
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={banned} onChange={(e) => setBanned(e.target.checked)} /> Banned</label>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Status: {banned ? 'Banned (blocked from bot access)' : premium ? 'Premium (unlimited)' : 'Free/trial'} · Attempted {student.attempted || 0} · Correct {student.correct || 0} · Accuracy {student.accuracy || 0}%
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  )
}

export default function Accounts() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [editing, setEditing] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q), 250); return () => clearTimeout(t) }, [q])
  const qs = useMemo(() => {
    const p = new URLSearchParams()
    if (debouncedQ) p.set('q', debouncedQ)
    if (status !== 'all') p.set('status', status)
    const s = p.toString(); return s ? `?${s}` : ''
  }, [debouncedQ, status])
  const { data: rows, loading, error, reload } = useLoad(() => api(`/students${qs}`), [qs], 15000)

  const patch = async (id, body) => { setErr(''); try { await api(`/students/${id}`, { method: 'PUT', body }); reload() } catch (e) { setErr(e.message) } }

  const counts = useMemo(() => {
    const all = rows || []
    return {
      all: all.length,
      active: all.filter((s) => !s.banned).length,
      premium: all.filter((s) => s.premium).length,
      free: all.filter((s) => !s.premium).length,
      trial_exhausted: all.filter((s) => s.exhausted).length,
      banned: all.filter((s) => s.banned).length,
    }
  }, [rows])

  const tone = (s) => s.banned ? 'bad' : s.premium ? 'ok' : s.exhausted ? 'warn' : ''

  if (loading) return <p className="muted">Loading…</p>
  if (error && !rows) return <div className="err">{error}</div>

  return (
    <>
      <div className="head"><div><h1>Accounts</h1><p>Student accounts — edit details, premium access, bans, and status.</p></div></div>
      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="text" placeholder="Search by name or phone…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 260px' }} />
          <div className="tabs" style={{ flexWrap: 'wrap' }}>
            {STATUS.map((s) => (
              <button key={s.id} className={status === s.id ? 'on' : ''} onClick={() => setStatus(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <span className="pill">All: {counts.all}</span>
          <span className="pill ok">Active: {counts.active}</span>
          <span className="pill ok">Premium: {counts.premium}</span>
          <span className="pill">Free: {counts.free}</span>
          <span className="pill warn">Trial exhausted: {counts.trial_exhausted}</span>
          <span className="pill bad">Banned: {counts.banned}</span>
        </div>
      </div>

      <div className="card">
        <div className="row between" style={{ marginBottom: 10 }}>
          <h2>Students</h2>
          <span className="muted">{rows?.length || 0} shown</span>
        </div>
        {!rows?.length ? <div className="empty">No accounts match these filters.</div> : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Status</th>
                  <th className="num">Trials</th>
                  <th className="num">Rank</th>
                  <th className="num">Accuracy</th>
                  <th>Last seen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{s.name || '—'}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{s.phone}</div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <StatusPill status={tone(s) || 'ok'} />
                        <span style={{ fontSize: 13 }}>{s.status === 'trial_exhausted' ? 'Trial exhausted' : s.status === 'premium' ? 'Premium' : s.status === 'banned' ? 'Banned' : 'Active'}</span>
                        {s.premium && <span className="pill ok" style={{ fontSize: 11 }}>Premium</span>}
                        {s.banned && <span className="pill bad" style={{ fontSize: 11 }}>Banned</span>}
                      </div>
                    </td>
                    <td className="num">{s.trialsUsed ?? 0}{s.exhausted && !s.premium ? ' (maxed)' : ''}</td>
                    <td className="num">{s.rank ? `#${s.rank}` : '—'}</td>
                    <td className="num">{s.attempted ? `${s.accuracy}% (${s.correct}/${s.attempted})` : '—'}</td>
                    <td className="muted">{s.lastSeen ? when(s.lastSeen) : '—'}</td>
                    <td className="num">
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <button className="btn sm" onClick={() => setEditing(s)}>Edit</button>
                        <button className="btn sm" onClick={() => patch(s.id, { premium: !s.premium })}>{s.premium ? 'Remove premium' : 'Make premium'}</button>
                        <button className={`btn sm ${s.banned ? '' : 'danger'}`} onClick={() => patch(s.id, { banned: !s.banned })}>{s.banned ? 'Unban' : 'Ban'}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && <EditModal student={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />}
    </>
  )
}