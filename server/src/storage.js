import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') })

const BUCKET = 'uploads'

// Compress uploaded images before they hit S3: cap the longest side, convert to JPEG
// (PNG with alpha stays PNG), and drop quality to keep storage + WhatsApp delivery small.
const MAX_DIMENSION = 1600
const JPEG_QUALITY = 85

async function compressImage(buffer, mime) {
  if (!mime || !mime.startsWith('image/')) return { buffer, mime }
  try {
    const input = sharp(buffer)
    const meta = await input.metadata()
    const hasAlpha = meta.alpha || meta.channels === 4 || mime === 'image/png'
    let out = input.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    if (hasAlpha) {
      out = out.png({ quality: 85, adaptiveFiltering: true, effort: 6 })
      mime = 'image/png'
    } else {
      out = out.jpeg({ quality: JPEG_QUALITY, progressive: true })
      mime = 'image/jpeg'
    }
    const compressed = await out.toBuffer()
    return compressed.length < buffer.length ? { buffer: compressed, mime } : { buffer, mime }
  } catch (e) {
    console.error('[storage] image compression failed, uploading original:', e.message)
    return { buffer, mime }
  }
}

let s3Client = null
function getClient() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.AWS_REGION,
      endpoint: process.env.AWS_ENDPOINT_URL_S3,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      },
      forcePathStyle: true
    })
  }
  return s3Client
}

function randomFilename(originalName, mime) {
  const ext = mime ? '.' + String(mime).split('/')[1] : path.extname(originalName).slice(0, 10)
  return crypto.randomBytes(12).toString('hex') + ext
}

export async function uploadToS3(file) {
  let buffer = file.buffer
  let mime = file.mimetype
  if (mime?.startsWith('image/')) {
    const compressed = await compressImage(buffer, mime)
    buffer = compressed.buffer
    mime = compressed.mime
  }
  const filename = randomFilename(file.originalname, mime)
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: filename,
    Body: buffer,
    ContentType: mime
  })
  await getClient().send(cmd)
  return { filename, originalname: file.originalname, mimetype: mime }
}

export async function deleteFromS3(filename) {
  if (!filename) return
  const cmd = new DeleteObjectCommand({ Bucket: BUCKET, Key: filename })
  await getClient().send(cmd).catch(() => {})
}

export function getS3Url(filename) {
  if (!filename) return null
  return `${process.env.AWS_ENDPOINT_URL_S3}/${BUCKET}/${filename}`
}

export function getPublicUrl(filename) {
  if (!filename) return null
  return `/api/storage/${filename}`
}