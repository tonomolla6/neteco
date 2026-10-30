import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createB2bRequest,
  listB2bRequests,
  readB2bRequest,
  replyB2bRequest,
  cancelB2bRequest,
  addB2bDocument,
  listAdminB2bRequests,
  readAdminB2bRequest,
  commandAdminB2bRequest
} from '../../workers/support/b2b-requests'
import { InsightError } from '../../workers/support/insight-commands'
import {
  insightsFixture,
  seedOrder,
  claimsOf,
  ADMIN,
  ADMIN2,
  NOPERM,
  NOMFA,
  CUSTOMER_A,
  CUSTOMER_B,
  CUSTOMER_PENDING
} from './support-insights-fixture'

let f: Awaited<ReturnType<typeof insightsFixture>>
const NOW = '2026-10-29T12:00:00Z'
const ORDER_A = '50000000-0000-4000-8000-0000000000a1'
const ORDER_B = '50000000-0000-4000-8000-0000000000b1'
const key = () => crypto.randomUUID()
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => (e instanceof InsightError ? e.code : String(e))
  )
const A = () => claimsOf(CUSTOMER_A)
const quote = {
  kind: 'quote',
  subject: 'Presupuesto de lejía',
  details: { lines: [{ productSlug: 'lejia-5l', quantity: 40 }] }
}
const credit = {
  kind: 'credit',
  subject: 'Línea de crédito',
  details: { requestedLimitCents: 500000, paymentTermDays: 30, justification: 'Compras mensuales recurrentes' }
}
const claim = {
  kind: 'claim',
  subject: 'Garrafas rotas',
  orderId: ORDER_A,
  details: { claimType: 'damaged', description: 'Dos garrafas llegaron rotas' }
}
const doc = {
  kind: 'safety_data_sheet',
  fileName: 'ficha.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64)
}
const create = (input: unknown = quote, who = A(), at = NOW) => createB2bRequest(f.database, who, input, key(), at)

beforeEach(async () => {
  f = await insightsFixture()
  seedOrder(f.sqlite, { id: ORDER_A, customerId: CUSTOMER_A.customer, createdAt: '2026-10-01T10:00:00Z' })
  seedOrder(f.sqlite, { id: ORDER_B, customerId: CUSTOMER_B.customer, createdAt: '2026-10-01T10:00:00Z' })
})
afterEach(() => f.sqlite.close())

describe('createB2bRequest (SUP-017)', () => {
  it('accepts all five kinds, each with its own SLA and a first event', async () => {
    const expected: Record<string, string> = {
      quote: '2026-10-30T12:00:00Z',
      product_onboarding: '2026-11-01T12:00:00Z',
      documentation: '2026-10-31T12:00:00Z',
      credit: '2026-11-01T12:00:00Z',
      claim: '2026-10-30T12:00:00Z'
    }
    const inputs = [
      quote,
      {
        kind: 'product_onboarding',
        subject: 'Alta de producto',
        details: {
          productName: 'Desengrasante X',
          intendedUse: 'Limpieza de cocinas',
          estimatedMonthlyUnits: 50,
          hasSafetyDataSheet: true
        }
      },
      {
        kind: 'documentation',
        subject: 'Ficha de seguridad',
        details: { documentType: 'safety_data_sheet', productSlug: 'lejia-5l' }
      },
      credit,
      claim
    ]
    for (const input of inputs) {
      const r = await create(input)
      expect(r).toMatchObject({ status: 'submitted', version: 1, slaDueAt: expected[(input as { kind: string }).kind] })
      expect(r.publicRef).toMatch(/^B2B-[0-9A-F]{20}$/)
    }
    expect(
      f.sqlite.prepare("SELECT count(*) n FROM support_b2b_request_events WHERE action='submitted' AND seq=1").get()
    ).toEqual({ n: 5 })
  })
  it('requires an approved company and a live customer session', async () => {
    expect(await code(create(quote, claimsOf(CUSTOMER_PENDING)))).toBe('company_not_approved')
    expect(await code(createB2bRequest(f.database, null, quote, key(), NOW))).toBe('unauthenticated')
    expect(await code(create(quote, claimsOf(ADMIN)))).toBe('unauthenticated')
  })
  it('lets a claim reference only the customer own orders', async () => {
    expect(await code(create({ ...claim, orderId: ORDER_B }))).toBe('not_found')
    expect(await code(create({ ...claim, orderId: crypto.randomUUID() }))).toBe('not_found')
    expect((await create(claim)).status).toBe('submitted')
  })
  it('is idempotent and rejects key reuse with another payload', async () => {
    const k = key()
    const first = await createB2bRequest(f.database, A(), quote, k, NOW)
    expect(await createB2bRequest(f.database, A(), quote, k, NOW)).toEqual(first)
    expect((f.sqlite.prepare('SELECT count(*) n FROM support_b2b_requests').get() as { n: number }).n).toBe(1)
    expect(await code(createB2bRequest(f.database, A(), credit, k, NOW))).toBe('idempotency_conflict')
  })
  it('validates input strictly', async () => {
    expect(await code(create({ ...quote, details: { lines: [{ productSlug: 'a', quantity: 0 }] } }))).toBe(
      'invalid_input'
    )
    expect(await code(create({ ...quote, extra: true }))).toBe('invalid_input')
    expect(await code(createB2bRequest(f.database, A(), quote, 'bad-key', NOW))).toBe('invalid_input')
  })
  it('caps simultaneously open requests per company', async () => {
    for (let i = 0; i < 25; i++) await create({ ...quote, subject: `Presupuesto número ${i}` })
    expect(await code(create())).toBe('limit_exceeded')
    expect((await create(quote, claimsOf(CUSTOMER_B))).status).toBe('submitted')
  })
})

describe('customer reads, replies and cancellation', () => {
  it('lists only the own company and exposes SLA state', async () => {
    const mine = await create()
    await create(quote, claimsOf(CUSTOMER_B))
    const list = await listB2bRequests(f.database, A(), {}, NOW)
    expect(list.items).toEqual([
      expect.objectContaining({ id: mine.id, kind: 'quote', status: 'submitted', slaState: 'on_track' })
    ])
    expect((await listB2bRequests(f.database, A(), {}, '2026-10-30T11:00:00Z')).items[0]!.slaState).toBe('at_risk')
    expect((await listB2bRequests(f.database, A(), {}, '2026-10-31T00:00:00Z')).items[0]!.slaState).toBe('breached')
    expect((await listB2bRequests(f.database, A(), { status: 'resolved' }, NOW)).items).toEqual([])
  })
  it('reads detail with the customer-visible timeline and documents, never another company', async () => {
    const r = await create()
    await addB2bDocument(f.database, A(), r.id, doc, key(), NOW)
    const detail = await readB2bRequest(f.database, A(), r.id, NOW)
    expect(detail.request).toMatchObject({ id: r.id, details: quote.details })
    expect(detail.events.map((e) => e.action)).toEqual(['submitted', 'document'])
    expect(detail.documents).toEqual([expect.objectContaining({ fileName: 'ficha.pdf', scanStatus: 'pending' })])
    expect(await code(readB2bRequest(f.database, claimsOf(CUSTOMER_B), r.id, NOW))).toBe('not_found')
  })
  it('records a reply and reopens a request that waits for the customer', async () => {
    const r = await create()
    await commandAdminB2bRequest(
      f.database,
      claimsOf(ADMIN),
      r.id,
      { action: 'start_review', expectedVersion: 1 },
      key(),
      NOW
    )
    await commandAdminB2bRequest(
      f.database,
      claimsOf(ADMIN),
      r.id,
      { action: 'request_info', expectedVersion: 2, note: 'Falta el CIF' },
      key(),
      NOW
    )
    const reply = await replyB2bRequest(f.database, A(), r.id, { message: 'Adjunto el CIF' }, key(), NOW)
    expect(reply).toMatchObject({ status: 'in_review', version: 4 })
    const events = (await readB2bRequest(f.database, A(), r.id, NOW)).events
    expect(events.map((e) => [e.actorType, e.action])).toEqual([
      ['customer', 'submitted'],
      ['admin', 'status'],
      ['admin', 'status'],
      ['customer', 'reply']
    ])
  })
  it('refuses to reply to a closed request or to another company', async () => {
    const r = await create()
    await cancelB2bRequest(f.database, A(), r.id, { expectedVersion: 1 }, key(), NOW)
    expect(await code(replyB2bRequest(f.database, A(), r.id, { message: 'hola' }, key(), NOW))).toBe(
      'invalid_transition'
    )
    expect(await code(replyB2bRequest(f.database, claimsOf(CUSTOMER_B), r.id, { message: 'hola' }, key(), NOW))).toBe(
      'not_found'
    )
    expect(await code(replyB2bRequest(f.database, A(), r.id, { message: '' }, key(), NOW))).toBe('invalid_input')
  })
  it('cancels with optimistic concurrency and idempotency', async () => {
    const r = await create()
    const k = key()
    const done = await cancelB2bRequest(
      f.database,
      A(),
      r.id,
      { expectedVersion: 1, reason: 'Ya no hace falta' },
      k,
      NOW
    )
    expect(done).toMatchObject({ status: 'cancelled', version: 2 })
    expect(
      await cancelB2bRequest(f.database, A(), r.id, { expectedVersion: 1, reason: 'Ya no hace falta' }, k, NOW)
    ).toEqual(done)
    expect(await code(cancelB2bRequest(f.database, A(), r.id, { expectedVersion: 2 }, key(), NOW))).toBe(
      'invalid_transition'
    )
    const other = await create()
    expect(await code(cancelB2bRequest(f.database, A(), other.id, { expectedVersion: 9 }, key(), NOW))).toBe(
      'concurrency_conflict'
    )
    expect(f.sqlite.prepare('SELECT closed_at FROM support_b2b_requests WHERE id=?').get(r.id)).toEqual({
      closed_at: NOW
    })
  })
  it('does not let the customer cancel once the company has been approved', async () => {
    const r = await create(credit)
    await commandAdminB2bRequest(
      f.database,
      claimsOf(ADMIN),
      r.id,
      { action: 'start_review', expectedVersion: 1 },
      key(),
      NOW
    )
    await commandAdminB2bRequest(
      f.database,
      claimsOf(ADMIN),
      r.id,
      { action: 'approve', expectedVersion: 2 },
      key(),
      NOW
    )
    expect(await code(cancelB2bRequest(f.database, A(), r.id, { expectedVersion: 3 }, key(), NOW))).toBe(
      'invalid_transition'
    )
  })
})

describe('supporting documents (metadata, quarantined until scanned)', () => {
  it('registers a document pending scan and is idempotent', async () => {
    const r = await create()
    const k = key()
    const first = await addB2bDocument(f.database, A(), r.id, doc, k, NOW)
    expect(first).toMatchObject({ scanStatus: 'pending' })
    expect(await addB2bDocument(f.database, A(), r.id, doc, k, NOW)).toEqual(first)
  })
  it('rejects duplicates, unsafe names/types, other companies, closed requests and excess files', async () => {
    const r = await create()
    await addB2bDocument(f.database, A(), r.id, doc, key(), NOW)
    expect(await code(addB2bDocument(f.database, A(), r.id, doc, key(), NOW))).toBe('duplicate_document')
    expect(
      await code(
        addB2bDocument(f.database, A(), r.id, { ...doc, sha256: 'b'.repeat(64), fileName: '../x.pdf' }, key(), NOW)
      )
    ).toBe('invalid_input')
    expect(
      await code(
        addB2bDocument(
          f.database,
          A(),
          r.id,
          { ...doc, sha256: 'b'.repeat(64), contentType: 'application/x-msdownload' },
          key(),
          NOW
        )
      )
    ).toBe('invalid_input')
    expect(
      await code(
        addB2bDocument(f.database, A(), r.id, { ...doc, sha256: 'b'.repeat(64), sizeBytes: 20_000_000 }, key(), NOW)
      )
    ).toBe('invalid_input')
    expect(
      await code(addB2bDocument(f.database, claimsOf(CUSTOMER_B), r.id, { ...doc, sha256: 'c'.repeat(64) }, key(), NOW))
    ).toBe('not_found')
    for (let i = 0; i < 9; i++)
      await addB2bDocument(
        f.database,
        A(),
        r.id,
        { ...doc, sha256: String(i).repeat(64), fileName: `doc${i}.pdf` },
        key(),
        NOW
      )
    expect(await code(addB2bDocument(f.database, A(), r.id, { ...doc, sha256: 'd'.repeat(64) }, key(), NOW))).toBe(
      'limit_exceeded'
    )
    const closed = await create()
    await cancelB2bRequest(f.database, A(), closed.id, { expectedVersion: 1 }, key(), NOW)
    expect(await code(addB2bDocument(f.database, A(), closed.id, doc, key(), NOW))).toBe('invalid_transition')
  })
})

describe('administrative queue and workflow', () => {
  it('requires live support authority with MFA', async () => {
    expect(await code(listAdminB2bRequests(f.database, claimsOf(NOPERM), {}, NOW))).toBe('forbidden')
    expect(await code(listAdminB2bRequests(f.database, claimsOf(NOMFA), {}, NOW))).toBe('mfa_required')
    expect(await code(listAdminB2bRequests(f.database, null, {}, NOW))).toBe('unauthenticated')
    expect(await code(listAdminB2bRequests(f.database, claimsOf(CUSTOMER_A), {}, NOW))).toBe('forbidden')
  })
  it('lists by SLA urgency and filters by kind, status and SLA state', async () => {
    const q = await create(quote, A(), '2026-10-29T08:00:00Z')
    const c = await create(credit, claimsOf(CUSTOMER_B), '2026-10-29T08:00:00Z')
    const list = await listAdminB2bRequests(f.database, claimsOf(ADMIN), {}, NOW)
    expect(list.items.map((i) => i.id)).toEqual([q.id, c.id])
    expect(list.items[0]).toMatchObject({ companyName: 'Empresa c1', kind: 'quote' })
    expect(
      (await listAdminB2bRequests(f.database, claimsOf(ADMIN), { kind: 'credit' }, NOW)).items.map((i) => i.id)
    ).toEqual([c.id])
    expect(
      (await listAdminB2bRequests(f.database, claimsOf(ADMIN), { sla: 'breached' }, '2026-10-31T00:00:00Z')).items.map(
        (i) => i.id
      )
    ).toEqual([q.id])
    expect((await listAdminB2bRequests(f.database, claimsOf(ADMIN), { status: 'in_review' }, NOW)).items).toEqual([])
  })
  it('runs submitted -> in_review -> approved -> resolved and records who did what', async () => {
    const r = await create(credit)
    const step = (action: string, expectedVersion: number, note?: string, who = ADMIN) =>
      commandAdminB2bRequest(
        f.database,
        claimsOf(who),
        r.id,
        { action, expectedVersion, note },
        key(),
        '2026-10-29T13:00:00Z'
      )
    expect(await step('start_review', 1)).toMatchObject({ status: 'in_review', version: 2 })
    expect(await step('approve', 2, 'Límite aprobado por 5.000 EUR', ADMIN2)).toMatchObject({
      status: 'approved',
      version: 3
    })
    expect(await step('resolve', 3)).toMatchObject({ status: 'resolved', version: 4 })
    const row = f.sqlite
      .prepare('SELECT status,first_response_at,closed_at FROM support_b2b_requests WHERE id=?')
      .get(r.id)
    expect(row).toEqual({
      status: 'resolved',
      first_response_at: '2026-10-29T13:00:00Z',
      closed_at: '2026-10-29T13:00:00Z'
    })
    const detail = await readAdminB2bRequest(f.database, claimsOf(ADMIN), r.id, NOW)
    expect(detail.events.map((e) => [e.action, e.toStatus, e.actorId])).toEqual([
      ['submitted', 'submitted', CUSTOMER_A.id],
      ['status', 'in_review', ADMIN.id],
      ['status', 'approved', ADMIN2.id],
      ['status', 'resolved', ADMIN.id]
    ])
  })
  it('enforces the transition table per kind', async () => {
    const q = await create(claim)
    const cmd = (action: string, expectedVersion: number, id = q.id) =>
      code(
        commandAdminB2bRequest(f.database, claimsOf(ADMIN), id, { action, expectedVersion, note: 'nota' }, key(), NOW)
      )
    expect(await cmd('approve', 1)).toBe('invalid_transition')
    expect(await cmd('resolve', 1)).toBe('invalid_transition')
    expect(await cmd('start_review', 1)).toBe('ok')
    expect(await cmd('approve', 2)).toBe('invalid_transition')
    expect(await cmd('start_review', 2)).toBe('invalid_transition')
    expect(await cmd('resolve', 2)).toBe('ok')
    expect(await cmd('reply', 3)).toBe('invalid_transition')
    expect(await cmd('start_review', 1, crypto.randomUUID())).toBe('not_found')
  })
  it('needs a note to reject, ask for information or reply', async () => {
    const r = await create()
    await commandAdminB2bRequest(
      f.database,
      claimsOf(ADMIN),
      r.id,
      { action: 'start_review', expectedVersion: 1 },
      key(),
      NOW
    )
    for (const action of ['reject', 'request_info', 'reply'])
      expect(
        await code(
          commandAdminB2bRequest(f.database, claimsOf(ADMIN), r.id, { action, expectedVersion: 2 }, key(), NOW)
        )
      ).toBe('invalid_input')
  })
  it('sends a visible reply, assigns an owner and keeps CAS on every command', async () => {
    const r = await create()
    await commandAdminB2bRequest(
      f.database,
      claimsOf(ADMIN),
      r.id,
      { action: 'reply', expectedVersion: 1, note: 'Recibido, lo revisamos hoy' },
      key(),
      NOW
    )
    expect((await readB2bRequest(f.database, A(), r.id, NOW)).events.at(-1)).toMatchObject({
      actorType: 'admin',
      action: 'reply',
      note: 'Recibido, lo revisamos hoy'
    })
    expect(
      await commandAdminB2bRequest(
        f.database,
        claimsOf(ADMIN2),
        r.id,
        { action: 'assign', expectedVersion: 2 },
        key(),
        NOW
      )
    ).toMatchObject({ version: 3 })
    expect(f.sqlite.prepare('SELECT owner_id FROM support_b2b_requests WHERE id=?').get(r.id)).toEqual({
      owner_id: ADMIN2.id
    })
    expect(
      await code(
        commandAdminB2bRequest(f.database, claimsOf(ADMIN), r.id, { action: 'assign', expectedVersion: 2 }, key(), NOW)
      )
    ).toBe('concurrency_conflict')
  })
  it('replays an idempotent command without a second event', async () => {
    const r = await create()
    const k = key()
    const first = await commandAdminB2bRequest(
      f.database,
      claimsOf(ADMIN),
      r.id,
      { action: 'start_review', expectedVersion: 1 },
      k,
      NOW
    )
    expect(
      await commandAdminB2bRequest(
        f.database,
        claimsOf(ADMIN),
        r.id,
        { action: 'start_review', expectedVersion: 1 },
        k,
        NOW
      )
    ).toEqual(first)
    expect(
      (
        f.sqlite.prepare('SELECT count(*) n FROM support_b2b_request_events WHERE request_id=?').get(r.id) as {
          n: number
        }
      ).n
    ).toBe(2)
    expect(
      await code(
        commandAdminB2bRequest(
          f.database,
          claimsOf(ADMIN),
          r.id,
          { action: 'reply', expectedVersion: 1, note: 'x' },
          k,
          NOW
        )
      )
    ).toBe('idempotency_conflict')
  })
  it('measures SLA: first response in time is met, late is breached, assignment alone does not count', async () => {
    const onTime = await create(quote, A(), '2026-10-29T08:00:00Z')
    const late = await create(quote, claimsOf(CUSTOMER_B), '2026-10-29T08:00:00Z')
    await commandAdminB2bRequest(
      f.database,
      claimsOf(ADMIN),
      onTime.id,
      { action: 'start_review', expectedVersion: 1 },
      key(),
      '2026-10-29T09:00:00Z'
    )
    await commandAdminB2bRequest(
      f.database,
      claimsOf(ADMIN),
      late.id,
      { action: 'assign', expectedVersion: 1 },
      key(),
      '2026-10-29T09:00:00Z'
    )
    const items = (await listAdminB2bRequests(f.database, claimsOf(ADMIN), {}, '2026-10-31T00:00:00Z')).items
    expect(items.find((i) => i.id === onTime.id)!.slaState).toBe('met')
    expect(items.find((i) => i.id === late.id)!.slaState).toBe('breached')
    await commandAdminB2bRequest(
      f.database,
      claimsOf(ADMIN),
      late.id,
      { action: 'start_review', expectedVersion: 2 },
      key(),
      '2026-10-31T01:00:00Z'
    )
    expect(
      (await readAdminB2bRequest(f.database, claimsOf(ADMIN), late.id, '2026-11-02T00:00:00Z')).request.slaState
    ).toBe('breached')
  })
})
