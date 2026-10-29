import { z } from 'zod'
import { catalogPublicationIssues, type PublicationIssue } from '../../server/domain/catalog-publication'
import { eligibleMediaEvidenceSql } from '../media/governance'
import { ADMIN_CATALOG_PERMISSION, parseAdminCatalogLegacyId, type AdminCatalogReadResult } from './admin-catalog'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { sellableExpression } from './inventory'
import { effectiveGrossCentsExpression, parameterizeEffectivePricingSql, resolvePricingInstant } from './pricing'
import { catalogTypedAttributeIntegritySql } from './typed-attribute-integrity'

export interface D1CatalogPublicationReadiness {
  source: 'cloudflare'
  advisory: true
  publicationEnabled: false
  productId: number
  productUuid: string
  catalogVersion: number
  evaluatedAt: string
  issues: PublicationIssue[]
  limitations: PublicationIssue[]
}

// These are bounded observations, not a per-type policy or a future mutation
// guard. More rows/depth produce an explicit issue, never a false all-clear.
const MAX_VARIANTS = 500
const MAX_ANCESTORS = 128
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const productSchema = z.object({
  uuid: z.string(),
  id: positiveId,
  catalogVersion: positiveId,
  name: z.string(),
  shortDescription: z.string().nullable(),
  description: z.string().nullable(),
  brandStatus: z.string().nullable(),
  regulatory: z.string(),
  typedValid: z.union([z.literal(0), z.literal(1)])
})
const categorySchema = z.object({
  id: z.string(),
  legacyId: z.number().nullable(),
  parentId: z.string().nullable(),
  status: z.string(),
  depth: z.number(),
  cycle: z.number()
})
const variantSchema = z.object({
  legacyId: z.number().nullable(),
  sku: z.string(),
  ean: z.string().nullable(),
  gtin: z.string().nullable(),
  mpn: z.string().nullable(),
  identifierExceptionReason: z.string().nullable().optional(),
  priceCents: z.number(),
  currency: z.string(),
  unitBase: z.string(),
  unitLabel: z.string(),
  contentQuantity: z.number(),
  minimumQuantity: z.number(),
  quantityIncrement: z.number(),
  maximumQuantity: z.number().nullable(),
  weightGrams: z.number(),
  widthMm: z.number(),
  heightMm: z.number(),
  depthMm: z.number(),
  backorderAllowed: z.union([z.literal(0), z.literal(1)]),
  leadTimeDays: z.number().nullable(),
  taxRate: z.number().nullable(),
  taxFrom: z.string().nullable(),
  taxUntil: z.string().nullable(),
  stock: z.number(),
  inventoryAvailable: z.union([z.literal(0), z.literal(1)])
})
const mediaSchema = z.object({
  mainAlt: z.string().nullable(),
  mainAuthorizedAt: z.string().nullable(),
  hasSds: z.union([z.literal(0), z.literal(1)])
})
type Product = z.infer<typeof productSchema>
type Category = z.infer<typeof categorySchema>
type Variant = z.infer<typeof variantSchema>
type Media = z.infer<typeof mediaSchema>

function rows<T>(result: D1Result<unknown> | undefined, schema: z.ZodType<T>): T[] {
  // The SQLite test adapter has no success metadata; an explicit failure or a
  // missing/invalid result is never interpreted as an empty successful read.
  const response: { success?: boolean; results?: unknown } | undefined = result
  if (!response || response.success === false) throw new Error('catalog_readiness_unavailable')
  const parsed = z.array(schema).safeParse(response.results)
  if (!parsed.success) throw new Error('catalog_readiness_unavailable')
  return parsed.data
}

function taxCurrent(variant: Variant, instant: string): boolean {
  if (variant.taxRate === null || !Number.isInteger(variant.taxRate) || variant.taxRate < 0 || variant.taxRate > 10000)
    return false
  try {
    if (variant.taxFrom === null) return false
    const start = Date.parse(resolvePricingInstant({ instant: variant.taxFrom }))
    const end = variant.taxUntil === null ? null : Date.parse(resolvePricingInstant({ instant: variant.taxUntil }))
    const at = Date.parse(instant)
    return start <= at && (end === null || (end > start && at < end))
  } catch {
    return false
  }
}

export function catalogReadinessIssues(
  product: Product,
  categories: Category[],
  variants: Variant[],
  media: Media,
  instant: string
) {
  const categoryPublished =
    categories.length > 0 &&
    categories.every((category) => category.cycle === 0 && category.status === 'published') &&
    categories[categories.length - 1]!.parentId === null
  const issues = catalogPublicationIssues({
    name: product.name,
    shortDescription: product.shortDescription,
    description: product.description,
    categoryStatus: categoryPublished ? 'published' : 'unavailable',
    brandStatus: product.brandStatus,
    // Only a current governed main mapping supplies these sentinels. Legacy
    // attributes.image/imageRights are deliberately absent from the query.
    image: media.mainAlt === null ? null : 'governed-main',
    imageAlt: media.mainAlt,
    imageRightsOwner: media.mainAlt === null ? null : 'governed-rights',
    imageRightsLicense: media.mainAlt === null ? null : 'governed-rights',
    imageAuthorizedAt: media.mainAuthorizedAt,
    variants: variants.slice(0, MAX_VARIANTS).map((variant) => ({
      ...variant,
      backorderAllowed: variant.backorderAllowed === 1
    }))
  })
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message })
  if (product.typedValid !== 1)
    add('product.typed', 'attributes.typed', 'Los atributos tipados o sus referencias no son válidos')
  if (categories.some((category) => category.cycle !== 0))
    add('category.cycle', 'category', 'La jerarquía de categorías contiene un ciclo')
  if (categories.some((category) => !positiveId.safeParse(category.legacyId).success))
    add('category.mapping', 'category', 'Falta una asociación numérica segura de categoría')
  if (categories.at(-1)?.parentId !== null && categories.length >= MAX_ANCESTORS + 1)
    add('category.depth', 'category', 'La jerarquía excede el límite de comprobación')
  if (variants.length > MAX_VARIANTS)
    add('variant.limit', 'variants', 'Hay más variantes que el límite de comprobación')
  variants.slice(0, MAX_VARIANTS).forEach((variant, index) => {
    const path = `variants.${index}`
    if (!positiveId.safeParse(variant.legacyId).success)
      add('variant.mapping', `${path}.id`, 'Falta una asociación numérica segura de variante')
    if (variant.currency !== 'EUR') add('variant.currency', `${path}.currency`, 'La moneda comercial no es compatible')
    if (!taxCurrent(variant, instant)) add('variant.tax', `${path}.tax`, 'Falta una clase de IVA vigente y válida')
    if (!Number.isSafeInteger(variant.minimumQuantity) || !Number.isSafeInteger(variant.quantityIncrement))
      add('variant.quantity_integer', `${path}.minimumQuantity`, 'MOQ e incremento deben ser enteros seguros')
    if (variant.maximumQuantity !== null && !Number.isSafeInteger(variant.maximumQuantity))
      add('variant.maximum_integer', `${path}.maximumQuantity`, 'El máximo debe ser un entero seguro')
    if (variant.backorderAllowed === 1) {
      if (variant.leadTimeDays !== null && (!Number.isSafeInteger(variant.leadTimeDays) || variant.leadTimeDays < 0))
        add('variant.lead_time', `${path}.leadTimeDays`, 'El backorder exige un plazo de entrega válido')
    } else if (variant.inventoryAvailable !== 1) {
      add('inventory.scope', `${path}.stock`, 'No se puede verificar el stock del único almacén')
    } else if (!Number.isSafeInteger(variant.stock) || variant.stock < variant.minimumQuantity) {
      add('variant.stock', `${path}.stock`, 'El stock vendible no cubre la cantidad mínima')
    }
  })
  let regulatory: unknown
  try {
    regulatory = JSON.parse(product.regulatory)
  } catch {
    regulatory = null
  }
  if (regulatory === null || typeof regulatory !== 'object' || Array.isArray(regulatory)) {
    add('regulatory.shape', 'regulatory', 'No se puede evaluar la declaración regulatoria')
  } else if (Object.hasOwn(regulatory, 'requiresSds')) {
    const requiresSds: unknown = Reflect.get(regulatory, 'requiresSds')
    if (typeof requiresSds !== 'boolean')
      add('regulatory.requires_sds', 'regulatory.requiresSds', 'La declaración de aplicabilidad SDS no es válida')
    else if (requiresSds && media.hasSds !== 1)
      add('regulatory.sds', 'documents.sds', 'Falta una SDS asociada con evidencias gobernadas vigentes')
  }
  return issues
}

/** Private advisory snapshot only. This neither enables publication nor proves
 * current R2 bytes or real-world approval. Future status writes must recheck
 * every dependency in their own SQL batch and final rollback guard.
 */
export async function readD1CatalogPublicationReadiness(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  legacyId: string
): Promise<AdminCatalogReadResult<D1CatalogPublicationReadiness>> {
  if (!claims) return { outcome: 'denied', code: 'unauthenticated' }
  const instant = resolvePricingInstant({ instant: now })
  const started = Date.now()
  const authorizationInstant = () =>
    new Date(Date.parse(instant) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const before = await authorizeD1Session(database, claims, ADMIN_CATALOG_PERMISSION, {
    now: authorizationInstant(),
    requireMfa: true
  })
  if (!before.allowed) return { outcome: 'denied', code: before.code }
  const id = typeof legacyId === 'string' ? parseAdminCatalogLegacyId(legacyId) : null
  if (id === null) return { outcome: 'not_found' }
  const price = parameterizeEffectivePricingSql(effectiveGrossCentsExpression('v'), instant)
  const mediaInstant = new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const raw = await database.batch<unknown>([
    database
      .prepare(
        `SELECT p.id AS uuid,p.legacy_id AS id,p.catalog_version AS catalogVersion,
          p.name,p.short_description AS shortDescription,p.description,b.status AS brandStatus,p.regulatory,
          ${catalogTypedAttributeIntegritySql({
            sourceSql: 'SELECT id,category_id,attributes FROM products WHERE legacy_id=?1',
            mode: 'historical',
            clockSql: '?2',
            requirePublicReferences: true,
            prefix: 'readiness_typed'
          })} AS typedValid
        FROM products p LEFT JOIN brands b ON b.id=p.brand_id WHERE p.legacy_id=?1`
      )
      .bind(id, instant),
    database
      .prepare(
        `WITH RECURSIVE ancestors AS (
          SELECT c.id,c.legacy_id AS legacyId,c.parent_id AS parentId,c.status,0 AS depth,0 AS cycle,json_array(c.id) AS visited
          FROM categories c JOIN products p ON p.category_id=c.id WHERE p.legacy_id=?
          UNION ALL
          SELECT c.id,c.legacy_id,c.parent_id,c.status,a.depth+1,
            EXISTS(SELECT 1 FROM json_each(a.visited) WHERE value=c.id),json_insert(a.visited,'$[#]',c.id)
          FROM ancestors a JOIN categories c ON c.id=a.parentId WHERE a.cycle=0 AND a.depth<${MAX_ANCESTORS}
        ) SELECT id,legacyId,parentId,status,depth,cycle FROM ancestors ORDER BY depth`
      )
      .bind(id),
    database
      .prepare(
        `WITH scope_locations AS (
          SELECT id FROM inventory_locations WHERE active=1
          UNION SELECT location_id FROM inventory_balances
          UNION SELECT location_id FROM inventory_movements
          UNION SELECT location_id FROM inventory_reservation_lines
        ), inventory_scope AS (
          SELECT CASE WHEN count(*)=1 AND sum(CASE WHEN l.active=1 AND l.kind='warehouse' THEN 1 ELSE 0 END)=1
            THEN 1 ELSE 0 END AS available,min(l.id) AS locationId
          FROM scope_locations scope LEFT JOIN inventory_locations l ON l.id=scope.id
        ) SELECT v.legacy_id AS legacyId,v.sku,v.ean,v.gtin,v.mpn,${price.sql} AS priceCents,v.currency,
          v.unit_base AS unitBase,v.unit_label AS unitLabel,v.content_quantity AS contentQuantity,
          v.minimum_quantity AS minimumQuantity,v.quantity_increment AS quantityIncrement,v.maximum_quantity AS maximumQuantity,
          v.weight_grams AS weightGrams,v.width_mm AS widthMm,v.height_mm AS heightMm,v.depth_mm AS depthMm,
          v.backorder_allowed AS backorderAllowed,v.lead_time_days AS leadTimeDays,
          tax.rate_basis_points AS taxRate,tax.valid_from AS taxFrom,tax.valid_until AS taxUntil,
          COALESCE((SELECT ${sellableExpression()} FROM inventory_balances b
            WHERE b.variant_id=v.id AND b.location_id=scope.locationId),0) AS stock,scope.available AS inventoryAvailable
        FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN tax_classes tax ON tax.id=v.tax_class_id
          CROSS JOIN inventory_scope scope WHERE p.legacy_id=? AND v.status<>'discontinued'
        ORDER BY v.legacy_id,v.id LIMIT ${MAX_VARIANTS + 1}`
      )
      .bind(...price.instantParameters, id),
    database
      .prepare(
        `WITH evidence AS (${eligibleMediaEvidenceSql()}), main AS (
          SELECT e.alt,e.authorized_at FROM evidence e JOIN products p ON p.id=e.product_id
          WHERE p.legacy_id=? AND e.role='main' AND e.variant_id IS NULL
          ORDER BY e.valid_from DESC,e.created_at DESC,e.id DESC LIMIT 1
        ) SELECT (SELECT alt FROM main) AS mainAlt,(SELECT authorized_at FROM main) AS mainAuthorizedAt,
          EXISTS(SELECT 1 FROM evidence e JOIN products p ON p.id=e.product_id
            WHERE p.legacy_id=? AND e.role='sds' AND (e.variant_id IS NULL OR EXISTS(
              SELECT 1 FROM variants v WHERE v.id=e.variant_id AND v.product_id=p.id AND v.status<>'discontinued'
            ))) AS hasSds`
      )
      .bind(mediaInstant, id, id)
  ])
  const after = await authorizeD1Session(database, claims, ADMIN_CATALOG_PERMISSION, {
    now: authorizationInstant(),
    requireMfa: true
  })
  if (!after.allowed) return { outcome: 'denied', code: after.code }
  const products = rows(raw[0], productSchema)
  if (products.length === 0) return { outcome: 'not_found' }
  if (products.length !== 1) throw new Error('catalog_readiness_unavailable')
  const categories = rows(raw[1], categorySchema)
  const variants = rows(raw[2], variantSchema)
  const media = rows(raw[3], mediaSchema)
  if (media.length !== 1) throw new Error('catalog_readiness_unavailable')
  const product = products[0]!
  return {
    outcome: 'found',
    data: {
      source: 'cloudflare',
      advisory: true,
      publicationEnabled: false,
      productId: product.id,
      productUuid: product.uuid,
      catalogVersion: product.catalogVersion,
      evaluatedAt: instant,
      issues: catalogReadinessIssues(product, categories, variants, media[0]!, instant),
      limitations: [
        {
          code: 'policy.product_type',
          path: 'policy',
          message: 'Esta consulta informativa no evalúa la política de completitud por tipo'
        },
        {
          code: 'policy.identifier_exceptions',
          path: 'variants',
          message: 'Esta consulta informativa no evalúa excepciones gobernadas de identificador'
        },
        {
          code: 'evidence.external_acceptance',
          path: 'media',
          message: 'Esta consulta no acredita aprobación real de los datos y evidencias'
        },
        {
          code: 'evidence.object_availability',
          path: 'media',
          message: 'No se comprueba la disponibilidad ni integridad actual de bytes R2'
        },
        {
          code: 'advisory.snapshot',
          path: 'publication',
          message: 'Este snapshot no sustituye la validación atómica de una publicación'
        }
      ]
    }
  }
}

export {
  productSchema as publicationProductSchema,
  categorySchema as publicationCategorySchema,
  variantSchema as publicationVariantSchema,
  mediaSchema as publicationMediaSchema
}
