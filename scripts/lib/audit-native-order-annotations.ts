import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  orderAnnotationsResponseSchema,
  orderAnnotationsReceiptSchema,
  orderAnnotationCommandSchema
} from '../../shared/order-annotations'
import { orderTimelineResponseSchema } from '../../shared/order-timeline'
import { ORDER_EXPORT_HEADERS, ORDER_EXPORT_COLUMNS, verifyOrderExportCsv } from '../../shared/order-export'
export interface NativeOrderAnnotationsInput {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  adminCookie: string
  customerCookie: string
  orderId: string
  scenario?: (name: string) => void
}
export const ORDER_ANNOTATIONS_NATIVE_SCENARIOS = [
  'native_order_annotations_empty_private_read',
  'native_order_annotations_append_note_and_labels',
  'native_order_annotations_exact_replay',
  'native_order_annotations_read_only_receipt',
  'native_order_annotations_stale_cas_rejected',
  'native_order_annotations_labels_only_preserves_note',
  'native_order_annotations_second_note_keyset_pagination',
  'native_order_annotations_unknown_receipt_not_absence',
  'native_order_annotations_anonymous_customer_denied',
  'native_order_annotations_public_privacy_and_money_stock_unchanged'
] as const
export async function auditNativeOrderAnnotations(input: NativeOrderAnnotationsInput) {
  const origin = new URL(input.origin)
  assert(
    origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname === 'shop-audit.neteco.test',
    'isolated origin required'
  )
  z.string().uuid().parse(input.orderId)
  for (const cookie of [input.adminCookie, input.customerCookie])
    assert(
      typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 16384 && !/[\r\n]/u.test(cookie),
      'invalid private cookie'
    )
  assert.notEqual(input.adminCookie, input.customerCookie)
  let requests = 0
  const checks: string[] = []
  const mark = (index: number) => {
    const name = ORDER_ANNOTATIONS_NATIVE_SCENARIOS[index]!
    checks.push(name)
    input.scenario?.(name)
  }
  const path = `/api/admin/orders/${input.orderId}/annotations`
  async function request(route: string, method = 'GET', body?: unknown, cookie = input.adminCookie, key?: string) {
    requests++
    return input.dispatch(
      new Request(input.origin + route, {
        method,
        headers: {
          Origin: input.origin,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '192.0.2.163',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual'
      })
    )
  }
  async function json(response: Response, status = 200, cachePolicy: 'private' | 'no-store' = 'private') {
    assert.equal(response.status, status)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/i)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
    if (cachePolicy === 'private') assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/i)
    assert.equal(response.headers.get('set-cookie'), null)
    const bytes = await response.arrayBuffer()
    assert(bytes.byteLength > 0 && bytes.byteLength <= 150000)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  }
  async function all(sql: string, ...args: unknown[]) {
    const result = await input.database
      .prepare(sql)
      .bind(...args)
      .all()
    assert(result.success && Array.isArray(result.results))
    assert.equal(result.meta.rows_written, 0)
    assert(result.results.length <= 10000, 'bounded fixture required')
    return result.results
  }
  async function digest() {
    const tables = [
      'orders',
      'order_lines',
      'inventory_reservations',
      'inventory_reservation_lines',
      'inventory_balances',
      'inventory_movements',
      'payment_commands',
      'payment_intents',
      'payment_events',
      'payment_fulfilment_claims',
      'payment_recovery_jobs',
      'order_events',
      'fiscal_outbox_events',
      'fiscal_invoice_intents',
      'fiscal_documents',
      'refund_contracts',
      'fiscal_credit_contracts'
    ]
    const rows = await Promise.all(tables.map((table) => all(`SELECT * FROM ${table} ORDER BY 1,2 LIMIT 10001`)))
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  }
  const ledger = async () =>
    all('SELECT * FROM order_annotation_commands WHERE order_id=? ORDER BY version', input.orderId)
  const readWitness = async () =>
    Promise.all([
      all('SELECT * FROM order_annotation_commands ORDER BY order_id,version LIMIT 10001'),
      all('SELECT * FROM identity_rate_limits ORDER BY identity_id,scope LIMIT 10001')
    ])
  const baseline = await digest()
  assert.equal((await ledger()).length, 0, 'caller must supply an unannotated owned order')
  const read = async (suffix = '') => {
    const value = orderAnnotationsResponseSchema.parse(await json(await request(path + suffix)))
    assert.equal(value.orderId, input.orderId)
    return value
  }
  const beforeInitial = await readWitness(),
    first = await read()
  assert.deepEqual(first, {
    source: 'cloudflare',
    orderId: input.orderId,
    version: 0,
    labels: [],
    notes: [],
    nextCursor: null
  })
  assert.deepEqual(await readWitness(), beforeInitial)
  mark(0)
  const firstKey = randomUUID(),
    note = 'Nota interna sintética ' + firstKey,
    labels = ['Revisión sintética']
  const body = { expectedVersion: 0, note, labels }
  const post = async (key: string, value: unknown) => {
    const parsed = orderAnnotationsReceiptSchema.parse(
      await json(await request(path, 'POST', value, input.adminCookie, key))
    )
    assert.equal(parsed.orderId, input.orderId)
    assert.equal(parsed.commandId, key)
    return parsed
  }
  const receipt = await post(firstKey, body)
  assert.equal(receipt.version, 1)
  assert.equal(receipt.noteId, firstKey)
  assert.deepEqual(receipt.labels, labels)
  assert.equal((await ledger()).length, 1)
  mark(1)
  assert.deepEqual(await post(firstKey, body), receipt)
  assert.equal((await ledger()).length, 1)
  mark(2)
  const beforeReceipt = await readWitness(),
    recovered = orderAnnotationCommandSchema.parse(await json(await request(path + '/commands/' + firstKey)))
  assert.equal(recovered.outcome, 'applied')
  assert.deepEqual(recovered.receipt, receipt)
  assert.deepEqual(await readWitness(), beforeReceipt)
  mark(3)
  assert.deepEqual(
    await json(
      await request(path, 'POST', { expectedVersion: 0, note: 'No debe guardarse' }, input.adminCookie, randomUUID()),
      409
    ),
    { error: { code: 'conflict' } }
  )
  assert.equal((await ledger()).length, 1)
  mark(4)
  const labelsReceipt = await post(randomUUID(), { expectedVersion: 1, labels: ['Comprobado sintético'] })
  assert.equal(labelsReceipt.version, 2)
  assert.equal(labelsReceipt.noteId, null)
  const labelsState = await read()
  assert.equal(labelsState.notes.length, 1)
  assert.equal(labelsState.notes[0]!.text, note)
  assert.deepEqual(labelsState.labels, labelsReceipt.labels)
  mark(5)
  const secondKey = randomUUID(),
    secondNote = 'Segunda nota interna sintética ' + secondKey
  const second = await post(secondKey, { expectedVersion: 2, note: secondNote })
  assert.equal(second.version, 3)
  assert.deepEqual(second.labels, labelsReceipt.labels)
  const page = await read('?limit=1')
  assert.equal(page.notes.length, 1)
  assert.equal(page.version, 3)
  assert.equal(page.nextCursor, page.notes[0]!.id)
  const next = await read('?limit=1&before=' + encodeURIComponent(page.nextCursor!))
  assert.equal(next.notes.length, 1)
  assert.equal(next.nextCursor, null)
  assert.notEqual(next.notes[0]!.id, page.notes[0]!.id)
  assert.deepEqual(new Set([page.notes[0]!.text, next.notes[0]!.text]), new Set([note, secondNote]))
  assert.deepEqual(await digest(), baseline, 'money/stock changed')
  mark(6)
  const unknownKey = randomUUID(),
    beforeUnknown = await readWitness(),
    unknown = orderAnnotationCommandSchema.parse(await json(await request(path + '/commands/' + unknownKey)))
  assert.deepEqual(unknown, {
    source: 'cloudflare',
    orderId: input.orderId,
    commandId: unknownKey,
    outcome: 'unknown',
    receipt: null
  })
  assert.deepEqual(await readWitness(), beforeUnknown)
  mark(7)
  await json(await request(path, 'GET', undefined, ''), 401)
  await json(await request(path, 'GET', undefined, input.customerCookie), 403)
  await json(
    await request(path, 'POST', { expectedVersion: 3, note: 'No autorizado' }, input.customerCookie, randomUUID()),
    403
  )
  assert.deepEqual(await readWitness(), beforeUnknown)
  mark(8)
  const timeline = orderTimelineResponseSchema.parse(
    await json(await request(`/api/orders/${input.orderId}/timeline`, 'GET', undefined, input.customerCookie))
  )
  assert.equal(timeline.orderId, input.orderId)
  assert.equal(timeline.audience, 'customer')
  const detail = (await json(
    await request(`/api/orders/${input.orderId}/lines`, 'GET', undefined, input.customerCookie),
    200,
    'no-store'
  )) as Record<string, unknown>
  assert.equal(detail.orderId, input.orderId)
  assert(Array.isArray(detail.lines) && detail.lines.length > 0)
  const publicText = JSON.stringify({ timeline, detail })
  for (const text of [note, secondNote, ...labelsReceipt.labels, 'internalNotes', 'annotations', 'authorId'])
    assert(!publicText.includes(text), 'private annotation leaked')
  const exported = await request('/api/admin/orders/export.csv?q=' + encodeURIComponent(input.orderId))
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get('cache-control') ?? '', /private.*no-store/i)
  const bytes = new Uint8Array(await exported.arrayBuffer()),
    metadata = {
      source: 'cloudflare' as const,
      rows: Number(exported.headers.get(ORDER_EXPORT_HEADERS.rows)),
      bytes: Number(exported.headers.get(ORDER_EXPORT_HEADERS.bytes))
    }
  assert.equal(exported.headers.get(ORDER_EXPORT_HEADERS.source), 'cloudflare')
  assert.equal(metadata.rows, 1)
  verifyOrderExportCsv(bytes, metadata)
  const csv = new TextDecoder().decode(bytes)
  for (const text of [note, secondNote, ...labelsReceipt.labels])
    assert(!csv.includes(text), 'private annotation leaked into export')
  assert(!ORDER_EXPORT_COLUMNS.some((column) => /annotation|note|label|author/i.test(column)))
  assert.equal((await ledger()).length, 3)
  assert.deepEqual(await digest(), baseline, 'money/stock changed')
  mark(9)
  return {
    scenarios: checks.length,
    requests,
    checks,
    ledgerCommands: 3,
    notes: 2,
    pagination: 'keyset_no_snapshot_claim' as const,
    productionAcceptance: false as const,
    providerOperation: false as const
  }
}
