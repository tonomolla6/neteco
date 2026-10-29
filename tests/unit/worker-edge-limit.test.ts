import { describe, expect, it, vi } from 'vitest'
import { checkAdministrativeEdgeLimit } from '../../workers/auth/edge-limit'

const pepper = 'test-only-edge-pepper-at-least-32-characters'
function request(address?: string, forwarded = '198.51.100.99') {
  return new Request('https://neteco.invalid/api/admin/media', {
    headers: {
      ...(address ? { 'cf-connecting-ip': address } : {}),
      'x-forwarded-for': forwarded
    }
  })
}

describe('administrative pre-authentication edge limiter', () => {
  it('uses a stable keyed hash, never the raw IP or forwarded value', async () => {
    const limiter = { limit: vi.fn(async () => ({ success: true })) }
    expect(await checkAdministrativeEdgeLimit(request('192.0.2.1'), limiter, pepper)).toBe('allowed')
    expect(await checkAdministrativeEdgeLimit(request('192.0.2.1', '203.0.113.9'), limiter, pepper)).toBe('allowed')
    expect(limiter.limit.mock.calls[0]).toEqual(limiter.limit.mock.calls[1])
    const first = JSON.stringify(limiter.limit.mock.calls[0])
    expect(first).toMatch(/[0-9a-f]{64}/)
    expect(first).not.toContain('192.0.2.1')
    await checkAdministrativeEdgeLimit(request('192.0.2.1'), limiter, `${pepper}-rotated`)
    expect(limiter.limit.mock.calls[2]).not.toEqual(limiter.limit.mock.calls[0])
  })

  it('canonicalizes equivalent IPv6 addresses', async () => {
    const limiter = { limit: vi.fn(async () => ({ success: true })) }
    await checkAdministrativeEdgeLimit(request('2001:0DB8:0:0:0:0:0:1'), limiter, pepper)
    await checkAdministrativeEdgeLimit(request('2001:db8::1'), limiter, pepper)
    expect(limiter.limit).toHaveBeenCalledTimes(2)
    expect(limiter.limit.mock.calls[0]).toEqual(limiter.limit.mock.calls[1])
  })

  it('keeps returns and order scopes in distinct stable HMAC partitions', async () => {
    const subjects: string[] = []
    const limiter = {
      limit: vi.fn(async ({ key }: { key: string }) => {
        subjects.push(key)
        return { success: true }
      })
    }
    const scopes = ['admin-returns', 'customer-returns', 'admin-orders'] as const
    for (const scope of scopes) {
      expect(await checkAdministrativeEdgeLimit(request('192.0.2.1'), limiter, pepper, scope)).toBe('allowed')
    }
    expect(subjects).toHaveLength(3)
    expect(new Set(subjects).size).toBe(3)
    for (const subject of subjects) expect(subject).toMatch(/^[0-9a-f]{64}$/)
    for (const scope of scopes) {
      expect(await checkAdministrativeEdgeLimit(request('192.0.2.1'), limiter, pepper, scope)).toBe('allowed')
    }
    expect(subjects.slice(3)).toEqual(subjects.slice(0, 3))
  })

  it.each([undefined, 'garbage', '999.1.1.1', '192.0.2.1, 192.0.2.2', '::1%eth0', '::ffff:999.1.1.1'])(
    'fails closed for missing or invalid trusted addresses: %s',
    async (address) => {
      const limiter = { limit: vi.fn(async () => ({ success: true })) }
      expect(await checkAdministrativeEdgeLimit(request(address), limiter, pepper)).toBe('unavailable')
      expect(limiter.limit).not.toHaveBeenCalled()
    }
  )

  it('honors denials and fails closed on outages or missing secrets', async () => {
    expect(
      await checkAdministrativeEdgeLimit(request('192.0.2.1'), { limit: async () => ({ success: false }) }, pepper)
    ).toBe('limited')
    expect(
      await checkAdministrativeEdgeLimit(
        request('192.0.2.1'),
        {
          limit: async () => {
            throw new Error('offline')
          }
        },
        pepper
      )
    ).toBe('unavailable')
    const limiter = { limit: vi.fn(async () => ({ success: true })) }
    expect(await checkAdministrativeEdgeLimit(request('192.0.2.1'), limiter, '')).toBe('unavailable')
    expect(limiter.limit).not.toHaveBeenCalled()
  })
})
