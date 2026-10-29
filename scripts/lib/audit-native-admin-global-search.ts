import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { adminGlobalSearchQuerySchema, adminGlobalSearchResponseSchema } from '../../shared/admin-global-search'

export interface NativeAdminGlobalSearchInput {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  adminCookie: string
  customerCookie: string
  productLegacyId: number
  productSku: string
  orderId: string
  scenario?: (name: string) => void
}
export const ADMIN_GLOBAL_SEARCH_NATIVE_SCENARIOS = [
  'native_admin_global_search_existing_sku_canonical_product',
  'native_admin_global_search_existing_order_uuid_minimal_metadata',
  'native_admin_global_search_server_limit_one_private_no_cookie',
  'native_admin_global_search_anonymous_denied',
  'native_admin_global_search_customer_denied',
  'native_admin_global_search_scoped_counts_and_fixture_digests_unchanged'
] as const

/** Acceptance assertions against caller-owned real workerd/D1. No seeds,
 * authority inserts, SQL mutations, provider calls or browser. Unit doubles of
 * these boundaries do not constitute live acceptance. Caller must separately
 * assert its global outboundRequests === 0, before withdrawing the SKU fixture.
 */
export async function auditNativeAdminGlobalSearch(input: NativeAdminGlobalSearchInput) {
  const origin = new URL(input.origin)
  assert(origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname.endsWith('.test'))
  for (const cookie of [input.adminCookie, input.customerCookie])
    assert(typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 16384 && !/[\r\n]/u.test(cookie))
  assert(Number.isSafeInteger(input.productLegacyId) && input.productLegacyId > 0)
  const skuQuery = adminGlobalSearchQuerySchema.parse(input.productSku)
  assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(input.orderId))
  const product = await input.database
    .prepare(
      'SELECT p.id, p.legacy_id AS legacyId, p.name, v.sku FROM products p JOIN variants v ON v.product_id = p.id WHERE p.legacy_id = ? AND v.sku = ? LIMIT 1'
    )
    .bind(input.productLegacyId, input.productSku)
    .first<{ id: string; legacyId: number; name: string; sku: string }>()
  assert(
    product && product.legacyId === input.productLegacyId && product.sku === input.productSku,
    'Caller must supply an existing product/SKU, not a manufactured search response'
  )
  const order = await input.database
    .prepare('SELECT id FROM orders WHERE id = ?')
    .bind(input.orderId)
    .first<{ id: string }>()
  assert(order && order.id === input.orderId, 'Caller must supply an existing durable order')

  const tables = [
    'products',
    'variants',
    'categories',
    'orders',
    'order_lines',
    'identities',
    'auth_sessions',
    'roles',
    'permissions',
    'role_permissions',
    'identity_roles',
    'cart_commands',
    'catalog_product_status_commands',
    'catalog_product_status_audit',
    'order_fulfillment_commands',
    'order_fulfillment_audit'
  ] as const
  async function snapshot() {
    const counts = await input.database
      .prepare(`SELECT ${tables.map((table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`).join(', ')}`)
      .first<Record<string, number>>()
    assert(counts && tables.every((table) => Number.isSafeInteger(counts[table]) && counts[table]! >= 0))
    // Deliberately scoped metadata, not customer contact data or financial sums.
    const rows = await Promise.all([
      input.database
        .prepare(
          'SELECT id, legacy_id, category_id, name, slug, status, published_at, created_at, updated_at FROM products WHERE id = ?'
        )
        .bind(product!.id)
        .all(),
      input.database
        .prepare('SELECT id, legacy_id, product_id, sku, status FROM variants WHERE product_id = ? ORDER BY id')
        .bind(product!.id)
        .all(),
      input.database
        .prepare(
          'SELECT id, cart_id, quote_id, status, reservation_id, created_at, updated_at FROM orders WHERE id = ?'
        )
        .bind(input.orderId)
        .all(),
      input.database
        .prepare(
          'SELECT id, identity_id, session_version, mfa_verified, created_at, expires_at, revoked_at FROM auth_sessions ORDER BY id'
        )
        .all(),
      input.database.prepare('SELECT code, name, description FROM roles ORDER BY code').all(),
      input.database
        .prepare('SELECT role_code, permission_code FROM role_permissions ORDER BY role_code, permission_code')
        .all(),
      input.database
        .prepare(
          'SELECT identity_id, role_code, granted_by, granted_at, expires_at FROM identity_roles ORDER BY identity_id, role_code'
        )
        .all()
    ])
    assert(rows.every((result) => result.success && Array.isArray(result.results)))
    return {
      counts,
      digest: createHash('sha256')
        .update(JSON.stringify(rows.map((result) => result.results)))
        .digest('hex')
    }
  }
  const before = await snapshot(),
    checks: string[] = []
  const mark = (index: number) => input.scenario?.(ADMIN_GLOBAL_SEARCH_NATIVE_SCENARIOS[index]!)
  async function read(query: string, limit: number, cookie?: string) {
    const response = await input.dispatch(
      new Request(
        `${input.origin}/api/admin/global-search?${new URLSearchParams({ q: query, limit: String(limit) })}`,
        {
          method: 'GET',
          headers: {
            origin: input.origin,
            'sec-fetch-site': 'same-origin',
            'cf-connecting-ip': '192.0.2.159',
            ...(cookie ? { cookie } : {})
          }
        }
      )
    )
    const cache = response.headers.get('cache-control') ?? ''
    assert(/\bprivate\b/iu.test(cache) && /\bno-store\b/iu.test(cache))
    assert.equal(response.headers.get('set-cookie'), null, 'Search must not create/rotate a session')
    assert.match(response.headers.get('content-type') ?? '', /application\/json/iu)
    const bytes = await response.arrayBuffer()
    assert(bytes.byteLength > 0 && bytes.byteLength <= 32768, 'Search response must stay bounded')
    return { status: response.status, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  }
  async function confirmed(query: string, limit: number) {
    const response = await read(query, limit, input.adminCookie)
    assert.equal(response.status, 200)
    const body = adminGlobalSearchResponseSchema.parse(response.body)
    assert.equal(body.query, adminGlobalSearchQuerySchema.parse(query))
    assert(body.items.length <= limit)
    assert.equal(new Set(body.items.map((item) => `${item.kind}:${item.id}`)).size, body.items.length)
    return body
  }
  mark(0)
  const products = await confirmed(skuQuery, 5)
  assert.deepEqual(
    products.items.find((item) => item.kind === 'product' && item.id === String(input.productLegacyId)),
    {
      kind: 'product',
      id: String(input.productLegacyId),
      label: product.name,
      description: product.sku,
      to: `/admin/productos/${input.productLegacyId}`
    }
  )
  checks.push(ADMIN_GLOBAL_SEARCH_NATIVE_SCENARIOS[0])
  mark(1)
  const orders = await confirmed(input.orderId, 5)
  assert.deepEqual(
    orders.items.find((item) => item.kind === 'order' && item.id === input.orderId),
    {
      kind: 'order',
      id: input.orderId,
      label: `Pedido ${input.orderId}`,
      description: 'Pedido',
      to: `/admin/pedidos/${input.orderId}`
    }
  )
  checks.push(ADMIN_GLOBAL_SEARCH_NATIVE_SCENARIOS[1])
  mark(2)
  await confirmed(skuQuery, 1)
  checks.push(ADMIN_GLOBAL_SEARCH_NATIVE_SCENARIOS[2])
  mark(3)
  const anonymous = await read(skuQuery, 5)
  assert.equal(anonymous.status, 401)
  assert.deepEqual(anonymous.body, { error: { code: 'unauthenticated' } })
  checks.push(ADMIN_GLOBAL_SEARCH_NATIVE_SCENARIOS[3])
  mark(4)
  const customer = await read(input.orderId, 5, input.customerCookie)
  assert.equal(customer.status, 403)
  assert.deepEqual(customer.body, { error: { code: 'forbidden' } })
  checks.push(ADMIN_GLOBAL_SEARCH_NATIVE_SCENARIOS[4])
  mark(5)
  const after = await snapshot()
  assert.deepEqual(after, before, 'Scoped application counts and metadata digests must not change')
  checks.push(ADMIN_GLOBAL_SEARCH_NATIVE_SCENARIOS[5])
  return {
    scenarios: checks.length,
    checks,
    scopedCountTables: tables,
    fixtureDigestsUnchanged: true,
    countsUnchanged: true,
    globalRowsWrittenProof: false,
    outboundNetworkGate: 'caller_owned' as const,
    productionAcceptance: false
  }
}
