import { mkdir, rename } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { validateRuntimeConfiguration } from '../../../utils/runtime-config'

const schema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(3).max(500)
  })
  .strict()

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'catalog.publish', { mfa: true })
  const assetId = z.string().uuid().parse(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const sql = useDatabase()
  const [asset] = await sql<
    Array<{
      storageKey: string
      quarantineStatus: string
      rightsStatus: string
      ownerName: string | null
      license: string | null
      authorizedAt: Date | null
      altText: string | null
      mimeType: string
    }>
  >`
    SELECT storage_key AS "storageKey", quarantine_status AS "quarantineStatus",
           rights_status AS "rightsStatus", owner_name AS "ownerName", license, authorized_at AS "authorizedAt",
           alt_text AS "altText", mime_type AS "mimeType"
    FROM media_assets WHERE id = ${assetId}
  `
  if (!asset) throw createError({ statusCode: 404, statusMessage: 'Asset no encontrado' })
  let storageKey = asset.storageKey
  if (body.decision === 'approve') {
    if (asset.quarantineStatus !== 'clean') {
      throw createError({ statusCode: 409, statusMessage: 'El antivirus no ha aprobado el archivo' })
    }
    if (
      !asset.ownerName ||
      !asset.license ||
      !asset.authorizedAt ||
      (asset.mimeType.startsWith('image/') && !asset.altText)
    ) {
      throw createError({ statusCode: 409, statusMessage: 'La evidencia de derechos o accesibilidad está incompleta' })
    }
    const filename = basename(asset.storageKey)
    if (asset.storageKey !== `quarantine/${filename}`) throw new Error('Invalid quarantined storage key')
    const cleanDirectory = resolve(runtime.media.storageDirectory, 'clean')
    await mkdir(cleanDirectory, { recursive: true, mode: 0o700 })
    await rename(resolve(runtime.media.storageDirectory, asset.storageKey), resolve(cleanDirectory, filename))
    storageKey = `clean/${filename}`
  }
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE media_assets SET storage_key = ${storageKey},
        rights_status = ${body.decision === 'approve' ? 'approved' : 'blocked'},
        quarantine_status = ${body.decision === 'approve' ? 'clean' : 'rejected'},
        source_url = ${body.decision === 'approve' ? `/media/${assetId}` : null}, updated_at = now()
      WHERE id = ${assetId}
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted,
        after_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${authenticated.profile.id}, 'media.rights.decision', 'media_asset', ${assetId},
        ${transaction.json({ rightsStatus: asset.rightsStatus, quarantineStatus: asset.quarantineStatus })},
        ${transaction.json({ rightsStatus: body.decision === 'approve' ? 'approved' : 'blocked' })},
        ${body.reason}, ${correlationId}
      )
    `
  })
  return { id: assetId, rightsStatus: body.decision === 'approve' ? 'approved' : 'blocked' }
})
