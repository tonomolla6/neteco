import { z } from 'zod'
import { useDatabase } from '../../../../db/client'
import { catalogPublicationIssues, type PublicationVariant } from '../../../../domain/catalog-publication'

const schema = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(3).max(500).default('Publication status update')
})

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const product = await sql.begin(async (transaction) => {
    const [current] = await transaction<
      Array<{
        uuid: string
        status: string
        name: string
        shortDescription: string | null
        description: string | null
        categoryStatus: string
        brandStatus: string | null
        image: string | null
        imageAlt: string | null
        imageRightsOwner: string | null
        imageRightsLicense: string | null
        imageAuthorizedAt: string | null
      }>
    >`
      SELECT product.id AS uuid, product.status, product.name,
             product.short_description AS "shortDescription", product.description,
             category.status AS "categoryStatus", brand.status AS "brandStatus",
             product.attributes ->> 'image' AS image, product.attributes ->> 'imageAlt' AS "imageAlt",
             product.attributes #>> '{imageRights,owner}' AS "imageRightsOwner",
             product.attributes #>> '{imageRights,license}' AS "imageRightsLicense",
             product.attributes #>> '{imageRights,authorizedAt}' AS "imageAuthorizedAt"
      FROM products product
      JOIN categories category ON category.id = product.category_id
      LEFT JOIN brands brand ON brand.id = product.brand_id
      WHERE product.legacy_id = ${id} FOR UPDATE OF product
    `
    if (!current) return null
    if (body.active) {
      const variants = await transaction<PublicationVariant[]>`
        SELECT sku, ean, gtin, mpn, identifier_exception_reason AS "identifierExceptionReason",
               price_gross_cents AS "priceCents", unit_base AS "unitBase", unit_label AS "unitLabel",
               content_quantity::float8 AS "contentQuantity", minimum_quantity AS "minimumQuantity",
               quantity_increment AS "quantityIncrement", maximum_quantity AS "maximumQuantity",
               weight_grams AS "weightGrams", width_mm AS "widthMm", height_mm AS "heightMm",
               depth_mm AS "depthMm", backorder_allowed AS "backorderAllowed",
               lead_time_days AS "leadTimeDays"
        FROM variants WHERE product_id = ${current.uuid} AND status <> 'discontinued'
        ORDER BY legacy_id
      `
      const issues = catalogPublicationIssues({ ...current, variants })
      const [approvedMedia] = await transaction<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM media_assets
          WHERE source_url = ${current.image} AND rights_status = 'approved' AND quarantine_status = 'clean'
        ) AS exists
      `
      if (!approvedMedia?.exists) {
        issues.push({
          code: 'media.approval',
          path: 'image',
          message: 'La imagen no ha superado cuarentena y aprobación de derechos'
        })
      }
      if (issues.length) {
        throw createError({
          statusCode: 409,
          statusMessage: `Publicación bloqueada: ${issues
            .slice(0, 5)
            .map((issue) => issue.message)
            .join('; ')}`,
          data: { issues }
        })
      }
    }
    await transaction`
      UPDATE products SET status = ${body.active ? 'published' : 'hidden'},
        published_at = CASE WHEN ${body.active} THEN COALESCE(published_at, now()) ELSE published_at END,
        updated_at = now()
      WHERE id = ${current.uuid}
    `
    await transaction`
      UPDATE variants SET status = ${body.active ? 'published' : 'hidden'}, updated_at = now()
      WHERE product_id = ${current.uuid} AND status <> 'discontinued'
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted,
        after_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${administrator.id}, 'product.publication.update', 'product', ${String(id)},
        ${transaction.json({ status: current.status })},
        ${transaction.json({ active: body.active })}, ${body.reason}, ${correlationId}
      )
    `
    return current
  })
  if (!product) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })
  return { id, active: body.active }
})
