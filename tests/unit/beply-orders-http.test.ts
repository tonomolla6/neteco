import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleBeplyOrdersRequest, ownsBeplyOrdersNamespace } from '../../workers/integrations/beply-orders-http'
const { verify, read, retry } = vi.hoisted(() => ({ verify: vi.fn(), read: vi.fn(), retry: vi.fn() }))
vi.mock('../../workers/auth/session-cookie', () => ({ verifySessionCookie: verify }))
vi.mock('../../workers/integrations/beply-orders', async (original) => {
  const actual = await original<typeof import('../../workers/integrations/beply-orders')>()
  return { ...actual, readBeplyOrder: read, retryBeplyOrder: retry }
})
const id = '10000000-0000-4000-8000-000000000010'
const deps = {
  database: {} as D1Database,
  origin: 'https://shop.example.invalid',
  sessionCookieConfiguration: { maxAgeSeconds: 3600, password: 'synthetic-cookie-key-at-least-32-chars' },
  now: () => '2026-11-12T10:00:00Z'
}
const claims = { identityId: id, sessionId: id, sessionVersion: 1 }
const path = `/api/orders/${id}/beply`
const request = (pathname = path, init: RequestInit = {}) => new Request(`${deps.origin}${pathname}`, init)
beforeEach(() => {
  vi.clearAllMocks()
  verify.mockResolvedValue(claims)
  read.mockResolvedValue({ orderId: id, state: 'shipped' })
  retry.mockResolvedValue({ version: 2 })
})
describe('Beply account/admin HTTP boundary', () => {
  it.each(['', 'admin/'])('rejects another request host before auth or order reads for %s', async (prefix) => {
    const response = await handleBeplyOrdersRequest(
      new Request(`https://alternate.invalid/api/${prefix}orders/${id}/beply`),
      deps
    )
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: { code: 'csrf_rejected' } })
    expect(verify).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })
  it('accounts for time spent awaiting cookie verification before the D1 authorization boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(deps.now()))
    try {
      verify.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(Date.parse(deps.now()) + 2000))
        return claims
      })
      expect((await handleBeplyOrdersRequest(request(), deps))?.status).toBe(200)
      expect(read).toHaveBeenCalledWith(deps.database, { kind: 'customer', claims }, id, '2026-11-12T10:00:02Z')
    } finally {
      vi.useRealTimers()
    }
  })
  it('exports namespace ownership for rate limiting before the handler reads D1', () => {
    expect(ownsBeplyOrdersNamespace(path)).toBe(true)
    expect(ownsBeplyOrdersNamespace(`/api/orders/${id}/%2562eply`)).toBe(true)
    expect(ownsBeplyOrdersNamespace('/api/orders')).toBe(false)
  })
  it('claims only the assigned routes and returns a private authorized customer view', async () => {
    expect(await handleBeplyOrdersRequest(request('/api/orders'), deps)).toBeNull()
    const response = await handleBeplyOrdersRequest(request(), deps)
    expect(response?.status).toBe(200)
    expect(response?.headers.get('cache-control')).toBe('private, no-store')
    expect(read).toHaveBeenCalledWith(deps.database, { kind: 'customer', claims }, id, deps.now())
  })
  it('delegates admin authority to the live D1 authorization boundary', async () => {
    await handleBeplyOrdersRequest(request(`/api/admin/orders/${id}/beply`), deps)
    expect(read).toHaveBeenCalledWith(deps.database, { kind: 'admin', claims }, id, deps.now())
    read.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { code: 'forbidden' }))
    const response = await handleBeplyOrdersRequest(request(), deps)
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: { code: 'forbidden' } })
  })
  it('owns encoded aliases so they cannot fall through to another backend', async () => {
    for (const pathname of [`/api/orders/${id}/%62eply`, `/api/orders/${id}/beply/unknown`]) {
      expect((await handleBeplyOrdersRequest(request(pathname), deps))?.status).toBe(404)
    }
    expect(read).not.toHaveBeenCalled()
  })
  it('rejects unauthenticated requests without reading orders', async () => {
    verify.mockResolvedValue(null)
    expect((await handleBeplyOrdersRequest(request(), deps))?.status).toBe(401)
    expect(read).not.toHaveBeenCalled()
  })
  it.each([
    [`/api/orders/${id}/beply?other=1`, {}, 400],
    [path, { method: 'DELETE' }, 405],
    [path, { headers: { Origin: 'https://attacker.invalid' } }, 403],
    [path, { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
    ['/api/orders/not-an-id/beply', {}, 404]
  ])('rejects malformed or cross origin read %s', async (pathname, init, status) => {
    expect((await handleBeplyOrdersRequest(request(pathname, init), deps))?.status).toBe(status)
    expect(read).not.toHaveBeenCalled()
  })
  it('validates and passes an idempotent admin retry with the expected version', async () => {
    const input = { commandId: 'retry1', expectedVersion: 1, reason: 'Synthetic operator retry' }
    const response = await handleBeplyOrdersRequest(
      request(`/api/admin/orders/${id}/beply/retry`, {
        method: 'POST',
        headers: { Origin: deps.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      }),
      deps
    )
    expect(response?.status).toBe(202)
    expect(retry).toHaveBeenCalledWith(deps.database, claims, id, input, deps.now())
  })
  it('rejects oversized/unknown retry properties, CSRF and provider error details', async () => {
    const target = `/api/admin/orders/${id}/beply/retry`
    expect((await handleBeplyOrdersRequest(request(target, { method: 'POST' }), deps))?.status).toBe(403)
    for (const body of [
      'x'.repeat(20000),
      JSON.stringify({ commandId: 'retry1', expectedVersion: 1, reason: 'A valid reason', extra: true })
    ]) {
      expect(
        (
          await handleBeplyOrdersRequest(
            request(target, {
              method: 'POST',
              headers: { Origin: deps.origin, 'Content-Type': 'application/json' },
              body
            }),
            deps
          )
        )?.status
      ).toBeGreaterThanOrEqual(400)
    }
    expect(retry).not.toHaveBeenCalled()
    read.mockRejectedValue(new Error('Token secret; customer@example.invalid'))
    const response = await handleBeplyOrdersRequest(request(), deps)
    expect(response?.status).toBe(503)
    expect(await response?.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
})
