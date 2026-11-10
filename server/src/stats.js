import { all, get } from './db.js'
import { balance } from './payments.js'

const lastDays = (n) => {
  const out = []
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10))
  return out
}

export async function leaderboard() {
  const rows = await all(`
    SELECT s.id, s.name, s.phone,
           COUNT(DISTINCT a.question_id) AS attempted,
           COUNT(DISTINCT CASE WHEN a.is_correct = true THEN a.question_id END) AS correct,
           COUNT(a.id) AS total_attempts,
           COALESCE(SUM(CASE WHEN a.is_correct = true THEN 1 ELSE 0 END), 0) AS correct_attempts
    FROM students s
    JOIN attempts a ON a.student_id = s.id
    GROUP BY s.id`)
  rows.forEach((r) => {
    r.attempted = Number(r.attempted)
    r.correct = Number(r.correct)
    r.total_attempts = Number(r.total_attempts)
    r.correct_attempts = Number(r.correct_attempts)
    r.accuracy = r.total_attempts ? Math.round((r.correct_attempts / r.total_attempts) * 100) : 0
  })
  rows.sort((a, b) => b.correct - a.correct || b.accuracy - a.accuracy || b.attempted - a.attempted || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  rows.forEach((r, i) => (r.rank = i + 1))
  return rows
}

export async function studentStats(studentId) {
  const board = await leaderboard()
  const me = board.find((r) => r.id === studentId)
  return { me: me || null, total: board.length, top: board.slice(0, 3) }
}

export async function dashboard() {
  const [
    totalQuestions,
    totalCourses,
    studentsCount,
    premiumCount,
    perfRow,
    activeToday,
    byCourseRows,
    studentsByDay,
    revByDayRows,
    attByDayRows,
    studentsBeforeSince,
  ] = await Promise.all([
    get('SELECT COUNT(*) c FROM questions'),
    get('SELECT COUNT(*) c FROM courses'),
    get('SELECT COUNT(*) c FROM students'),
    get('SELECT COUNT(*) c FROM students WHERE premium = true'),
    get(`SELECT COUNT(*) AS attempts, COALESCE(SUM(CASE WHEN is_correct = true THEN 1 ELSE 0 END), 0) AS correct FROM attempts`),
    get("SELECT COUNT(DISTINCT student_id) c FROM attempts WHERE date(created_at) = date('now')"),
    all(`
      SELECT c.name, COUNT(a.id) AS attempts, COALESCE(SUM(CASE WHEN a.is_correct = true THEN 1 ELSE 0 END), 0) AS correct
      FROM courses c
      LEFT JOIN topics t ON t.course_id = c.id
      LEFT JOIN questions q ON q.topic_id = t.id
      LEFT JOIN attempts a ON a.question_id = q.id
      GROUP BY c.id, c.name
      ORDER BY attempts DESC
      LIMIT 8`),
    all(`SELECT date(created_at) d, COUNT(*) c FROM students WHERE date(created_at) >= $1 GROUP BY d`, lastDays(30)[0]),
    all(`SELECT date(created_at) d, SUM(amount) s FROM transactions WHERE type='payment' AND status='success' AND date(created_at) >= $1 GROUP BY d`, lastDays(30)[0]),
    all(`SELECT date(created_at) d, COUNT(*) c, SUM(CASE WHEN is_correct = true THEN 1 ELSE 0 END) AS k FROM attempts WHERE date(created_at) >= $1 GROUP BY d`, lastDays(30)[0]),
    get("SELECT COUNT(*) c FROM students WHERE date(created_at) < $1", lastDays(30)[0]),
  ])

  const perf = perfRow
  const byCourse = byCourseRows.map((r) => ({
    name: r.name,
    attempts: Number(r.attempts),
    correct: Number(r.correct),
    accuracy: Number(r.attempts) ? Math.round((Number(r.correct) / Number(r.attempts)) * 100) : 0,
  }))

  const days = lastDays(30)
  const since = days[0]
  const newByDayMap = Object.fromEntries(studentsByDay.map((r) => [r.d, Number(r.c)]))
  const revByDayMap = Object.fromEntries(revByDayRows.map((r) => [r.d, Number(r.s)]))
  const attByDayMap = Object.fromEntries(attByDayRows.map((r) => [r.d, { c: Number(r.c), k: Number(r.k) }]))

  let running = Number(studentsBeforeSince.c)
  const growth = days.map((d) => {
    running += newByDayMap[d] || 0
    return { date: d, label: d.slice(5), students: running, newStudents: newByDayMap[d] || 0, revenue: revByDayMap[d] || 0 }
  })

  const daily = days.map((d) => ({
    date: d,
    label: d.slice(5),
    attempts: attByDayMap[d]?.c || 0,
    accuracy: attByDayMap[d]?.c ? Math.round((attByDayMap[d].k / attByDayMap[d].c) * 100) : null,
  }))

  const recentTransactions = await all(`
    SELECT t.*, s.name student_name FROM transactions t LEFT JOIN students s ON s.id = t.student_id
    ORDER BY t.id DESC LIMIT 10`)

  const b = await balance()
  return {
    totals: { totalQuestions: totalQuestions.c, totalCourses: totalCourses.c, students: studentsCount.c, premium: premiumCount.c, activeToday: activeToday.c, ...b },
    performance: {
      attempts: Number(perf.attempts),
      correct: Number(perf.correct),
      accuracy: Number(perf.attempts) ? Math.round((Number(perf.correct) / Number(perf.attempts)) * 100) : 0,
      byCourse,
      daily,
    },
    growth,
    recentTransactions,
  }
}
