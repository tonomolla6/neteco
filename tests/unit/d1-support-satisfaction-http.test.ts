import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { handleCustomerSupportHttp } from '../../workers/support/customer-http'
import { handleAdminSupportHttp } from '../../workers/support/admin-http'
import { handleSatisfactionHttp } from '../../workers/support/satisfaction-http'
import { GUEST_ORDER_COOKIE } from '../../workers/catalog/guest-order-access'
import { executeSupportAdminCommand } from '../../workers/support/operations'
import {
  customerSatisfactionSchema,
  satisfactionIntentHash,
  satisfactionReceiptSchema
} from '../../shared/support-satisfaction'
import { supportFixture, ORIGIN, CLAIMS } from './d1-support-fixture'

// The initial behavioral RED used the existing real support dispatch (404).
// Keep legacy handlers after the new namespace to test accidental fallthrough.
describe('support satisfaction HTTP boundaries', () => {
  let fixture: Awaited<ReturnType<typeof supportFixture>>
  beforeEach(async () => {
    fixture = await supportFixture()
    fixture.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0068_support_satisfaction.sql', import.meta.url), 'utf8')
    )
  })
  afterEach(() => fixture.sqlite.close())

  async function dispatch(request: Request, edge = true) {
    const dependencies = { ...fixture.deps, edgeGate: edge ? fixture.deps.edgeGate : undefined }
    return (
      (await handleSatisfactionHttp(request, dependencies)) ??
      (await handleCustomerSupportHttp(request, dependencies)) ??
      (await handleAdminSupportHttp(request, dependencies)) ??
      new Response(null, { status: 404 })
    )
  }

  function request(path: string, cookie = '', origin?: string) {
    return new Request(ORIGIN + path, {
      headers: {
        'CF-Connecting-IP': '192.0.2.149',
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {})
      }
    })
  }

  async function privateFailure(response: Response, status: number) {
    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('vary')).toContain('Cookie')
  }

  it('requires a real customer session', async () => {
    const path = `/api/account/satisfaction/delivery/${fixture.order}`
    await privateFailure(await dispatch(request(path)), 401)
  })

  it('never treats sealed guest order access as satisfaction write authority', async () => {
    const before = fixture.economic()
    const guest = await dispatch(
      new Request(`${ORIGIN}/api/account/satisfaction/delivery/${fixture.order}`, {
        method: 'POST',
        headers: {
          cookie: `${GUEST_ORDER_COOKIE}=synthetic-read-only`,
          origin: ORIGIN,
          'CF-Connecting-IP': '192.0.2.149',
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify({ score: 5, privacyAcknowledged: true, expectedSourceVersion: 1 })
      })
    )
    await privateFailure(guest, 403)
    expect(fixture.economic()).toEqual(before)
  })

  it('fails closed without the mandatory edge gate before exposing customer data', async () => {
    await privateFailure(
      await dispatch(request(`/api/account/satisfaction/delivery/${fixture.order}`, fixture.customerCookie), false),
      503
    )
  })

  it('rejects a foreign Origin on customer reads, without mutating economic state', async () => {
    const before = fixture.economic()
    await privateFailure(
      await dispatch(
        request(
          `/api/account/satisfaction/delivery/${fixture.order}`,
          fixture.customerCookie,
          'https://attacker.invalid'
        )
      ),
      403
    )
    expect(fixture.economic()).toEqual(before)
  })

  it('keeps administrative comments behind exact support.manage and current MFA', async () => {
    const path = '/api/admin/support/satisfaction'
    await privateFailure(await dispatch(request(path, fixture.customerCookie)), 403)
    fixture.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
    await privateFailure(await dispatch(request(path, fixture.adminCookie)), 403)
  })

  it('returns canonical email_unverified 403 if verification is revoked between HTTP and core authorization', async () => {
    let authorizationReads = 0
    const database = new Proxy(fixture.database, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            if (sql.includes('SELECT i.id, s.mfa_verified') && ++authorizationReads === 2)
              fixture.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CLAIMS.identityId)
            return target.prepare(sql)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const response = await handleSatisfactionHttp(request('/api/admin/support/satisfaction', fixture.adminCookie), {
      ...fixture.deps,
      database
    })
    expect(authorizationReads).toBe(2)
    await privateFailure(response!, 403)
    expect(await response!.json()).toEqual({ error: { code: 'email_unverified' } })
  })

  it('does not claim unrelated customer routes', async () => {
    expect((await dispatch(request('/api/account/satisfactionX'))).status).toBe(404)
  })

  it.each([
    ['/api/account/satisfaction/delivery/00000000-0000-4000-8000-000000000001', 'DELETE', 'GET, POST'],
    ['/api/admin/support/satisfaction', 'POST', 'GET'],
    [
      '/api/account/satisfaction/delivery/00000000-0000-4000-8000-000000000001/commands/00000000-0000-4000-8000-000000000002',
      'POST',
      'GET'
    ]
  ])('rejects unsupported methods before authentication: %s %s', async (path, method, allow) => {
    const response = await dispatch(new Request(ORIGIN + path, { method }))
    await privateFailure(response, 405)
    expect(response.headers.get('allow')).toBe(allow)
  })

  it.each([
    '/api/account/satisfaction%2fdelivery%2f00000000-0000-4000-8000-000000000001',
    '/api/account/satisfaction/delivery/not-a-uuid',
    '/api/account/satisfaction/support/00000000-0000-4000-8000-000000000001',
    '/api/admin/support/satisfaction?comments=true&comments=false',
    '/api/admin/support/satisfaction?__proto__=private',
    '/api/admin/support/satisfaction?customerId=private'
  ])('fails closed on malformed paths and private query injection: %s', async (path) => {
    await privateFailure(await dispatch(request(path, fixture.customerCookie)), 400)
  })

  it('requires exact Origin and explicit privacy acceptance on mutations', async () => {
    const path = `/api/account/satisfaction/delivery/${fixture.order}`
    const headers = {
      cookie: fixture.customerCookie,
      'CF-Connecting-IP': '192.0.2.149',
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID()
    }
    const body = JSON.stringify({ score: 5, expectedSourceVersion: 1 })
    await privateFailure(await dispatch(new Request(ORIGIN + path, { method: 'POST', headers, body })), 403)
    await privateFailure(
      await dispatch(new Request(ORIGIN + path, { method: 'POST', headers: { ...headers, origin: ORIGIN }, body })),
      422
    )
  })

  it('rejects invalid recovery correlation without exposing absence as a successful result', async () => {
    const path = `/api/account/satisfaction/delivery/${fixture.order}/commands/${crypto.randomUUID()}`
    await privateFailure(await dispatch(request(path, fixture.customerCookie)), 422)
    await privateFailure(await dispatch(request(path + '?comment=private', fixture.customerCookie)), 400)
  })

  it('does not offer delivery feedback without a configured privacy retention policy', async () => {
    const response = await handleSatisfactionHttp(
      request(`/api/account/satisfaction/delivery/${fixture.order}`, fixture.customerCookie),
      { ...fixture.deps, policy: null }
    )
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({ eligible: false, reason: 'policy_unavailable', privacy: null })
  })

  it('keeps unresolved support ineligible and preserves the real projection-integrity guard', async () => {
    const ticket = await fixture.ticket()
    const path = `/api/account/satisfaction/support/${ticket.publicRef}`
    const response = await dispatch(request(path, fixture.customerCookie))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ eligible: false, reason: 'source_not_final' })
    // The real trigger rejects this corruption before it can become an HTTP
    // source. Never disable it to fabricate a supposedly confirmed resolution.
    expect(() =>
      fixture.sqlite.prepare("UPDATE support_tickets SET state='resolved' WHERE public_ref=?").run(ticket.publicRef)
    ).toThrow('support_projection_invalid')
    const stillOpen = await dispatch(request(path, fixture.customerCookie))
    expect(stillOpen.status).toBe(200)
    expect(await stillOpen.json()).toMatchObject({ eligible: false, reason: 'source_not_final', feedback: null })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM support_satisfaction_commands').get()).toEqual({ n: 0 })
  })

  it('reads confirmed support eligibility without Origin, commits once and recovers the exact private receipt', async () => {
    const ticket = await fixture.ticket()
    await executeSupportAdminCommand(
      fixture.database,
      CLAIMS,
      ticket.publicRef,
      {
        action: 'update',
        expectedVersion: 1,
        reason: 'Resolución sintética revisada',
        state: 'resolved',
        priority: 'normal',
        ownerId: null,
        nextActionAt: null,
        slaDueAt: null,
        resolution: 'Respuesta sintética completa al caso.'
      },
      { idempotencyKey: crypto.randomUUID() }
    )
    const path = `/api/account/satisfaction/support/${ticket.publicRef}`
    const read = await dispatch(request(path, fixture.customerCookie))
    expect(read.status).toBe(200)
    const state = customerSatisfactionSchema.parse(await read.json())
    expect(state).toMatchObject({
      eligible: true,
      target: { kind: 'support', id: ticket.publicRef, version: 2 }
    })
    const body = {
      score: 4,
      comment: 'Comentario privado sintético',
      privacyAcknowledged: true,
      expectedSourceVersion: 2,
      expectedPolicyHash: state.privacy!.policyHash
    }
    const key = crypto.randomUUID()
    const mutation = () =>
      new Request(ORIGIN + path, {
        method: 'POST',
        headers: {
          cookie: fixture.customerCookie,
          origin: ORIGIN,
          'CF-Connecting-IP': '192.0.2.149',
          'Content-Type': 'application/json',
          'Idempotency-Key': key
        },
        body: JSON.stringify(body)
      })
    const before = fixture.economic()
    const applied = await dispatch(mutation())
    expect(applied.status).toBe(201)
    const receipt = satisfactionReceiptSchema.parse(await applied.json())
    expect(receipt).toMatchObject({ commandId: key, target: { id: ticket.publicRef, version: 2 }, score: 4 })
    expect(JSON.stringify(receipt)).not.toContain(body.comment)
    const replay = await dispatch(mutation())
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(receipt)
    const hash = await satisfactionIntentHash('support', ticket.publicRef, body)
    const recovery = (commandId: string) =>
      new Request(`${ORIGIN}${path}/commands/${commandId}`, {
        headers: {
          cookie: fixture.customerCookie,
          'CF-Connecting-IP': '192.0.2.149',
          'X-Neteco-Command-Payload-Hash': hash
        }
      })
    expect(await (await dispatch(recovery(key))).json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(await (await dispatch(recovery(crypto.randomUUID()))).json()).toEqual({
      source: 'cloudflare',
      outcome: 'unknown'
    })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM support_satisfaction_commands').get()).toEqual({ n: 1 })
    expect(fixture.economic()).toEqual(before)
    const summary = await dispatch(request('/api/admin/support/satisfaction', fixture.adminCookie))
    expect(summary.status).toBe(200)
    expect(await summary.json()).toMatchObject({
      total: 1,
      commentsIncluded: false,
      items: [{ score: 4, comment: null }]
    })
    const comments = await dispatch(request('/api/admin/support/satisfaction?comments=true', fixture.adminCookie))
    expect(comments.status).toBe(200)
    expect(await comments.json()).toMatchObject({ commentsIncluded: true, items: [{ comment: body.comment }] })
  })
})
