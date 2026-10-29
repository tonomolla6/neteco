import {
  catalogDraftAuthoringOptionsSchema,
  CATALOG_DRAFT_AUTHORING_CAPABILITIES,
  type CatalogDraftAuthoringOptions
} from '../../shared/catalog-draft-authoring-options'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { ADMIN_CATALOG_PERMISSION, type AdminCatalogReadResult } from './admin-catalog'
import { resolvePricingInstant } from './pricing'

function confirmedRows(result: unknown) {
  if (!result || typeof result !== 'object' || Object.getOwnPropertyDescriptor(result, 'success')?.value !== true)
    throw new Error('catalog_authoring_references_unavailable')
  const rows: unknown = Object.getOwnPropertyDescriptor(result, 'results')?.value
  if (!Array.isArray(rows)) throw new Error('catalog_authoring_references_unavailable')
  return rows
}

/** Current bounded reference reads only. No tax, brand, shipping profile or
 * warehouse is created as a side effect of authoring a draft product. */
export async function readD1CatalogDraftAuthoringOptions(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  options: { now?: string } = {}
): Promise<AdminCatalogReadResult<CatalogDraftAuthoringOptions>> {
  if (!claims) return { outcome: 'denied', code: 'unauthenticated' }
  const started = Date.now(),
    instant = resolvePricingInstant({ instant: options.now })
  const liveNow = () =>
    new Date(Date.parse(instant) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const authorize = () =>
    authorizeD1Session(database, claims, ADMIN_CATALOG_PERMISSION, { now: liveNow(), requireMfa: true })
  const before = await authorize()
  if (!before.allowed) return { outcome: 'denied', code: before.code }
  const categories = await database
    .prepare(
      `SELECT category.legacy_id AS id,category.name,parent.legacy_id AS parentId,category.status
    FROM categories category LEFT JOIN categories parent ON parent.id=category.parent_id
    WHERE category.legacy_id BETWEEN 1 AND 9007199254740991 AND category.status<>'discontinued'
      AND (category.parent_id IS NULL OR parent.legacy_id BETWEEN 1 AND 9007199254740991)
    ORDER BY category.sort_order,category.name,category.legacy_id LIMIT 501`
    )
    .all()
  const brands = await database
    .prepare("SELECT id,name,status FROM brands WHERE status<>'archived' ORDER BY name,id LIMIT 501")
    .all()
  const taxClasses = await database
    .prepare(
      `SELECT id,code,name,rate_basis_points AS rateBasisPoints,valid_from AS validFrom,valid_until AS validUntil
    FROM tax_classes WHERE COALESCE(julianday(valid_from)<=julianday(COALESCE(?1,'now')),0)
      AND (valid_until IS NULL OR COALESCE(julianday(valid_until)>julianday(COALESCE(?1,'now')),0))
    ORDER BY rate_basis_points,code,id LIMIT 501`
    )
    .bind(options.now === undefined ? null : instant)
    .all()
  const shippingProfiles = await database
    .prepare('SELECT id,code,name,kind FROM shipping_profiles ORDER BY name,id LIMIT 501')
    .all()
  const after = await authorize()
  if (!after.allowed) return { outcome: 'denied', code: after.code }
  const parsed = catalogDraftAuthoringOptionsSchema.safeParse({
    source: 'cloudflare',
    capabilities: CATALOG_DRAFT_AUTHORING_CAPABILITIES,
    categories: confirmedRows(categories),
    brands: confirmedRows(brands),
    taxClasses: confirmedRows(taxClasses),
    shippingProfiles: confirmedRows(shippingProfiles)
  })
  if (!parsed.success) throw new Error('invalid_catalog_authoring_references')
  return { outcome: 'found', data: parsed.data }
}
