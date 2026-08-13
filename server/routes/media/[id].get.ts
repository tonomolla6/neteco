import { createReadStream } from 'node:fs'
import { basename, resolve } from 'node:path'
import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

export default defineEventHandler(async (event) => {
  const assetId = z.string().uuid().parse(getRouterParam(event, 'id'))
  const sql = useDatabase()
  const [asset] = await sql<Array<{ storageKey: string; mimeType: string; originalName: string; checksum: string }>>`
    SELECT storage_key AS "storageKey", mime_type AS "mimeType", original_name AS "originalName",
           checksum_sha256 AS checksum
    FROM media_assets
    WHERE id = ${assetId} AND rights_status = 'approved' AND quarantine_status = 'clean'
      AND storage_key LIKE 'clean/%'
  `
  if (!asset) throw createError({ statusCode: 404, statusMessage: 'Asset no disponible' })
  const filename = basename(asset.storageKey)
  if (asset.storageKey !== `clean/${filename}`)
    throw createError({ statusCode: 404, statusMessage: 'Asset no disponible' })
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  setHeader(event, 'content-type', asset.mimeType)
  setHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
  setHeader(event, 'etag', `"${asset.checksum}"`)
  setHeader(event, 'content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(asset.originalName)}`)
  return sendStream(event, createReadStream(resolve(runtime.media.storageDirectory, 'clean', filename)))
})
