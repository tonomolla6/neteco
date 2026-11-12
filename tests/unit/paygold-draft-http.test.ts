import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handlePayGoldDraftHttp, PAYGOLD_DRAFT_PATH } from '../../workers/payments/paygold-draft-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { BUYER_CLAIMS, returnsFixture } from './d1-returns-fixture'
import { utc } from './pay-ext-fixture'
import worker from '../../workers/canary'
import { testUuid } from '../support/deterministic'

const origin = 'https://account.example.invalid'
const configuration = { password: 'synthetic-draft-link-cookie-password-over-32-chars', maxAgeSeconds: 3600 }
const draftId = '50000000-0000-4000-8000-0000000000d1'
const orderId = '60000000-0000-4000-8000-0000000000d1'
const token = 'c'.repeat(64)
let cookie: string
let fixture: Awaited<ReturnType<typeof returnsFixture>>
const issue = vi.fn()
beforeEach(async () => {
  fixture = await returnsFixture()
  cookie = (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  issue.mockReset()
  issue.mockImplementation(async (_c: unknown, input: { draftId: string; orderId: string; expiresAt: string }) => ({
    draftId: input.draftId,
    orderId: input.orderId,
    paymentIntentId: testUuid(),
    amountCents: 1234,
    expiresAt: input.expiresAt,
    url: 'https://paygold.example.invalid/link/abc'
  }))
})
const body = () => ({ draftId, expectedVersion: 3, orderId, commandId: testUuid(), expiresAt: utc(600_000) })
const make = (
  over: { b?: unknown; headers?: Record<string, string>; method?: string; order?: string | null; path?: string } = {}
) => {
  const b = (over.b ?? body()) as { commandId: string }
  return new Request(`${origin}${over.path ?? PAYGOLD_DRAFT_PATH}`, {
    method: over.method ?? 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'idempotency-key': b.commandId,
      cookie: `${cookie}${over.order === null ? '' : `; neteco-order-access-v2=v1.${orderId}.${token}`}`,
      ...over.headers
    },
    body: over.method === 'GET' ? undefined : JSON.stringify(b)
  })
}
const deps = () => ({
  database: fixture.database,
  origin,
  sessionCookieConfiguration: configuration,
  now: () => utc(),
  issue
})

describe('draft PayGold HTTP', () => {
  it('issues a link for a verified session and order cookie without echoing the order credential', async () => {
    const res = (await handlePayGoldDraftHttp(make(), deps()))!
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(JSON.stringify(await res.json())).not.toContain(token)
    expect(issue).toHaveBeenCalledWith(BUYER_CLAIMS, expect.objectContaining({ draftId, orderId, orderToken: token }))
  })
  it('rejects foreign origins, cross-site requests, missing sessions and missing order credentials', async () => {
    expect((await handlePayGoldDraftHttp(make({ headers: { origin: 'https://evil.example' } }), deps()))!.status).toBe(
      403
    )
    expect((await handlePayGoldDraftHttp(make({ headers: { 'sec-fetch-site': 'cross-site' } }), deps()))!.status).toBe(
      403
    )
    expect((await handlePayGoldDraftHttp(make({ headers: { cookie: '' } }), deps()))!.status).toBe(401)
    expect((await handlePayGoldDraftHttp(make({ order: null }), deps()))!.status).toBe(401)
    expect(issue).not.toHaveBeenCalled()
  })
  it('validates content type, idempotency header, unknown fields and size', async () => {
    expect((await handlePayGoldDraftHttp(make({ headers: { 'content-type': 'text/plain' } }), deps()))!.status).toBe(
      415
    )
    expect((await handlePayGoldDraftHttp(make({ headers: { 'idempotency-key': testUuid() } }), deps()))!.status).toBe(
      400
    )
    expect((await handlePayGoldDraftHttp(make({ b: { ...body(), amountCents: 1 } }), deps()))!.status).toBe(400)
    expect((await handlePayGoldDraftHttp(make({ b: { ...body(), pad: 'x'.repeat(5000) } }), deps()))!.status).toBe(413)
    expect((await handlePayGoldDraftHttp(make({ method: 'GET' }), deps()))!.status).toBe(405)
    expect(issue).not.toHaveBeenCalled()
  })
  it('does not leak domain failures and treats a malformed provider result as unavailable', async () => {
    const { PayGoldError } = await import('../../workers/payments/paygold-links')
    issue.mockRejectedValueOnce(new PayGoldError('not_payable'))
    expect((await handlePayGoldDraftHttp(make(), deps()))!.status).toBe(409)
    issue.mockRejectedValueOnce(new Error('sql: secret detail'))
    const res = (await handlePayGoldDraftHttp(make(), deps()))!
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    issue.mockResolvedValueOnce({ draftId, orderId, extra: 1 })
    expect((await handlePayGoldDraftHttp(make(), deps()))!.status).toBe(503)
  })
  it('ignores other paths', async () => {
    expect(await handlePayGoldDraftHttp(make({ path: '/api/account/paygold-links' }), deps())).toBeNull()
  })
})

describe('worker mount', () => {
  it('owns the draft route even though the quote handler would return 404 for it', async () => {
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: configuration.password,
      DB: { prepare: vi.fn() }
    } as unknown as CloudflareEnv
    const res = await worker.fetch(new Request(`${origin}${PAYGOLD_DRAFT_PATH}`, { method: 'POST' }), env)
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toContain('private')
  })
})
