import { all, get } from './db.js'
import { balance } from './payments.js'

const lastDays = (n) => {
  const out = []
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10))
  return out
}

export function leaderboard() {
  const rows = all(`
    SELECT s.id, s.name, s.phone,
           COUNT(DISTINCT a.question_id) AS attempted,
           COUNT(DISTINCT CASE WHEN a.is_correct = 1 THEN a.question_id END) AS correct,
           COUNT(a.id) AS total_attempts,
           COALESCE(SUM(a.is_correct), 0) AS correct_attempts
    FROM students s JOIN attempts a ON a.student_id = s.id
    GROUP BY s.id`)
  rows.forEach((r) => (r.accuracy = r.total_attempts ? Math.round((r.correct_attempts / r.total_attempts) * 100) : 0))
  // Most distinct questions answered correctly wins; accuracy then volume break ties.
  rows.sort((a, b) => b.correct - a.correct || b.accuracy - a.accuracy || b.attempted - a.attempted || a.id - b.id)
  rows.forEach((r, i) => (r.rank = i + 1))
  return rows
}

export function studentStats(studentId) {
  const board = leaderboard()
  const me = board.find((r) => r.id === studentId)
  return { me: me || null, total: board.length, top: board.slice(0, 3) }
}

export function dashboard() {
  const totalQuestions = get('SELECT COUNT(*) c FROM questions').c
  const totalCourses = get('SELECT COUNT(*) c FROM courses').c
  const students = get('SELECT COUNT(*) c FROM students').c
  const premium = get('SELECT COUNT(*) c FROM students WHERE premium = 1').c
  const perf = get('SELECT COUNT(*) attempts, COALESCE(SUM(is_correct),0) correct FROM attempts')
  const activeToday = get("SELECT COUNT(DISTINCT student_id) c FROM attempts WHERE date(created_at) = date('now')").c

  const byCourse = all(`
    SELECT c.name, COUNT(a.id) attempts, COALESCE(SUM(a.is_correct),0) correct
    FROM courses c
    LEFT JOIN topics t ON t.course_id = c.id
    LEFT JOIN questions q ON q.topic_id = t.id
    LEFT JOIN attempts a ON a.question_id = q.id
    GROUP BY c.id ORDER BY attempts DESC LIMIT 8`).map((r) => ({
    ...r,
    accuracy: r.attempts ? Math.round((r.correct / r.attempts) * 100) : 0,
  }))

  const days = lastDays(30)
  const since = days[0]
  const newByDay = Object.fromEntries(
    all("SELECT date(created_at) d, COUNT(*) c FROM students WHERE date(created_at) >= ? GROUP BY d", since).map((r) => [r.d, r.c]),
  )
  const revByDay = Object.fromEntries(
    all("SELECT date(created_at) d, SUM(amount) s FROM transactions WHERE type='payment' AND status='success' AND date(created_at) >= ? GROUP BY d", since).map((r) => [r.d, r.s]),
  )
  const attByDay = Object.fromEntries(
    all('SELECT date(created_at) d, COUNT(*) c, SUM(is_correct) k FROM attempts WHERE date(created_at) >= ? GROUP BY d', since).map((r) => [r.d, r]),
  )
  let running = get('SELECT COUNT(*) c FROM students WHERE date(created_at) < ?', since).c
  const growth = days.map((d) => {
    running += newByDay[d] || 0
    return { date: d, label: d.slice(5), students: running, newStudents: newByDay[d] || 0, revenue: revByDay[d] || 0 }
  })
  const daily = days.map((d) => ({
    date: d,
    label: d.slice(5),
    attempts: attByDay[d]?.c || 0,
    accuracy: attByDay[d]?.c ? Math.round((attByDay[d].k / attByDay[d].c) * 100) : null,
  }))

  const recentTransactions = all(`
    SELECT t.*, s.name student_name FROM transactions t LEFT JOIN students s ON s.id = t.student_id
    ORDER BY t.id DESC LIMIT 10`)

  return {
    totals: { totalQuestions, totalCourses, students, premium, activeToday, ...balance() },
    performance: {
      attempts: perf.attempts,
      correct: perf.correct,
      accuracy: perf.attempts ? Math.round((perf.correct / perf.attempts) * 100) : 0,
      byCourse,
      daily,
    },
    growth,
    recentTransactions,
  }
}
