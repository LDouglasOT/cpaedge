import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { pool } from './src/db.js'

const sql = readFileSync('./migrations/001_init.sql', 'utf8')
try {
  await pool.query(sql)
  console.log('Migration applied successfully')
} catch (err) {
  console.error('Migration failed:', err)
  process.exit(1)
} finally {
  await pool.end()
}
