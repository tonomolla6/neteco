import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readContactAnalysis,
  classifyTicketRootCause,
  createContactBacklogItem,
  transitionContactBacklogItem,
  listContactBacklog
} from '../../workers/support/contact-analysis'
import { createD1SupportRca } from '../../workers/support/rca'
import { InsightError } from '../../workers/support/insight-commands'
import {
  insightsFixture,
  seedOrder,
  seedTicket,
  claimsOf,
  ADMIN,
  ADMIN2,
  NOPERM,
  NOMFA,
  CUSTOMER_A
} from './support-insights-fixture'
import { testUuid } from '../support/deterministic'

let f: Awaited<ReturnType<typeof insightsFixture>>
const NOW = '2026-11-02T09:00:00Z'
const WINDOW = { from: '2026-10-01', to: '2026-11-01', limit: 10 }
const oid = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const key = () => testUuid()
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => (e instanceof InsightError ? e.code : String(e))
  )
const ticketIds: string[] = []

beforeEach(async () => {
  f = await insightsFixture()
  ticketIds.length = 0
  // 10 SEUR orders (1..10), 5 GLS orders (11..15); lejia in orders 1-8, desengrasante in 9-12.
  for (let n = 1; n <= 15; n++)
    seedOrder(f.sqlite, {
      id: oid(n),
      customerId: CUSTOMER_A.customer,
      createdAt: `2026-10-${String(n).padStart(2, '0')}T10:00:00Z`,
      carrier: n <= 10 ? 'SEUR' : 'GLS',
      productSlugs: n <= 8 ? ['lejia-5l'] : n <= 12 ? ['desengrasante'] : ['ambientador']
    })
  const t = (o: Parameters<typeof seedTicket>[1]) =>
    ticketIds.push(seedTicket(f.sqlite, { customerId: CUSTOMER_A.customer, ...o }))
  t({ category: 'shipping', createdAt: '2026-10-05T09:00:00Z', orderId: oid(1), adminTouches: 1 })
  t({ category: 'shipping', createdAt: '2026-10-06T09:00:00Z', orderId: oid(1) })
  t({ category: 'shipping', createdAt: '2026-10-07T09:00:00Z', orderId: oid(2) })
  t({ category: 'shipping', createdAt: '2026-10-12T09:00:00Z', orderId: oid(11), adminTouches: 1 })
  t({ category: 'product', createdAt: '2026-10-08T09:00:00Z', orderId: oid(3), productSlug: 'lejia-5l' })
  t({ category: 'product', createdAt: '2026-10-09T09:00:00Z', productSlug: 'lejia-5l' })
  t({ category: 'payment', createdAt: '2026-10-10T09:00:00Z' })
  t({ category: 'shipping', createdAt: '2026-09-20T09:00:00Z', orderId: oid(1) }) // outside window
})
afterEach(() => f.sqlite.close())

describe('readContactAnalysis (SUP-014)', () => {
  it('computes the contact rate per 100 orders overall', async () => {
    const r = await readContactAnalysis(f.database, claimsOf(ADMIN), WINDOW, NOW)
    expect(r.totals).toMatchObject({
      orders: 15,
      contacts: 7,
      ratePer100Orders: 46.67,
      touches: 2,
      estimatedCostCents: null
    })
  })
  it('breaks contacts down by carrier with the matching order base', async () => {
    const r = await readContactAnalysis(f.database, claimsOf(ADMIN), WINDOW, NOW)
    expect(r.byCarrier).toEqual([
      { key: 'SEUR', orders: 10, contacts: 4, ratePer100Orders: 40 },
      { key: 'GLS', orders: 5, contacts: 1, ratePer100Orders: 20 }
    ])
  })
  it('breaks contacts down by product against orders containing it', async () => {
    const r = await readContactAnalysis(f.database, claimsOf(ADMIN), WINDOW, NOW)
    expect(r.byProduct).toEqual([{ key: 'lejia-5l', orders: 8, contacts: 2, ratePer100Orders: 25 }])
  })
  it('lists orders with repeated contacts without exposing personal data', async () => {
    const r = await readContactAnalysis(f.database, claimsOf(ADMIN), WINDOW, NOW)
    expect(r.byOrder).toEqual([{ key: oid(1), contacts: 2 }])
    expect(JSON.stringify(r)).not.toMatch(/@|Cliente|requester|subject/)
  })
  it('groups by ticket category and by root cause, reporting unclassified honestly', async () => {
    const r = await readContactAnalysis(f.database, claimsOf(ADMIN), WINDOW, NOW)
    expect(r.byCategory).toEqual([
      { key: 'shipping', contacts: 4, touches: 2 },
      { key: 'product', contacts: 2, touches: 0 },
      { key: 'payment', contacts: 1, touches: 0 }
    ])
    expect(r.byRootCause).toEqual([{ key: 'unclassified', contacts: 7, touches: 2 }])
    await classifyTicketRootCause(
      f.database,
      claimsOf(ADMIN),
      { ticketId: ticketIds[0]!, rootCause: 'transit_damage', expectedVersion: 0 },
      key(),
      NOW
    )
    const after = await readContactAnalysis(f.database, claimsOf(ADMIN), WINDOW, NOW)
    expect(after.byRootCause).toEqual([
      { key: 'unclassified', contacts: 6, touches: 1 },
      { key: 'transit_damage', contacts: 1, touches: 1 }
    ])
  })
  it('prices handling effort only when a per-touch cost is supplied', async () => {
    const r = await readContactAnalysis(f.database, claimsOf(ADMIN), { ...WINDOW, touchCostCents: 450 }, NOW)
    expect(r.totals.estimatedCostCents).toBe(900)
    expect(r.byCategory[0]).toMatchObject({ key: 'shipping', estimatedCostCents: 900 })
  })
  it('suggests backlog candidates for concentrated groups only', async () => {
    const r = await readContactAnalysis(f.database, claimsOf(ADMIN), WINDOW, NOW)
    expect(r.suggestions).toEqual([
      expect.objectContaining({ dimension: 'carrier', dimensionKey: 'SEUR', rootCause: 'unclassified', contacts: 4 }),
      expect.objectContaining({ dimension: 'category', dimensionKey: 'shipping', contacts: 4 })
    ])
  })
  it('honours the limit', async () => {
    const r = await readContactAnalysis(f.database, claimsOf(ADMIN), { ...WINDOW, limit: 1 }, NOW)
    expect(r.byCarrier).toHaveLength(1)
    expect(r.byCategory).toHaveLength(1)
  })
  it('is empty and safe when there is no activity', async () => {
    const r = await readContactAnalysis(
      f.database,
      claimsOf(ADMIN),
      { from: '2025-12-01', to: '2025-12-15', limit: 10 },
      NOW
    )
    expect(r.totals).toMatchObject({ orders: 0, contacts: 0, ratePer100Orders: null })
    expect(r.byCarrier).toEqual([])
  })
  it('needs live support authority and a valid window', async () => {
    expect(await code(readContactAnalysis(f.database, claimsOf(NOPERM), WINDOW, NOW))).toBe('forbidden')
    expect(await code(readContactAnalysis(f.database, claimsOf(NOMFA), WINDOW, NOW))).toBe('mfa_required')
    expect(await code(readContactAnalysis(f.database, null, WINDOW, NOW))).toBe('unauthenticated')
    expect(
      await code(
        readContactAnalysis(f.database, claimsOf(ADMIN), { from: '2026-11-01', to: '2026-10-01', limit: 10 }, NOW)
      )
    ).toBe('invalid_input')
    expect(await code(readContactAnalysis(f.database, claimsOf(ADMIN), { ...WINDOW, touchCostCents: -5 }, NOW))).toBe(
      'invalid_input'
    )
  })
  it('reads with a constant number of statements regardless of volume (no N+1)', async () => {
    const seen: string[] = []
    const spy = new Proxy(f.database, {
      get: (t, p) => (p === 'prepare' ? (sql: string) => (seen.push(sql), t.prepare(sql)) : (t as never)[p])
    })
    await readContactAnalysis(spy, claimsOf(ADMIN), WINDOW, NOW)
    const first = seen.length
    for (let n = 20; n < 40; n++) seedTicket(f.sqlite, { category: 'other', createdAt: '2026-10-20T09:00:00Z' })
    seen.length = 0
    await readContactAnalysis(spy, claimsOf(ADMIN), WINDOW, NOW)
    expect(seen.length).toBe(first)
  })
})

describe('classifyTicketRootCause', () => {
  it('creates then updates with optimistic concurrency', async () => {
    const input = { ticketId: ticketIds[2]!, rootCause: 'delivery_delay' as const, expectedVersion: 0 }
    expect(await classifyTicketRootCause(f.database, claimsOf(ADMIN), input, key(), NOW)).toMatchObject({
      rootCause: 'delivery_delay',
      version: 1
    })
    expect(await code(classifyTicketRootCause(f.database, claimsOf(ADMIN2), input, key(), NOW))).toBe(
      'concurrency_conflict'
    )
    expect(
      await classifyTicketRootCause(
        f.database,
        claimsOf(ADMIN2),
        { ...input, rootCause: 'transit_damage', note: 'Caja aplastada', expectedVersion: 1 },
        key(),
        NOW
      )
    ).toMatchObject({ rootCause: 'transit_damage', version: 2 })
    expect(
      f.sqlite.prepare('SELECT root_cause,classified_by,version FROM support_contact_classifications').get()
    ).toEqual({ root_cause: 'transit_damage', classified_by: ADMIN2.id, version: 2 })
  })
  it('replays idempotently and rejects reuse with another payload', async () => {
    const k = key()
    const input = { ticketId: ticketIds[2]!, rootCause: 'wrong_item' as const, expectedVersion: 0 }
    const first = await classifyTicketRootCause(f.database, claimsOf(ADMIN), input, k, NOW)
    expect(await classifyTicketRootCause(f.database, claimsOf(ADMIN), input, k, NOW)).toEqual(first)
    expect(
      await code(classifyTicketRootCause(f.database, claimsOf(ADMIN), { ...input, rootCause: 'other' }, k, NOW))
    ).toBe('idempotency_conflict')
  })
  it('validates ticket, taxonomy and authority', async () => {
    const base = { ticketId: ticketIds[0]!, rootCause: 'other' as const, expectedVersion: 0 }
    expect(
      await code(classifyTicketRootCause(f.database, claimsOf(ADMIN), { ...base, ticketId: testUuid() }, key(), NOW))
    ).toBe('not_found')
    expect(
      await code(
        classifyTicketRootCause(f.database, claimsOf(ADMIN), { ...base, rootCause: 'color' } as never, key(), NOW)
      )
    ).toBe('invalid_input')
    expect(await code(classifyTicketRootCause(f.database, claimsOf(NOPERM), base, key(), NOW))).toBe('forbidden')
    expect(await code(classifyTicketRootCause(f.database, claimsOf(ADMIN), base, 'nope', NOW))).toBe('invalid_input')
  })
})

describe('contact backlog', () => {
  const item = {
    dimension: 'carrier' as const,
    dimensionKey: 'SEUR',
    rootCause: 'delivery_delay' as const,
    title: 'Retrasos recurrentes con SEUR',
    priority: 'high' as const,
    from: '2026-10-01',
    to: '2026-11-01',
    evidence: { contacts: 3, ratePer100Orders: 30 }
  }
  it('creates an item from the analysis evidence', async () => {
    const r = await createContactBacklogItem(f.database, claimsOf(ADMIN), item, key(), NOW)
    expect(r).toMatchObject({ status: 'open', version: 1 })
    const list = await listContactBacklog(f.database, claimsOf(ADMIN), {}, NOW)
    expect(list.items).toEqual([
      expect.objectContaining({
        id: r.id,
        dimension: 'carrier',
        dimensionKey: 'SEUR',
        priority: 'high',
        evidence: { contacts: 3, ratePer100Orders: 30 }
      })
    ])
  })
  it('does not duplicate the same finding for the same window', async () => {
    const first = await createContactBacklogItem(f.database, claimsOf(ADMIN), item, key(), NOW)
    expect(await code(createContactBacklogItem(f.database, claimsOf(ADMIN2), item, key(), NOW))).toBe(
      'duplicate_backlog'
    )
    expect((f.sqlite.prepare('SELECT count(*) n FROM support_contact_backlog_items').get() as { n: number }).n).toBe(1)
    const k = key()
    const again = await createContactBacklogItem(f.database, claimsOf(ADMIN), { ...item, dimensionKey: 'GLS' }, k, NOW)
    expect(
      await createContactBacklogItem(f.database, claimsOf(ADMIN), { ...item, dimensionKey: 'GLS' }, k, NOW)
    ).toEqual(again)
    expect(first.id).not.toBe(again.id)
  })
  it('links an RCA and moves open -> planned -> done with CAS', async () => {
    const created = await createContactBacklogItem(f.database, claimsOf(ADMIN), item, key(), NOW)
    const rca = await createD1SupportRca(
      f.database,
      claimsOf(ADMIN),
      {
        incidentCategory: 'delay',
        title: 'Retrasos de transportista',
        severity: 'high',
        rootCauseSummary: 'Recogida tardía en el almacén',
        fiveWhys: ['No se recogió a tiempo'],
        preventiveActions: []
      },
      { idempotencyKey: 'rca-1', now: () => NOW }
    )
    expect(
      await transitionContactBacklogItem(
        f.database,
        claimsOf(ADMIN),
        created.id,
        { action: 'plan', expectedVersion: 1, rcaId: rca.rcaId },
        key(),
        NOW
      )
    ).toMatchObject({ status: 'planned', version: 2 })
    expect(
      await code(
        transitionContactBacklogItem(
          f.database,
          claimsOf(ADMIN2),
          created.id,
          { action: 'complete', expectedVersion: 1 },
          key(),
          NOW
        )
      )
    ).toBe('concurrency_conflict')
    expect(
      await transitionContactBacklogItem(
        f.database,
        claimsOf(ADMIN2),
        created.id,
        { action: 'complete', expectedVersion: 2 },
        key(),
        NOW
      )
    ).toMatchObject({ status: 'done', version: 3 })
    expect(f.sqlite.prepare('SELECT rca_id FROM support_contact_backlog_items').get()).toEqual({ rca_id: rca.rcaId })
    expect(
      await code(
        transitionContactBacklogItem(
          f.database,
          claimsOf(ADMIN),
          created.id,
          { action: 'plan', expectedVersion: 3 },
          key(),
          NOW
        )
      )
    ).toBe('invalid_transition')
  })
  it('rejects unknown RCAs, bad input and missing authority', async () => {
    const created = await createContactBacklogItem(f.database, claimsOf(ADMIN), item, key(), NOW)
    expect(
      await code(
        transitionContactBacklogItem(
          f.database,
          claimsOf(ADMIN),
          created.id,
          { action: 'plan', expectedVersion: 1, rcaId: testUuid() },
          key(),
          NOW
        )
      )
    ).toBe('invalid_input')
    expect(
      await code(
        transitionContactBacklogItem(
          f.database,
          claimsOf(ADMIN),
          testUuid(),
          { action: 'dismiss', expectedVersion: 1 },
          key(),
          NOW
        )
      )
    ).toBe('not_found')
    expect(await code(createContactBacklogItem(f.database, claimsOf(ADMIN), { ...item, title: 'x' }, key(), NOW))).toBe(
      'invalid_input'
    )
    expect(await code(createContactBacklogItem(f.database, claimsOf(NOPERM), item, key(), NOW))).toBe('forbidden')
    expect(await code(listContactBacklog(f.database, null, {}, NOW))).toBe('unauthenticated')
  })
  it('filters the backlog by status', async () => {
    const a = await createContactBacklogItem(f.database, claimsOf(ADMIN), item, key(), NOW)
    await createContactBacklogItem(f.database, claimsOf(ADMIN), { ...item, dimensionKey: 'GLS' }, key(), NOW)
    await transitionContactBacklogItem(
      f.database,
      claimsOf(ADMIN),
      a.id,
      { action: 'dismiss', expectedVersion: 1 },
      key(),
      NOW
    )
    expect((await listContactBacklog(f.database, claimsOf(ADMIN), { status: 'open' }, NOW)).items).toHaveLength(1)
    expect((await listContactBacklog(f.database, claimsOf(ADMIN), { status: 'dismissed' }, NOW)).items).toHaveLength(1)
  })
})
