import type { VerifiedSessionClaims } from '../catalog/authorization'
import { searchSql, searchTerm } from '../catalog/admin-catalog'
import { readD1AdminCapabilities } from './admin-capabilities'
import {
  adminGlobalSearchQuerySchema,
  adminGlobalSearchResponseSchema,
  type AdminGlobalSearchResponse
} from '../../shared/admin-global-search'

export class AdminGlobalSearchError extends Error {
  constructor(readonly code: 'invalid_input' | 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'forbidden') {
    super(code)
    this.name = 'AdminGlobalSearchError'
  }
}
// Materialized term projections avoid multiplying nested Spanish-fold
// expressions inside correlated predicates on native D1. No public FTS or
// publication authority is involved in this private administration read.
const sql = `WITH variant_terms AS MATERIALIZED (
  SELECT product_id,sku,${searchSql('sku')} AS term FROM variants
  WHERE ?2=1 AND legacy_id BETWEEN 1 AND 9007199254740991 AND status<>'discontinued'
), variant_matches AS (
  SELECT product_id,min(sku) AS representative,min(CASE WHEN instr(term,?1)>0 THEN sku END) AS matched,
  max(term=?1) AS exact FROM variant_terms GROUP BY product_id
), product_hits AS (
  SELECT 'product' AS kind,cast(p.legacy_id AS TEXT) AS id,substr(p.name,1,200) AS label,
  substr(COALESCE(v.matched,v.representative,''),1,160) AS description,
  '/admin/productos/'||p.legacy_id AS "to",
  CASE WHEN ${searchSql('p.name')}=?1 OR v.exact=1 THEN 0 ELSE 1 END AS rank
  FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN variant_matches v ON v.product_id=p.id
  WHERE ?2=1 AND p.legacy_id BETWEEN 1 AND 9007199254740991 AND c.legacy_id BETWEEN 1 AND 9007199254740991
  AND (instr(${searchSql('p.name')},?1)>0 OR v.matched IS NOT NULL)
  ORDER BY rank,lower(label),id LIMIT ?4
), order_hits AS (
  SELECT 'order' AS kind,o.id AS id,'Pedido '||o.id AS label,'Pedido' AS description,
  '/admin/pedidos/'||o.id AS "to",CASE WHEN lower(o.id)=?1 THEN 0 ELSE 1 END AS rank
  FROM orders o WHERE ?3=1 AND instr(lower(o.id),?1)>0
  AND length(o.id)=36 AND substr(o.id,9,1)='-' AND substr(o.id,14,1)='-' AND substr(o.id,19,1)='-' AND substr(o.id,24,1)='-'
  AND length(replace(o.id,'-',''))=32 AND lower(replace(o.id,'-','')) NOT GLOB '*[^0-9a-f]*'
  ORDER BY rank,lower(label),id LIMIT ?4
), hits AS (SELECT * FROM product_hits UNION ALL SELECT * FROM order_hits)
SELECT kind,id,label,description,"to" FROM hits ORDER BY rank,kind,lower(label),id LIMIT ?4`

/** Capabilities before and after the single bounded data query. No heartbeat,
 * clock override from HTTP, payload lookup, ledger write or per-result read. */
export async function readD1AdminGlobalSearch(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  options: { query: string; limit?: number; now?: () => string }
): Promise<AdminGlobalSearchResponse> {
  const parsed = adminGlobalSearchQuerySchema.safeParse(options.query),
    limit = options.limit ?? 10
  if (!parsed.success || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new AdminGlobalSearchError('invalid_input')
  const query = parsed.data,
    clock = options.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
  async function authority() {
    if (!claims) throw new AdminGlobalSearchError('unauthenticated')
    const caps = await readD1AdminCapabilities(database, claims, clock())
    if (!caps) throw new AdminGlobalSearchError('unauthenticated')
    if (caps.state !== 'ready') throw new AdminGlobalSearchError(caps.state)
    return caps
  }
  const first = await authority()
  const result = await database
    .prepare(sql)
    .bind(
      searchTerm(query),
      first.permissions.includes('catalog.write') ? 1 : 0,
      first.permissions.includes('administration.manage') ? 1 : 0,
      limit
    )
    .all()
  const current = await authority()
  if (JSON.stringify(first.permissions) !== JSON.stringify(current.permissions))
    throw new AdminGlobalSearchError('forbidden')
  if (result.success !== true || !Array.isArray(result.results)) throw new Error('unconfirmed_global_search')
  const items = result.results.map((row) => ({
    ...row,
    label: typeof row.label === 'string' ? row.label.slice(0, 200) : row.label,
    description: typeof row.description === 'string' ? row.description.slice(0, 160) : row.description
  }))
  return adminGlobalSearchResponseSchema.parse({ source: 'cloudflare', query, items })
}
