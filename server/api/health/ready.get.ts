import { useDatabase } from '../../db/client'
import { useRedis } from '../../db/redis'

export default defineEventHandler(async (event) => {
  try {
    const database = useDatabase()
    await database`SELECT 1 AS ready`
    const redis = useRedis()
    if (redis.status === 'wait') await redis.connect()
    await redis.ping()
    let catalog = 'not_checked'
    if (process.env.APP_ENV === 'production') {
      const [catalogState] = await database<
        Array<{ released: boolean; demoRecords: number; incompleteProducts: number; incompleteVariants: number }>
      >`
        SELECT
          EXISTS (SELECT 1 FROM catalog_releases WHERE status = 'released') AS released,
          (SELECT count(*)::int FROM products
           WHERE status = 'published' AND source_version ILIKE '%demo%') AS "demoRecords",
          (SELECT count(*)::int FROM products product
           JOIN categories category ON category.id = product.category_id
           LEFT JOIN brands brand ON brand.id = product.brand_id
           WHERE product.status = 'published' AND (
             length(trim(COALESCE(product.short_description, ''))) < 20
             OR length(trim(COALESCE(product.description, ''))) < 40
             OR category.status <> 'published' OR brand.status IS DISTINCT FROM 'published'
             OR COALESCE(product.attributes ->> 'image', '') = ''
             OR COALESCE(product.attributes ->> 'imageAlt', '') = ''
             OR COALESCE(product.attributes #>> '{imageRights,owner}', '') = ''
             OR COALESCE(product.attributes #>> '{imageRights,license}', '') = ''
             OR COALESCE(product.attributes #>> '{imageRights,authorizedAt}', '') = ''
             OR product.attributes ->> 'image' NOT LIKE '/media/%'
             OR NOT EXISTS (
               SELECT 1 FROM media_assets asset
               WHERE asset.source_url = product.attributes ->> 'image'
                 AND asset.rights_status = 'approved' AND asset.quarantine_status = 'clean'
             )
             OR (
               product.regulatory ->> 'requiresSds' = 'true'
               AND NOT EXISTS (
                 SELECT 1 FROM product_media media
                 JOIN media_assets document ON document.id = media.asset_id
                 WHERE media.product_id = product.id AND media.role = 'sds'
                   AND document.rights_status = 'approved' AND document.quarantine_status = 'clean'
               )
             )
           )) AS "incompleteProducts",
          (SELECT count(*)::int FROM variants variant
           JOIN products product ON product.id = variant.product_id
           WHERE product.status = 'published' AND variant.status = 'published' AND (
             variant.price_gross_cents <= 0 OR variant.weight_grams <= 0 OR variant.width_mm <= 0
             OR variant.height_mm <= 0 OR variant.depth_mm <= 0
             OR (variant.ean IS NULL AND variant.gtin IS NULL AND variant.mpn IS NULL
                 AND length(trim(COALESCE(variant.identifier_exception_reason, ''))) < 10)
           )) AS "incompleteVariants"
      `
      if (
        !catalogState?.released ||
        catalogState.demoRecords > 0 ||
        catalogState.incompleteProducts > 0 ||
        catalogState.incompleteVariants > 0
      ) {
        throw new Error('Production catalog release is missing or incomplete')
      }
      catalog = 'ready'
    }
    return {
      status: 'ready',
      dependencies: { database: 'ready', redis: 'ready', catalog },
      correlationId: event.context.correlationId
    }
  } catch {
    setResponseStatus(event, 503)
    return { status: 'not_ready', correlationId: event.context.correlationId }
  }
})
