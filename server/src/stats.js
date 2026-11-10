import { prisma } from './db.js'
import { balance } from './payments.js'

const lastDays = (n) => {
  const out = []
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10))
  return out
}

export async function leaderboard() {
  const students = await prisma.student.findMany({
    include: {
      attempts: {
        select: { questionId: true, isCorrect: true }
      }
    }
  })
  
  const rows = students.map((s) => {
    const attempts = s.attempts
    const uniqueQuestions = new Set(attempts.map((a) => a.questionId))
    const correctQuestions = new Set(attempts.filter((a) => a.isCorrect).map((a) => a.questionId))
    const totalAttempts = attempts.length
    const correctAttempts = attempts.filter((a) => a.isCorrect).length
    const attempted = uniqueQuestions.size
    const correct = correctQuestions.size
    const accuracy = totalAttempts ? Math.round((correctAttempts / totalAttempts) * 100) : 0
    return {
      id: s.id,
      name: s.name,
      phone: s.phone,
      attempted,
      correct,
      total_attempts: totalAttempts,
      correct_attempts: correctAttempts,
      accuracy
    }
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
  const since = new Date(Date.now() - 30 * 86400000)
  const days = lastDays(30)
  const sinceStr = days[0]

  const [
    totalQuestions,
    totalCourses,
    studentsCount,
    premiumCount,
    totalAttempts,
    correctAttempts,
    activeToday,
    byCourseRows,
    studentsByDay,
    revByDayRows,
    attemptsByDay,
    correctByDay,
    studentsBeforeSince,
  ] = await Promise.all([
    prisma.question.count(),
    prisma.course.count(),
    prisma.student.count(),
    prisma.student.count({ where: { premium: true } }),
    prisma.attempt.count(),
    prisma.attempt.count({ where: { isCorrect: true } }),
    prisma.attempt.groupBy({
      by: ['studentId'],
      where: { createdAt: { gte: new Date(new Date().setHours(0,0,0,0)) } },
      _count: { id: true }
    }).then(r => r.length),
    prisma.course.findMany({
      include: {
        topics: {
          include: {
            questions: {
              include: { attempts: true }
            }
          }
        }
      }
    }).then(courses => courses.map(c => ({
      name: c.name,
      attempts: c.topics.reduce((sum, t) => sum + t.questions.reduce((s, q) => s + q.attempts.length, 0), 0),
      correct: c.topics.reduce((sum, t) => sum + t.questions.reduce((s, q) => s + q.attempts.filter(a => a.isCorrect).length, 0), 0)
    })).sort((a, b) => b.attempts - a.attempts).slice(0, 8)),
    prisma.student.groupBy({
      by: ['createdAt'],
      where: { createdAt: { gte: since } },
      _count: { id: true }
    }).then(r => r.map(x => ({ d: x.createdAt.toISOString().slice(0, 10), c: x._count.id }))),
    prisma.transaction.groupBy({
      by: ['createdAt'],
      where: { type: 'payment', status: 'success', createdAt: { gte: since } },
      _sum: { amount: true }
    }).then(r => r.map(x => ({ d: x.createdAt.toISOString().slice(0, 10), s: Number(x._sum.amount || 0) }))),
    prisma.attempt.groupBy({
      by: ['createdAt'],
      where: { createdAt: { gte: since } },
      _count: { id: true }
    }).then(r => r.map(x => ({ d: x.createdAt.toISOString().slice(0, 10), c: x._count.id }))),
    prisma.attempt.groupBy({
      by: ['createdAt'],
      where: { createdAt: { gte: since }, isCorrect: true },
      _count: { id: true }
    }).then(r => r.map(x => ({ d: x.createdAt.toISOString().slice(0, 10), k: x._count.id }))),
    prisma.student.count({ where: { createdAt: { lt: since } }})
  ])

  const perf = { attempts: totalAttempts, correct: correctAttempts }
  const byCourse = byCourseRows.map((r) => ({
    name: r.name,
    attempts: Number(r.attempts),
    correct: Number(r.correct),
    accuracy: Number(r.attempts) ? Math.round((Number(r.correct) / Number(r.attempts)) * 100) : 0,
  }))

  const newByDayMap = Object.fromEntries(studentsByDay.map((r) => [r.d, Number(r.c)]))
  const revByDayMap = Object.fromEntries(revByDayRows.map((r) => [r.d, Number(r.s)]))
  const attByDayMap = Object.fromEntries(attemptsByDay.map((r) => [r.d, Number(r.c)]))
  const correctByDayMap = Object.fromEntries(correctByDay.map((r) => [r.d, Number(r.k)]))

  let running = Number(studentsBeforeSince)
  const growth = days.map((d) => {
    running += newByDayMap[d] || 0
    return { date: d, label: d.slice(5), students: running, newStudents: newByDayMap[d] || 0, revenue: revByDayMap[d] || 0 }
  })

  const daily = days.map((d) => ({
    date: d,
    label: d.slice(5),
    attempts: attByDayMap[d] || 0,
    accuracy: attByDayMap[d] ? Math.round((correctByDayMap[d] || 0) / attByDayMap[d] * 100) : null,
  }))

  const recentTransactions = await prisma.transaction.findMany({
    take: 10,
    orderBy: { id: 'desc' },
    include: { student: { select: { name: true } } }
  }).then(txs => txs.map(t => ({ ...t, student_name: t.student?.name || null })))

  const b = await balance()
  return {
    totals: { totalQuestions, totalCourses, students: studentsCount, premium: premiumCount, activeToday, ...b },
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