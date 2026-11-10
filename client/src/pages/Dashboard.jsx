import React, { useState } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, money } from '../api.js'
import { Stat, TxTable, useLoad } from '../components.jsx'

const axis = { fontSize: 12, fill: 'var(--muted)' }
const tip = { contentStyle: { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 13 } }

export default function Dashboard() {
  const { data: d, error, loading } = useLoad(() => api('/dashboard'), [], 15000)
  const [growthView, setGrowthView] = useState('students')
  if (loading) return <p className="muted">Loading…</p>
  if (error && !d) return <div className="err">{error}</div>
  const { totals: t, performance: p, growth, recentTransactions } = d
  const conversion = t.students ? Math.round((t.premium / t.students) * 100) : 0

  return (
    <>
      <div className="head"><div><h1>Dashboard</h1><p>How the platform is doing right now.</p></div></div>

      <div className="grid g4">
        <Stat label="Questions in the bank" value={t.totalQuestions.toLocaleString()} note={`${t.totalCourses} course${t.totalCourses === 1 ? '' : 's'}`} />
        <Stat label="Subscribed students" value={t.students.toLocaleString()} note={`${t.activeToday} active today`} />
        <Stat label="Premium accounts" value={t.premium.toLocaleString()} note={`${conversion}% of students`} />
        <Stat label="Performance" value={`${p.accuracy}%`} note={`${p.correct.toLocaleString()} of ${p.attempts.toLocaleString()} answers correct`} />
      </div>

      <div className="grid g2 section">
        <div className="card">
          <div className="row between">
            <div><h2>Platform growth</h2><p className="sub">Last 30 days</p></div>
            <div className="tabs">
              <button className={growthView === 'students' ? 'on' : ''} onClick={() => setGrowthView('students')}>Students</button>
              <button className={growthView === 'revenue' ? 'on' : ''} onClick={() => setGrowthView('revenue')}>Revenue</button>
            </div>
          </div>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              {growthView === 'students' ? (
                <AreaChart data={growth} margin={{ left: -10, right: 8, top: 6 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval={4} />
                  <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip {...tip} formatter={(v) => [v, 'Total students']} />
                  <Area type="monotone" dataKey="students" stroke="var(--brand)" fill="var(--brand)" fillOpacity={0.15} strokeWidth={2} />
                </AreaChart>
              ) : (
                <BarChart data={growth} margin={{ left: -10, right: 8, top: 6 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval={4} />
                  <YAxis tick={axis} tickLine={false} axisLine={false} />
                  <Tooltip {...tip} formatter={(v) => [money(v), 'Revenue']} />
                  <Bar dataKey="revenue" fill="var(--brand)" radius={[3, 3, 0, 0]} />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h2>Performance</h2>
          <p className="sub">Daily answer accuracy, last 30 days</p>
          <div style={{ height: 150 }}>
            <ResponsiveContainer>
              <LineChart data={p.daily} margin={{ left: -10, right: 8, top: 6 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval={6} />
                <YAxis tick={axis} tickLine={false} axisLine={false} domain={[0, 100]} unit="%" />
                <Tooltip {...tip} formatter={(v, _n, i) => [`${v}% of ${i.payload.attempts} answers`, 'Accuracy']} />
                <Line type="monotone" dataKey="accuracy" stroke="var(--brand)" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <h3 style={{ margin: '14px 0 6px' }}>By course</h3>
          {p.byCourse.length === 0 ? <div className="muted">Add courses to see performance.</div> : (
            <div style={{ display: 'grid', gap: 8 }}>
              {p.byCourse.map((c) => (
                <div key={c.name}>
                  <div className="row between"><span>{c.name}</span><span className="muted">{c.attempts ? `${c.accuracy}% · ${c.attempts} answers` : 'No answers yet'}</span></div>
                  <div style={{ height: 6, background: 'var(--bg)', borderRadius: 99, marginTop: 3 }}>
                    <div style={{ width: `${c.accuracy}%`, height: '100%', background: 'var(--brand)', borderRadius: 99 }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card section">
        <h2>Recent transactions</h2>
        <p className="sub">The latest 10 payments and withdrawals</p>
        <TxTable rows={recentTransactions} />
      </div>
    </>
  )
}
