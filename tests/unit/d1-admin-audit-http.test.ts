import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { adminAuditFixture, ADMIN, RECIPIENT } from './d1-admin-audit-fixture'
import {
  adminAuditListSchema,
  adminAuditDetailSchema,
  adminAuditReceiptSchema,
  adminAuditIntentHash,
  adminAuditHash,
  ADMIN_AUDIT_EXPORT_HEADERS,
  ADMIN_AUDIT_EXPORT_CONTENT_TYPE
} from '../../shared/admin-audit'
import { testUuid } from '../support/deterministic'

const ORIGIN = 'https://audit.neteco.test'
describe('ADM005 actual canary HTTP with real D1 administrative command evidence', () => {
  let f: Awaited<ReturnType<typeof adminAuditFixture>>
  let eventId: string
  let env: CloudflareEnv
  beforeEach(async () => {
    f = await adminAuditFixture()
    eventId = (await f.source()).id
    env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      EMAIL_ENABLED: 'false',
      DB: f.database,
      AUTH_ORIGIN: ORIGIN,
      NUXT_SESSION_PASSWORD: f.configuration.password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-admin-audit-http-rate-pepper-32',
      AUTH_TOKEN_PEPPER: 'synthetic-admin-audit-http-token-pepper-32',
      AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) }
    } as unknown as CloudflareEnv
  })
  afterEach(() => {
    f?.sqlite.close()
    vi.restoreAllMocks()
  })
  async function send(
    path = '/api/admin/audit',
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
    claims = ADMIN,
    environment = env
  ) {
    return worker.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          cookie: headers.cookie ?? (await f.cookie(claims)),
          'CF-Connecting-IP': '192.0.2.85',
          ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      }),
      environment
    )
  }
  function privateResponse(response: Response) {
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
    expect(response.headers.get('set-cookie')).toBeNull()
  }
  it('reads exact source evidence with GET without Origin, bounded list and redacted detail', async () => {
    const response = await send('/api/admin/audit?family=admin_invitation&limit=1')
    expect(response.status).toBe(200)
    privateResponse(response)
    const list = adminAuditListSchema.parse(await response.json())
    expect(list.items.map((item) => item.id)).toEqual([eventId])
    const detail = await send('/api/admin/audit/' + encodeURIComponent(eventId))
    expect(detail.status).toBe(200)
    const value = adminAuditDetailSchema.parse(await detail.json())
    expect(value.item).toMatchObject({ id: eventId, family: 'admin_invitation', reason: 'redacted' })
    expect(JSON.stringify(value)).not.toContain(f.input.recipientEmail)
    expect(JSON.stringify(value)).not.toContain(f.input.tokenHash)
    expect(JSON.stringify(value)).not.toContain(f.input.reason)
  })
  it('reviews explicitly once, replays the exact receipt and recovers through GET without repeating the write', async () => {
    const input = {
      expectedVersion: 0,
      disposition: 'reviewed',
      reason: 'Revisión administrativa sintética confirmada.'
    }
    const key = testUuid(),
      path = '/api/admin/audit/' + eventId + '/reviews'
    const response = await send(path, 'POST', input, { 'Idempotency-Key': key })
    expect(response.status).toBe(201)
    privateResponse(response)
    const receipt = adminAuditReceiptSchema.parse(await response.json())
    const hash = await adminAuditIntentHash('review', eventId, input)
    expect(receipt).toMatchObject({ action: 'review', commandId: key, eventId, version: 1, payloadHash: hash })
    expect(await (await send(path, 'POST', input, { 'Idempotency-Key': key })).json()).toEqual(receipt)
    const recovered = await send(`/api/admin/audit/commands/${key}?payloadHash=${hash}`)
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    const detail = adminAuditDetailSchema.parse(await (await send('/api/admin/audit/' + eventId)).json())
    expect(detail.reviews).toHaveLength(1)
    expect(detail.item.reviewVersion).toBe(1)
    expect(JSON.stringify(detail)).not.toContain(input.reason)
  })
  it('creates a governed export receipt then downloads exact bounded private CSV without a new command', async () => {
    const input = {
      filters: { family: 'admin_invitation' },
      reason: 'Exportación administrativa sintética confirmada.'
    }
    const key = testUuid()
    const response = await send('/api/admin/audit/exports', 'POST', input, { 'Idempotency-Key': key })
    expect(response.status).toBe(201)
    const receipt = adminAuditReceiptSchema.parse(await response.json())
    expect(receipt.action).toBe('export')
    if (receipt.action !== 'export') throw new Error('Expected export receipt')
    expect(receipt).toMatchObject({
      commandId: key,
      rows: 1,
      payloadHash: await adminAuditIntentHash('export', null, input)
    })
    const download = await send(`/api/admin/audit/exports/${key}/download`)
    expect(download.status).toBe(200)
    privateResponse(download)
    expect(download.headers.get('content-type')).toBe(ADMIN_AUDIT_EXPORT_CONTENT_TYPE)
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="neteco-admin-audit.csv"')
    const bytes = new Uint8Array(await download.arrayBuffer())
    const csv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    expect([...bytes.slice(0, 3)]).toEqual([239, 187, 191])
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(bytes.byteLength).toBe(receipt.bytes)
    expect(await adminAuditHash(csv)).toBe(receipt.digest)
    expect(download.headers.get(ADMIN_AUDIT_EXPORT_HEADERS.rows)).toBe('1')
    expect(download.headers.get(ADMIN_AUDIT_EXPORT_HEADERS.bytes)).toBe(String(receipt.bytes))
    expect(download.headers.get(ADMIN_AUDIT_EXPORT_HEADERS.digest)).toBe(receipt.digest)
    expect(csv).not.toContain(f.input.recipientEmail)
    expect(csv).not.toContain(f.input.tokenHash)
    expect(csv).not.toContain(input.reason)
    const recovered = await send(`/api/admin/audit/commands/${key}?payloadHash=${receipt.payloadHash}`)
    expect(await recovered.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(await (await send('/api/admin/audit/exports', 'POST', input, { 'Idempotency-Key': key })).json()).toEqual(
      receipt
    )
  })
  it('denies anonymous, non-administrator and revoked MFA enrollment rather than showing empty history', async () => {
    expect((await send(undefined, 'GET', undefined, { cookie: '' })).status).toBe(401)
    expect((await send(undefined, 'GET', undefined, {}, RECIPIENT)).status).toBe(403)
    const cookie = await f.cookie()
    f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(ADMIN.identityId)
    const response = await send(undefined, 'GET', undefined, { cookie })
    expect(response.status).toBe(403)
    privateResponse(response)
    expect(await response.json()).toEqual({ error: { code: 'mfa_required' } })
  })
  it('owns aliases and methods fail-closed and rejects unknown/repeated filter transport', async () => {
    const method = await send(undefined, 'DELETE')
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('GET')
    for (const path of ['/API/admin/audit', '/api/admin/%61udit', '/api/admin/audit/', '/api/admin/audit/export.csv'])
      expect((await send(path)).status).toBe(404)
    for (const query of ['unexpected=1', 'family=inventory&family=support', 'limit=26', 'cursor=***'])
      expect((await send('/api/admin/audit?' + query)).status).toBe(422)
  })
  it('rejects cross-origin and alternate-host reads without touching D1', async () => {
    const cookie = await f.cookie()
    const prepare = vi.spyOn(f.database, 'prepare')
    const response = await worker.fetch(
      new Request('https://foreign.invalid/api/admin/audit', {
        headers: { cookie, 'CF-Connecting-IP': '192.0.2.85' }
      }),
      env
    )
    expect(response.status).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
    const rejected = await send('/api/admin/audit/exports', 'POST', {}, { cookie, origin: 'https://foreign.invalid' })
    expect(rejected.status).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
  })
  it('applies edge denial before cookie or database and returns private errors', async () => {
    const cookie = await f.cookie()
    const prepare = vi.spyOn(f.database, 'prepare')
    const limit = vi.fn(async () => ({ success: false }))
    const response = await worker.fetch(
      new Request(ORIGIN + '/api/admin/audit', {
        headers: { cookie, 'CF-Connecting-IP': '192.0.2.85' }
      }),
      { ...env, ADMIN_EDGE_LIMIT: { limit } } as CloudflareEnv
    )
    expect(response.status).toBe(429)
    expect(limit).toHaveBeenCalledOnce()
    expect(prepare).not.toHaveBeenCalled()
    privateResponse(response)
  })
  it('does not turn database outages into empty lists or successful exports', async () => {
    const cookie = await f.cookie()
    const unavailable = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('synthetic database outage')
        }
      }
    } as unknown as CloudflareEnv
    const response = await worker.fetch(
      new Request(ORIGIN + '/api/admin/audit', {
        headers: { cookie, 'CF-Connecting-IP': '192.0.2.85' }
      }),
      unavailable
    )
    expect(response.status).toBe(503)
    privateResponse(response)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
})
