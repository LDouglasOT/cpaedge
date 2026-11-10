import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { UPLOAD_DIR } from './db.js'
import { ADMIN_PASSWORD } from './auth.js'
import { api, publicRouter } from './routes.js'
import { restoreSessions } from './whatsapp/manager.js'
import { loadSettings } from './db.js'

const app = express()
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }))
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8') } }))

// Uploaded question documents. File names are random, so links are unguessable.
app.use('/uploads', express.static(UPLOAD_DIR, { index: false, dotfiles: 'deny' }))

app.use('/api', publicRouter)
app.use('/api', api)

// Serve the built dashboard when it exists (npm run build in /client) so one process runs everything.
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^\/(?!api|uploads).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }))
app.use((err, _req, res, _next) => {
  console.error(err)
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 500
  res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 25MB' : 'Something went wrong' })
})

const port = Number(process.env.PORT || 4000)
app.listen(port, async () => {
  console.log(`QuizBot API listening on http://localhost:${port}`)
  if (ADMIN_PASSWORD === 'admin123') console.warn('⚠️  Using the default admin password. Set ADMIN_PASSWORD in server/.env')
  const provider = process.env.PAYMENT_PROVIDER || 'marzpay'
  console.log(`Payment provider: ${provider}`)
  if (provider === 'marzpay') {
    for (const k of ['MARZPAY_API_KEY', 'MARZPAY_API_SECRET']) if (!process.env[k]) console.warn(`⚠️  ${k} is not set in server/.env - payments won't work until it is`)
  }
  await restoreSessions()
  await loadSettings()
})
