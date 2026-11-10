import React, { useEffect, useState } from 'react'
import { api, getToken, setToken, setUnauthorizedHandler } from './api.js'
import Dashboard from './pages/Dashboard.jsx'
import WhatsApp from './pages/WhatsApp.jsx'
import Funds from './pages/Funds.jsx'
import QuestionBank from './pages/QuestionBank.jsx'
import Admins from './pages/Admins.jsx'

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦', view: Dashboard },
  { id: 'whatsapp', label: 'WhatsApp', icon: '✆', view: WhatsApp },
  { id: 'funds', label: 'Funds', icon: '＄', view: Funds },
  { id: 'bank', label: 'Question bank', icon: '☰', view: QuestionBank },
  { id: 'admins', label: 'Administrators', icon: '👥', view: Admins },
]

function Login({ onDone }) {
  const [phone, setPhone] = useState('admin@local')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      const { token } = await api('/login', { method: 'POST', body: { phone, password: pw } })
      setToken(token); onDone()
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}><i /> CPA Edge Admin</div>
        <label className="f"><span>Phone / Email</span><input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        <label className="f"><span>Password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy || !pw}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken())
  const [tab, setTab] = useState(() => localStorage.getItem('cpaedge_tab') || 'dashboard')

  useEffect(() => { setUnauthorizedHandler(() => { setToken(null); setAuthed(false) }) }, [])
  useEffect(() => { localStorage.setItem('cpaedge_tab', tab) }, [tab])

  if (!authed) return <Login onDone={() => setAuthed(true)} />
  const View = (TABS.find((t) => t.id === tab) || TABS[0]).view

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><i /> CPA Edge</div>
        {TABS.map((t) => (
          <button key={t.id} className={`nav ${t.id === tab ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            <span aria-hidden>{t.icon}</span> {t.label}
          </button>
        ))}
        <div className="spacer" />
        <button className="nav" onClick={() => { setToken(null); setAuthed(false) }}>Sign out</button>
      </aside>
      <main className="main"><View /></main>
    </div>
  )
}
