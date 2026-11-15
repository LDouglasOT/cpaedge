import 'dotenv/config'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, 'migrations')
const url = process.env.DATABASE_URL

if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const needsSsl = /sslmode=require|neon\.tech|amazonaws\.com/.test(url)
const client = new pg.Client({
  connectionString: url,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
})

await client.connect()
console.log(`Connected. Applying ${files.length} migration(s)...\n`)

let failed = 0
for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8')
  process.stdout.write(`Running ${file} ... `)
  try {
    await client.query(sql)
    console.log('OK')
  } catch (e) {
    failed++
    console.error('FAILED')
    console.error('  ' + e.message)
  }
}

await client.end()

if (failed) {
  console.error(`\n${failed} migration(s) failed.`)
  process.exit(1)
}
console.log('\nAll migrations applied.')