import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  supportOptionsSchema,
  supportReceiptSchema,
  supportAdminTicketSchema,
  supportCustomerTicketSchema,
  supportAdminListSchema,
  supportCustomerListSchema,
  supportUuid
} from '../../shared/support-operations'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { canonicalJson } from '../../workers/catalog/inventory'
export interface NativeSupportAuditInput {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  customerCookie: string
  orderId: string
  scenario: (name: string) => void
  /** Optional authoritative scanner transport. Upload is genuine private R2;
   * callback must sign/verify a receipt, never insert a clean flag in SQL. */
  scanAttachment?: (input: { attachmentId: string; checksum: string; byteSize: number }) => Promise<Response>
}
export interface NativeSupportAuditEvidence {
  scenarios: number
  checks: readonly string[]
  publicRef: string
  finalVersion: number
  inventoryUnchanged: true
  contractUnchanged: true
  inventoryDigest: string
  contractDigest: string
  privateNotesRedacted: true
  anonymousOwnership: false
  attachmentsExercised: boolean
  providerAuthority: false
  scheduledEntrypointExercised: false
}
const queries = [
  'SELECT * FROM inventory_locations ORDER BY id',
  'SELECT * FROM inventory_balances ORDER BY variant_id,location_id',
  'SELECT * FROM inventory_reservations ORDER BY id',
  'SELECT * FROM inventory_reservation_lines ORDER BY reservation_id,variant_id,location_id',
  'SELECT * FROM inventory_movements ORDER BY id',
  'SELECT * FROM orders ORDER BY id',
  'SELECT * FROM order_lines ORDER BY order_id,line_index',
  'SELECT * FROM order_shipping_address ORDER BY order_id',
  'SELECT * FROM order_billing_address ORDER BY order_id',
  'SELECT * FROM order_events ORDER BY id',
  'SELECT * FROM payment_intents ORDER BY id',
  'SELECT * FROM order_payment_states ORDER BY order_id',
  'SELECT * FROM payment_commands ORDER BY order_id,command_id',
  'SELECT * FROM payment_events ORDER BY id',
  'SELECT * FROM payment_fulfilment_claims ORDER BY order_id',
  'SELECT * FROM order_fulfillments ORDER BY order_id',
  'SELECT * FROM order_fulfillment_commands ORDER BY id',
  'SELECT * FROM order_fulfillment_audit ORDER BY command_id',
  'SELECT * FROM order_returns ORDER BY id',
  'SELECT * FROM order_return_commands ORDER BY id',
  'SELECT * FROM order_return_events ORDER BY command_id',
  'SELECT * FROM fiscal_outbox_events ORDER BY id',
  'SELECT * FROM fiscal_invoice_intents ORDER BY id',
  'SELECT * FROM fiscal_issuance_work ORDER BY intent_id',
  'SELECT * FROM fiscal_provider_receipts ORDER BY intent_id',
  'SELECT * FROM fiscal_documents ORDER BY id',
  'SELECT * FROM fiscal_issuance_events ORDER BY id'
] as const
async function digest(database: D1Database) {
  const raw = catalogPolicyOwnJson(await database.batch(queries.map((sql) => database.prepare(sql))))
  assert(Array.isArray(raw) && raw.length === queries.length, 'native_support_d1_batch_unconfirmed')
  const rows = raw.map((envelope) => {
    assert(
      envelope && typeof envelope === 'object' && !Array.isArray(envelope),
      'native_support_d1_envelope_unconfirmed'
    )
    assert.equal(Reflect.get(envelope, 'success'), true, 'native_support_d1_success_unconfirmed')
    const result = Reflect.get(envelope, 'results')
    assert(Array.isArray(result), 'native_support_d1_results_unconfirmed')
    return result
  })
  const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
  return { inventory: hash(rows.slice(0, 5)), contract: hash(rows.slice(5)) }
}
async function body(response: Response, status: number) {
  assert.equal(response.status, status, 'native_support_status_mismatch')
  assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/, 'native_support_private_cache_missing')
  assert.match(response.headers.get('vary') ?? '', /\bcookie\b/i, 'native_support_cookie_vary_missing')
  assert.match(response.headers.get('x-robots-tag') ?? '', /\bnoindex\b/, 'native_support_noindex_missing')
  const text = await response.text()
  assert(text.length > 0 && text.length <= 262144, 'native_support_body_unconfirmed')
  return catalogPolicyOwnJson(JSON.parse(text) as unknown)
}
function code(raw: unknown, expected: string) {
  assert.equal(canonicalJson(raw), canonicalJson({ error: { code: expected } }), 'native_support_error_contract')
}
export async function auditNativeSupport(input: NativeSupportAuditInput): Promise<NativeSupportAuditEvidence> {
  const origin = new URL(input.origin)
  assert(
    origin.protocol === 'https:' &&
      origin.origin === input.origin &&
      (origin.hostname.endsWith('.test') || origin.hostname.endsWith('.invalid')),
    'native_support_local_origin_required'
  )
  assert(supportUuid.safeParse(input.orderId).success, 'native_support_order_id_invalid')
  for (const cookie of [input.adminCookie, input.customerCookie])
    assert(
      typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 16384 && !/[\r\n]/.test(cookie),
      'native_support_cookie_invalid'
    )
  const checks: string[] = [],
    prefix = 'native-support:' + randomUUID(),
    privateMarker = 'PRIVATE_SUPPORT_' + randomUUID()
  async function check<T>(name: string, run: () => Promise<T>) {
    const label = 'native_support_' + name
    input.scenario(label)
    const result = await run()
    checks.push(label)
    return result
  }
  function request(
    path: string,
    cookie: string,
    method = 'GET',
    payload?: unknown,
    key?: string,
    address = '192.0.2.149'
  ) {
    return input.dispatch(
      new Request(input.origin + path, {
        method,
        headers: {
          Origin: input.origin,
          Cookie: cookie,
          'CF-Connecting-IP': address,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {})
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
      })
    )
  }
  const before = await digest(input.database)
  const configured = await check('real_contact_options', async () => {
    const response = await request('/api/support/options', '')
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert(cookie, 'native_support_intake_context_missing')
    return { cookie, options: supportOptionsSchema.parse(await body(response, 200)) }
  })
  const contact = {
    name: 'Synthetic native support buyer',
    email: 'synthetic-contact@example.test',
    category: 'order',
    subject: 'Native local operational support audit',
    message: 'Consulta contextual sintética registrada por HTTP local.',
    privacyAcknowledged: true,
    website: ''
  }
  const first = await check('verified_owned_contact', async () => {
    const receipt = supportReceiptSchema.parse(
      await body(
        await request(
          '/api/support/tickets',
          input.customerCookie,
          'POST',
          { ...contact, orderId: input.orderId },
          prefix + ':create'
        ),
        201
      )
    )
    assert.equal(receipt.version, 1)
    assert.equal(receipt.inventoryEffect, 'none')
    assert.equal(receipt.economicEffect, 'none')
    return receipt
  })
  const publicRef = first.publicRef,
    adminPath = '/api/admin/support/' + publicRef,
    customerPath = '/api/account/support/' + publicRef
  async function adminRead(version: number) {
    const dto = supportAdminTicketSchema.parse(await body(await request(adminPath, input.adminCookie), 200))
    assert.equal(dto.publicRef, publicRef)
    assert.equal(dto.version, version)
    assert.equal(dto.orderId, input.orderId)
    return dto
  }
  async function customerRead(version: number) {
    const raw = await body(await request(customerPath, input.customerCookie), 200),
      dto = supportCustomerTicketSchema.parse(raw)
    assert.equal(dto.publicRef, publicRef)
    assert.equal(dto.version, version)
    assert.equal(dto.orderId, input.orderId)
    assert(!canonicalJson(raw).includes(privateMarker), 'native_support_internal_leak')
    assert(!Object.hasOwn(dto, 'requester'), 'native_support_requester_leak')
    assert.equal(dto.context.order?.id, input.orderId, 'native_support_owned_order_context_missing')
    return dto
  }
  await check('creation_exact_replay', async () => {
    assert.deepEqual(
      supportReceiptSchema.parse(
        await body(
          await request(
            '/api/support/tickets',
            input.customerCookie,
            'POST',
            { ...contact, orderId: input.orderId },
            prefix + ':create'
          ),
          201
        )
      ),
      first
    )
  })
  await check('creation_key_conflict', async () => {
    code(
      await body(
        await request(
          '/api/support/tickets',
          input.customerCookie,
          'POST',
          { ...contact, orderId: input.orderId, message: contact.message + ' changed' },
          prefix + ':create'
        ),
        409
      ),
      'idempotency_conflict'
    )
  })
  await check('verified_customer_public_baseline', () => customerRead(1))
  await check('admin_exact_grant_context_baseline', () => adminRead(1))
  await check('sealed_customer_is_not_admin', async () => {
    const response = await request(adminPath, input.customerCookie)
    assert.equal(response.status, 403)
  })
  const note = {
    action: 'note',
    expectedVersion: 1,
    reason: privateMarker,
    message: privateMarker + ' internal staff-only note'
  }
  const noted = await check('internal_note_recorded', async () =>
    supportReceiptSchema.parse(
      await body(await request(adminPath, input.adminCookie, 'PUT', note, prefix + ':note'), 200)
    )
  )
  assert.equal(noted.version, 2)
  assert.equal(noted.emailStatus, 'not_requested')
  await check('private_note_redacted_from_portal', () => customerRead(2))
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await check('documented_call_not_external_call', async () => {
    const receipt = supportReceiptSchema.parse(
      await body(
        await request(
          adminPath,
          input.adminCookie,
          'PUT',
          {
            action: 'call',
            expectedVersion: 2,
            reason: privateMarker,
            message: privateMarker + ' previous call annotation',
            occurredAt: now,
            nextActionAt: null
          },
          prefix + ':call'
        ),
        200
      )
    )
    assert.equal(receipt.version, 3)
    assert.equal(receipt.emailStatus, 'not_requested')
  })
  await check('call_details_not_customer_visible', () => customerRead(3))
  const reply = {
    action: 'reply',
    expectedVersion: 3,
    reason: 'Documented public response',
    message: 'Respuesta pública sin notas internas.'
  }
  const replied = await check('public_reply_queued_not_delivered', async () =>
    supportReceiptSchema.parse(
      await body(await request(adminPath, input.adminCookie, 'PUT', reply, prefix + ':reply'), 200)
    )
  )
  assert.equal(replied.version, 4)
  assert.equal(replied.emailStatus, 'queued')
  await check('portal_has_public_reply_only', async () => {
    const dto = await customerRead(4)
    assert(dto.timeline.some((event) => event.body === reply.message))
  })
  await check('reply_exact_key_replay', async () => {
    assert.deepEqual(
      supportReceiptSchema.parse(
        await body(await request(adminPath, input.adminCookie, 'PUT', reply, prefix + ':reply'), 200)
      ),
      replied
    )
  })
  await check('reply_same_key_content_conflict', async () => {
    code(
      await body(
        await request(
          adminPath,
          input.adminCookie,
          'PUT',
          { ...reply, message: reply.message + ' changed' },
          prefix + ':reply'
        ),
        409
      ),
      'idempotency_conflict'
    )
  })
  await check('stale_version_rejected', async () => {
    code(
      await body(await request(adminPath, input.adminCookie, 'PUT', reply, prefix + ':stale'), 409),
      'version_conflict'
    )
  })
  await check('direct_closing_invalid', async () => {
    code(
      await body(
        await request(
          adminPath,
          input.adminCookie,
          'PUT',
          {
            action: 'update',
            expectedVersion: 4,
            reason: 'Invalid state skip',
            state: 'closed',
            priority: 'normal',
            ownerId: null,
            nextActionAt: null,
            slaDueAt: null,
            resolution: 'Documented public summary'
          },
          prefix + ':skip'
        ),
        409
      ),
      'invalid_transition'
    )
  })
  await check('customer_response_owner_bound', async () => {
    const receipt = supportReceiptSchema.parse(
      await body(
        await request(
          customerPath,
          input.customerCookie,
          'POST',
          {
            expectedVersion: 4,
            message: 'Seguimiento público del cliente verificado.'
          },
          prefix + ':followup'
        ),
        201
      )
    )
    assert.equal(receipt.version, 5)
    assert.equal(receipt.emailStatus, 'not_requested')
  })
  await check('historical_exact_replay_after_advance', async () => {
    assert.deepEqual(
      supportReceiptSchema.parse(
        await body(await request(adminPath, input.adminCookie, 'PUT', reply, prefix + ':reply'), 200)
      ),
      replied
    )
  })
  await check('admin_customer_lists_are_distinct_contracts', async () => {
    const admin = supportAdminListSchema.parse(
        await body(await request('/api/admin/support?q=' + encodeURIComponent(publicRef), input.adminCookie), 200)
      ),
      customer = supportCustomerListSchema.parse(
        await body(await request('/api/account/support', input.customerCookie), 200)
      )
    assert(admin.items.some((item) => item.publicRef === publicRef))
    assert(customer.items.some((item) => item.publicRef === publicRef))
  })
  await check('anonymous_contact_does_not_claim_order', async () => {
    const receipt = supportReceiptSchema.parse(
        await body(
          await request(
            '/api/support/tickets',
            configured.cookie,
            'POST',
            { ...contact, orderReference: input.orderId },
            prefix + ':anonymous',
            '192.0.2.150'
          ),
          201
        )
      ),
      dto = supportAdminTicketSchema.parse(
        await body(await request('/api/admin/support/' + receipt.publicRef, input.adminCookie), 200)
      )
    assert.equal(dto.identityStatus, 'unverified_contact')
    assert.equal(dto.orderId, null)
    assert.equal(dto.context.order, null)
    const response = await request('/api/account/support/' + receipt.publicRef, input.customerCookie)
    assert.equal(response.status, 404)
  })
  await check('guest_order_claim_blocked', async () => {
    code(
      await body(
        await request(
          '/api/support/tickets',
          configured.cookie,
          'POST',
          { ...contact, orderId: input.orderId },
          prefix + ':guest-claim',
          '192.0.2.151'
        ),
        403
      ),
      'guest_verification_required'
    )
  })
  await check('cross_origin_rejected', async () => {
    const response = await input.dispatch(
      new Request(input.origin + adminPath, {
        method: 'PUT',
        headers: {
          Origin: 'https://foreign.example.test',
          Cookie: input.adminCookie,
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '192.0.2.149',
          'Idempotency-Key': prefix + ':foreign'
        },
        body: JSON.stringify(reply)
      })
    )
    assert.equal(response.status, 403)
  })
  let finalVersion = 5,
    attachmentsExercised = false
  if (input.scanAttachment) {
    assert(configured.options.attachments, 'native_support_private_storage_required')
    const pdf = new TextEncoder().encode('%PDF-1.7\nSynthetic native private support evidence\n%%EOF'),
      form = new FormData()
    form.set('file', new File([pdf], 'private-case.pdf', { type: 'application/pdf' }))
    form.set('expectedVersion', '5')
    form.set('visibility', 'public')
    await check('real_private_r2_upload', async () => {
      const response = await input.dispatch(
        new Request(input.origin + customerPath + '/attachments', {
          method: 'POST',
          headers: {
            Origin: input.origin,
            Cookie: input.customerCookie,
            'CF-Connecting-IP': '192.0.2.149',
            'Idempotency-Key': prefix + ':attachment'
          },
          body: form
        })
      )
      const receipt = supportReceiptSchema.parse(await body(response, 201))
      assert.equal(receipt.version, 6)
    })
    finalVersion = 6
    const dto = await customerRead(6),
      attachment = dto.attachments.find((item) => item.state === 'quarantined')!
    assert(attachment && !attachment.downloadable, 'native_support_unscanned_attachment_exposed')
    const raw = await input.database
      .prepare('SELECT checksum,byte_size FROM support_attachments WHERE id=?')
      .bind(attachment.id)
      .first<{ checksum: string; byte_size: number }>()
    assert(raw, 'native_support_attachment_storage_unconfirmed')
    await check('unscanned_download_rejected', async () => {
      assert.equal((await request(customerPath + '/attachments/' + attachment.id, input.customerCookie)).status, 409)
    })
    await check('verified_scanner_transport', async () => {
      const receipt = await input.scanAttachment!({
        attachmentId: attachment.id,
        checksum: raw.checksum,
        byteSize: raw.byte_size
      })
      assert.equal(receipt.status, 200, 'native_support_scanner_receipt_unconfirmed')
    })
    await check('clean_private_download', async () => {
      const response = await request(customerPath + '/attachments/' + attachment.id, input.customerCookie)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/)
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf)
    })
    attachmentsExercised = true
  } else if (!configured.options.attachments) {
    await check('private_storage_disabled_explicitly', async () => {
      code(
        await body(
          await request(customerPath + '/attachments', input.customerCookie, 'POST', {}, prefix + ':disabled'),
          503
        ),
        'attachments_unavailable'
      )
    })
  }
  await check('final_ledger_matches_projection_and_public_portal', async () => {
    await adminRead(finalVersion)
    await customerRead(finalVersion)
    const proof = await input.database
      .prepare(
        'SELECT t.version,(SELECT count(*) FROM support_commands c WHERE c.ticket_id=t.id) AS commands,' +
          '(SELECT count(*) FROM support_events e WHERE e.ticket_id=t.id) AS events FROM support_tickets t WHERE public_ref=?'
      )
      .bind(publicRef)
      .first<{ version: number; commands: number; events: number }>()
    assert.equal(
      canonicalJson(proof),
      canonicalJson({ version: finalVersion, commands: finalVersion, events: finalVersion })
    )
  })
  await check('global_inventory_payment_fiscal_contracts_unchanged', async () => {
    assert.deepEqual(await digest(input.database), before)
  })
  return {
    scenarios: checks.length,
    checks,
    publicRef,
    finalVersion,
    inventoryUnchanged: true,
    contractUnchanged: true,
    inventoryDigest: before.inventory,
    contractDigest: before.contract,
    privateNotesRedacted: true,
    anonymousOwnership: false,
    attachmentsExercised,
    providerAuthority: false,
    scheduledEntrypointExercised: false
  }
}
