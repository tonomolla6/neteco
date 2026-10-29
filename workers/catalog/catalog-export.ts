import {
  CATALOG_EXPORT_COLUMNS,
  CATALOG_EXPORT_MAX_BYTES,
  CATALOG_EXPORT_MAX_CELL_CHARACTERS,
  CATALOG_EXPORT_MAX_PRODUCTS,
  CATALOG_EXPORT_MAX_ROWS,
  CATALOG_EXPORT_PROFILE,
  CATALOG_EXPORT_SHEET_NAMES,
  catalogExportFiltersSchema,
  catalogExportHash,
  catalogExportOwnJson,
  catalogExportSnapshotSchema,
  type CatalogExportSnapshot
} from '../../shared/catalog-export'
import type { VerifiedSessionClaims } from './authorization'
import { searchSql, searchTerm } from './admin-catalog'
import { sellableExpression } from './inventory'
import { effectiveGrossCentsExpression, effectiveVersionIdExpression, PRICE_INSTANT_TOKEN } from './pricing'

export class CatalogExportError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'too_large' | 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'forbidden'
  ) {
    super(code)
  }
}
const utc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const unavailable = () => new Error('catalog_export_unavailable')
function bounded(value: unknown): unknown {
  let parsed: unknown
  try {
    parsed = catalogExportOwnJson(value)
  } catch (failure) {
    if (failure instanceof Error && failure.message === 'catalog_export_too_large')
      throw new CatalogExportError('too_large')
    throw unavailable()
  }
  return parsed
}
function own(value: unknown): Record<string, unknown> {
  const parsed = bounded(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unavailable()
  return parsed as Record<string, unknown>
}
/** Both permissions are checked in ONE fresh query, never sequential grants
 * whose intersection could cease to exist between awaits. Also used after the
 * read and after WebCrypto so revoked/expired access never releases a snapshot. */
async function authorize(database: D1Database, input: VerifiedSessionClaims | null) {
  const claims = input === null ? null : own(input)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (
    !claims ||
    typeof claims.sessionId !== 'string' ||
    !uuid.test(claims.sessionId) ||
    typeof claims.identityId !== 'string' ||
    !uuid.test(claims.identityId) ||
    typeof claims.sessionVersion !== 'number' ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    throw new CatalogExportError('unauthenticated')
  const result = await database
    .prepare(
      `SELECT s.mfa_verified,
    (i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?1) AS email_verified,
    (SELECT count(DISTINCT granted.permission_code) FROM identity_roles assigned
      JOIN role_permissions granted ON granted.role_code=assigned.role_code
      WHERE assigned.identity_id=i.id AND granted.permission_code IN ('catalog.write','administration.manage')
        AND assigned.granted_at<=?1 AND (assigned.expires_at IS NULL OR assigned.expires_at>?1)) AS permitted
    FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
    WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4
      AND s.session_version=i.session_version AND s.revoked_at IS NULL
      AND s.created_at<=?1 AND s.expires_at>?1 AND i.status IN ('pending','active')`
    )
    .bind(utc(), claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<unknown>()
  if (result === null) throw new CatalogExportError('unauthenticated')
  const row = own(result)
  if (
    ![0, 1].includes(row.email_verified as number) ||
    ![0, 1].includes(row.mfa_verified as number) ||
    ![0, 1, 2].includes(row.permitted as number)
  )
    throw unavailable()
  if (row.email_verified !== 1) throw new CatalogExportError('email_unverified')
  if (row.mfa_verified !== 1) throw new CatalogExportError('mfa_required')
  if (row.permitted !== 2) throw new CatalogExportError('forbidden')
}
function confirmed(result: unknown): unknown[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw unavailable()
  const success = Object.getOwnPropertyDescriptor(result, 'success'),
    values = Object.getOwnPropertyDescriptor(result, 'results')
  if (
    success?.value !== true ||
    !Object.hasOwn(success, 'value') ||
    !values ||
    !Object.hasOwn(values, 'value') ||
    !Array.isArray(values.value)
  )
    throw unavailable()
  if (values.value.length > CATALOG_EXPORT_MAX_ROWS) throw new CatalogExportError('too_large')
  return values.value
}
function columns(name: keyof typeof CATALOG_EXPORT_COLUMNS, alias: string) {
  return CATALOG_EXPORT_COLUMNS[name]
    .filter((column) => column !== 'record_json')
    .map((column) => `${alias}.${column}`)
    .join(',')
}
/** Read-only, consistent D1 batch. Includes native/unmapped products and ALL
 * their variants, regardless of status. No UUIDs, mappings, stock or approval
 * receipts are invented. Prices/stock are observations at observedAt only. */
export async function readCatalogSnapshot(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  input: unknown
): Promise<CatalogExportSnapshot> {
  const parsed = catalogExportFiltersSchema.safeParse(input)
  if (!parsed.success) throw new CatalogExportError('invalid_input')
  const filters = parsed.data
  await authorize(database, claims)
  const observedAt = utc()
  const cte = `WITH RECURSIVE selected AS (
    SELECT p.* FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN brands brand ON brand.id=p.brand_id
    WHERE (?1='' OR instr(${searchSql('p.name')},?1)>0 OR instr(${searchSql("COALESCE(brand.name,'NETECO')")},?1)>0
      OR EXISTS(SELECT 1 FROM variants search_v WHERE search_v.product_id=p.id AND instr(${searchSql('search_v.sku')},?1)>0))
      AND (?2 IS NULL OR c.legacy_id=?2) AND (?3 IS NULL OR p.status=?3)
  ), chosen AS (SELECT * FROM selected WHERE (SELECT count(*) FROM selected)<=${CATALOG_EXPORT_MAX_PRODUCTS}),
  chosen_variants AS (SELECT v.* FROM variants v JOIN chosen p ON p.id=v.product_id),
  chosen_categories(id) AS (SELECT category_id FROM chosen UNION SELECT c.parent_id FROM categories c JOIN chosen_categories ancestors ON ancestors.id=c.id WHERE c.parent_id IS NOT NULL)
  `
  const pricing = (sql: string) => sql.replaceAll(PRICE_INSTANT_TOKEN, '?4')
  const queries: Array<{ sql: string; price?: boolean; reference?: string }> = [
    { sql: 'SELECT count(*) AS n FROM selected' },
    { sql: `SELECT ${columns('Products', 'p')} FROM chosen p ORDER BY p.id LIMIT 10001` },
    {
      sql: `SELECT ${CATALOG_EXPORT_COLUMNS.Variants.filter(
        (column) => !['record_json', 'effective_gross_cents', 'effective_price_version_id'].includes(column)
      )
        .map((column) => `v.${column}`)
        .join(',')},
      ${pricing(effectiveGrossCentsExpression('v'))} AS effective_gross_cents,
      ${pricing(effectiveVersionIdExpression('v'))} AS effective_price_version_id FROM chosen_variants v ORDER BY v.product_id,v.id LIMIT 10001`,
      price: true
    },
    {
      sql: `SELECT ${CATALOG_EXPORT_COLUMNS.Inventory.filter(
        (column) => !['record_json', 'sellable_quantity'].includes(column)
      )
        .map((column) => `b.${column}`)
        .join(',')},
      ${sellableExpression()} AS sellable_quantity FROM inventory_balances b JOIN chosen_variants v ON v.id=b.variant_id ORDER BY b.variant_id,b.location_id LIMIT 10001`
    },
    {
      sql: `SELECT ${columns('Prices', 'price')} FROM variant_price_versions price JOIN chosen_variants v ON v.id=price.variant_id ORDER BY price.variant_id,price.valid_from,price.id LIMIT 10001`
    },
    {
      sql: `SELECT ${CATALOG_EXPORT_COLUMNS.Media.filter((column) => !['record_json', 'withdrawn_at'].includes(column))
        .map((column) => `m.${column}`)
        .join(',')},
      (SELECT w.created_at FROM product_media_publication_events w WHERE w.publication_id=m.id) AS withdrawn_at
      FROM product_media_publications m JOIN chosen p ON p.id=m.product_id ORDER BY m.product_id,m.id LIMIT 10001`
    },
    {
      sql: 'SELECT c.* FROM categories c WHERE c.id IN (SELECT id FROM chosen_categories) ORDER BY c.id LIMIT 10001',
      reference: 'category'
    },
    {
      sql: 'SELECT b.* FROM brands b WHERE b.id IN (SELECT brand_id FROM chosen) ORDER BY b.id LIMIT 10001',
      reference: 'brand'
    },
    {
      sql: 'SELECT s.* FROM catalog_sources s WHERE s.id IN (SELECT source_id FROM chosen UNION SELECT source_id FROM categories WHERE id IN (SELECT id FROM chosen_categories)) ORDER BY s.id LIMIT 10001',
      reference: 'source'
    },
    {
      sql: 'SELECT t.* FROM tax_classes t WHERE t.id IN (SELECT tax_class_id FROM chosen_variants) ORDER BY t.id LIMIT 10001',
      reference: 'tax'
    },
    {
      sql: 'SELECT s.* FROM shipping_profiles s WHERE s.id IN (SELECT shipping_profile_id FROM chosen_variants) ORDER BY s.id LIMIT 10001',
      reference: 'shipping'
    },
    {
      sql: 'SELECT l.* FROM inventory_locations l WHERE l.id IN (SELECT location_id FROM inventory_balances WHERE variant_id IN (SELECT id FROM chosen_variants)) ORDER BY l.id LIMIT 10001',
      reference: 'location'
    },
    {
      sql: `SELECT u.id,u.filename,u.content_type,u.byte_size,u.width,u.height,u.alt,u.rights_owner,u.rights_license,u.rights_source,u.rights_status,u.scan_status,u.storage_status,u.created_at,u.stored_at
      FROM media_uploads u WHERE u.id IN (SELECT upload_id FROM product_media_publications WHERE product_id IN (SELECT id FROM chosen)) ORDER BY u.id LIMIT 10001`,
      reference: 'media_metadata'
    },
    {
      sql: `SELECT a.* FROM media_assets a WHERE EXISTS (
        SELECT 1 FROM product_media m JOIN chosen p ON p.id=m.product_id
        WHERE m.asset_id=a.id AND (m.variant_id IS NULL OR EXISTS (
          SELECT 1 FROM chosen_variants v WHERE v.id=m.variant_id AND v.product_id=m.product_id
        ))) ORDER BY a.id LIMIT 10001`,
      reference: 'imported_asset'
    },
    {
      sql: `SELECT m.* FROM product_media m JOIN chosen p ON p.id=m.product_id
        WHERE m.variant_id IS NULL OR EXISTS (
          SELECT 1 FROM chosen_variants v WHERE v.id=m.variant_id AND v.product_id=m.product_id
        ) ORDER BY m.product_id,m.variant_id,m.asset_id,m.role,m.version LIMIT 10001`,
      reference: 'imported_media'
    }
  ]
  // Aggregate candidate counts and raw bytes INSIDE D1 before returning any
  // large text. Each bounded subquery supplies an overflow sentinel, never a
  // truncated successful file. All projected columns are accounted for.
  const textColumns = [
    CATALOG_EXPORT_COLUMNS.Products.filter((column) => column !== 'record_json'),
    CATALOG_EXPORT_COLUMNS.Variants.filter((column) => column !== 'record_json'),
    CATALOG_EXPORT_COLUMNS.Inventory.filter((column) => column !== 'record_json'),
    CATALOG_EXPORT_COLUMNS.Prices.filter((column) => column !== 'record_json'),
    CATALOG_EXPORT_COLUMNS.Media.filter((column) => column !== 'record_json'),
    [
      'id',
      'legacy_id',
      'parent_id',
      'name',
      'slug',
      'description',
      'sort_order',
      'status',
      'seo_title',
      'seo_description',
      'source_id',
      'source_version',
      'created_at',
      'updated_at'
    ],
    ['id', 'name', 'slug', 'manufacturer_name', 'website_url', 'logo_asset_id', 'status', 'created_at', 'updated_at'],
    ['id', 'code', 'name', 'owner', 'kind', 'is_master', 'created_at'],
    ['id', 'code', 'name', 'rate_basis_points', 'valid_from', 'valid_until', 'beply_code', 'created_at'],
    ['id', 'code', 'name', 'kind', 'adr_data', 'constraints', 'created_at'],
    ['id', 'code', 'name', 'kind', 'active', 'created_at'],
    [
      'id',
      'filename',
      'content_type',
      'byte_size',
      'width',
      'height',
      'alt',
      'rights_owner',
      'rights_license',
      'rights_source',
      'rights_status',
      'scan_status',
      'storage_status',
      'created_at',
      'stored_at'
    ],
    [
      'id',
      'storage_key',
      'original_name',
      'mime_type',
      'byte_size',
      'checksum_sha256',
      'owner_name',
      'source_url',
      'license',
      'authorized_at',
      'rights_status',
      'quarantine_status',
      'alt_text',
      'metadata',
      'created_at'
    ],
    ['product_id', 'variant_id', 'asset_id', 'role', 'version', 'sort_order']
  ]
  const budgetParts = queries
    .slice(1)
    .map(
      (query, index) =>
        `SELECT count(*) AS n,COALESCE(sum(${textColumns[index]!.map((column) => `COALESCE(length(CAST(candidate."${column}" AS BLOB)),0)`).join('+')}),0) AS bytes FROM (${query.sql}) candidate`
    )
  // Local workerd accepts five compound terms, not SQLite's larger default.
  // Partition every added query, not just the initial twelve, into at most four
  // terms. Four groups currently keep the outer compound below five as well.
  const budgetGroups = Array.from({ length: Math.ceil(budgetParts.length / 4) }, (_, index) =>
    budgetParts.slice(index * 4, index * 4 + 4)
  )
  const budget = budgetGroups
    .map((parts) => `SELECT sum(n) AS n,sum(bytes) AS bytes FROM (${parts.join(' UNION ALL ')})`)
    .join(' UNION ALL ')
  const boundedCte = cte + `, limits AS (SELECT sum(n) AS n,sum(bytes) AS bytes FROM (${budget})) `
  const binds = [
    searchTerm(filters.q),
    filters.category ?? null,
    filters.status ?? null,
    new Date(observedAt).toISOString()
  ]
  const results = await database.batch(
    queries.map((query, index) =>
      database
        .prepare(
          boundedCte +
            (index === 0
              ? 'SELECT count(*) AS n,(SELECT n FROM limits) AS row_n,(SELECT bytes FROM limits) AS raw_bytes FROM selected'
              : `SELECT * FROM (${query.sql}) WHERE (SELECT n FROM limits)<=${CATALOG_EXPORT_MAX_ROWS} AND (SELECT bytes FROM limits)<=${CATALOG_EXPORT_MAX_BYTES}`)
        )
        .bind(...binds)
    )
  )
  if (!Array.isArray(results) || results.length !== queries.length) throw unavailable()
  if (Object.getPrototypeOf(results) !== Array.prototype || Reflect.ownKeys(results).length !== results.length + 1)
    throw unavailable()
  for (let index = 0; index < results.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(results, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw unavailable()
  }
  // One cumulative own-JSON budget across ALL groups, before flatMap/JSON.
  const groups = bounded(results.map(confirmed)) as Array<Record<string, unknown>[]>
  if (groups.some((rows) => rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))))
    throw unavailable()
  const totals = groups[0]![0],
    total = totals?.n
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw unavailable()
  if (
    !totals ||
    typeof totals.row_n !== 'number' ||
    !Number.isSafeInteger(totals.row_n) ||
    totals.row_n < 0 ||
    typeof totals.raw_bytes !== 'number' ||
    !Number.isSafeInteger(totals.raw_bytes) ||
    totals.raw_bytes < 0
  )
    throw unavailable()
  if (total > CATALOG_EXPORT_MAX_PRODUCTS) throw new CatalogExportError('too_large')
  if (totals.row_n > CATALOG_EXPORT_MAX_ROWS || totals.raw_bytes > CATALOG_EXPORT_MAX_BYTES)
    throw new CatalogExportError('too_large')
  const entities = groups.slice(1, 6)
  const references = groups.slice(6).flatMap((rows, index) =>
    rows.map((data) => ({
      kind: queries[index + 6]!.reference!,
      id:
        queries[index + 6]!.reference === 'imported_media'
          ? JSON.stringify([data.product_id, data.variant_id, data.asset_id, data.role, data.version])
          : data.id,
      name: data.name ?? data.filename ?? data.original_name ?? data.role ?? '',
      data
    }))
  )
  entities.push(references)
  if (entities[0]!.length !== total) throw unavailable()
  if (entities.reduce((count, rows) => count + rows.length, 0) > CATALOG_EXPORT_MAX_ROWS)
    throw new CatalogExportError('too_large')
  const sheets = CATALOG_EXPORT_SHEET_NAMES.map((name, index) => ({
    name,
    columns: [...CATALOG_EXPORT_COLUMNS[name]],
    rows: entities[index]!.map((record) => {
      const text = JSON.stringify(record)
      if (text.length > CATALOG_EXPORT_MAX_CELL_CHARACTERS) throw new CatalogExportError('too_large')
      return CATALOG_EXPORT_COLUMNS[name].map((column) => {
        if (column === 'record_json') return text
        if (!Object.hasOwn(record, column)) throw unavailable()
        const value: unknown = record[column]
        if (value === null) return ''
        if (typeof value === 'string') return value
        if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
        throw unavailable()
      })
    })
  }))
  const payload = {
    source: 'cloudflare',
    profile: CATALOG_EXPORT_PROFILE,
    snapshotId: crypto.randomUUID(),
    observedAt,
    filters,
    counts: Object.fromEntries(sheets.map((sheet) => [sheet.name.toLowerCase(), sheet.rows.length])),
    sheets,
    hash: '0'.repeat(64)
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > CATALOG_EXPORT_MAX_BYTES)
    throw new CatalogExportError('too_large')
  const checked = catalogExportSnapshotSchema.safeParse(payload)
  if (!checked.success) throw unavailable()
  await authorize(database, claims)
  const hash = await catalogExportHash(checked.data)
  await authorize(database, claims)
  return { ...checked.data, hash }
}
