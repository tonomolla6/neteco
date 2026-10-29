import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resourceHubFixture } from './resource-hub-fixture'
import { handleResourceHubHttp } from '../../workers/content/resource-hub-http'
describe('resource hub public HTTP boundaries', () => {
  let f: Awaited<ReturnType<typeof resourceHubFixture>>
  beforeEach(async () => {
    f = await resourceHubFixture()
  })
  afterEach(() => f.sqlite.close())
  const call = (path: string, init?: RequestInit) =>
    handleResourceHubHttp(new Request(`https://cms.neteco.invalid${path}`, init), f.deps)
  it('serves a public empty hub without authentication or domain mutations', async () => {
    const before = f.sqlite.prepare('SELECT count(*) n FROM content_publications').get()
    const r = (await call('/api/resources'))!
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ source: 'cloudflare', items: [] })
    expect(f.sqlite.prepare('SELECT count(*) n FROM content_publications').get()).toEqual(before)
  })
  it('returns canonical resource metadata from the actual published CMS version', async () => {
    await f.resource({ slug: 'recurso-http' })
    const r = (await call('/api/resources/recurso-http'))!
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ canonicalPath: '/recursos/recurso-http', preview: false })
  })
  it('rejects non-read methods without accepting a preview token or duplicate query', async () => {
    expect((await call('/api/resources', { method: 'POST' }))!.status).toBe(405)
    expect((await call('/api/resources?preview=secret'))!.status).toBe(400)
    expect((await call('/api/resources?q=a&q=b'))!.status).toBe(400)
  })
  it('owns encoded and case aliases but never serves them or falls through', async () => {
    for (const path of ['/API/resources', '/api/%72esources', '/api/resources/invalid%2Fslug'])
      expect((await call(path))!.status).toBe(404)
    expect(await call('/api/unrelated')).toBeNull()
  })
  it('returns opaque unavailable errors with private no-store and no-referrer', async () => {
    const broken = new Proxy(f.database, {
      get() {
        throw new Error('private SQL credential')
      }
    })
    const r = (await handleResourceHubHttp(new Request('https://cms.neteco.invalid/api/resources'), {
      ...f.deps,
      database: broken
    }))!
    expect(r.status).toBe(503)
    expect(r.headers.get('cache-control')).toContain('no-store')
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await r.text()).not.toContain('private SQL credential')
  })
})
