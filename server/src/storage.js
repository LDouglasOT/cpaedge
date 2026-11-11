import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') })

const BUCKET = 'uploads'

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

function randomFilename(originalName) {
  return crypto.randomBytes(12).toString('hex') + path.extname(originalName).slice(0, 10)
}

export async function uploadToS3(file) {
  const filename = randomFilename(file.originalname)
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: filename,
    Body: file.buffer,
    ContentType: file.mimetype
  })
  await getClient().send(cmd)
  return { filename, originalname: file.originalname, mimetype: file.mimetype }
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