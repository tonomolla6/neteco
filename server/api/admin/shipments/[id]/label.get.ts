import { createError } from 'h3'
import { useDatabase } from '../../../../db/client'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const sql = useDatabase()
  const [document] = await sql<{ bytes: Uint8Array; content_type: string; checksum_sha256: string }[]>`
    SELECT bytes, content_type, checksum_sha256 FROM shipment_documents
    WHERE shipment_id = ${String(getRouterParam(event, 'id'))} AND kind = 'label'
  `
  if (!document) throw createError({ statusCode: 404, statusMessage: 'Etiqueta no encontrada' })
  setResponseHeader(event, 'content-type', document.content_type)
  setResponseHeader(event, 'content-disposition', `attachment; filename="etiqueta-${getRouterParam(event, 'id')}.pdf"`)
  setResponseHeader(event, 'etag', `"${document.checksum_sha256}"`)
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return document.bytes
})
