import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'
import {
  ORDER_EXPORT_COLUMNS,
  ORDER_EXPORT_CONTENT_TYPE,
  ORDER_EXPORT_FILENAME,
  ORDER_EXPORT_HEADERS,
  ORDER_EXPORT_MAX_BYTES,
  ORDER_EXPORT_MAX_ROWS,
  orderExportCsvCell,
  orderExportMetadataSchema,
  verifyOrderExportCsv
} from '../../shared/order-export'

export interface NativeOrderExportInput {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  adminCookie: string
  customerCookie: string
  unverifiedAdminCookie?: string
  orderId: string
  scenario?: (name: string) => void
}
export const ORDER_EXPORT_NATIVE_SCENARIOS = [
  'native_order_export_filtered_exact_summary_minor_units',
  'native_order_export_complete_small_dataset',
  'native_order_export_confirmed_empty_header_only',
  'native_order_export_invalid_filters_rejected',
  'native_order_export_anonymous_denied',
  'native_order_export_customer_denied',
  'native_order_export_scoped_counts_and_digests_unchanged'
] as const
const text = z.string().max(4096)
const summarySchema = z
  .object({
    id: z.string().uuid(),
    status: text,
    orderStatus: text,
    paymentStatus: text,
    inventoryStatus: text,
    fulfillmentStatus: text,
    invoiceStatus: text,
    name: text,
    company: text.nullable(),
    email: text,
    city: text,
    paymentMethod: text,
    shippingMethod: text,
    total: z.number().int().nonnegative(),
    createdAt: text,
    lines: z.number().int().nonnegative(),
    shipmentId: text.nullable(),
    trackingNumber: text.nullable(),
    shipmentStatus: text.nullable()
  })
  .strict()
const listSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(summarySchema).max(100),
    pagination: z
      .object({
        page: z.number().int().positive(),
        perPage: z.literal(100),
        total: z.number().int().nonnegative().max(ORDER_EXPORT_MAX_ROWS),
        pages: z.number().int().nonnegative()
      })
      .strict(),
    capabilities: z.record(z.string(), z.boolean())
  })
  .strict()
/** Caller-owned isolated workerd/D1 acceptance only. SELECTs and bounded scoped
 * digests give limited evidence, not a global rows_written proof. No seeds,
 * authority inserts, provider calls, browser or production acceptance. The
 * caller separately owns the global outboundRequests === 0 assertion.
 */
export async function auditNativeOrderExport(input: NativeOrderExportInput) {
  const origin = new URL(input.origin)
  assert(origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname.endsWith('.test'))
  for (const cookie of [
    input.adminCookie,
    input.customerCookie,
    ...(input.unverifiedAdminCookie ? [input.unverifiedAdminCookie] : [])
  ])
    assert(typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 16384 && !/[\r\n]/u.test(cookie))
  assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(input.orderId))
  const order = await input.database
    .prepare('SELECT id, total_gross_cents FROM orders WHERE id = ?')
    .bind(input.orderId)
    .first<{ id: string; total_gross_cents: number }>()
  assert(
    order?.id === input.orderId && Number.isSafeInteger(order.total_gross_cents) && order.total_gross_cents >= 0,
    'Caller must provide an existing order with durable minor-unit amount'
  )
  const tables = [
    'orders',
    'order_lines',
    'order_shipping_address',
    'inventory_balances',
    'inventory_reservations',
    'inventory_reservation_lines',
    'inventory_movements',
    'order_payment_states',
    'payment_intents',
    'payment_events',
    'refund_contracts',
    'refund_receipts',
    'fiscal_invoice_intents',
    'fiscal_provider_receipts',
    'fiscal_documents',
    'fiscal_credit_contracts',
    'fiscal_credit_receipts',
    'fiscal_credit_documents',
    'identities',
    'auth_sessions',
    'identity_roles',
    'role_permissions',
    'identity_rate_limits'
  ] as const
  async function snapshot() {
    const counts = await input.database
      .prepare(`SELECT ${tables.map((table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`).join(', ')}`)
      .first<Record<string, number>>()
    assert(counts && tables.every((table) => Number.isSafeInteger(counts[table]) && counts[table]! >= 0))
    const queries: Array<[string, string[]]> = [
      ['SELECT * FROM orders WHERE id = ?', [input.orderId]],
      ['SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index LIMIT 1001', [input.orderId]],
      ['SELECT * FROM order_shipping_address WHERE order_id = ?', [input.orderId]],
      [
        'SELECT * FROM inventory_reservations WHERE id = (SELECT reservation_id FROM orders WHERE id = ?)',
        [input.orderId]
      ],
      [
        'SELECT * FROM inventory_reservation_lines WHERE reservation_id = (SELECT reservation_id FROM orders WHERE id = ?) ORDER BY variant_id LIMIT 1001',
        [input.orderId]
      ],
      [
        'SELECT * FROM inventory_balances WHERE variant_id IN (SELECT variant_id FROM order_lines WHERE order_id = ?) ORDER BY variant_id,location_id LIMIT 1001',
        [input.orderId]
      ],
      ['SELECT * FROM order_payment_states WHERE order_id = ?', [input.orderId]],
      ['SELECT * FROM payment_intents WHERE order_id = ? ORDER BY id LIMIT 1001', [input.orderId]],
      ['SELECT * FROM refund_contracts WHERE order_id = ? ORDER BY id LIMIT 1001', [input.orderId]],
      [
        'SELECT * FROM refund_receipts WHERE refund_id IN (SELECT id FROM refund_contracts WHERE order_id = ?) ORDER BY refund_id LIMIT 1001',
        [input.orderId]
      ],
      ['SELECT * FROM fiscal_invoice_intents WHERE order_id = ? ORDER BY id LIMIT 1001', [input.orderId]],
      [
        'SELECT * FROM fiscal_provider_receipts WHERE intent_id IN (SELECT id FROM fiscal_invoice_intents WHERE order_id = ?) ORDER BY intent_id LIMIT 1001',
        [input.orderId]
      ],
      ['SELECT * FROM fiscal_credit_contracts WHERE order_id = ? ORDER BY id LIMIT 1001', [input.orderId]],
      [
        'SELECT * FROM fiscal_credit_receipts WHERE credit_id IN (SELECT id FROM fiscal_credit_contracts WHERE order_id = ?) ORDER BY credit_id LIMIT 1001',
        [input.orderId]
      ],
      ['SELECT id,status,session_version,email_verified_at FROM identities ORDER BY id LIMIT 1001', []],
      [
        'SELECT id,identity_id,session_version,mfa_verified,expires_at,revoked_at FROM auth_sessions ORDER BY id LIMIT 1001',
        []
      ],
      [
        'SELECT identity_id,role_code,granted_at,expires_at FROM identity_roles ORDER BY identity_id,role_code LIMIT 1001',
        []
      ],
      ['SELECT * FROM role_permissions ORDER BY role_code,permission_code LIMIT 1001', []],
      ['SELECT * FROM identity_rate_limits ORDER BY identity_id,scope LIMIT 1001', []]
    ]
    const rows = await Promise.all(
      queries.map(async ([sql, values]) => {
        const result = await input.database
          .prepare(sql)
          .bind(...values)
          .all()
        assert(
          result.success && Array.isArray(result.results) && result.results.length <= 1000,
          'Scoped digest must remain bounded'
        )
        return result.results
      })
    )
    return { counts, digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
  }
  const before = await snapshot(),
    checks: string[] = []
  const mark = (index: number) => {
    const id = ORDER_EXPORT_NATIVE_SCENARIOS[index]!
    checks.push(id)
    input.scenario?.(id)
  }
  async function read(path: string, query: URLSearchParams, cookie?: string) {
    const response = await input.dispatch(
      new Request(`${input.origin}${path}?${query}`, {
        method: 'GET',
        headers: {
          origin: input.origin,
          'sec-fetch-site': 'same-origin',
          'cf-connecting-ip': '192.0.2.164',
          ...(cookie ? { cookie } : {})
        }
      })
    )
    const cache = response.headers.get('cache-control') ?? ''
    assert(/\bprivate\b/iu.test(cache) && /\bno-store\b/iu.test(cache) && !/\bpublic\b/iu.test(cache))
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(response.headers.get('location'), null)
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert(bytes.byteLength > 0 && bytes.byteLength <= ORDER_EXPORT_MAX_BYTES)
    return { response, bytes }
  }
  const stable = { sortKey: 'id', sortDir: 'asc' }
  async function list(filters: Record<string, string>) {
    const items: z.infer<typeof summarySchema>[] = []
    let total = -1
    for (let page = 1; page <= 10; page++) {
      const result = await read(
        '/api/admin/orders',
        new URLSearchParams({ ...filters, page: String(page), perPage: '100' }),
        input.adminCookie
      )
      assert.equal(result.response.status, 200)
      assert.match(result.response.headers.get('content-type') ?? '', /application\/json/iu)
      const dto = listSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)))
      assert.equal(dto.pagination.page, page)
      assert.equal(dto.pagination.pages, Math.ceil(dto.pagination.total / 100))
      if (total === -1) total = dto.pagination.total
      assert.equal(dto.pagination.total, total, 'Dataset must stay stable during acceptance')
      items.push(...dto.items)
      if (page >= dto.pagination.pages) break
    }
    assert.equal(items.length, total)
    assert.equal(new Set(items.map((item) => item.id)).size, items.length)
    return items
  }
  async function exported(filters: Record<string, string>) {
    const result = await read('/api/admin/orders/export.csv', new URLSearchParams(filters), input.adminCookie)
    assert.equal(result.response.status, 200)
    const headers = result.response.headers
    assert.equal(headers.get('content-type'), ORDER_EXPORT_CONTENT_TYPE)
    assert.equal(headers.get('content-disposition'), `attachment; filename="${ORDER_EXPORT_FILENAME}"`)
    assert.match(headers.get('vary') ?? '', /\bCookie\b/iu)
    const integer = (name: string) => {
      const value = headers.get(name) ?? ''
      assert.match(value, /^(0|[1-9]\d*)$/u)
      return Number(value)
    }
    const metadata = orderExportMetadataSchema.parse({
      source: headers.get(ORDER_EXPORT_HEADERS.source),
      rows: integer(ORDER_EXPORT_HEADERS.rows),
      bytes: integer(ORDER_EXPORT_HEADERS.bytes)
    })
    verifyOrderExportCsv(result.bytes, metadata)
    return parseCatalogCsvCells(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes.subarray(3)), {
      maxRows: ORDER_EXPORT_MAX_ROWS + 1,
      maxColumns: ORDER_EXPORT_COLUMNS.length,
      maxCellCharacters: 4096
    }).slice(1)
  }
  function match(rows: string[][], items: z.infer<typeof summarySchema>[]) {
    const expected = items.map(
      (item) =>
        parseCatalogCsvCells(
          ORDER_EXPORT_COLUMNS.map((column) =>
            orderExportCsvCell(item[column === 'totalGrossCents' ? 'total' : column] ?? '')
          ).join(','),
          { maxRows: 1, maxColumns: 16, maxCellCharacters: 4096 }
        )[0]
    )
    assert.deepEqual(rows, expected, 'Exact sixteen CSV fields must match the same authorized summary')
  }
  const filtered = { ...stable, q: input.orderId }
  const selectedRows = await exported(filtered),
    selectedItems = await list(filtered)
  match(selectedRows, selectedItems)
  const index = selectedItems.findIndex((item) => item.id === input.orderId)
  assert(index >= 0)
  assert.equal(
    selectedRows[index]![ORDER_EXPORT_COLUMNS.indexOf('totalGrossCents')],
    String(order.total_gross_cents),
    'CSV preserves integer cents, not formatted euros'
  )
  mark(0)
  match(await exported(stable), await list(stable))
  mark(1)
  const empty = { ...stable, q: `native-export-empty-${input.orderId}` }
  const emptyItems = await list(empty),
    emptyRows = await exported(empty)
  assert.equal(emptyItems.length, 0)
  assert.equal(emptyRows.length, 0)
  mark(2)
  async function rejected(
    query: URLSearchParams,
    cookie: string | undefined,
    status: number,
    codes: readonly string[]
  ) {
    const result = await read('/api/admin/orders/export.csv', query, cookie)
    assert.equal(result.response.status, status)
    assert.match(result.response.headers.get('content-type') ?? '', /application\/json/iu)
    assert(result.bytes.byteLength <= 4096)
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)) as unknown
    const parsed = z
      .object({ error: z.object({ code: z.enum(codes as [string, ...string[]]) }).strict() })
      .strict()
      .parse(body)
    assert(codes.includes(parsed.error.code))
    assert.equal(result.response.headers.get('content-disposition'), null)
  }
  for (const query of ['unknown=value', 'from=bad-date', 'q=a&q=b', 'page=1', 'perPage=25'])
    await rejected(new URLSearchParams(query), input.adminCookie, 400, ['invalid_input'])
  mark(3)
  await rejected(new URLSearchParams(filtered), undefined, 401, ['unauthenticated'])
  mark(4)
  await rejected(new URLSearchParams(filtered), input.customerCookie, 403, [
    'forbidden',
    'mfa_required',
    'email_unverified'
  ])
  if (input.unverifiedAdminCookie)
    await rejected(new URLSearchParams(filtered), input.unverifiedAdminCookie, 403, [
      'mfa_required',
      'email_unverified'
    ])
  mark(5)
  assert.deepEqual(await snapshot(), before, 'Scoped counts and fixture digests must remain unchanged')
  mark(6)
  return {
    scenarios: checks.length,
    checks,
    scopedCountTables: tables,
    countsUnchanged: true,
    fixtureDigestsUnchanged: true,
    globalRowsWrittenProof: false,
    outboundNetworkGate: 'caller_owned' as const,
    productionAcceptance: false,
    unverifiedAdminChecked: !!input.unverifiedAdminCookie
  }
}
