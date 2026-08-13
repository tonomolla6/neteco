import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { useDatabase } from '../../db/client'
import {
  clamAvScan,
  imageDimensions,
  safeMediaFilename,
  stripMediaMetadata,
  validateMediaUploadEnvelope
} from '../../utils/media-upload'
import type { AllowedMediaType } from '../../utils/media-upload'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

function field(parts: Awaited<ReturnType<typeof readMultipartFormData>>, name: string) {
  return (
    parts
      ?.find((part) => part.name === name && !part.filename)
      ?.data.toString('utf8')
      .trim() ?? ''
  )
}

export default defineEventHandler(async (event) => {
  const administrator = await requirePermission(event, 'catalog.write', { mfa: true })
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const parts = await readMultipartFormData(event)
  const upload = parts?.find((part) => part.name === 'file' && part.filename)
  if (!upload?.filename || !upload.data.length)
    throw createError({ statusCode: 400, statusMessage: 'Falta el archivo' })
  const originalName = upload.filename
  let type: AllowedMediaType
  try {
    type = validateMediaUploadEnvelope({
      bytes: upload.data,
      declaredType: upload.type,
      maximumBytes: runtime.media.maxBytes
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Archivo inválido'
    const statusCode = message.includes('tamaño') ? 413 : message.includes('MIME') ? 415 : 422
    throw createError({ statusCode, statusMessage: message })
  }
  const ownerName = field(parts, 'ownerName')
  const license = field(parts, 'license')
  const altText = field(parts, 'altText')
  const authorizedAt = field(parts, 'authorizedAt')
  if (
    !ownerName ||
    !license ||
    (type.startsWith('image/') && altText.length < 5) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(authorizedAt)
  ) {
    throw createError({ statusCode: 400, statusMessage: 'Faltan derechos, fecha o texto alternativo' })
  }
  const id = randomUUID()
  const filename = safeMediaFilename(originalName, type, id)
  const dimensions = imageDimensions(upload.data, type)
  if (
    dimensions &&
    (dimensions.width < 600 || dimensions.height < 600 || dimensions.width > 12_000 || dimensions.height > 12_000)
  ) {
    throw createError({ statusCode: 422, statusMessage: 'La imagen debe medir entre 600 y 12.000 píxeles por lado' })
  }
  const normalized = stripMediaMetadata(upload.data, type)
  const quarantineDirectory = resolve(runtime.media.storageDirectory, 'quarantine')
  await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 })
  await writeFile(resolve(quarantineDirectory, filename), normalized, { mode: 0o600, flag: 'wx' })
  let quarantineStatus: 'pending' | 'clean' | 'rejected' = 'pending'
  if (runtime.media.clamavHost) {
    try {
      await clamAvScan(upload.data, runtime.media.clamavHost, runtime.media.clamavPort)
      quarantineStatus = 'clean'
    } catch {
      quarantineStatus = 'rejected'
    }
  }
  const sql = useDatabase()
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO media_assets (
        id, storage_key, original_name, mime_type, byte_size, width, height, checksum_sha256,
        owner_name, license, authorized_at, rights_status, quarantine_status, alt_text, metadata
      ) VALUES (
        ${id}, ${`quarantine/${filename}`}, ${originalName}, ${type}, ${normalized.length},
        ${dimensions?.width ?? null}, ${dimensions?.height ?? null},
        ${createHash('sha256').update(normalized).digest('hex')}, ${ownerName}, ${license},
        ${new Date(`${authorizedAt}T00:00:00.000Z`)}, 'pending', ${quarantineStatus}, ${altText || null},
        ${transaction.json({ uploadedBy: administrator.profile.id, normalizedFilename: filename })}
      )
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, after_redacted, correlation_id
      ) VALUES (
        'staff', ${administrator.profile.id}, 'media.upload', 'media_asset', ${id},
        ${transaction.json({ type, bytes: upload.data.length, quarantineStatus })},
        ${event.context.correlationId ?? crypto.randomUUID()}
      )
    `
  })
  setResponseStatus(event, 201)
  return { id, quarantineStatus, rightsStatus: 'pending', canApprove: quarantineStatus === 'clean' }
})
