import type { AdminProductDetail, AdminProductSummary } from '../../shared/types/admin'
import {
  CATALOG_DRAFT_AUTHORING_CAPABILITIES,
  type CatalogDraftAuthoringSnapshot
} from '../../shared/catalog-draft-authoring-options'
import { splitGross } from '../../server/domain/money'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { sellableExpression } from './inventory'
import {
  effectiveGrossCentsExpression,
  effectiveGovernedVersionIdExpression,
  parameterizeEffectivePricingSql,
  resolvePricingInstant
} from './pricing'
import { parseVolumeTiers } from './volume-pricing'
import { catalogCategorySnapshotSchema, type CatalogCategorySnapshot } from '../../shared/catalog-category-commands'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'

/** catalog.read is also granted to customers. Private editorial data requires
 * the live draft-editing permission, as existing content/media admin reads do.
 * A role name (including admin) in a cookie is never sufficient authority. */
export const ADMIN_CATALOG_PERMISSION = 'catalog.write'

/** These describe implemented D1 operations, not the legacy editor's buttons.
 * In particular a writable permission does NOT mean this adapter offers CRUD. */
export const ADMIN_CATALOG_CAPABILITIES = {
  ...CATALOG_DRAFT_AUTHORING_CAPABILITIES,
  productsRead: true,
  productDetailRead: true,
  productReadinessRead: true,
  /** Separate publisher-authorized reader; availability is not a permission. */
  productPublicationPolicyRead: true,
  categoriesRead: true,
  pricesRead: true,
  inventoryRead: true,
  productCreate: false,
  productUpdate: false,
  /** A separate draft-only editor, never the legacy full-product payload. */
  productMetadataUpdate: true,
  /** Bounded CSV editorial profile, not full catalogue/price/stock import. */
  productEditorialImport: true,
  /** New-only full tabular drafts; permissions are checked again on execution. */
  productNativeImport: true,
  /** Large-file upload, sealed review and recovery; not whole-job application. */
  productImportJobPreparation: true,
  /** Atomic whole-job draft application and exact unused-row compensation. */
  productImportJobCommands: true,
  productSnapshotExport: true,
  productDelete: false,
  productStatusUpdate: false,
  /** Narrow, audited state transitions; never the legacy boolean active PUT. */
  productStatusTransition: true,
  categoryCreate: false,
  categoryUpdate: false,
  categoryDelete: false,
  variantWrite: false,
  priceWrite: false,
  inventoryWrite: false,
  identifierExceptionsRead: false
} as const

export const ADMIN_CATALOG_STATUSES = ['draft', 'review', 'published', 'hidden', 'discontinued'] as const
export type AdminCatalogStatus = (typeof ADMIN_CATALOG_STATUSES)[number]
export interface AdminCatalogQuery {
  q: string
  category?: number
  active?: '0' | '1'
  status?: AdminCatalogStatus
  page: number
  perPage: number
}

export type AdminCatalogReadResult<T> =
  | { outcome: 'found'; data: T }
  | { outcome: 'not_found' }
  | { outcome: 'denied'; code: 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'forbidden' }

interface CatalogMetadata {
  source: 'cloudflare'
  capabilities: typeof ADMIN_CATALOG_CAPABILITIES
}

export interface D1AdminProductList extends CatalogMetadata {
  items: Array<
    Omit<AdminProductSummary, 'minPrice'> & { uuid: string; minPrice: number | null; catalogVersion: number }
  >
  pagination: { page: number; perPage: number; total: number; pages: number }
  pricingInstant: string
}

type AdminVariant = AdminProductDetail['variants'][number]
export interface D1AdminProductVariant extends AdminVariant {
  /** Private association identifier; numeric IDs remain the editor contract. */
  uuid: string
  status: AdminCatalogStatus
  /** Legacy `stock` remains physical stock; never silently reinterpret it. */
  physicalStock: number
  sellableStock: number
  taxRateBasisPoints: number
  netPrice: number
  compareAtPrice: number | null
  referencePrice30d: number | null
  pricingVersion: string
  priceTiers: ReturnType<typeof parseVolumeTiers>
}

export interface D1AdminProductDetail extends Omit<AdminProductDetail, 'variants'>, CatalogMetadata {
  uuid: string
  catalogVersion: number
  variants: D1AdminProductVariant[]
  pricingInstant: string
  /** Bounded draft authoring projection; financial values remain read-only. */
  authoring: CatalogDraftAuthoringSnapshot
  /** This read adapter does not project the governed exception ledger. */
  fieldAvailability: { identifierExceptionReason: false }
}

export interface D1AdminCategory {
  id: number
  name: string
  slug: string
  parentId: number | null
  sort: number
  status: AdminCatalogStatus
  directCount: number
  /** Same subtree-count semantics as the existing CategoryResponse. */
  count: number
  /** Exact stored identity/parent; parentId above remains its legacy tree projection. */
  authoring: CatalogCategorySnapshot
}
export interface D1AdminCategoryNode extends D1AdminCategory {
  children: D1AdminCategoryNode[]
}
export interface D1AdminCategoryResponse extends Omit<CatalogMetadata, 'capabilities'> {
  capabilities: Omit<typeof ADMIN_CATALOG_CAPABILITIES, 'categoryCreate' | 'categoryUpdate' | 'categoryDelete'> & {
    categoryCreate: boolean
    categoryUpdate: boolean
    categoryDelete: boolean
  }
  roots: D1AdminCategoryNode[]
  flat: D1AdminCategory[]
  unmappedCategories: number
}

/** Numeric legacy mappings are the editor contract; reject coercions, unsafe
 * numbers and aliases instead of resolving them via SKU/slug/internal UUID. */
export function parseAdminCatalogLegacyId(value: string): number | null {
  if (!/^[1-9]\d{0,15}$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 && String(id) === value ? id : null
}

function validQuery(query: AdminCatalogQuery) {
  return (
    typeof query.q === 'string' &&
    query.q.length <= 160 &&
    ![...query.q].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    Number.isSafeInteger(query.page) &&
    query.page > 0 &&
    query.page <= 1_000_000 &&
    Number.isSafeInteger(query.perPage) &&
    query.perPage > 0 &&
    query.perPage <= 500 &&
    (query.category === undefined || (Number.isSafeInteger(query.category) && query.category > 0)) &&
    (query.active === undefined || query.active === '0' || query.active === '1') &&
    (query.status === undefined || ADMIN_CATALOG_STATUSES.includes(query.status))
  )
}

/** Load raw rows, recheck authority, THEN project private editor fields. Fresh
 * elapsed server time makes a grant/session expiring during a read ineffective;
 * a pinned test instant never becomes request input. */
async function authorized<Raw, Data>(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  load: (instant: string) => Promise<Raw | null>,
  project: (raw: Raw, instant: string) => Data
): Promise<AdminCatalogReadResult<Data>> {
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
  const raw = await load(instant)
  const after = await authorizeD1Session(database, claims, ADMIN_CATALOG_PERMISSION, {
    now: authorizationInstant(),
    requireMfa: true
  })
  if (!after.allowed) return { outcome: 'denied', code: after.code }
  return raw === null ? { outcome: 'not_found' } : { outcome: 'found', data: project(raw, instant) }
}

const metadata = (): CatalogMetadata => ({ source: 'cloudflare', capabilities: ADMIN_CATALOG_CAPABILITIES })
/** Platform errors or incomplete envelopes are not confirmed empty reads.
 * Inspect own data descriptors without evaluating getters or inherited flags. */
function confirmedRows<T>(result: unknown): T[] {
  if (!result || typeof result !== 'object' || Object.getOwnPropertyDescriptor(result, 'success')?.value !== true)
    throw new Error('admin_catalog_read_unavailable')
  const rows: unknown = Object.getOwnPropertyDescriptor(result, 'results')?.value
  if (!Array.isArray(rows)) throw new Error('admin_catalog_read_unavailable')
  return rows as T[]
}
function confirmedCount(rows: unknown[]): number {
  const row: unknown = Object.getOwnPropertyDescriptor(rows, '0')?.value
  if (rows.length !== 1 || !row || typeof row !== 'object') throw new Error('admin_catalog_read_unavailable')
  const total: unknown = Object.getOwnPropertyDescriptor(row, 'total')?.value
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
    throw new Error('admin_catalog_read_unavailable')
  return total
}
const SEARCH_FOLD = [
  ['Á', 'a'],
  ['á', 'a'],
  ['É', 'e'],
  ['é', 'e'],
  ['Í', 'i'],
  ['í', 'i'],
  ['Ó', 'o'],
  ['ó', 'o'],
  ['Ú', 'u'],
  ['ú', 'u'],
  ['Ü', 'u'],
  ['ü', 'u'],
  ['Ñ', 'n'],
  ['ñ', 'n']
] as const
export function searchSql(expression: string) {
  return `lower(${SEARCH_FOLD.reduce((sql, [from, to]) => `replace(${sql}, '${from}', '${to}')`, expression)})`
}
export function searchTerm(term: string) {
  return SEARCH_FOLD.reduce((text, [from, to]) => text.replaceAll(from, to), term.trim()).toLowerCase()
}
function parseJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function visual(value: string, fallback: { type: string; color: string }) {
  const parsed = parseJson(value)
  return object(parsed) && typeof parsed.type === 'string' && typeof parsed.color === 'string'
    ? { type: parsed.type, color: parsed.color }
    : { ...fallback }
}
function badges(value: string): string[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed.filter((badge): badge is string => typeof badge === 'string') : []
}
function attributes(value: string): Array<{ k: string; v: string }> {
  const parsed = parseJson(value)
  return Array.isArray(parsed)
    ? parsed
        .filter((entry) => object(entry) && typeof entry.k === 'string' && typeof entry.v === 'string')
        .map((entry) => ({ k: entry.k as string, v: entry.v as string }))
    : []
}

interface ProductSummaryRow extends Omit<AdminProductSummary, 'featured' | 'active' | 'visual' | 'minPrice'> {
  uuid: string
  catalogVersion: number
  featured: number
  visualJson: string
  minPrice: number | null
}
const PRODUCT_JOINS = `FROM products p JOIN categories c ON c.id = p.category_id
  LEFT JOIN brands b ON b.id = p.brand_id`
const MAPPED_PRODUCTS = 'p.legacy_id BETWEEN 1 AND 9007199254740991 AND c.legacy_id BETWEEN 1 AND 9007199254740991'

export async function listD1AdminProducts(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  query: AdminCatalogQuery
): Promise<AdminCatalogReadResult<D1AdminProductList>> {
  if (!validQuery(query)) throw new Error('invalid_admin_catalog_query')
  return authorized(
    database,
    claims,
    now,
    async (instant) => {
      const filters = [MAPPED_PRODUCTS]
      const parameters: Array<string | number> = []
      if (query.q.trim()) {
        // instr is literal: percent, underscore, backslash and SQL syntax have no
        // wildcard/operator meaning. Hidden variant SKUs are editorially searchable.
        filters.push(`(instr(${searchSql('p.name')}, ?) > 0 OR instr(${searchSql("COALESCE(b.name, 'NETECO')")}, ?) > 0
        OR EXISTS(SELECT 1 FROM variants sku WHERE sku.product_id = p.id AND instr(${searchSql('sku.sku')}, ?) > 0))`)
        const term = searchTerm(query.q)
        parameters.push(term, term, term)
      }
      if (query.category !== undefined) {
        filters.push('c.legacy_id = ?')
        parameters.push(query.category)
      }
      if (query.active !== undefined)
        filters.push(query.active === '1' ? "p.status = 'published'" : "p.status <> 'published'")
      if (query.status !== undefined) {
        filters.push('p.status = ?')
        parameters.push(query.status)
      }
      const where = `WHERE ${filters.join(' AND ')}`
      const effective = parameterizeEffectivePricingSql(effectiveGrossCentsExpression('v'), instant)
      // One batch, two fixed queries, regardless of the product/variant count.
      const result = await database.batch<ProductSummaryRow | { total: number }>([
        database
          .prepare(
            `SELECT p.legacy_id AS id, p.id AS uuid, p.catalog_version AS catalogVersion,
          p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
          p.featured, p.status, p.series,
          COALESCE(json_extract(p.attributes, '$.visual'), '{"type":"botella","color":"#64748b"}') AS visualJson,
          c.legacy_id AS categoryId, c.name AS categoryName,
          MIN(${effective.sql}) AS minPrice, COUNT(v.id) AS formats
        ${PRODUCT_JOINS} LEFT JOIN variants v ON v.product_id = p.id ${where}
        GROUP BY p.id, b.name, c.legacy_id, c.name
        ORDER BY lower(p.name), p.legacy_id, p.id LIMIT ? OFFSET ?`
          )
          .bind(...effective.instantParameters, ...parameters, query.perPage, (query.page - 1) * query.perPage),
        database.prepare(`SELECT COUNT(*) AS total ${PRODUCT_JOINS} ${where}`).bind(...parameters)
      ])
      if (!Array.isArray(result) || result.length !== 2) throw new Error('admin_catalog_read_unavailable')
      return { rows: confirmedRows<ProductSummaryRow>(result[0]), total: confirmedCount(confirmedRows(result[1])) }
    },
    (raw, instant) => ({
      ...metadata(),
      items: raw.rows.map(({ visualJson, ...row }) => ({
        ...row,
        featured: row.featured === 1,
        active: row.status === 'published',
        visual: visual(visualJson, { type: 'botella', color: '#64748b' })
      })),
      pagination: {
        page: query.page,
        perPage: query.perPage,
        total: raw.total,
        pages: Math.ceil(raw.total / query.perPage)
      },
      pricingInstant: instant
    })
  )
}

interface ProductDetailRow extends Omit<
  AdminProductDetail,
  'variants' | 'featured' | 'active' | 'visual' | 'badges' | 'attrs'
> {
  uuid: string
  catalogVersion: number
  featured: number
  visualJson: string
  badgesJson: string
  attrsJson: string
  brandId: string | null
}
interface VariantRow extends Omit<
  D1AdminProductVariant,
  'backorderAllowed' | 'priceTiers' | 'netPrice' | 'identifierExceptionReason'
> {
  backorderAllowed: number
  priceTiersJson: string
  taxClassId: string
  shippingProfileId: string
}

export async function readD1AdminProduct(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  legacyId: string
): Promise<AdminCatalogReadResult<D1AdminProductDetail>> {
  const id = parseAdminCatalogLegacyId(legacyId)
  return authorized(
    database,
    claims,
    now,
    async (instant) => {
      if (id === null) return null
      const product = await database
        .prepare(
          `SELECT p.id AS uuid, p.legacy_id AS id, p.catalog_version AS catalogVersion, p.name, p.slug,
        COALESCE(b.name, 'NETECO') AS brand, p.brand_id AS brandId, c.legacy_id AS categoryId,
        p.short_description AS shortDesc, p.description, p.usage, p.featured, p.status, p.series,
        COALESCE(json_extract(p.attributes, '$.visual'), '{"type":"caja","color":"#009ac9"}') AS visualJson,
        COALESCE(json_extract(p.attributes, '$.badges'), '[]') AS badgesJson,
        COALESCE(json_extract(p.attributes, '$.attrs'), '[]') AS attrsJson,
        CAST(json_extract(p.attributes, '$.image') AS TEXT) AS image,
        CAST(json_extract(p.attributes, '$.imageAlt') AS TEXT) AS imageAlt,
        CAST(json_extract(p.attributes, '$.imageRights.owner') AS TEXT) AS imageRightsOwner,
        CAST(json_extract(p.attributes, '$.imageRights.license') AS TEXT) AS imageRightsLicense,
        CAST(json_extract(p.attributes, '$.imageRights.authorizedAt') AS TEXT) AS imageAuthorizedAt
      ${PRODUCT_JOINS} WHERE p.legacy_id = ? AND ${MAPPED_PRODUCTS}`
        )
        .bind(id)
        .first<ProductDetailRow>()
      if (!product) return null
      const selected = parameterizeEffectivePricingSql(effectiveGovernedVersionIdExpression('v'), instant)
      const variants = await database
        .prepare(
          `SELECT v.legacy_id AS id, v.id AS uuid, v.format, v.sku, v.ean, v.gtin, v.mpn, v.status,
        v.tax_class_id AS taxClassId, v.shipping_profile_id AS shippingProfileId,
        COALESCE(price.gross_cents, v.price_gross_cents) AS price,
        CASE WHEN price.id IS NULL THEN v.compare_at_gross_cents ELSE price.compare_at_gross_cents END AS compareAtPrice,
        price.reference_gross_cents_30d AS referencePrice30d, COALESCE(price.volume_tiers, '[]') AS priceTiersJson,
        COALESCE(price.id, 'legacy:' || v.id) AS pricingVersion, tax.rate_basis_points AS taxRateBasisPoints,
        COALESCE(SUM(b.physical_quantity), 0) AS stock,
        COALESCE(SUM(b.physical_quantity), 0) AS physicalStock,
        COALESCE(SUM(${sellableExpression()}), 0) AS sellableStock,
        v.content_quantity AS units, v.unit_label AS unitLabel, v.unit_base AS unitBase,
        v.units_per_case AS unitsPerCase, v.cases_per_pallet AS casesPerPallet,
        v.minimum_quantity AS minimumQuantity, v.quantity_increment AS quantityIncrement,
        v.maximum_quantity AS maximumQuantity, v.weight_grams AS weightGrams, v.width_mm AS widthMm,
        v.height_mm AS heightMm, v.depth_mm AS depthMm, v.safety_stock AS safetyStock,
        v.backorder_allowed AS backorderAllowed, v.lead_time_days AS leadTimeDays, v.color, v.image
      FROM variants v JOIN tax_classes tax ON tax.id = v.tax_class_id
      LEFT JOIN variant_price_versions price ON price.id = ${selected.sql} AND price.variant_id = v.id
      LEFT JOIN inventory_balances b ON b.variant_id = v.id
      WHERE v.product_id = ? AND v.status <> 'discontinued' AND v.legacy_id BETWEEN 1 AND 9007199254740991
      GROUP BY v.id ORDER BY v.legacy_id, v.id`
        )
        .bind(...selected.instantParameters, product.uuid)
        .all<VariantRow>()
      return { product, variants: confirmedRows<VariantRow>(variants) }
    },
    ({ product, variants }, instant) => {
      const { featured, visualJson, badgesJson, attrsJson, brandId, ...fields } = product
      return {
        ...fields,
        ...metadata(),
        featured: featured === 1,
        active: product.status === 'published',
        visual: visual(visualJson, { type: 'caja', color: '#009ac9' }),
        badges: badges(badgesJson),
        attrs: attributes(attrsJson),
        variants: variants.map(
          ({ backorderAllowed, priceTiersJson, taxClassId: _tax, shippingProfileId: _shipping, ...variant }) => ({
            ...variant,
            backorderAllowed: backorderAllowed === 1,
            identifierExceptionReason: null,
            netPrice: splitGross(variant.price, variant.taxRateBasisPoints).netCents,
            priceTiers: parseVolumeTiers(priceTiersJson, variant.price)
          })
        ),
        pricingInstant: instant,
        authoring: {
          productId: product.id,
          productUuid: product.uuid,
          catalogVersion: product.catalogVersion,
          status: product.status,
          brandId,
          variants: variants.map((variant) => ({
            id: variant.id,
            uuid: variant.uuid,
            status: variant.status,
            sku: variant.sku,
            format: variant.format,
            ean: variant.ean,
            gtin: variant.gtin,
            mpn: variant.mpn,
            taxClassId: variant.taxClassId,
            shippingProfileId: variant.shippingProfileId,
            unitBase: variant.unitBase,
            unitLabel: variant.unitLabel,
            contentQuantity: variant.units,
            unitsPerCase: variant.unitsPerCase,
            casesPerPallet: variant.casesPerPallet,
            minimumQuantity: variant.minimumQuantity,
            quantityIncrement: variant.quantityIncrement,
            maximumQuantity: variant.maximumQuantity,
            weightGrams: variant.weightGrams,
            widthMm: variant.widthMm,
            heightMm: variant.heightMm,
            depthMm: variant.depthMm,
            backorderAllowed: variant.backorderAllowed === 1,
            leadTimeDays: variant.leadTimeDays,
            color: variant.color
          }))
        },
        fieldAvailability: { identifierExceptionReason: false }
      }
    }
  )
}

interface CategoryRow {
  uuid: string
  parentUuid: string | null
  id: number | null
  name: string
  slug: string
  sort: number
  status: AdminCatalogStatus
  directCount: number
  version: number
  directChildren: number
}
class CategoryReadAuthorityError extends Error {
  constructor(readonly code: 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'forbidden') {
    super(code)
  }
}

/** Private tree includes ALL publication states. It never changes the public
 * /api/categories publication rule or substitutes a public filtered tree. */
export async function listD1AdminCategories(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string
): Promise<AdminCatalogReadResult<D1AdminCategoryResponse>> {
  try {
    return await authorized(
      database,
      claims,
      now,
      async () => {
        const result = await database
          .prepare(
            `SELECT c.id AS uuid, c.parent_id AS parentUuid,
        c.legacy_id AS id, c.name, c.slug, c.sort_order AS sort, c.status, c.category_version AS version,
        (SELECT count(*) FROM categories child WHERE child.parent_id=c.id) AS directChildren, COUNT(p.id) AS directCount
      FROM categories c LEFT JOIN products p ON p.category_id = c.id
      GROUP BY c.id ORDER BY c.sort_order, lower(c.name), c.legacy_id, c.id`
          )
          .all<CategoryRow>()
        const rows = catalogPolicyOwnJson(confirmedRows<CategoryRow>(result))
        if (!Array.isArray(rows)) throw new Error('admin_catalog_read_unavailable')
        const writer = await authorizeD1Session(database, claims!, 'administration.manage', { requireMfa: true })
        // The extra asynchronous capability read must never outlive private read
        // authority. Use the current real server clock after its final await.
        const reader = await authorizeD1Session(database, claims!, ADMIN_CATALOG_PERMISSION, { requireMfa: true })
        if (!reader.allowed) throw new CategoryReadAuthorityError(reader.code)
        return { rows: rows as CategoryRow[], writer: writer.allowed }
      },
      ({ rows, writer }) => {
        const records = new Map(rows.map((row) => [row.uuid, row]))
        const mapped = (row: CategoryRow) => row.id !== null && Number.isSafeInteger(row.id) && row.id > 0
        const nodes = new Map<string, D1AdminCategoryNode>()
        // Validate ancestry by durable IDs. Never loop forever, silently omit a
        // cyclic subtree or fabricate a parent when the stored tree is corrupt.
        for (const row of rows) {
          const visited = new Set([row.uuid])
          let parent = row.parentUuid === null ? undefined : records.get(row.parentUuid)
          while (parent) {
            if (visited.has(parent.uuid)) throw new Error('invalid_admin_category_hierarchy')
            visited.add(parent.uuid)
            parent = parent.parentUuid === null ? undefined : records.get(parent.parentUuid)
          }
          if (!mapped(row)) continue
          nodes.set(row.uuid, {
            id: row.id!,
            name: row.name,
            slug: row.slug,
            parentId: null,
            sort: row.sort,
            status: row.status,
            directCount: row.directCount,
            count: 0,
            authoring: catalogCategorySnapshotSchema.parse({
              id: row.id!,
              uuid: row.uuid,
              version: row.version,
              name: row.name,
              slug: row.slug,
              status: row.status,
              actualParentUuid: row.parentUuid,
              actualParentId: row.parentUuid === null ? null : (records.get(row.parentUuid)?.id ?? null),
              parentMapped: row.parentUuid === null || mapped(records.get(row.parentUuid)!),
              sort: row.sort,
              directChildren: row.directChildren,
              directProducts: row.directCount
            }),
            children: []
          })
        }
        // Unmapped ancestors are traversable, not colliding null legacy keys. Their
        // mapped descendants retain their nearest addressable editorial parent.
        for (const row of rows) {
          const node = nodes.get(row.uuid)
          let parent = row.parentUuid === null ? undefined : records.get(row.parentUuid)
          while (parent && !nodes.has(parent.uuid))
            parent = parent.parentUuid === null ? undefined : records.get(parent.parentUuid)
          if (node && parent) {
            const ancestor = nodes.get(parent.uuid)!
            node.parentId = ancestor.id
            ancestor.children.push(node)
          }
          let ancestor: CategoryRow | undefined = row
          while (ancestor) {
            const mappedAncestor = nodes.get(ancestor.uuid)
            if (mappedAncestor) mappedAncestor.count += row.directCount
            ancestor = ancestor.parentUuid === null ? undefined : records.get(ancestor.parentUuid)
          }
        }
        return {
          ...metadata(),
          capabilities: {
            ...ADMIN_CATALOG_CAPABILITIES,
            categoryCreate: writer,
            categoryUpdate: writer,
            categoryDelete: writer
          },
          roots: [...nodes.values()].filter((node) => node.parentId === null),
          flat: [...nodes.values()].map(({ children: _children, ...node }) => node),
          unmappedCategories: rows.length - nodes.size
        }
      }
    )
  } catch (failure) {
    if (failure instanceof CategoryReadAuthorityError) return { outcome: 'denied', code: failure.code }
    throw failure
  }
}
