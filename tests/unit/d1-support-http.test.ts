import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { supportFixture, CONTACT, ORIGIN, BUYER_CLAIMS, CLAIMS, utc } from './d1-support-fixture'
import {
  supportAdminTicketSchema,
  supportCustomerTicketSchema,
  supportOptionsSchema,
  supportReceiptSchema
} from '../../shared/support-operations'

let f: Awaited<ReturnType<typeof supportFixture>>
beforeEach(async () => {
  f = await supportFixture()
})
afterEach(() => {
  f.sqlite.close()
})
async function anonymousCookie() {
  const response = await f.request('/api/support/options', 'GET', undefined, '')
  expect(response.status).toBe(200)
  expect(supportOptionsSchema.safeParse(await response.json()).success).toBe(true)
  return response.headers.get('set-cookie')!.split(';')[0]!
}
describe('native support HTTP boundaries', () => {
  it('owns malformed namespace aliases and never falls through', async () => {
    for (const path of ['/api/admin/support%2Fprivate', '/api/account/support%252Fprivate', '/api/support%2Fprivate']) {
      const response = await f.request(
        path,
        'GET',
        undefined,
        path.includes('account') ? f.customerCookie : f.adminCookie
      )
      expect(response.status).not.toBe(404)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }
  })
  it('fails closed when edge limiter is absent before contact writes', async () => {
    delete f.deps.edgeGate
    expect((await f.request('/api/support/options', 'GET', undefined, '')).status).toBe(503)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual({ n: 0 })
  })
  it('anonymous cookie is technical context only, without customer/order claims', async () => {
    const cookie = await anonymousCookie(),
      response = await f.request('/api/support/tickets', 'POST', CONTACT, cookie)
    expect(response.status).toBe(201)
    expect(supportReceiptSchema.safeParse(await response.json()).success).toBe(true)
    expect(f.sqlite.prepare('SELECT customer_id,order_id FROM support_tickets').get()).toEqual({
      customer_id: null,
      order_id: null
    })
    expect((await f.request('/api/account/support', 'GET', undefined, cookie)).status).toBe(401)
  })
  it('matching contact email or order number never claims a guest order', async () => {
    const cookie = await anonymousCookie()
    expect((await f.request('/api/support/tickets', 'POST', { ...CONTACT, orderId: f.order }, cookie)).status).toBe(403)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_tickets').get()).toEqual({ n: 0 })
    expect((await f.request('/api/account/support', 'GET', undefined, 'neteco-order-access-v2=opaque')).status).toBe(
      403
    )
  })
  it('sealed customer contact and portal bind real current owner, no SQL assignment', async () => {
    const before = f.economic(),
      response = await f.request('/api/support/tickets', 'POST', { ...CONTACT, orderId: f.order }, f.customerCookie)
    expect(response.status).toBe(201)
    const receipt = supportReceiptSchema.parse(await response.json())
    const detail = await f.request('/api/account/support/' + receipt.publicRef, 'GET', undefined, f.customerCookie)
    expect(detail.status).toBe(200)
    const parsed = supportCustomerTicketSchema.parse(await detail.json())
    expect(parsed.context.order?.id).toBe(f.order)
    expect(JSON.stringify(parsed)).not.toContain('requester')
    expect(f.economic()).toEqual(before)
  })
  it('requires exact support.manage and MFA, not administration.manage', async () => {
    const ticket = await f.ticket()
    expect((await f.request('/api/admin/support/' + ticket.publicRef)).status).toBe(200)
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
    expect((await f.request('/api/admin/support/' + ticket.publicRef)).status).toBe(403)
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(CLAIMS.sessionId)
    f.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='support.manage'")
    expect((await f.request('/api/admin/support')).status).toBe(403)
  })
  it('reads private admin timeline but never returns it through customer portal', async () => {
    const ticket = await f.ticket(),
      body = { action: 'note', expectedVersion: 1, reason: 'Nota interna', message: 'PRIVATE_INTERNAL_SENTINEL' }
    expect((await f.request('/api/admin/support/' + ticket.publicRef, 'PUT', body)).status).toBe(200)
    const admin = supportAdminTicketSchema.parse(
      await (await f.request('/api/admin/support/' + ticket.publicRef)).json()
    )
    expect(admin.timeline.some((event) => event.visibility === 'internal')).toBe(true)
    const customer = await f.request('/api/account/support/' + ticket.publicRef, 'GET', undefined, f.customerCookie)
    const raw = await customer.text()
    expect(raw).not.toContain('PRIVATE_INTERNAL_SENTINEL')
    expect(raw).not.toContain('requester')
  })
  it('rejects cross-origin writes before durable effects', async () => {
    const ticket = await f.ticket(),
      count = f.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()
    const response = await f.dispatch(
      new Request(ORIGIN + '/api/admin/support/' + ticket.publicRef, {
        method: 'PUT',
        headers: { origin: 'https://evil.example.test', cookie: f.adminCookie, 'content-type': 'application/json' },
        body: '{}'
      })
    )
    expect(response.status).toBe(403)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual(count)
  })
  it('rejects malformed bodies, extra owner claims, honeypot and privacy omission', async () => {
    for (const body of [
      { ...CONTACT, ownerId: CLAIMS.identityId },
      { ...CONTACT, privacyAcknowledged: false },
      { ...CONTACT, website: 'bot' }
    ]) {
      expect((await f.request('/api/support/tickets', 'POST', body, f.customerCookie)).status).toBe(422)
    }
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual({ n: 0 })
  })
  it('strict pagination forbids duplicate and unknown query parameters', async () => {
    for (const query of ['?page=1&page=2', '?perPage=51', '?owner=bad', '?includeInternal=true']) {
      expect((await f.request('/api/admin/support' + query)).status).toBe(422)
    }
  })
  it('adaptive challenge absent and failed verifiers block; no cookie-based identity', async () => {
    const cookie = await anonymousCookie()
    for (let index = 0; index < 2; index++)
      expect((await f.request('/api/support/tickets', 'POST', CONTACT, cookie)).status).toBe(201)
    expect((await f.request('/api/support/tickets', 'POST', CONTACT, cookie)).status).toBe(503)
    f.deps.challengeVerifier = vi.fn(async () => false)
    expect(
      (await f.request('/api/support/tickets', 'POST', { ...CONTACT, challengeToken: 'untrusted-token' }, cookie))
        .status
    ).toBe(403)
    f.deps.challengeVerifier = vi.fn(async () => true)
    const response = await f.request(
      '/api/support/tickets',
      'POST',
      { ...CONTACT, challengeToken: 'trusted-local-proof' },
      cookie
    )
    expect(response.status).toBe(201)
    expect(JSON.stringify(f.sqlite.prepare('SELECT input FROM support_commands').all())).not.toContain(
      'trusted-local-proof'
    )
    expect((await f.request('/api/support/tickets', 'POST', CONTACT, cookie)).status).toBe(429)
  })
  it('exact confirmed contact replay bypasses quota without replaying challenge', async () => {
    const cookie = await anonymousCookie(),
      key = crypto.randomUUID(),
      response = await f.request('/api/support/tickets', 'POST', CONTACT, cookie, key)
    const first = await response.json()
    f.sqlite.exec('UPDATE support_intake_limits SET used=6')
    const replay = await f.request('/api/support/tickets', 'POST', CONTACT, cookie, key)
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(first)
    expect(f.sqlite.prepare('SELECT used FROM support_intake_limits').get()).toEqual({ used: 6 })
  })
  it('explicit privacy policy missing returns review-required, never invented SLA', async () => {
    f.deps.policy = null
    const options = await f.request('/api/support/options', 'GET', undefined, '')
    expect(await options.json()).toMatchObject({ policy: null, privacyReviewRequired: true })
    const cookie = options.headers.get('set-cookie')!.split(';')[0]!
    expect((await f.request('/api/support/tickets', 'POST', CONTACT, cookie)).status).toBe(201)
    expect(f.sqlite.prepare('SELECT policy,retention_until,sla_due_at FROM support_tickets').get()).toEqual({
      policy: null,
      retention_until: null,
      sla_due_at: null
    })
  })
  it('invalid configured policy and private scanner absence fail closed', async () => {
    f.deps.policy = { ...f.deps.policy!, retentionDays: 0 }
    expect((await f.request('/api/support/options', 'GET', undefined, '')).status).toBe(503)
    expect((await f.request('/api/support/attachments/scan-receipts', 'POST', {})).status).toBe(503)
  })
  it('revoked verified session never downgrades to anonymous intake', async () => {
    const cookie = await anonymousCookie()
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
    expect((await f.request('/api/support/tickets', 'POST', CONTACT, f.customerCookie + '; ' + cookie)).status).toBe(
      401
    )
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_tickets').get()).toEqual({ n: 0 })
  })
  it('attachments disabled is explicit and captured before malformed multipart', async () => {
    const ticket = await f.ticket()
    const response = await f.request(
      '/api/account/support/' + ticket.publicRef + '/attachments',
      'POST',
      {},
      f.customerCookie
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'attachments_unavailable' } })
  })
})
