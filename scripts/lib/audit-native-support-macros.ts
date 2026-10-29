import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  supportMacroCommandSchema,
  supportMacroReceiptSchema,
  supportMacroSelectionSchema,
  supportMacroPreviewSchema,
  supportMacroLibrarySchema
} from '../../shared/support-macros'
import {
  supportContactInputSchema,
  supportReceiptSchema,
  supportAdminInputSchema,
  supportAdminTicketSchema,
  supportCustomerTicketSchema
} from '../../shared/support-operations'

export interface NativeSupportMacrosAuditInput {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  customerCookie: string
  scenario: (name: string) => void
}
export async function auditNativeSupportMacros(input: NativeSupportMacrosAuditInput): Promise<{
  scenarios: number
  checks: readonly string[]
  macroId: string
  publicRef: string
  noExternalLegalApproval: true
  queuedOnly: true
  replayNoExtraSideEffect: true
}> {
  const origin = new URL(input.origin)
  assert(
    origin.protocol === 'https:' &&
      origin.origin === input.origin &&
      (origin.hostname.endsWith('.test') || origin.hostname.endsWith('.invalid')),
    'native_support_macros_local_origin_required'
  )
  for (const cookie of [input.adminCookie, input.customerCookie])
    assert(
      typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 16384 && !/[\r\n]/.test(cookie),
      'native_support_macros_cookie_invalid'
    )
  const checks: string[] = [],
    macroId = randomUUID(),
    prefix = 'native-support-macros:' + randomUUID(),
    macroPath = '/api/admin/support/macros/' + macroId
  async function check<T>(name: string, run: () => Promise<T>) {
    const label = 'native_support_macros_' + name
    input.scenario(label)
    const result = await run()
    checks.push(label)
    return result
  }
  async function request(path: string, cookie: string, method = 'GET', payload?: unknown, key?: string) {
    return input.dispatch(
      new Request(input.origin + path, {
        method,
        headers: {
          Origin: input.origin,
          Cookie: cookie,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '192.0.2.157',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {})
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
      })
    )
  }
  async function body(response: Response, status: number) {
    assert(
      /private.*no-store/.test(response.headers.get('cache-control') ?? '') &&
        /\bcookie\b/i.test(response.headers.get('vary') ?? '') &&
        /\bnoindex\b/.test(response.headers.get('x-robots-tag') ?? ''),
      'native_support_macros_private_response_required'
    )
    assert.equal(response.status, status, 'native_support_macros_status_mismatch')
    const text = await response.text()
    assert(text.length > 0 && text.length <= 262144, 'native_support_macros_body_unconfirmed')
    return { text, raw: JSON.parse(text) as unknown }
  }
  async function error(response: Response, status: number, expected: string) {
    assert.deepEqual((await body(response, status)).raw, { error: { code: expected } })
  }
  async function macroCommand(payload: unknown, key: string) {
    const receipt = supportMacroReceiptSchema.parse(
      (
        await body(
          await request(
            macroPath,
            input.adminCookie,
            'PUT',
            supportMacroCommandSchema.parse(payload),
            prefix + ':' + key
          ),
          200
        )
      ).raw
    )
    assert.equal(receipt.macroId, macroId)
    return receipt
  }
  const created = await check('verified_general_ticket', async () => {
    const receipt = supportReceiptSchema.parse(
      (
        await body(
          await request(
            '/api/support/tickets',
            input.customerCookie,
            'POST',
            supportContactInputSchema.parse({
              name: 'Synthetic macro audit buyer',
              email: 'synthetic-macro@example.test',
              category: 'other',
              subject: 'Synthetic local reviewed support macro',
              message: 'Consulta general sintética sin pedido asociado.',
              privacyAcknowledged: true,
              website: ''
            }),
            prefix + ':ticket'
          ),
          201
        )
      ).raw
    )
    assert.equal(receipt.version, 1)
    assert.equal(receipt.emailStatus, 'queued')
    return receipt
  })
  const publicRef = created.publicRef,
    ticketPath = '/api/admin/support/' + publicRef
  await check('draft', async () => {
    const draft = await macroCommand(
      {
        action: 'draft',
        expectedVersion: 0,
        reason: 'Synthetic local acceptance only',
        title: 'Acuse sintético de soporte',
        body: 'Ticket {{ticket.reference}}: {{personal.nextStep}}. Estado: {{ticket.state}}.',
        tone: 'Claro y sin promesas externas ni decisiones legales reales',
        personalizations: [{ key: 'nextStep', label: 'Siguiente paso concreto', required: true }]
      },
      'draft'
    )
    assert.equal(draft.state, 'draft')
    assert.equal(draft.version, 1)
  })
  const now = Date.now(),
    iso = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const approved = await check('explicitly_synthetic_review', async () => {
    const result = await macroCommand(
      {
        action: 'approve',
        expectedVersion: 1,
        reason: 'Synthetic references only; NOT external legal approval',
        operationalReference: 'synthetic-local-operational-reference:' + macroId,
        legalReference: 'synthetic-local-NOT-legal-approval:' + macroId,
        reviewedAt: iso(now - 60000),
        expiresAt: iso(now + 86400000)
      },
      'approve'
    )
    assert.equal(result.state, 'approved')
    assert.equal(result.version, 2)
    return result
  })
  const selection = supportMacroSelectionSchema.parse({
    macroId,
    revisionId: approved.commandId,
    personalizations: { nextStep: 'Revisar el caso sintético antes de responder' }
  })
  await check('required_personalization', async () =>
    error(await requestedPreview({ ...selection, personalizations: {} }), 422, 'invalid_input')
  )
  function requestedPreview(payload: unknown) {
    return request(
      ticketPath + '/macro-preview',
      input.adminCookie,
      'POST',
      payload,
      prefix + ':preview:' + randomUUID()
    )
  }
  const preview = await check('exact_preview', async () => {
    const result = supportMacroPreviewSchema.parse((await body(await requestedPreview(selection), 200)).raw)
    assert.equal(result.publicRef, publicRef)
    assert.equal(result.ticketVersion, 1)
    assert.deepEqual(result.selection, selection)
    assert.equal(result.message, `Ticket ${publicRef}: ${selection.personalizations.nextStep}. Estado: open.`)
    assert.equal(result.review.legalReference, 'synthetic-local-NOT-legal-approval:' + macroId)
    return result
  })
  const reply = supportAdminInputSchema.parse({
      action: 'reply',
      expectedVersion: 1,
      reason: 'Synthetic confirmed reviewed reply',
      message: preview.message,
      macro: { ...selection, confirmed: true }
    }),
    key = prefix + ':reply'
  const sent = await check('confirmed_exact_reply_queued', async () => {
    const result = await body(await request(ticketPath, input.adminCookie, 'PUT', reply, key), 200)
    const receipt = supportReceiptSchema.parse(result.raw)
    assert.equal(receipt.version, 2)
    assert.equal(receipt.publicRef, publicRef)
    assert.equal(receipt.emailStatus, 'queued')
    const row = await input.database
      .prepare('SELECT id,input,response FROM support_commands WHERE public_ref=? AND idempotency_key=?')
      .bind(publicRef, key)
      .first<{ id: string; input: string; response: string }>()
    assert(row && row.id === receipt.commandId, 'native_support_macros_reply_ledger_mismatch')
    assert.deepEqual(JSON.parse(row.input), reply)
    assert.deepEqual(JSON.parse(row.response), result.raw)
    return result
  })
  async function proof() {
    const queries = [
      'SELECT * FROM support_tickets WHERE public_ref=?',
      'SELECT * FROM support_commands WHERE public_ref=? ORDER BY result_version',
      'SELECT e.* FROM support_events e JOIN support_tickets t ON t.id=e.ticket_id WHERE t.public_ref=? ORDER BY e.id',
      'SELECT e.*,d.status AS delivery_status,(SELECT count(*) FROM transactional_email_deliveries x WHERE x.event_id=e.id) AS provider_work FROM email_outbox_events e JOIN email_outbox_delivery d ON d.event_id=e.id JOIN support_tickets t ON t.id=e.source_id WHERE t.public_ref=? ORDER BY e.id'
    ]
    const results = await input.database.batch<Record<string, unknown>>(
      queries.map((sql) => input.database.prepare(sql).bind(publicRef))
    )
    assert.equal(results.length, queries.length, 'native_support_macros_evidence_unconfirmed')
    return results.map((result) => {
      assert(result.success === true && Array.isArray(result.results), 'native_support_macros_evidence_unconfirmed')
      return result.results
    })
  }
  const beforeReplay = await check('durable_queued_evidence', async () => {
    const rows = await proof()
    assert.deepEqual(
      rows.map((r) => r.length),
      [1, 2, 2, 2]
    )
    assert.equal(rows[0]![0]!.order_id, null)
    assert(rows[0]![0]!.customer_id, 'native_support_macros_verified_owner_missing')
    assert.equal(rows[0]![0]!.version, 2)
    assert(
      rows[3]!.every((row) => row.delivery_status === 'ready' && row.provider_work === 0),
      'native_support_macros_not_queued_only'
    )
    return rows
  })
  await check('withdraw', async () => {
    const withdrawn = await macroCommand(
      { action: 'withdraw', expectedVersion: 2, reason: 'Synthetic local withdrawal' },
      'withdraw'
    )
    assert.equal(withdrawn.state, 'withdrawn')
    assert.equal(withdrawn.version, 3)
  })
  await check('withdrawn_exact_replay_no_extra_effect', async () => {
    assert.equal((await body(await request(ticketPath, input.adminCookie, 'PUT', reply, key), 200)).text, sent.text)
    assert.deepEqual(await proof(), beforeReplay)
  })
  await check('withdrawn_new_send_denied', async () => {
    await error(
      await request(ticketPath, input.adminCookie, 'PUT', { ...reply, expectedVersion: 2 }, prefix + ':new-reply'),
      409,
      'invalid_transition'
    )
    await error(await requestedPreview(selection), 409, 'invalid_transition')
    assert.deepEqual(await proof(), beforeReplay)
  })
  await check('library_and_exact_historical_detail', async () => {
    supportMacroLibrarySchema.parse(
      (await body(await request('/api/admin/support/macros', input.adminCookie), 200)).raw
    )
    const detail = supportMacroLibrarySchema.parse((await body(await request(macroPath, input.adminCookie), 200)).raw)
    assert.equal(detail.macros.length, 1)
    const macro = detail.macros[0]!
    assert.equal(macro.macroId, macroId)
    assert.equal(macro.state, 'withdrawn')
    assert.deepEqual(
      macro.history.map((item) => item.version),
      [3, 2, 1]
    )
    assert.equal(macro.history[1]!.commandId, approved.commandId)
    assert.equal(macro.history[1]!.snapshot.review?.legalReference, preview.review.legalReference)
    const history = await input.database
      .prepare('SELECT id,version,state,response FROM support_macro_commands WHERE macro_id=? ORDER BY version')
      .bind(macroId)
      .all<{ id: string; version: number; state: string; response: string }>()
    assert(history.success && history.results.length === 3, 'native_support_macros_history_unconfirmed')
    for (const row of history.results) {
      const item = macro.history.find((item) => item.commandId === row.id)
      assert(item && item.version === row.version && item.state === row.state, 'native_support_macros_history_mismatch')
      assert.equal(supportMacroReceiptSchema.parse(JSON.parse(row.response)).commandId, row.id)
    }
    const admin = supportAdminTicketSchema.parse((await body(await request(ticketPath, input.adminCookie), 200)).raw)
    const customer = supportCustomerTicketSchema.parse(
      (await body(await request('/api/account/support/' + publicRef, input.customerCookie), 200)).raw
    )
    for (const ticket of [admin, customer]) {
      assert.equal(ticket.orderId, null)
      assert.equal(ticket.identityStatus, 'verified_customer')
      assert.equal(ticket.version, 2)
      assert.equal(ticket.timeline.filter((event) => event.body === preview.message).length, 1)
    }
  })
  await check('private_authority_uniform_denials', async () => {
    for (const [cookie, status, codes] of [
      [input.customerCookie, 403, ['forbidden', 'mfa_required']],
      ['', 401, ['unauthenticated']]
    ] as const) {
      const denied = await body(await request(macroPath, cookie), status)
      assert(codes.some((code) => JSON.stringify(denied.raw) === JSON.stringify({ error: { code } })))
      const unknown = await body(await request('/api/admin/support/macros/' + randomUUID(), cookie), status)
      assert.equal(unknown.text, denied.text, 'native_support_macros_authority_leak')
    }
    assert.deepEqual(await proof(), beforeReplay)
  })
  return {
    scenarios: checks.length,
    checks,
    macroId,
    publicRef,
    noExternalLegalApproval: true,
    queuedOnly: true,
    replayNoExtraSideEffect: true
  }
}
