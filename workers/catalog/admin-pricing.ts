import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import {
  effectiveGrossCentsExpression,
  effectiveGovernedVersionIdExpression,
  parameterizeEffectivePricingSql,
  PRICE_INSTANT_TOKEN,
  resolvePricingInstant
} from './pricing'
import { parseVolumeTiers } from './volume-pricing'
import { ADMIN_PRICE_WRITE_PERMISSION } from './admin-price-commands'

/** Public catalog.read is insufficient to reveal draft SKUs and price history. */
export const ADMIN_PRICING_PERMISSION = 'catalog.write'
export const ADMIN_PRICING_CAPABILITIES = {
  pricesRead: true,
  priceHistoryRead: true,
  priceSchedulesRead: true,
  priceWrite: false,
  priceSchedule: false,
  priceCancel: false
} as const

export interface AdminPricingQuery {
  q: string
  /** Optional canonical variant legacy ID; not an internal UUID or a SKU. */
  variant?: number
  page: number
  perPage: number
  historyPage: number
  historyPerPage: number
}
export interface AdminPricingPagination {
  page: number
  perPage: number
  total: number
  pages: number
}
/** Real governed version fields match the ordinary Node panel's history DTO.
 * Creator/canceller identity, audit payloads and rights evidence stay private. */
export interface D1AdminPriceVersion {
  id: string
  grossCents: number
  compareAtGrossCents: number | null
  referenceGrossCents30d: number | null
  volumeTiers: ReturnType<typeof parseVolumeTiers>
  validFrom: string
  validUntil: string | null
  status: 'approved' | 'cancelled'
  reason: string
}
export interface D1AdminPriceItem {
  variantId: string
  id: number
  sku: string
  format: string
  product: string
  currency: string
  grossCents: number
  compareAtGrossCents: number | null
  referenceGrossCents30d: number | null
  volumeTiers: ReturnType<typeof parseVolumeTiers>
  pricingVersion: string
  currentPrice: { kind: 'legacy' | 'governed'; versionId: string | null }
  productId: number
  productUuid: string
  catalogVersion: number
  quantityRules: { minimumQuantity: number; maximumQuantity: number | null; quantityIncrement: number }
  /** Complete last approved head, independent of history pagination. */
  latestApproved: D1AdminPriceVersion | null
  /** Advisory at pricingInstant; the writer rechecks the live SQL clock. */
  cancellable: boolean
  /** Legacy fallback has no invented validity when created_at is invalid. */
  validFrom: string | null
  history: D1AdminPriceVersion[]
  /** Per-variant count, including approved and cancelled versions. */
  historyPagination: AdminPricingPagination
  /** Earliest approved future version across ALL versions, not history page. */
  scheduled: D1AdminPriceVersion | null
}
export interface D1AdminPricingList {
  source: 'cloudflare'
  capabilities: Omit<typeof ADMIN_PRICING_CAPABILITIES, 'priceSchedule' | 'priceCancel'> & {
    priceSchedule: boolean
    priceCancel: boolean
  }
  items: D1AdminPriceItem[]
  /** Count of matching mapped, non-discontinued variants, not versions. */
  pagination: AdminPricingPagination
  pricingInstant: string
  referenceEvidence: 'available_approved_windows_only'
  /** Maximum response records: list 500 items + 4000 history + 500 schedules.
   * A targeted legacy variant read contains at most 100 history + 1 schedule. */
  limits: { itemsPerPageMax: 500; historyPerPageMax: number; returnedVersionRecordsMax: number }
}
export type AdminPricingReadResult =
  | { outcome: 'found'; data: D1AdminPricingList }
  | { outcome: 'denied'; code: 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'forbidden' }

export function parseAdminPricingLegacyId(value: string): number | null {
  if (!/^[1-9]\d{0,15}$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function validQuery(query: AdminPricingQuery) {
  return (
    typeof query.q === 'string' &&
    query.q.length <= 160 &&
    !Array.from(query.q).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    Number.isSafeInteger(query.page) &&
    query.page > 0 &&
    query.page <= 1_000_000 &&
    Number.isSafeInteger(query.perPage) &&
    query.perPage > 0 &&
    query.perPage <= 500 &&
    Number.isSafeInteger(query.historyPage) &&
    query.historyPage > 0 &&
    query.historyPage <= 1_000_000 &&
    Number.isSafeInteger(query.historyPerPage) &&
    query.historyPerPage > 0 &&
    query.historyPerPage <= (query.variant === undefined ? 8 : 100) &&
    (query.variant === undefined || (Number.isSafeInteger(query.variant) && query.variant > 0))
  )
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
function searchSql(expression: string) {
  return `lower(${SEARCH_FOLD.reduce((sql, [from, to]) => `replace(${sql}, '${from}', '${to}')`, expression)})`
}
function searchTerm(term: string) {
  return SEARCH_FOLD.reduce((text, [from, to]) => text.replaceAll(from, to), term.trim()).toLowerCase()
}

interface PriceItemRow {
  variantId: string
  id: number
  sku: string
  format: string
  product: string
  currency: string
  grossCents: number
  compareAtGrossCents: number | null
  referenceGrossCents30d: number | null
  volumeJson: string
  pricingVersion: string
  validFrom: string | null
  legacyCreatedAt: string
  historyTotal: number
  currentVersionId: string | null
  productId: number
  productUuid: string
  catalogVersion: number
  minimumQuantity: number
  maximumQuantity: number | null
  quantityIncrement: number
}
interface PriceHistoryRow extends Omit<D1AdminPriceVersion, 'volumeTiers'> {
  variantId: string
  volumeJson: string
  historyRow: number
  isScheduled: number
  isHead: number
}

function pagination(page: number, perPage: number, total: number): AdminPricingPagination {
  return { page, perPage, total, pages: Math.ceil(total / perPage) }
}
function legacyTimestamp(value: string): string | null {
  // SQLite CURRENT_TIMESTAMP is UTC but lacks the ISO separator/suffix.
  const instant = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
  try {
    return new Date(resolvePricingInstant({ instant })).toISOString()
  } catch {
    return null
  }
}
function version(row: PriceHistoryRow): D1AdminPriceVersion {
  return {
    id: row.id,
    grossCents: row.grossCents,
    compareAtGrossCents: row.compareAtGrossCents,
    referenceGrossCents30d: row.referenceGrossCents30d,
    volumeTiers: parseVolumeTiers(row.volumeJson, row.grossCents),
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    status: row.status,
    reason: row.reason
  }
}

/** Same winning version rule as storefront/catalog. Only prepared binds are
 * used for input and clock; three data reads, regardless of item/history count.
 * Load raw records, recheck live authority at elapsed server time, THEN project.
 * `now` is server-owned/test-only, never a URL/body/header timestamp. */
export async function listD1AdminPrices(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  query: AdminPricingQuery
): Promise<AdminPricingReadResult> {
  if (!validQuery(query)) throw new Error('invalid_admin_pricing_query')
  if (!claims) return { outcome: 'denied', code: 'unauthenticated' }
  const instant = resolvePricingInstant({ instant: now })
  const started = Date.now()
  const authorizationInstant = () =>
    new Date(Date.parse(instant) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const before = await authorizeD1Session(database, claims, ADMIN_PRICING_PERMISSION, {
    now: authorizationInstant(),
    requireMfa: true
  })
  if (!before.allowed) return { outcome: 'denied', code: before.code }

  const filters = ["v.status <> 'discontinued'", 'v.legacy_id BETWEEN 1 AND 9007199254740991']
  const parameters: Array<string | number> = []
  if (query.q.trim()) {
    filters.push(`(instr(${searchSql('p.name')}, ?) > 0 OR instr(${searchSql('v.sku')}, ?) > 0)`)
    const term = searchTerm(query.q)
    parameters.push(term, term)
  }
  if (query.variant !== undefined) {
    filters.push('v.legacy_id = ?')
    parameters.push(query.variant)
  }
  const matched = `FROM variants v JOIN products p ON p.id = v.product_id WHERE ${filters.join(' AND ')}`
  const countStatement = database.prepare(`SELECT count(*) AS total ${matched}`).bind(...parameters)
  const selected = `selected AS (
    SELECT v.*, p.name AS productName, p.legacy_id AS productLegacyId, p.catalog_version AS catalogVersion ${matched}
    ORDER BY lower(p.name), v.legacy_id, v.id LIMIT ? OFFSET ?
  )`
  const pageParameters = [...parameters, query.perPage, (query.page - 1) * query.perPage]
  const currentSql = parameterizeEffectivePricingSql(
    `WITH ${selected}
    SELECT v.id AS variantId, v.legacy_id AS id, v.sku, v.format, v.productName AS product, v.currency,
      v.product_id AS productUuid,v.productLegacyId AS productId,v.catalogVersion,
      v.minimum_quantity AS minimumQuantity,v.maximum_quantity AS maximumQuantity,v.quantity_increment AS quantityIncrement,
      ${effectiveGrossCentsExpression('v')} AS grossCents,
      CASE WHEN price.id IS NULL THEN v.compare_at_gross_cents ELSE price.compare_at_gross_cents END AS compareAtGrossCents,
      price.reference_gross_cents_30d AS referenceGrossCents30d,
      COALESCE(price.volume_tiers, '[]') AS volumeJson,
      COALESCE(price.id, 'legacy:' || v.id) AS pricingVersion,
      price.id AS currentVersionId,
      price.valid_from AS validFrom, v.created_at AS legacyCreatedAt,
      (SELECT count(*) FROM variant_price_versions history WHERE history.variant_id = v.id) AS historyTotal
    FROM selected v LEFT JOIN variant_price_versions price
      ON price.id = ${effectiveGovernedVersionIdExpression('v')} AND price.variant_id = v.id
    ORDER BY lower(v.productName), v.legacy_id, v.id`,
    instant
  )
  const itemStatement = database.prepare(currentSql.sql).bind(...pageParameters, ...currentSql.instantParameters)
  const historySql = parameterizeEffectivePricingSql(
    `WITH ${selected}, ranked AS (
    SELECT history.variant_id AS variantId, history.id, history.gross_cents AS grossCents,
      history.compare_at_gross_cents AS compareAtGrossCents,
      history.reference_gross_cents_30d AS referenceGrossCents30d, history.volume_tiers AS volumeJson,
      history.valid_from AS validFrom, history.valid_until AS validUntil, history.status, history.reason,
      row_number() OVER (PARTITION BY history.variant_id
        ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ', history.valid_from) DESC,
          strftime('%Y-%m-%dT%H:%M:%fZ', history.created_at) DESC, history.id DESC) AS historyRow,
      history.id = (
        SELECT scheduled.id FROM variant_price_versions scheduled
        WHERE scheduled.variant_id = history.variant_id AND scheduled.status = 'approved'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', scheduled.valid_from) > ${PRICE_INSTANT_TOKEN}
        ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ', scheduled.valid_from),
          strftime('%Y-%m-%dT%H:%M:%fZ', scheduled.created_at) DESC, scheduled.id DESC LIMIT 1
      ) AS isScheduled,
      history.id=(SELECT head.id FROM variant_price_versions head WHERE head.variant_id=history.variant_id AND head.status='approved'
        ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ',head.valid_from) DESC,
          strftime('%Y-%m-%dT%H:%M:%fZ',head.created_at) DESC,head.id DESC LIMIT 1) AS isHead
    FROM variant_price_versions history JOIN selected v ON v.id = history.variant_id
  ) SELECT * FROM ranked WHERE (historyRow > ? AND historyRow <= ?) OR isScheduled OR isHead
    ORDER BY variantId, historyRow`,
    instant
  )
  const historyStart = (query.historyPage - 1) * query.historyPerPage
  const historyEnd = historyStart + query.historyPerPage
  // A single read batch keeps count/items/history on the same D1 snapshot.
  const [countResult, itemResult, historyResult] = await database.batch([
    countStatement,
    itemStatement,
    database.prepare(historySql.sql).bind(...pageParameters, ...historySql.instantParameters, historyStart, historyEnd)
  ])
  if (!countResult || !itemResult || !historyResult) throw new Error('admin_pricing_read_unavailable')
  const count = countResult.results[0] as { total: number } | undefined
  const items = itemResult.results as unknown as PriceItemRow[]
  const history = historyResult.results as unknown as PriceHistoryRow[]
  const after = await authorizeD1Session(database, claims, ADMIN_PRICING_PERMISSION, {
    now: authorizationInstant(),
    requireMfa: true
  })
  if (!after.allowed) return { outcome: 'denied', code: after.code }
  const writer = await authorizeD1Session(database, claims, ADMIN_PRICE_WRITE_PERMISSION, {
    now: authorizationInstant(),
    requireMfa: true
  })
  const finalReader = await authorizeD1Session(database, claims, ADMIN_PRICING_PERMISSION, {
    now: authorizationInstant(),
    requireMfa: true
  })
  if (!finalReader.allowed) return { outcome: 'denied', code: finalReader.code }

  const versions = new Map<
    string,
    { history: D1AdminPriceVersion[]; scheduled: D1AdminPriceVersion | null; head: D1AdminPriceVersion | null }
  >()
  for (const row of history) {
    let bucket = versions.get(row.variantId)
    if (!bucket) {
      bucket = { history: [], scheduled: null, head: null }
      versions.set(row.variantId, bucket)
    }
    const entry = version(row)
    if (row.historyRow > historyStart && row.historyRow <= historyEnd) bucket.history.push(entry)
    if (row.isScheduled) bucket.scheduled = entry
    if (row.isHead) bucket.head = entry
  }
  return {
    outcome: 'found',
    data: {
      source: 'cloudflare',
      capabilities: { ...ADMIN_PRICING_CAPABILITIES, priceSchedule: writer.allowed, priceCancel: writer.allowed },
      pricingInstant: instant,
      referenceEvidence: 'available_approved_windows_only',
      pagination: pagination(query.page, query.perPage, count?.total ?? 0),
      limits: {
        itemsPerPageMax: 500,
        historyPerPageMax: query.variant === undefined ? 8 : 100,
        returnedVersionRecordsMax: query.variant === undefined ? 5000 : 102
      },
      items: items.map((row) => ({
        variantId: row.variantId,
        id: row.id,
        sku: row.sku,
        format: row.format,
        product: row.product,
        currency: row.currency,
        grossCents: row.grossCents,
        compareAtGrossCents: row.compareAtGrossCents,
        referenceGrossCents30d: row.referenceGrossCents30d,
        volumeTiers: parseVolumeTiers(row.volumeJson, row.grossCents),
        pricingVersion: row.pricingVersion,
        currentPrice: { kind: row.currentVersionId === null ? 'legacy' : 'governed', versionId: row.currentVersionId },
        productId: row.productId,
        productUuid: row.productUuid,
        catalogVersion: row.catalogVersion,
        quantityRules: {
          minimumQuantity: row.minimumQuantity,
          maximumQuantity: row.maximumQuantity,
          quantityIncrement: row.quantityIncrement
        },
        latestApproved: versions.get(row.variantId)?.head ?? null,
        cancellable:
          !!versions.get(row.variantId)?.head &&
          Date.parse(versions.get(row.variantId)!.head!.validFrom) > Date.parse(instant),
        validFrom: row.validFrom ?? legacyTimestamp(row.legacyCreatedAt),
        history: versions.get(row.variantId)?.history ?? [],
        scheduled: versions.get(row.variantId)?.scheduled ?? null,
        historyPagination: pagination(query.historyPage, query.historyPerPage, row.historyTotal)
      }))
    }
  }
}
