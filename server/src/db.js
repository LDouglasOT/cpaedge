import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import path from 'node:path'

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data')
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
export const SESSION_DIR = path.join(DATA_DIR, 'sessions')
for (const d of [DATA_DIR, UPLOAD_DIR, SESSION_DIR]) fs.mkdirSync(d, { recursive: true })

const DEFAULTS = {
  premium_price: '5000',
  currency: 'UGX',
  trial_limit: '5',
  bot_name: 'CPA Edge',
  welcome_message:
    'Welcome to *{bot}*! 🎓\nPractise past questions, get instant feedback with explanations, and see how you rank against other students.\n\nYou get *{trials} free trial questions*. Pick a course below to begin.',
}

let cache = null

export const getSetting = async (k) => {
  const s = await allSettings()
  return s[k] ?? DEFAULTS[k]
}

export const setSetting = async (k, v) => {
  await prisma.setting.upsert({
    where: { key: k },
    update: { value: String(v) },
    create: { key: k, value: String(v) },
  })
  cache = null
}

export const allSettings = async () => {
  if (cache) return cache
  const rows = await prisma.setting.findMany()
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  for (const [k, v] of Object.entries(DEFAULTS)) if (cache[k] === undefined) cache[k] = v
  return cache
}

export const loadSettings = async () => {
  cache = await allSettings()
}

export const endPool = async () => prisma.$disconnect()