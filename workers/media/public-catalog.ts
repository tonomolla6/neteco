import { eligibleMediaPublicationSql, type EligibleMediaPublicationRow } from './governance'

export type PublicDocumentRole = 'datasheet' | 'sds' | 'certificate' | 'label'

export interface PublicMediaDocument {
  id: string
  role: PublicDocumentRole
  name: string
  url: string
  version: string
  language: string
  authorizedAt: string
}

export interface PublicMediaImage {
  image: string
  imageAlt: string
}

export interface PublicProductMedia {
  image?: string
  imageAlt?: string
  variants: Map<string, PublicMediaImage>
  documents: PublicMediaDocument[]
}

const DOCUMENT_ROLES = new Set<PublicDocumentRole>(['datasheet', 'sds', 'certificate', 'label'])
const BATCH_SIZE = 80

export function publicMediaInstant(now?: string): string {
  const value = now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const instant = Date.parse(value)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
    !Number.isFinite(instant) ||
    new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z') !== value
  ) {
    throw new Error('invalid_media_instant')
  }
  return value
}

/** Only publication identifiers appear in public URLs, never original keys or
 * legacy attributes. Parameters are an intentionally finite transform contract.
 */
export function publicMediaImageUrl(publicationId: string): string {
  return `/media/${publicationId}/image?w=800&format=jpeg`
}

/** Fresh authoritative D1 projections, shared with the byte-delivery gate. This
 * helper does not prove object availability: delivery also verifies owned R2
 * bytes. It must not be cached independently of source/rights/scan eligibility.
 */
export async function readPublicProductMedia(
  database: D1Database,
  productIds: readonly string[],
  now?: string
): Promise<Map<string, PublicProductMedia>> {
  if (
    productIds.length > 1000 ||
    productIds.some(
      (id) =>
        typeof id !== 'string' ||
        !id ||
        id.length > 200 ||
        Array.from(id).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
  ) {
    throw new Error('invalid_media_product_ids')
  }
  const ids = [...new Set(productIds)]
  const result = new Map<string, PublicProductMedia>(
    ids.map((id) => [id, { variants: new Map<string, PublicMediaImage>(), documents: [] }])
  )
  if (!ids.length) return result
  const instant = now === undefined ? null : publicMediaInstant(now)
  // Keep below D1's bound-parameter limit. Normal catalog/detail/search requests
  // use one query; unusually large internal consumers remain bounded batches.
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    const batch = ids.slice(offset, offset + BATCH_SIZE)
    const rows = await database
      .prepare(
        `SELECT * FROM (${eligibleMediaPublicationSql(now === undefined ? undefined : '?1')}) eligible
        WHERE product_id IN (${batch.map(() => '?').join(', ')})
        ORDER BY CASE role WHEN 'main' THEN 0 WHEN 'image' THEN 1 ELSE 2 END,
          valid_from DESC, created_at DESC, id DESC`
      )
      .bind(instant, ...batch)
      .all<EligibleMediaPublicationRow>()
    for (const row of rows.results) {
      const media = result.get(row.product_id)
      if (!media) continue
      if (row.role === 'main' || row.role === 'image') {
        const image = { image: publicMediaImageUrl(row.id), imageAlt: row.alt }
        if (row.variant_id) {
          if (!media.variants.has(row.variant_id)) media.variants.set(row.variant_id, image)
        } else if (!media.image) {
          media.image = image.image
          media.imageAlt = image.imageAlt
        }
      } else if (row.content_type === 'application/pdf' && DOCUMENT_ROLES.has(row.role as PublicDocumentRole)) {
        media.documents.push({
          id: row.id,
          role: row.role as PublicDocumentRole,
          name: row.title,
          url: `/media/${row.id}/document`,
          version: row.version,
          language: row.language,
          authorizedAt: row.authorized_at
        })
      }
    }
  }
  return result
}
