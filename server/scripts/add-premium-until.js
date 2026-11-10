import { prisma } from '../src/db.js'

async function addPremiumUntil() {
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE students ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ')
    console.log('Added premium_until column')
  } catch (err) {
    console.error('Error:', err.message)
  } finally {
    await prisma.$disconnect()
  }
}

addPremiumUntil()