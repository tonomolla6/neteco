import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invitationFixture, ADMIN, RECIPIENT, FOREIGN, ORIGIN } from './d1-admin-invitations-fixture'
import { handleAdminInvitationsHttp } from '../../workers/auth/admin-invitations-http'
import { adminInvitationIntentHash } from '../../shared/admin-invitations'

describe('ADM-004 real D1 invitation HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof invitationFixture>>
  beforeEach(async () => {
    f = await invitationFixture()
  })
  afterEach(() => f.sqlite.close())
  async function request(
    path = '/api/admin/invitations',
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
    claims = ADMIN
  ) {
    return (await handleAdminInvitationsHttp(
      new Request(ORIGIN + path, {
        method,
        headers: {
          cookie: await f.cookie(claims),
          origin: ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      }),
      f.deps
    ))!
  }
  it('lists delegation-bounded metadata and applies private no-store/no-referrer', async () => {
    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ source: 'cloudflare', items: [], roles: expect.any(Array) })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })
  it('creates once and retrieves an exact actor-bound receipt through manual GET', async () => {
    const key = crypto.randomUUID(),
      response = await request(undefined, 'POST', f.input, { 'idempotency-key': key })
    expect(response.status).toBe(201)
    const receipt = await response.json()
    const hash = await adminInvitationIntentHash('create', null, f.input)
    const recovered = await request('/api/admin/invitations/commands/' + key + '?payloadHash=' + hash)
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(JSON.stringify(receipt)).not.toContain(f.input.tokenHash)
  })
  it('previews without mutation and accepts with a cleared old session cookie', async () => {
    expect((await request(undefined, 'POST', f.input)).status).toBe(201)
    const result = await request('/api/account/invitations/preview', 'POST', { token: f.token }, {}, RECIPIENT)
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ roleCode: 'support', permissions: ['support.manage'] })
    const response = await request('/api/account/invitations/accept', 'POST', { token: f.token }, {}, RECIPIENT)
    expect(response.status).toBe(201)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await response.json()).toMatchObject({ action: 'accept', sessionRevoked: true })
  })
  it('denies foreign recipient, anonymous access and non-administrative issuers', async () => {
    expect((await request(undefined, 'POST', f.input)).status).toBe(201)
    expect((await request('/api/account/invitations/preview', 'POST', { token: f.token }, {}, FOREIGN)).status).toBe(
      409
    )
    expect((await request(undefined, 'GET', undefined, { cookie: '' })).status).toBe(401)
    expect((await request(undefined, 'GET', undefined, {}, RECIPIENT)).status).toBe(403)
  })
  it('rejects cross-origin, unexpected fields, token query and invalid keys before writes', async () => {
    expect((await request(undefined, 'POST', f.input, { origin: 'https://foreign.invalid' })).status).toBe(403)
    expect((await request(undefined, 'POST', { ...f.input, role: 'admin' })).status).toBe(422)
    expect(
      (await request('/api/account/invitations/preview?token=' + f.token, 'POST', { token: f.token }, {}, RECIPIENT))
        .status
    ).toBe(422)
    expect((await request(undefined, 'POST', f.input, { 'idempotency-key': 'not-a-uuid' })).status).toBe(422)
  })
  it('bounds body and methods and consumes aliases without fallback', async () => {
    expect((await request(undefined, 'POST', { ...f.input, reason: 'x'.repeat(17000) })).status).toBe(413)
    expect((await request(undefined, 'DELETE')).status).toBe(405)
    for (const path of ['/API/admin/invitations', '/api/admin/invitations/', '/api/admin/invi%74ations'])
      expect((await request(path)).status).toBe(404)
  })
  it('fails closed on an unavailable edge gate or D1, never as empty history', async () => {
    const req = new Request(ORIGIN + '/api/admin/invitations', { headers: { cookie: await f.cookie() } })
    expect((await handleAdminInvitationsHttp(req, { ...f.deps, edgeGate: async () => 'unavailable' }))?.status).toBe(
      503
    )
    const db = {
      prepare: () => {
        throw new Error('synthetic outage')
      }
    } as unknown as D1Database
    expect((await handleAdminInvitationsHttp(req, { ...f.deps, database: db }))?.status).toBe(503)
  })
  it('honours live MFA/enrollment and email verification even when the cookie is unchanged', async () => {
    f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(ADMIN.identityId)
    expect((await request()).status).toBe(403)
    f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(ADMIN.identityId)
    expect((await request()).status).toBe(403)
  })
})
