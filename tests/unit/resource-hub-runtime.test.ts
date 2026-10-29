import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { environment } from '../support/customer-operations-fixture'
import { resourceHubFixture } from './resource-hub-fixture'

describe('public resource hub actual Worker integration', () => {
  it('uses the governed CMS public reader without enabling account authentication', async () => {
    const f = await resourceHubFixture()
    try {
      const send = vi.fn()
      const env = environment({
        DB: f.database,
        CMS_PUBLICATION_ENABLED: 'true',
        AUTH_ENABLED: 'false',
        NEWSLETTER_EMAIL: { send }
      })
      const result = await worker.fetch(new Request(env.AUTH_ORIGIN + '/api/resources'), env)
      expect(result.status).toBe(200)
      expect(result.headers.get('cache-control')).toContain('no-store')
      expect(await result.json()).toMatchObject({ source: 'cloudflare', items: [], total: 0 })
      expect(send).not.toHaveBeenCalled()
    } finally {
      f.sqlite.close()
    }
  })

  it('keeps the exact namespace unavailable while publication is disabled without reading D1', async () => {
    const env = environment({ CMS_PUBLICATION_ENABLED: 'false' })
    const result = await worker.fetch(new Request(env.AUTH_ORIGIN + '/api/resources'), env)
    expect(result.status).toBe(503)
    expect(result.headers.get('referrer-policy')).toBe('no-referrer')
    expect(result.headers.get('cache-control')).toContain('no-store')
    expect(await result.json()).toEqual({ error: { code: 'content_unavailable' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it.each([
    '/API/resources',
    '/api/%72esources',
    '/api/%2572esources',
    '/api/resources%2fexample',
    '/api/resources%252fexample',
    '/api/resources%5cexample',
    '/api/resources%ZZ'
  ])('owns but rejects noncanonical alias %s before any legacy fallback', async (path) => {
    const env = environment({ CMS_PUBLICATION_ENABLED: 'false' })
    const result = await worker.fetch(new Request(env.AUTH_ORIGIN + path), env)
    expect(result.status).toBe(404)
    expect(result.headers.get('referrer-policy')).toBe('no-referrer')
    expect(result.headers.get('cache-control')).toContain('no-store')
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('does not silently replace an enabled reader outage with a successful empty list', async () => {
    const prepare = vi.fn(() => {
      throw new Error('synthetic_resource_source_outage')
    })
    const env = environment({ CMS_PUBLICATION_ENABLED: 'true', DB: { prepare, batch: vi.fn() } })
    const result = await worker.fetch(new Request(env.AUTH_ORIGIN + '/api/resources'), env)
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'content_unavailable' } })
  })
})
