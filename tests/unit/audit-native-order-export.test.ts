import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { auditNativeOrderExport } from '../../scripts/lib/audit-native-order-export'
import { ORDER_EXPORT_COLUMNS, orderExportCsvCell } from '../../shared/order-export'

// Synthetic boundary tests validate the assertions, never workerd/D1 acceptance.
const origin = 'https://shop-audit.neteco.test',
  orderId = '10000000-0000-4000-8000-000000000001'
const row = {
  id: orderId,
  status: 'pendiente_pago',
  orderStatus: 'awaiting_payment',
  paymentStatus: 'pending',
  inventoryStatus: 'reserved',
  fulfillmentStatus: 'pending',
  invoiceStatus: 'unavailable',
  name: '=Synthetic, "client"',
  company: null,
  email: 'synthetic@example.invalid',
  city: 'Ciudad',
  paymentMethod: '',
  shippingMethod: 'recogida',
  total: 12100,
  createdAt: '2026-10-08T12:00:00Z',
  lines: 1,
  shipmentId: null,
  trackingNumber: null,
  shipmentStatus: null
}
function boundary(violation = '') {
  const reached: string[] = [],
    statements: string[] = []
  let countReads = 0
  const prepare = vi.fn((sql: string) => {
    statements.push(sql)
    if (!/^SELECT\b/u.test(sql)) throw new Error('non_read_sql')
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => {
        if (sql.includes('COUNT(*)')) {
          countReads++
          if (countReads > 1) reached.push('snapshot')
          return Object.fromEntries(
            [...sql.matchAll(/ AS ([a-z_]+)/gu)].map((match) => [
              match[1]!,
              violation === 'counts' && countReads > 1 ? 2 : 1
            ])
          )
        }
        return { id: orderId, total_gross_cents: 12100 }
      }),
      all: vi.fn(async () => ({
        success: true,
        results: [{ metadata: violation === 'digest' && countReads > 1 ? 'changed' : 'original' }]
      }))
    }
    return statement
  })
  const dispatch = vi.fn(async (request: Request) => {
    expect(request.method).toBe('GET')
    const url = new URL(request.url)
    expect(url.origin).toBe(origin)
    const cookie = request.headers.get('cookie')
    const headers: Record<string, string> = { 'cache-control': 'private, no-store', vary: 'Cookie' }
    const isExport = url.pathname.endsWith('export.csv')
    if (!cookie) {
      reached.push('anonymous')
      if (violation !== 'anonymous')
        return Response.json({ error: { code: 'unauthenticated' } }, { status: 401, headers })
    }
    if (cookie === 'customer') {
      reached.push('customer')
      if (violation !== 'customer') return Response.json({ error: { code: 'forbidden' } }, { status: 403, headers })
    }
    if (cookie === 'unverified-admin') {
      reached.push('mfa')
      return Response.json({ error: { code: 'mfa_required' } }, { status: 403, headers })
    }
    const invalid =
      ['unknown', 'page', 'perPage'].some((key) => isExport && url.searchParams.has(key)) ||
      url.searchParams.getAll('q').length > 1 ||
      url.searchParams.get('from') === 'bad-date'
    if (invalid) {
      reached.push('invalid')
      if (violation !== 'invalid') return Response.json({ error: { code: 'invalid_input' } }, { status: 400, headers })
    }
    const empty = (url.searchParams.get('q') ?? '').startsWith('native-export-empty-')
    if (!isExport) {
      reached.push('list')
      return Response.json(
        {
          source: 'cloudflare',
          items: empty ? [] : [{ ...row, ...(violation === 'summary' ? { total: 12200 } : {}) }],
          pagination: { page: 1, perPage: 100, total: empty ? 0 : 1, pages: empty ? 0 : 1 },
          capabilities: {}
        },
        { headers }
      )
    }
    reached.push(empty ? 'empty' : 'export')
    const cells = ORDER_EXPORT_COLUMNS.map((column) =>
      orderExportCsvCell(row[(column === 'totalGrossCents' ? 'total' : column) as keyof typeof row] ?? '')
    )
    const text =
      '\uFEFF' +
      ORDER_EXPORT_COLUMNS.map(orderExportCsvCell).join(',') +
      '\r\n' +
      (empty ? '' : cells.join(',') + '\r\n')
    const bytes = new TextEncoder().encode(text)
    Object.assign(headers, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="neteco-pedidos.csv"',
      'x-neteco-export-source': 'cloudflare',
      'x-neteco-export-rows': String(empty ? 0 : 1),
      'x-neteco-export-bytes': String(bytes.byteLength)
    })
    if (violation === 'header') headers['x-neteco-export-rows'] = '2'
    if (violation === 'cookie') headers['set-cookie'] = 'unexpected=secret'
    if (violation === 'cache') headers['cache-control'] = 'public, max-age=300'
    if (violation === 'csv') bytes[0] = 0
    return new Response(bytes, { headers })
  })
  return {
    reached,
    statements,
    dispatch,
    prepare,
    input: {
      origin,
      orderId,
      dispatch,
      database: { prepare } as unknown as D1Database,
      adminCookie: 'admin',
      customerCookie: 'customer'
    }
  }
}
describe('native order export assertion boundary, not runtime acceptance', () => {
  it('compiles its scoped order-line read against the actual migration schema', async () => {
    const database = new DatabaseSync(':memory:')
    try {
      const migration = readFileSync(
        new URL('../../db/d1/migrations/0006_checkout_orders.sql', import.meta.url),
        'utf8'
      )
      const definition = migration.match(/CREATE TABLE order_lines \([\s\S]*?\) STRICT;/u)?.[0]
      expect(definition).toBeDefined()
      database.exec(definition!)
      const fixture = boundary(),
        prepare = fixture.prepare.getMockImplementation()!
      fixture.prepare.mockImplementation((sql) => {
        if (sql.startsWith('SELECT * FROM order_lines ')) database.prepare(sql)
        return prepare(sql)
      })
      await expect(auditNativeOrderExport(fixture.input)).resolves.toMatchObject({ scenarios: 7 })
    } finally {
      database.close()
    }
  })
  it('exercises every scenario on a valid boundary without production/global-write claims', async () => {
    const fixture = boundary(),
      scenario = vi.fn()
    const result = await auditNativeOrderExport({ ...fixture.input, scenario })
    expect(result).toMatchObject({
      scenarios: 7,
      countsUnchanged: true,
      fixtureDigestsUnchanged: true,
      globalRowsWrittenProof: false,
      productionAcceptance: false,
      outboundNetworkGate: 'caller_owned'
    })
    expect(scenario).toHaveBeenCalledTimes(7)
    expect(fixture.reached).toEqual(
      expect.arrayContaining(['export', 'list', 'empty', 'invalid', 'anonymous', 'customer', 'snapshot'])
    )
    expect(fixture.statements.every((sql) => /^SELECT\b/u.test(sql))).toBe(true)
  })
  it.each([
    ['header', 'export'],
    ['csv', 'export'],
    ['cookie', 'export'],
    ['cache', 'export'],
    ['summary', 'list'],
    ['anonymous', 'anonymous'],
    ['customer', 'customer'],
    ['invalid', 'invalid'],
    ['counts', 'snapshot'],
    ['digest', 'snapshot']
  ])('rejects %s only after reaching its targeted boundary %s', async (violation, step) => {
    const fixture = boundary(violation)
    await expect(auditNativeOrderExport(fixture.input)).rejects.toThrow()
    expect(fixture.reached).toContain(step)
  })
  it('uses an explicitly supplied unverified administrative cookie without manufacturing authority', async () => {
    const fixture = boundary()
    await auditNativeOrderExport({ ...fixture.input, unverifiedAdminCookie: 'unverified-admin' })
    expect(fixture.reached).toContain('mfa')
  })
  it.each(['https://neteco.es', 'http://shop-audit.neteco.test', 'https://shop-audit.neteco.test/path'])(
    'rejects unsafe origin %s before SQL or dispatch',
    async (origin) => {
      const fixture = boundary()
      await expect(auditNativeOrderExport({ ...fixture.input, origin })).rejects.toThrow()
      expect(fixture.prepare).not.toHaveBeenCalled()
      expect(fixture.dispatch).not.toHaveBeenCalled()
    }
  )
})
