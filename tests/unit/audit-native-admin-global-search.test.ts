import { describe, expect, it, vi } from 'vitest'
import { auditNativeAdminGlobalSearch } from '../../scripts/lib/audit-native-admin-global-search'

// Boundary tests of the acceptance helper, not evidence of live workerd/D1,
// permissions, a browser, production, or the caller's outbound-network gate.
const origin = 'https://shop-audit.neteco.test'
const orderId = '10000000-0000-4000-8000-000000000001'
function guarded() {
  const dispatch = vi.fn(async () => {
    throw new Error('unexpected_dispatch')
  })
  const prepare = vi.fn(() => {
    throw new Error('unexpected_database_read')
  })
  return {
    dispatch,
    prepare,
    input: {
      dispatch,
      database: { prepare } as unknown as D1Database,
      origin,
      adminCookie: 'neteco-session=synthetic-admin',
      customerCookie: 'neteco-session=synthetic-customer',
      productLegacyId: 1,
      productSku: 'SYNTH-SKU',
      orderId
    }
  }
}
function boundary() {
  let countReads = 0
  const state = {
    missingProduct: false,
    missingOrder: false,
    changedCounts: false,
    changedMetadata: false,
    violation: ''
  }
  const statements: string[] = []
  const prepare = vi.fn((sql: string) => {
    statements.push(sql)
    if (!/^SELECT\b/iu.test(sql)) throw new Error('SQL mutation forbidden in helper boundary')
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => {
        if (sql.includes('FROM products p JOIN variants'))
          return state.missingProduct
            ? null
            : { id: 'existing-product', legacyId: 1, name: 'Synthetic catalog product', sku: 'SYNTH-SKU' }
        if (sql === 'SELECT id FROM orders WHERE id = ?') return state.missingOrder ? null : { id: orderId }
        countReads++
        return Object.fromEntries(
          [...sql.matchAll(/ AS ([a-z_]+)/gu)].map((match) => [
            match[1]!,
            state.changedCounts && countReads > 1 ? 2 : 1
          ])
        )
      }),
      all: vi.fn(async () => ({
        success: true,
        results: [{ metadata: state.changedMetadata && countReads > 1 ? 'changed' : 'original' }]
      }))
    }
    return statement
  })
  const dispatch = vi.fn(async (request: Request) => {
    expect(request.method).toBe('GET')
    expect(new URL(request.url).origin).toBe(origin)
    const url = new URL(request.url),
      query = url.searchParams.get('q')!,
      limit = Number(url.searchParams.get('limit'))
    const cookie = request.headers.get('cookie')
    const headers: Record<string, string> = { 'cache-control': 'private, no-store', vary: 'Cookie' }
    if (state.violation === 'cookie') headers['set-cookie'] = 'neteco-session=unexpected'
    if (state.violation === 'cache') headers['cache-control'] = 'public, max-age=300'
    if (!cookie && state.violation !== 'anonymous')
      return Response.json({ error: { code: 'unauthenticated' } }, { status: 401, headers })
    if (cookie === 'neteco-session=synthetic-customer' && state.violation !== 'customer')
      return Response.json({ error: { code: 'forbidden' } }, { status: 403, headers })
    const product = {
      kind: 'product',
      id: '1',
      label: 'Synthetic catalog product',
      description: 'SYNTH-SKU',
      to: '/admin/productos/1'
    }
    const item: Record<string, unknown> =
      query === orderId
        ? {
            kind: 'order',
            id: orderId,
            label: `Pedido ${orderId}`,
            description: 'Pedido',
            to: `/admin/pedidos/${orderId}`
          }
        : { ...product }
    if (state.violation === 'destination') item.to = 'https://example.invalid/private'
    if (state.violation === 'privacy') item.customerEmail = 'customer@example.invalid'
    const items =
      state.violation === 'limit' && limit === 1 ? [item, { ...product, id: '2', to: '/admin/productos/2' }] : [item]
    return Response.json(
      { source: 'cloudflare', query: state.violation === 'query' ? 'wrong-query' : query, items },
      { headers }
    )
  })
  const input = { ...guarded().input, database: { prepare } as unknown as D1Database, dispatch }
  return { state, statements, dispatch, input }
}
describe('native global-search acceptance helper boundary, not live acceptance', () => {
  it('completes six assertion scenarios on a synthetic boundary without claiming live/provider acceptance', async () => {
    const fixture = boundary(),
      scenario = vi.fn()
    const result = await auditNativeAdminGlobalSearch({ ...fixture.input, scenario })
    expect(result).toMatchObject({
      scenarios: 6,
      countsUnchanged: true,
      fixtureDigestsUnchanged: true,
      globalRowsWrittenProof: false,
      outboundNetworkGate: 'caller_owned',
      productionAcceptance: false
    })
    expect(result.checks).toHaveLength(6)
    expect(scenario).toHaveBeenCalledTimes(6)
    expect(fixture.dispatch).toHaveBeenCalledTimes(5)
    expect(fixture.statements.every((sql) => /^SELECT\b/iu.test(sql))).toBe(true)
  })
  it.each(['missingProduct', 'missingOrder'] as const)(
    'requires a real existing fixture for %s before dispatch',
    async (key) => {
      const fixture = boundary()
      fixture.state[key] = true
      await expect(auditNativeAdminGlobalSearch(fixture.input)).rejects.toThrow()
      expect(fixture.dispatch).not.toHaveBeenCalled()
    }
  )
  it.each(['destination', 'privacy', 'query', 'cookie', 'cache', 'limit', 'anonymous', 'customer'])(
    'refuses boundary contract violation %s rather than counting a pass',
    async (violation) => {
      const fixture = boundary()
      fixture.state.violation = violation
      await expect(auditNativeAdminGlobalSearch(fixture.input)).rejects.toThrow()
    }
  )
  it.each(['changedCounts', 'changedMetadata'] as const)(
    'detects %s instead of claiming read-only evidence',
    async (key) => {
      const fixture = boundary()
      fixture.state[key] = true
      await expect(auditNativeAdminGlobalSearch(fixture.input)).rejects.toThrow()
    }
  )
  it.each(['http://shop-audit.neteco.test', 'https://neteco.es', 'https://shop-audit.neteco.test/path', 'not-a-url'])(
    'rejects unsafe origin %s before dispatch or SQL',
    async (origin) => {
      const fixture = guarded()
      await expect(auditNativeAdminGlobalSearch({ ...fixture.input, origin })).rejects.toThrow()
      expect(fixture.dispatch).not.toHaveBeenCalled()
      expect(fixture.prepare).not.toHaveBeenCalled()
    }
  )
  it.each([
    { productLegacyId: 0 },
    { productLegacyId: 1.5 },
    { productSku: '' },
    { productSku: 'x' },
    { productSku: 'x'.repeat(101) },
    { productSku: 'sku\nprivate' },
    { orderId: 'customer-email' },
    { adminCookie: '' },
    { customerCookie: 'invalid\r\ncookie' }
  ])('rejects invalid fixture argument %j before dispatch or SQL', async (invalid) => {
    const fixture = guarded()
    await expect(auditNativeAdminGlobalSearch({ ...fixture.input, ...invalid })).rejects.toThrow()
    expect(fixture.dispatch).not.toHaveBeenCalled()
    expect(fixture.prepare).not.toHaveBeenCalled()
  })
})
