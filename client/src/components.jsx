import React, { useEffect } from 'react'
import { money, when } from './api.js'

export function Stat({ label, value, note }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  )
}

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

const TONE = { success: 'ok', pending: 'warn', failed: 'bad' }
export const StatusPill = ({ status }) => <span className={`pill ${TONE[status] || ''}`}>{status}</span>

export function TxTable({ rows, onResolve }) {
  if (!rows?.length) return <div className="empty">No transactions yet.</div>
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr><th>Date</th><th>Type</th><th>Who</th><th>Method</th><th>Reference</th><th className="num">Amount</th><th>Status</th>{onResolve && <th />}</tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>{when(t.created_at)}</td>
              <td>{t.type === 'payment' ? 'Payment' : 'Withdrawal'}</td>
              <td>{t.student_name || t.phone || '—'}{t.student_name && t.phone ? <div className="muted">{t.phone}</div> : null}</td>
              <td>{(t.method || '').replace('_', ' ')}</td>
              <td className="muted">{t.reference}</td>
              <td className="num" style={{ color: t.type === 'withdrawal' ? 'var(--bad)' : undefined }}>
                {t.type === 'withdrawal' ? '−' : '+'}{money(t.amount, t.currency)}
              </td>
              <td><StatusPill status={t.status} />{t.note ? <div className="muted">{t.note}</div> : null}</td>
              {onResolve && (
                <td>
                  {t.status === 'pending' && (
                    <div className="row">
                      <button className="btn sm" onClick={() => onResolve(t, 'success')}>{t.type === 'payment' ? 'Mark paid' : 'Mark paid out'}</button>
                      <button className="btn sm danger" onClick={() => onResolve(t, 'failed')}>Fail</button>
                    </div>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function useLoad(fn, deps = [], intervalMs) {
  const [state, setState] = React.useState({ data: null, error: '', loading: true })
  const reload = React.useCallback(async () => {
    try { setState({ data: await fn(), error: '', loading: false }) }
    catch (e) { setState((s) => ({ ...s, error: e.message, loading: false })) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    reload()
    if (!intervalMs) return
    const t = setInterval(reload, intervalMs)
    return () => clearInterval(t)
  }, [reload, intervalMs])
  return { ...state, reload }
}
