/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON bodies in assertions */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handleSupportAssistantHttp,
  ownsSupportAssistantNamespace,
  handleSupportInsightsAdminHttp,
  ownsSupportInsightsAdminNamespace,
  handleB2bRequestsHttp,
  ownsB2bRequestsNamespace
} from '../../workers/support/insights-http'
import {
  insightsFixture,
  seedKnowledgePage,
  seedOrder,
  seedTicket,
  ADMIN,
  NOPERM,
  CUSTOMER_A,
  CUSTOMER_B,
  CUSTOMER_PENDING,
  ORIGIN,
  COOKIE_CONFIG,
  NOW
} from './support-insights-fixture'
import { testUuid } from '../support/deterministic'

let f: Awaited<ReturnType<typeof insightsFixture>>
let gate: 'allowed' | 'limited' | 'unavailable'
const deps = () => ({
  database: f.database,
  sessionCookieConfiguration: COOKIE_CONFIG,
  origin: ORIGIN,
  enabled: true,
  now: () => NOW,
  edgeGate: async () => gate
})
type Init = {
  method?: string
  actor?: { id: string } | null
  body?: unknown
  raw?: string
  key?: string | null
  origin?: string | null
  headers?: Record<string, string>
}
function req(path: string, init: Init = {}) {
  const method = init.method ?? 'GET'
  const headers: Record<string, string> = { ...init.headers }
  if (init.actor) headers.cookie = f.cookie(init.actor)
  if (method !== 'GET' && init.origin !== null) headers.origin = init.origin ?? ORIGIN
  if (method !== 'GET' && init.key !== null) headers['idempotency-key'] = init.key ?? testUuid()
  let body: string | undefined
  if (init.raw !== undefined) body = init.raw
  else if (init.body !== undefined) body = JSON.stringify(init.body)
  if (body !== undefined) headers['content-type'] = headers['content-type'] ?? 'application/json'
  return new Request(ORIGIN + path, { method, headers, body })
}
const json = async (r: Response | null) => ({ status: r!.status, body: (await r!.json()) as Record<string, any> })
const assistant = async (path: string, init?: Init) => json(await handleSupportAssistantHttp(req(path, init), deps()))
const admin = async (path: string, init?: Init) =>
  json(await handleSupportInsightsAdminHttp(req(path, { actor: ADMIN, ...init }), deps()))
const b2b = async (path: string, init?: Init) =>
  json(await handleB2bRequestsHttp(req(path, { actor: CUSTOMER_A, ...init }), deps()))

beforeEach(async () => {
  f = await insightsFixture()
  gate = 'allowed'
  seedKnowledgePage(f.sqlite, {
    slug: 'plazos-de-envio',
    title: 'Plazos de envío',
    description: 'Cuánto tarda.',
    category: 'envios',
    text: ['El envío por agencia tarda de 2 a 4 días.']
  })
})
afterEach(() => f.sqlite.close())

describe('namespaces', () => {
  it('own their routes including encoded traversal and nothing else', () => {
    expect(ownsSupportAssistantNamespace('/api/support/assistant/ask')).toBe(true)
    expect(ownsSupportAssistantNamespace('/api/support/%61ssistant/ask')).toBe(true)
    expect(ownsSupportAssistantNamespace('/api/support/knowledge')).toBe(false)
    expect(ownsSupportInsightsAdminNamespace('/api/admin/support/contact-analysis')).toBe(true)
    expect(ownsSupportInsightsAdminNamespace('/api/admin/support/education/candidates')).toBe(true)
    expect(ownsSupportInsightsAdminNamespace('/api/admin/support/assistant/stats')).toBe(true)
    expect(ownsSupportInsightsAdminNamespace('/api/admin/support/b2b-requests')).toBe(true)
    expect(ownsSupportInsightsAdminNamespace('/api/admin/support/rca')).toBe(false)
    expect(ownsB2bRequestsNamespace('/api/account/b2b-requests/abc')).toBe(true)
    expect(ownsB2bRequestsNamespace('/api/account/%62%32b-requests')).toBe(true)
    expect(ownsB2bRequestsNamespace('/api/account/orders')).toBe(false)
  })
  it('return null outside their namespace', async () => {
    expect(await handleSupportAssistantHttp(req('/api/other'), deps())).toBeNull()
    expect(await handleSupportInsightsAdminHttp(req('/api/other'), deps())).toBeNull()
    expect(await handleB2bRequestsHttp(req('/api/other'), deps())).toBeNull()
  })
})

describe('public assistant endpoints (SUP-012)', () => {
  const ask = (question: string, init: Init = {}) =>
    assistant('/api/support/assistant/ask', { method: 'POST', body: { question }, ...init })
  it('answers with citations and no-store headers', async () => {
    const res = await handleSupportAssistantHttp(
      req('/api/support/assistant/ask', { method: 'POST', body: { question: '¿Cuánto tarda el envío por agencia?' } }),
      deps()
    )
    expect(res!.status).toBe(200)
    expect(res!.headers.get('cache-control')).toContain('no-store')
    const body = (await res!.json()) as Record<string, any>
    expect(body).toMatchObject({
      outcome: 'answered',
      answer: 'El envío por agencia tarda de 2 a 4 días.',
      sources: [{ slug: 'plazos-de-envio' }]
    })
  })
  it('admits only POST, same-origin, JSON, a bounded body and an idempotency key', async () => {
    expect((await assistant('/api/support/assistant/ask')).status).toBe(405)
    expect((await ask('¿Cuánto tarda el envío?', { origin: 'https://evil.test' })).status).toBe(403)
    expect((await ask('¿Cuánto tarda el envío?', { origin: null })).status).toBe(403)
    expect((await ask('¿Cuánto tarda el envío?', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await ask('¿Cuánto tarda el envío?', { key: null })).body.error.code).toBe('invalid_input')
    expect(
      (
        await assistant('/api/support/assistant/ask', {
          method: 'POST',
          raw: 'question=hola',
          headers: { 'content-type': 'text/plain' }
        })
      ).status
    ).toBe(422)
    expect(
      (
        await assistant('/api/support/assistant/ask', {
          method: 'POST',
          raw: JSON.stringify({ question: 'x'.repeat(20000) })
        })
      ).status
    ).toBe(413)
    expect((await assistant('/api/support/assistant/ask', { method: 'POST', raw: '{bad' })).status).toBe(422)
    expect((await ask('x')).status).toBe(422)
    expect((await assistant('/api/support/assistant/unknown', { method: 'POST', body: {} })).status).toBe(404)
  })
  it('is rate limited and fails closed when abuse control is unavailable or knowledge disabled', async () => {
    gate = 'limited'
    const limited = await ask('¿Cuánto tarda el envío?')
    expect(limited.status).toBe(429)
    gate = 'unavailable'
    expect((await ask('¿Cuánto tarda el envío?')).status).toBe(503)
    gate = 'allowed'
    const off = await json(
      await handleSupportAssistantHttp(
        req('/api/support/assistant/ask', { method: 'POST', body: { question: 'hola mundo' } }),
        { ...deps(), enabled: false }
      )
    )
    expect(off).toMatchObject({ status: 503, body: { error: { code: 'knowledge_unavailable' } } })
  })
  it('replays an idempotent retry and flags key reuse with another question as 409', async () => {
    const key = testUuid()
    const a = await ask('¿Cuánto tarda el envío por agencia?', { key })
    const b = await ask('¿Cuánto tarda el envío por agencia?', { key })
    expect(b.body.turnId).toBe(a.body.turnId)
    expect((await ask('¿Dónde descargo mi factura?', { key })).status).toBe(409)
  })
  it('opens a handoff (e-mail or signed-in customer) and records feedback', async () => {
    const turn = (await ask('¿Qué pintura epoxi industrial recomendáis?')).body.turnId as string
    expect((await assistant('/api/support/assistant/handoff', { method: 'POST', body: { turnId: turn } })).status).toBe(
      422
    )
    const opened = await assistant('/api/support/assistant/handoff', {
      method: 'POST',
      body: { turnId: turn, contactEmail: 'ana@example.com' }
    })
    expect(opened).toMatchObject({ status: 201, body: { status: 'open' } })
    const again = await assistant('/api/support/assistant/handoff', {
      method: 'POST',
      body: { turnId: turn },
      actor: CUSTOMER_A
    })
    expect(again.body.handoffId).toBe(opened.body.handoffId)
    expect(
      (await assistant('/api/support/assistant/feedback', { method: 'POST', body: { turnId: turn, helpful: false } }))
        .body
    ).toMatchObject({ helpful: false, recorded: true })
    expect(
      (await assistant('/api/support/assistant/feedback', { method: 'POST', body: { turnId: turn, helpful: true } }))
        .status
    ).toBe(409)
    expect(
      (
        await assistant('/api/support/assistant/handoff', {
          method: 'POST',
          body: { turnId: testUuid(), contactEmail: 'a@b.es' }
        })
      ).status
    ).toBe(404)
  })
})

describe('administrative insight endpoints', () => {
  it('require a live session with support.manage', async () => {
    expect(
      (await admin('/api/admin/support/contact-analysis?from=2026-10-01&to=2026-11-01', { actor: null })).status
    ).toBe(401)
    expect(
      (await admin('/api/admin/support/contact-analysis?from=2026-10-01&to=2026-11-01', { actor: NOPERM })).status
    ).toBe(403)
    f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(ADMIN.id)
    expect((await admin('/api/admin/support/education/candidates')).status).toBe(403)
  })
  it('re-checks authority after the work and withholds the result when it was revoked', async () => {
    const real = f.database
    let calls = 0
    const spy = new Proxy(real, {
      get: (t, p) =>
        p === 'prepare'
          ? (sql: string) => {
              if (/FROM auth_sessions/.test(sql) && ++calls === 2)
                f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(ADMIN.id)
              return t.prepare(sql)
            }
          : (t as never)[p]
    })
    const res = await json(
      await handleSupportInsightsAdminHttp(
        req('/api/admin/support/contact-analysis?from=2026-10-01&to=2026-11-01', { actor: ADMIN }),
        { ...deps(), database: spy }
      )
    )
    expect(res.status).toBe(403)
  })
  it('serves the contact analysis and rejects unknown or malformed parameters', async () => {
    seedOrder(f.sqlite, {
      id: '50000000-0000-4000-8000-000000000001',
      customerId: CUSTOMER_A.customer,
      createdAt: '2026-10-02T00:00:00Z',
      carrier: 'SEUR'
    })
    seedTicket(f.sqlite, {
      category: 'shipping',
      createdAt: '2026-10-03T00:00:00Z',
      orderId: '50000000-0000-4000-8000-000000000001',
      customerId: CUSTOMER_A.customer
    })
    const ok = await admin('/api/admin/support/contact-analysis?from=2026-10-01&to=2026-11-01&touchCostCents=300')
    expect(ok.status).toBe(200)
    expect(ok.body.totals).toMatchObject({ orders: 1, contacts: 1, ratePer100Orders: 100 })
    expect((await admin('/api/admin/support/contact-analysis?from=2026-10-01&to=2026-11-01&evil=1')).status).toBe(422)
    expect((await admin('/api/admin/support/contact-analysis?from=2026-10-01&to=2026-11-01&limit=abc')).status).toBe(
      422
    )
    expect((await admin('/api/admin/support/contact-analysis?from=2026-10-01')).status).toBe(422)
  })
  it('classifies tickets, builds a backlog item and moves it', async () => {
    const ticketId = seedTicket(f.sqlite, { category: 'shipping', createdAt: '2026-10-03T00:00:00Z' })
    const cls = await admin('/api/admin/support/contact-analysis/classifications', {
      method: 'POST',
      body: { ticketId, rootCause: 'delivery_delay', expectedVersion: 0 }
    })
    expect(cls).toMatchObject({ status: 201, body: { version: 1 } })
    const item = {
      dimension: 'carrier',
      dimensionKey: 'SEUR',
      rootCause: 'delivery_delay',
      title: 'Retrasos recurrentes SEUR',
      priority: 'high',
      from: '2026-10-01',
      to: '2026-11-01',
      evidence: { contacts: 3 }
    }
    const created = await admin('/api/admin/support/contact-analysis/backlog', { method: 'POST', body: item })
    expect(created.status).toBe(201)
    expect((await admin('/api/admin/support/contact-analysis/backlog', { method: 'POST', body: item })).status).toBe(
      409
    )
    expect((await admin('/api/admin/support/contact-analysis/backlog')).body.items).toHaveLength(1)
    const moved = await admin(`/api/admin/support/contact-analysis/backlog/${created.body.id}/commands`, {
      method: 'POST',
      body: { action: 'plan', expectedVersion: 1 }
    })
    expect(moved).toMatchObject({ status: 200, body: { status: 'planned', version: 2 } })
  })
  it('requires same-origin JSON and an idempotency key for admin writes', async () => {
    const body = { ticketId: testUuid(), rootCause: 'other', expectedVersion: 0 }
    expect(
      (
        await admin('/api/admin/support/contact-analysis/classifications', {
          method: 'POST',
          body,
          origin: 'https://evil.test'
        })
      ).status
    ).toBe(403)
    expect(
      (await admin('/api/admin/support/contact-analysis/classifications', { method: 'POST', body, key: null })).status
    ).toBe(422)
    expect((await admin('/api/admin/support/contact-analysis/classifications', { method: 'POST', body })).status).toBe(
      404
    )
    expect((await admin('/api/admin/support/contact-analysis/classifications', { method: 'DELETE' })).status).toBe(405)
  })
  it('exposes the assistant handoff queue, commands and statistics', async () => {
    const turn = (
      await assistant('/api/support/assistant/ask', {
        method: 'POST',
        body: { question: '¿Qué pintura epoxi industrial recomendáis?' }
      })
    ).body.turnId
    const handoff = (
      await assistant('/api/support/assistant/handoff', {
        method: 'POST',
        body: { turnId: turn, contactEmail: 'ana@example.com' }
      })
    ).body.handoffId
    const list = await admin('/api/admin/support/assistant/handoffs?status=open')
    expect(list.body.items).toEqual([expect.objectContaining({ id: handoff, contactEmail: 'ana@example.com' })])
    expect(
      (
        await admin(`/api/admin/support/assistant/handoffs/${handoff}/commands`, {
          method: 'POST',
          body: { action: 'claim', expectedVersion: 1 }
        })
      ).body
    ).toMatchObject({ status: 'claimed' })
    expect((await admin('/api/admin/support/assistant/stats?from=2026-10-01&to=2026-11-01')).body).toMatchObject({
      turns: 1,
      handoffRequested: 1
    })
  })
  it('drives the education pipeline end to end over HTTP', async () => {
    for (let i = 0; i < 3; i++)
      await assistant('/api/support/assistant/ask', {
        method: 'POST',
        body: { question: '¿Qué pintura epoxi industrial recomendáis?' }
      })
    const detect = await admin('/api/admin/support/education/detect', {
      method: 'POST',
      body: { from: '2026-09-01', to: '2026-12-01', minOccurrences: 3 }
    })
    expect(detect).toMatchObject({ status: 200, body: { created: 1 } })
    const list = await admin('/api/admin/support/education/candidates')
    const id = list.body.items[0].id as string
    expect(
      (
        await admin(`/api/admin/support/education/candidates/${id}/commands`, {
          method: 'POST',
          body: { action: 'start_review', expectedVersion: 1 }
        })
      ).body.status
    ).toBe('in_review')
    expect((await admin(`/api/admin/support/education/candidates/${id}/deflection`)).status).toBe(409)
    expect((await admin(`/api/admin/support/education/candidates/${id}/deflection?windowDays=2`)).status).toBe(422)
  })
  it('serves the B2B queue to administrators only', async () => {
    const created = await b2b('/api/account/b2b-requests', {
      method: 'POST',
      body: {
        kind: 'quote',
        subject: 'Presupuesto de lejía',
        details: { lines: [{ productSlug: 'lejia-5l', quantity: 10 }] }
      }
    })
    const list = await admin('/api/admin/support/b2b-requests?kind=quote&sla=on_track')
    expect(list.body.items).toEqual([expect.objectContaining({ id: created.body.id, companyName: 'Empresa c1' })])
    expect((await admin(`/api/admin/support/b2b-requests/${created.body.id}`)).body.request.id).toBe(created.body.id)
    expect(
      (
        await admin(`/api/admin/support/b2b-requests/${created.body.id}/commands`, {
          method: 'POST',
          body: { action: 'start_review', expectedVersion: 1 }
        })
      ).body
    ).toMatchObject({ status: 'in_review', version: 2 })
    expect((await admin('/api/admin/support/b2b-requests', { actor: CUSTOMER_A })).status).toBe(403)
    expect((await admin('/api/admin/support/b2b-requests?kind=bogus')).status).toBe(422)
  })
})

describe('B2B customer portal endpoints (SUP-017)', () => {
  const quote = {
    kind: 'quote',
    subject: 'Presupuesto de lejía',
    details: { lines: [{ productSlug: 'lejia-5l', quantity: 10 }] }
  }
  it('requires a customer session', async () => {
    expect((await b2b('/api/account/b2b-requests', { actor: null })).status).toBe(401)
    expect((await b2b('/api/account/b2b-requests', { actor: ADMIN })).status).toBe(401)
    expect(
      (await b2b('/api/account/b2b-requests', { method: 'POST', body: quote, actor: CUSTOMER_PENDING })).status
    ).toBe(403)
  })
  it('creates, lists, reads, replies, attaches metadata and cancels', async () => {
    const created = await b2b('/api/account/b2b-requests', { method: 'POST', body: quote })
    expect(created).toMatchObject({ status: 201, body: { status: 'submitted', version: 1 } })
    const id = created.body.id as string
    expect((await b2b('/api/account/b2b-requests')).body.items).toHaveLength(1)
    expect((await b2b('/api/account/b2b-requests', { actor: CUSTOMER_B })).body.items).toHaveLength(0)
    expect((await b2b(`/api/account/b2b-requests/${id}`)).body.request).toMatchObject({
      id,
      kind: 'quote',
      slaState: 'on_track'
    })
    expect((await b2b(`/api/account/b2b-requests/${id}`, { actor: CUSTOMER_B })).status).toBe(404)
    expect(
      (
        await b2b(`/api/account/b2b-requests/${id}/reply`, {
          method: 'POST',
          body: { message: 'Necesito entrega semanal' }
        })
      ).status
    ).toBe(201)
    const doc = await b2b(`/api/account/b2b-requests/${id}/documents`, {
      method: 'POST',
      body: {
        kind: 'technical_sheet',
        fileName: 'ficha.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1000,
        sha256: 'a'.repeat(64)
      }
    })
    expect(doc).toMatchObject({ status: 201, body: { scanStatus: 'pending' } })
    expect(
      (await b2b(`/api/account/b2b-requests/${id}/cancel`, { method: 'POST', body: { expectedVersion: 1 } })).status
    ).toBe(409)
    expect(
      (await b2b(`/api/account/b2b-requests/${id}/cancel`, { method: 'POST', body: { expectedVersion: 2 } })).body
        .status
    ).toBe('cancelled')
  })
  it('keeps the same boundary rules as the other write endpoints', async () => {
    expect(
      (await b2b('/api/account/b2b-requests', { method: 'POST', body: quote, origin: 'https://evil.test' })).status
    ).toBe(403)
    expect((await b2b('/api/account/b2b-requests', { method: 'POST', body: quote, key: null })).status).toBe(422)
    expect((await b2b('/api/account/b2b-requests', { method: 'POST', body: { ...quote, kind: 'nope' } })).status).toBe(
      422
    )
    expect((await b2b('/api/account/b2b-requests/not-a-uuid')).status).toBe(404)
    expect((await b2b('/api/account/b2b-requests', { method: 'PUT', body: quote })).status).toBe(405)
    expect((await b2b('/api/account/b2b-requests?status=bogus')).status).toBe(422)
    gate = 'limited'
    expect((await b2b('/api/account/b2b-requests')).status).toBe(429)
  })
  it('replays an idempotent creation', async () => {
    const key = testUuid()
    const a = await b2b('/api/account/b2b-requests', { method: 'POST', body: quote, key })
    const b = await b2b('/api/account/b2b-requests', { method: 'POST', body: quote, key })
    expect(b.body.id).toBe(a.body.id)
  })
})
