import { z } from 'zod'
import { authorizeD1Session } from './authorization'
import {
  catalogReadinessIssues,
  publicationCategorySchema,
  publicationProductSchema,
  publicationVariantSchema
} from './catalog-publication-readiness'
import { AdminCatalogStatusError, type CatalogPublicationGate } from './admin-catalog-status'
import { effectiveGrossCentsExpression, effectiveGovernedVersionIdExpression, PRICE_INSTANT_TOKEN } from './pricing'
import { sellableExpression } from './inventory'
import { publicationValidityExpression } from './publication-validity'
import { catalogTypedAttributeIntegritySql } from './typed-attribute-integrity'
import { eligibleMediaEvidenceSql } from '../media/governance'
import { IntegrityError, ownedBytes } from '../media/public-delivery'
import { detectMediaType } from '../../shared/media-envelope'
import { MAX_MEDIA_UPLOAD_BYTES } from './media'
import type { PublicationIssue } from '../../server/domain/catalog-publication'
import {
  REQUIRED_CATALOG_POLICY_FIELDS as REQUIRED_FIELDS,
  CATALOG_POLICY_DOCUMENT_ROLES as DOCUMENT_ROLES
} from '../../shared/catalog-publication-policy'

const MAX_SNAPSHOT_BYTES = 384 * 1024
const MAX_MEDIA = 64
const MAX_TOTAL_MEDIA_BYTES = 32 * 1024 * 1024
const policySchema = z.object({
  id: z.string().min(1),
  code: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  version: z.number().int().positive(),
  requiredFields: z.string(),
  requiredMediaRoles: z.string(),
  identifierExceptionsAllowed: z.union([z.literal(0), z.literal(1)]),
  current: z.union([z.literal(0), z.literal(1)])
})
const mediaSchema = z.object({
  id: z.string(),
  product_id: z.string(),
  variant_id: z.string().nullable(),
  upload_id: z.string(),
  role: z.enum(['main', 'image', 'datasheet', 'sds', 'certificate', 'label']),
  alt: z.string(),
  authorized_at: z.string(),
  object_key: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  byte_size: z.number().int().positive().max(MAX_MEDIA_UPLOAD_BYTES),
  r2_etag: z.string(),
  content_type: z.enum(['image/png', 'image/jpeg', 'application/pdf'])
})
const snapshotSchema = z.object({
  product: publicationProductSchema
    .omit({ catalogVersion: true, typedValid: true })
    .extend({ usage: z.string().nullable(), series: z.string().nullable(), attributes: z.string() }),
  categories: z.array(publicationCategorySchema).max(129),
  variants: z
    .array(
      publicationVariantSchema.extend({
        uuid: z.string(),
        taxCurrent: z.union([z.literal(0), z.literal(1)]),
        pricingVersion: z.string().nullable(),
        identifierException: z.object({ id: z.string(), reason: z.string(), reference: z.string() }).nullable()
      })
    )
    .max(501),
  media: z.array(mediaSchema).max(MAX_MEDIA + 1),
  policy: policySchema.nullable()
})

/** Internal canonical dependency projection. Never return this JSON in HTTP.
 * Excludes only columns owned by the status command. Changes to variants,
 * category ancestry, price winner, tax validity, inventory, current media or
 * assigned policy remain observable without a products.catalog_version bump.
 * The same SQL is evaluated within every write/guard using its execution clock.
 */
export function publicationDependencySnapshotSql(clockParameter: number, productParameter: number): string {
  if (![clockParameter, productParameter].every((p) => Number.isSafeInteger(p) && p > 0 && p <= 100))
    throw new Error('invalid_publication_sql_parameter')
  const instant = '(SELECT now FROM gate_clock)'
  const price = effectiveGrossCentsExpression('v').replaceAll(PRICE_INSTANT_TOKEN, instant)
  // A governed ID can equal the public legacy marker; retain nullable raw
  // identity so expiry with the same amount still invalidates this snapshot.
  const version = effectiveGovernedVersionIdExpression('v').replaceAll(PRICE_INSTANT_TOKEN, instant)
  const media = eligibleMediaEvidenceSql().replace(
    'SELECT ? AS now',
    "SELECT strftime('%Y-%m-%dT%H:%M:%SZ',now) AS now FROM gate_clock"
  )
  return `(WITH RECURSIVE gate_clock AS (
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(?${clockParameter},'now')) AS now
  ), gate_product AS (SELECT * FROM products WHERE id=?${productParameter}), ancestors AS (
    SELECT c.id,c.legacy_id AS legacyId,c.parent_id AS parentId,c.status,0 AS depth,0 AS cycle,json_array(c.id) AS visited
    FROM categories c JOIN gate_product p ON p.category_id=c.id
    UNION ALL SELECT c.id,c.legacy_id,c.parent_id,c.status,a.depth+1,
      EXISTS(SELECT 1 FROM json_each(a.visited) WHERE value=c.id),json_insert(a.visited,'$[#]',c.id)
    FROM ancestors a JOIN categories c ON c.id=a.parentId WHERE a.cycle=0 AND a.depth<128
  ), scope_locations AS (
    SELECT id FROM inventory_locations WHERE active=1 UNION SELECT location_id FROM inventory_balances
    UNION SELECT location_id FROM inventory_movements UNION SELECT location_id FROM inventory_reservation_lines
  ), inventory_scope AS (
    SELECT CASE WHEN count(*)=1 AND sum(CASE WHEN l.active=1 AND l.kind='warehouse' THEN 1 ELSE 0 END)=1
      THEN 1 ELSE 0 END AS available,min(l.id) AS locationId
    FROM scope_locations scope LEFT JOIN inventory_locations l ON l.id=scope.id
  ), gate_media AS (${media}), gate_policy AS (
    SELECT policy.*,assignment.id AS assignment_id,assignment.seq AS assignment_seq,
      assignment.actor_id AS assignment_actor,assignment.reason AS assignment_reason,assignment.created_at AS assignment_created,
      CASE WHEN policy.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ',${instant})
        AND assignment.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ',${instant})
        AND policy.valid_from<=strftime('%Y-%m-%dT%H:%M:%SZ',${instant})
        AND (policy.valid_until IS NULL OR policy.valid_until>strftime('%Y-%m-%dT%H:%M:%SZ',${instant}))
        AND NOT EXISTS(SELECT 1 FROM catalog_publication_policy_withdrawals w WHERE w.policy_id=policy.id)
      THEN 1 ELSE 0 END AS current
    FROM catalog_product_publication_policies assignment JOIN catalog_publication_policies policy ON policy.id=assignment.policy_id
    WHERE assignment.product_id=?${productParameter} ORDER BY assignment.seq DESC LIMIT 1
  ) SELECT json_object(
    'product',json_object('uuid',p.id,'id',p.legacy_id,'name',p.name,'shortDescription',p.short_description,
      'description',p.description,'brandStatus',brand.status,'regulatory',p.regulatory,'attributes',p.attributes,
      'categoryId',p.category_id,'brandId',p.brand_id,'usage',p.usage,'series',p.series),
    'categories',json((SELECT json_group_array(json(item)) FROM (
      SELECT json_object('id',id,'legacyId',legacyId,'parentId',parentId,'status',status,'depth',depth,'cycle',cycle) AS item
      FROM ancestors ORDER BY depth))),
    'variants',json((SELECT json_group_array(json(item)) FROM (
      SELECT json_set(json_object('uuid',v.id,'legacyId',v.legacy_id,'sku',v.sku,'ean',v.ean,'gtin',v.gtin,'mpn',v.mpn,
        'priceCents',${price},'pricingVersion',${version},'currency',v.currency,'unitBase',v.unit_base,'unitLabel',v.unit_label,
        'contentQuantity',v.content_quantity,'minimumQuantity',v.minimum_quantity,'quantityIncrement',v.quantity_increment,
        'maximumQuantity',v.maximum_quantity),'$.weightGrams',v.weight_grams,'$.widthMm',v.width_mm,'$.heightMm',v.height_mm,'$.depthMm',v.depth_mm,
        '$.backorderAllowed',v.backorder_allowed,'$.leadTimeDays',v.lead_time_days,'$.taxRate',tax.rate_basis_points,
        '$.taxFrom',tax.valid_from,'$.taxUntil',tax.valid_until,
        '$.taxCurrent',CASE WHEN strftime('%Y-%m-%dT%H:%M:%fZ',tax.valid_from)<=${instant}
          AND (tax.valid_until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',tax.valid_until)>${instant}) THEN 1 ELSE 0 END,
        '$.stock',COALESCE((SELECT ${sellableExpression()} FROM inventory_balances b WHERE b.variant_id=v.id AND b.location_id=scope.locationId),0),
        '$.inventoryAvailable',scope.available,'$.shippingProfileId',v.shipping_profile_id,
        '$.identifierException',json(COALESCE((SELECT json_object('id',exception.id,'reason',exception.reason,'reference',exception.evidence_reference)
          FROM catalog_variant_identifier_exceptions exception WHERE exception.variant_id=v.id
          AND exception.valid_from<=strftime('%Y-%m-%dT%H:%M:%SZ',${instant})
          AND (exception.valid_until IS NULL OR exception.valid_until>strftime('%Y-%m-%dT%H:%M:%SZ',${instant}))
          AND exception.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ',${instant})
          AND NOT EXISTS(SELECT 1 FROM catalog_variant_identifier_exception_withdrawals w WHERE w.exception_id=exception.id)
          ORDER BY exception.valid_from DESC,exception.created_at DESC,exception.id DESC LIMIT 1),'null'))
      ) AS item FROM variants v JOIN gate_product vp ON vp.id=v.product_id
      LEFT JOIN tax_classes tax ON tax.id=v.tax_class_id CROSS JOIN inventory_scope scope
      WHERE v.status<>'discontinued' ORDER BY v.id LIMIT 501))),
    'media',json((SELECT json_group_array(json(item)) FROM (
      SELECT json_set(json_object('id',e.id,'product_id',e.product_id,'variant_id',e.variant_id,'upload_id',e.upload_id,
        'role',e.role,'alt',e.alt,'authorized_at',e.authorized_at,'object_key',e.object_key,'checksum',e.checksum,
        'byte_size',e.byte_size,'r2_etag',e.r2_etag,'content_type',e.content_type),'$.valid_from',e.valid_from,
        '$.created_at',e.created_at,'$.rights_decision_id',e.rights_decision_id,'$.scan_receipt_id',e.scan_receipt_id,'$.version',e.version)
        AS item FROM gate_media e WHERE e.product_id=p.id ORDER BY e.role,e.valid_from DESC,e.created_at DESC,e.id DESC LIMIT ${MAX_MEDIA + 1}))),
    'policy',json((SELECT json_set(json_object('id',id,'code',code,'version',version,'requiredFields',required_fields,
      'requiredMediaRoles',required_media_roles,'identifierExceptionsAllowed',identifier_exceptions_allowed,'current',current,
      'assignmentId',assignment_id,'assignmentSeq',assignment_seq,'assignmentActor',assignment_actor,'assignmentReason',assignment_reason,
      'assignmentCreated',assignment_created,'actor',actor_id,'reason',reason),'$.validFrom',valid_from,'$.validUntil',valid_until,'$.createdAt',created_at)
      FROM gate_policy))
  ) FROM gate_product p LEFT JOIN brands brand ON brand.id=p.brand_id)`
}

function blocked(code: string, path: string, message: string): never {
  throw new AdminCatalogStatusError('publication_blocked', [{ code, path, message }])
}
function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
function jsonList<T extends string>(raw: string, values: readonly T[]): T[] | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(value) || value.length > values.length || new Set(value).size !== value.length) return null
  const allowed = (item: unknown): item is T =>
    typeof item === 'string' && values.some((candidate) => candidate === item)
  return value.every(allowed) ? value : null
}

/** A publisher gate, not the advisory DTO. No defaults classify real products,
 * approve legal documents, or synthesize AV evidence. Operational acceptance
 * of genuine policies/data remains a separate gate from these local mechanics.
 */
export function createD1CatalogPublicationGate(deps: {
  bucket?: Pick<R2Bucket, 'get'>
  enabled: boolean
  /** Deterministic local tests only. Never supplied by HTTP or runtime config. */
  now?: string
}): CatalogPublicationGate {
  return {
    async prepare(database, product, claims) {
      if (!deps.enabled || !deps.bucket)
        blocked('media.object_unavailable', 'media', 'La entrega gobernada de medios no está habilitada')
      const now = deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      const authorization = await authorizeD1Session(database, claims, 'catalog.publish', { now, requireMfa: true })
      if (!authorization.allowed) throw new AdminCatalogStatusError(authorization.code)
      const row = await database
        .prepare(
          `SELECT ${publicationDependencySnapshotSql(1, 2)} AS snapshot,
          ${publicationValidityExpression('p', "COALESCE(?1,'now')")} AS validity,
          ${catalogTypedAttributeIntegritySql({
            sourceSql: 'SELECT id,category_id,attributes FROM products WHERE id=?2',
            mode: 'historical',
            clockSql: "COALESCE(?1,'now')",
            requirePublicReferences: true,
            prefix: 'gate_typed'
          })} AS typedValid FROM products p WHERE p.id=?2`
        )
        .bind(deps.now ?? null, product.productUuid)
        .first<{ snapshot: string | null; validity: number; typedValid: number }>()
      if (!row?.snapshot) throw new AdminCatalogStatusError('not_found')
      if (typeof row.snapshot !== 'string' || new TextEncoder().encode(row.snapshot).byteLength > MAX_SNAPSHOT_BYTES)
        blocked('publication.snapshot', 'publication', 'La comprobación excede el tamaño permitido')
      let raw: unknown
      try {
        raw = JSON.parse(row.snapshot)
      } catch {
        throw new Error('catalog_publication_snapshot_unavailable')
      }
      const parsed = snapshotSchema.safeParse(raw)
      if (!parsed.success) throw new Error('catalog_publication_snapshot_unavailable')
      const snapshot = parsed.data
      if (snapshot.product.uuid !== product.productUuid || snapshot.product.id !== product.productId)
        throw new Error('catalog_publication_snapshot_identity')
      if (row.typedValid !== 1)
        blocked('product.typed', 'attributes.typed', 'Los atributos tipados o sus referencias no son válidos')
      const policy = snapshot.policy
      if (!policy || policy.current !== 1)
        blocked('policy.missing', 'policy', 'Falta una política vigente revisada y asignada al producto')
      const fields = jsonList(policy.requiredFields, REQUIRED_FIELDS)
      const roles = jsonList(policy.requiredMediaRoles, DOCUMENT_ROLES)
      if (!fields || !roles)
        blocked('policy.invalid', 'policy', 'La política contiene reglas no compatibles o duplicadas')
      let regulatory: unknown
      try {
        regulatory = JSON.parse(snapshot.product.regulatory)
      } catch {
        regulatory = null
      }
      if (
        !regulatory ||
        typeof regulatory !== 'object' ||
        Array.isArray(regulatory) ||
        !Object.hasOwn(regulatory, 'productType') ||
        Reflect.get(regulatory, 'productType') !== policy.code ||
        !Object.hasOwn(regulatory, 'requiresSds') ||
        typeof Reflect.get(regulatory, 'requiresSds') !== 'boolean'
      )
        blocked(
          'policy.invalid',
          'regulatory',
          'Falta una clasificación y aplicabilidad documental explícitas coherentes con la política'
        )
      const issues: PublicationIssue[] = []
      const valueAt = (field: string): unknown => {
        let value: unknown = field.startsWith('regulatory.') ? regulatory : snapshot.product
        for (const key of field.startsWith('regulatory.') ? field.split('.').slice(1) : [field]) {
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
          value = Reflect.get(value, key)
        }
        return value
      }
      for (const field of fields) {
        const value = valueAt(field)
        if (
          field === 'regulatory.requiresSds' ? typeof value !== 'boolean' : !(typeof value === 'string' && value.trim())
        )
          issues.push({
            code: 'policy.field',
            path: 'policy',
            message: 'Falta un campo obligatorio de la política del tipo de producto'
          })
      }
      const requiredRoles = new Set<(typeof DOCUMENT_ROLES)[number]>(roles)
      if (Reflect.get(regulatory, 'requiresSds') === true) requiredRoles.add('sds')
      const selected = new Map<string, z.infer<typeof mediaSchema>>()
      const main = snapshot.media.find((media) => media.role === 'main' && media.variant_id === null)
      if (main) selected.set(main.id, main)
      for (const role of requiredRoles) {
        const productDocument = snapshot.media.find((media) => media.role === role && media.variant_id === null)
        if (productDocument) {
          selected.set(productDocument.id, productDocument)
          continue
        }
        for (const variant of snapshot.variants) {
          const document = snapshot.media.find((media) => media.role === role && media.variant_id === variant.uuid)
          if (document) selected.set(document.id, document)
          else
            issues.push({
              code: 'policy.document',
              path: 'policy',
              message: 'Falta un documento vigente para el producto o todas sus variantes vendibles'
            })
        }
      }
      const variants = snapshot.variants.map((variant) => {
        if (variant.taxCurrent !== 1)
          issues.push({ code: 'variant.tax', path: 'variants', message: 'Falta una clase de IVA vigente' })
        const exception = variant.identifierException
        const allow =
          policy.identifierExceptionsAllowed === 1 &&
          exception &&
          exception.reason.trim().length >= 10 &&
          exception.reference.trim().length >= 3
        if (!variant.ean && !variant.gtin && !variant.mpn?.trim() && !allow)
          issues.push({
            code: 'policy.identifier_exception',
            path: 'variants',
            message: 'Falta un identificador o una excepción vigente permitida y revisada'
          })
        return { ...variant, identifierExceptionReason: allow ? exception.reason : null }
      })
      issues.push(
        ...catalogReadinessIssues(
          { ...snapshot.product, catalogVersion: 1, typedValid: row.typedValid },
          snapshot.categories,
          variants,
          {
            mainAlt: main?.alt ?? null,
            mainAuthorizedAt: main?.authorized_at ?? null,
            hasSds: snapshot.media.some((media) => media.role === 'sds') ? 1 : 0
          },
          now
        )
      )
      if (snapshot.media.length > MAX_MEDIA)
        issues.push({
          code: 'publication.snapshot',
          path: 'publication',
          message: 'La evidencia de medios excede el límite de comprobación'
        })
      if (issues.length) throw new AdminCatalogStatusError('publication_blocked', issues)
      if (row.validity !== 1)
        blocked('publication.snapshot', 'publication', 'La evidencia de publicación no está vigente')
      if ([...selected.values()].reduce((total, media) => total + media.byte_size, 0) > MAX_TOTAL_MEDIA_BYTES)
        blocked('publication.snapshot', 'media', 'La evidencia documental excede el límite de bytes de comprobación')
      // Sequential, bounded owned reads; never retain all object bodies together.
      for (const media of selected.values()) {
        const object = await deps.bucket.get(media.object_key)
        if (!object || !('body' in object)) blocked('media.object_unavailable', 'media', 'Falta un original gobernado')
        if (object.key !== media.object_key || object.size !== media.byte_size || object.etag !== media.r2_etag) {
          await object.body.cancel().catch(() => undefined)
          blocked('media.object_integrity', 'media', 'Los metadatos del original no coinciden con la evidencia')
        }
        let bytes: Uint8Array<ArrayBuffer>
        try {
          bytes = await ownedBytes(object.body, media.byte_size, media.byte_size)
        } catch (error) {
          if (error instanceof IntegrityError)
            blocked('media.object_integrity', 'media', 'El tamaño del original no coincide con la evidencia')
          throw error
        }
        if (
          hex(await crypto.subtle.digest('SHA-256', bytes)) !== media.checksum ||
          detectMediaType(bytes) !== media.content_type
        )
          blocked('media.object_integrity', 'media', 'El contenido del original no coincide con la evidencia')
      }
      const after = await authorizeD1Session(database, claims, 'catalog.publish', {
        now: deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        requireMfa: true
      })
      if (!after.allowed) throw new AdminCatalogStatusError(after.code)
      const fingerprint = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.snapshot)))
      return {
        fingerprint,
        condition(offset) {
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > 97)
            throw new Error('invalid_publication_sql_parameter')
          return {
            sql: `${publicationDependencySnapshotSql(offset + 1, offset + 2)} = ?${offset + 3}
              AND EXISTS(SELECT 1 FROM products fresh WHERE fresh.id=?${offset + 2}
                AND ${publicationValidityExpression('fresh', `COALESCE(?${offset + 1},'now')`)})
              AND ${catalogTypedAttributeIntegritySql({
                sourceSql: `SELECT id,category_id,attributes FROM products WHERE id=?${offset + 2}`,
                mode: 'historical',
                clockSql: `COALESCE(?${offset + 1},'now')`,
                requirePublicReferences: true,
                prefix: 'gate_fresh_typed'
              })}=1`,
            parameters: [deps.now ?? null, product.productUuid, row.snapshot]
          }
        }
      }
    }
  }
}
