import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { adminInventoryVariantSchema, inventoryLegacyIdSchema } from '../../shared/inventory-commands'
import {
  inventoryCountImportPreviewSchema,
  inventoryCountImportReceiptSchema,
  inventoryCountImportSnapshotSchema,
  inventoryCountImportListSchema,
  inventoryCountImportCommandSchema,
  inventoryCountImportIntentHash
} from '../../shared/inventory-count-import'

export interface NativeInventoryCountImportInput {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  proposerCookie: string
  approverCookie: string
  unprivilegedCookie: string
  variantLegacyId: number
  scenario: (name: string) => void
}
async function readRows(database: D1Database, sql: string, ...params: (number | string)[]) {
  const result = await database
    .prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>()
  assert.equal(result.success, true)
  assert(result.results.length <= 1000, 'native_count_import_evidence_limit')
  if (result.meta?.rows_written !== undefined) assert.equal(result.meta.rows_written, 0)
  return result.results.map((row) => Object.fromEntries(Object.entries(row)))
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Ephemeral native Worker/D1 acceptance: every adjustment is an approved real
 * count command, never a seed or direct SQL write. No provider/browser exists. */
export async function auditNativeInventoryCountImport(input: NativeInventoryCountImportInput) {
  const origin = new URL(input.origin)
  assert(
    origin.protocol === 'https:' &&
      origin.origin === input.origin &&
      (origin.hostname.endsWith('.test') || origin.hostname.endsWith('.invalid'))
  )
  assert(inventoryLegacyIdSchema.safeParse(String(input.variantLegacyId)).success)
  assert(input.proposerCookie && input.approverCookie && input.unprivilegedCookie)
  assert.notEqual(input.proposerCookie, input.approverCookie)
  const base = '/api/admin/inventory/count-imports',
    checks: string[] = []
  const mark = (name: string) => {
    const id = 'native_inventory_count_import_' + name
    input.scenario(id)
    checks.push(id)
  }
  async function request(path: string, cookie: string, expected: number, body?: unknown, key?: string, hash?: string) {
    const response = await input.dispatch(
      new Request(input.origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: input.origin,
          Cookie: cookie,
          'CF-Connecting-IP': '192.0.2.177',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {}),
          ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    )
    assert.equal(response.status, expected, 'native_count_import_http_status')
    assert.match(response.headers.get('cache-control') ?? '', /private/)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    if (path.startsWith(base) || path.includes('COUNT-IMPORTS'))
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    const text = await response.text()
    assert(text.length <= 256 * 1024, 'native_count_import_response_limit')
    return JSON.parse(text) as unknown
  }
  const inventory = async () => ({
    balances: await readRows(
      input.database,
      'SELECT * FROM inventory_balances ORDER BY variant_id,location_id LIMIT 1001'
    ),
    movements: await readRows(input.database, 'SELECT * FROM inventory_movements ORDER BY id LIMIT 1001'),
    reservations: await readRows(input.database, 'SELECT * FROM inventory_reservations ORDER BY id LIMIT 1001'),
    reservationLines: await readRows(
      input.database,
      'SELECT * FROM inventory_reservation_lines ORDER BY reservation_id,variant_id,location_id LIMIT 1001'
    )
  })
  const economy = async () =>
    digest(
      await Promise.all(
        [
          'orders',
          'order_lines',
          'payment_intents',
          'payment_commands',
          'financial_commands',
          'refund_contracts',
          'refund_allocations',
          'refund_receipts'
        ].map((table) => readRows(input.database, `SELECT * FROM ${table} ORDER BY 1,2 LIMIT 1001`))
      )
    )
  const initial = adminInventoryVariantSchema.parse(
    await request('/api/admin/inventory/variants/' + input.variantLegacyId, input.proposerCookie, 200)
  )
  assert.equal(initial.variant.id, input.variantLegacyId)
  const counted = initial.balance.physicalQuantity + 1
  assert(Number.isSafeInteger(counted))
  const escapedSku = '"' + initial.variant.sku.replaceAll('"', '""') + '"'
  const csv = 'sku,countedPhysicalQuantity\n' + escapedSku + ',' + counted
  const before = await inventory(),
    economicBefore = await economy()
  const count = async (table: string) => {
    const result = await readRows(input.database, `SELECT count(*) AS n FROM ${table}`)
    assert.equal(result.length, 1)
    assert(Number.isSafeInteger(result[0]!.n))
    return Number(result[0]!.n)
  }
  const commandCount = await count('inventory_count_import_commands')
  const auditCount = await count('inventory_count_import_audit')

  mark('preview_readonly_current_difference')
  const preview = inventoryCountImportPreviewSchema.parse(
    await request(base + '/preview', input.proposerCookie, 200, { csv })
  )
  assert.equal(preview.canPropose, true)
  assert.equal(preview.rows.length, 1)
  assert.deepEqual(preview.rows[0], {
    rowNumber: 2,
    sku: initial.variant.sku,
    countedPhysicalQuantity: counted,
    variantId: input.variantLegacyId,
    expectedBalanceVersion: initial.balance.version,
    physicalQuantity: initial.balance.physicalQuantity,
    physicalDelta: 1,
    error: null
  })
  assert.deepEqual(await inventory(), before)
  assert.equal(await count('inventory_count_import_commands'), commandCount)

  mark('proposal_list_detail_without_stock_effect')
  const proposalKey = randomUUID(),
    proposalBody = {
      csv,
      previewHash: preview.previewHash,
      reason: 'Synthetic independent warehouse count import',
      reference: 'SYNTHETIC-NATIVE-INV010'
    }
  const proposalHash = await inventoryCountImportIntentHash('propose', null, proposalBody)
  const proposal = inventoryCountImportReceiptSchema.parse(
    await request(base, input.proposerCookie, 201, proposalBody, proposalKey)
  )
  assert.equal(proposal.commandId, proposalKey)
  assert.equal(proposal.payloadHash, proposalHash)
  assert.equal(proposal.action, 'propose')
  assert.equal(proposal.inventoryEffect, 'none')
  assert.deepEqual(await inventory(), before)
  const list = inventoryCountImportListSchema.parse(
    await request(base + '?page=1&perPage=25', input.proposerCookie, 200)
  )
  assert(list.items.some((item) => item.importId === proposal.importId && item.status === 'proposed'))
  const detail = inventoryCountImportSnapshotSchema.parse(
    await request(base + '/' + proposal.importId, input.approverCookie, 200)
  )
  assert.equal(detail.capabilities.approve, true)
  assert.equal(detail.rows[0]!.stale, false)

  mark('same_actor_rejected_without_ledger_write')
  const approvalBody = { expectedVersion: 1, reason: 'Synthetic second operator confirms the physical count' }
  assert.deepEqual(
    await request(base + '/' + proposal.importId + '/approve', input.proposerCookie, 409, approvalBody, randomUUID()),
    { error: { code: 'approval_self' } }
  )
  assert.deepEqual(await inventory(), before)
  assert.equal(await count('inventory_count_import_commands'), commandCount + 1)

  mark('independent_approval_exact_effect_replay_receipt')
  const approvalKey = randomUUID(),
    approvalHash = await inventoryCountImportIntentHash('approve', proposal.importId, approvalBody)
  const approved = inventoryCountImportReceiptSchema.parse(
    await request(base + '/' + proposal.importId + '/approve', input.approverCookie, 201, approvalBody, approvalKey)
  )
  assert.equal(approved.action, 'approve')
  assert.equal(approved.importId, proposal.importId)
  assert.equal(approved.commandId, approvalKey)
  assert.equal(approved.payloadHash, approvalHash)
  assert.equal(approved.inventoryEffect, 'physical_adjustment')
  assert.equal(approved.changedCount, 1)
  const after = await inventory()
  assert.deepEqual(after.reservations, before.reservations)
  assert.deepEqual(after.reservationLines, before.reservationLines)
  assert.equal(after.balances.length, before.balances.length)
  for (const old of before.balances) {
    const current = after.balances.find(
      (row) => row.variant_id === old.variant_id && row.location_id === old.location_id
    )
    assert(current)
    assert.deepEqual(
      current,
      old.variant_id === initial.variant.uuid && old.location_id === initial.warehouse.id
        ? { ...old, physical_quantity: counted, version: initial.balance.version + 1, updated_at: approved.recordedAt }
        : old
    )
  }
  for (const old of before.movements)
    assert.deepEqual(
      after.movements.find((row) => row.id === old.id),
      old
    )
  const added = after.movements.filter((row) => !before.movements.some((old) => old.id === row.id))
  assert.equal(added.length, 1)
  assert.equal(added[0]!.variant_id, initial.variant.uuid)
  assert.equal(added[0]!.location_id, initial.warehouse.id)
  assert.equal(added[0]!.physical_delta, 1)
  assert.equal(added[0]!.reserved_delta, 0)
  assert.equal(added[0]!.reference_type, 'inventory_count_import')
  assert.equal(added[0]!.correlation_id, proposal.importId)
  assert.deepEqual(
    inventoryCountImportReceiptSchema.parse(
      await request(base + '/' + proposal.importId + '/approve', input.approverCookie, 201, approvalBody, approvalKey)
    ),
    approved
  )
  for (const [cookie, key, hash, receipt] of [
    [input.proposerCookie, proposalKey, proposalHash, proposal],
    [input.approverCookie, approvalKey, approvalHash, approved]
  ] as const) {
    assert.deepEqual(
      inventoryCountImportCommandSchema.parse(
        await request(base + '/commands/' + key, cookie, 200, undefined, undefined, hash)
      ),
      { source: 'cloudflare', outcome: 'applied', receipt }
    )
  }
  assert.deepEqual(await inventory(), after)
  assert.equal(await count('inventory_count_import_commands'), commandCount + 2)
  assert.equal(await count('inventory_count_import_audit'), auditCount + 2)
  const final = inventoryCountImportSnapshotSchema.parse(
    await request(base + '/' + proposal.importId, input.approverCookie, 200)
  )
  assert.equal(final.status, 'approved')
  assert.equal(final.version, 2)
  assert.equal(final.capabilities.approve, false)

  mark('auth_and_namespace_fail_closed')
  assert.deepEqual(await request(base, '', 401), { error: { code: 'unauthenticated' } })
  const denied = (await request(base, input.unprivilegedCookie, 403)) as { error: { code: string } }
  assert.deepEqual(Object.keys(denied), ['error'])
  assert(['forbidden', 'mfa_required', 'email_unverified'].includes(denied.error.code))
  assert.deepEqual(await request('/api/admin/inventory/COUNT-IMPORTS/preview', input.proposerCookie, 404, { csv }), {
    error: { code: 'not_found' }
  })
  const unknown = inventoryCountImportCommandSchema.parse(
    await request(base + '/commands/' + randomUUID(), input.approverCookie, 200, undefined, undefined, 'a'.repeat(64))
  )
  assert.equal(unknown.outcome, 'unknown')
  assert.equal(unknown.receipt, null)

  mark('economic_invariants_and_exact_durable_counts')
  assert.equal(await economy(), economicBefore)
  assert.deepEqual(await inventory(), after)
  assert.equal(await count('inventory_count_import_commands'), commandCount + 2)
  assert.equal(await count('inventory_count_import_audit'), auditCount + 2)
  return {
    scenarios: checks.length,
    checks,
    atomic: true,
    inventoryEffect: 'one_approved_physical_increment',
    physicalDelta: 1,
    commandDelta: 2,
    auditDelta: 2,
    economicUnchanged: true,
    economicDigest: economicBefore,
    inventoryDigestBefore: digest(before),
    inventoryDigestAfter: digest(after),
    providerSubmission: false,
    browserExecuted: false
  }
}
