import { afterEach, beforeEach, expect, it } from 'vitest'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { handlePromotionalContentHttp } from '../../workers/cms/promotional-content-http'
let f: Awaited<ReturnType<typeof cmsPublicationFixture>>
beforeEach(async () => {
  f = await cmsPublicationFixture()
})
afterEach(() => f?.sqlite.close())
const url = 'https://shop.neteco.invalid/api/promotional-content'
it('serves an explicitly empty public selection privately without auth or writes', async () => {
  const response = await handlePromotionalContentHttp(new Request(`${url}?placement=home&path=%2F`), f.deps)
  expect(response?.status).toBe(200)
  expect(response?.headers.get('cache-control')).toBe('private, no-store')
  expect(response?.headers.has('set-cookie')).toBe(false)
  expect(await response?.json()).toMatchObject({ source: 'cloudflare', placement: 'home', items: [] })
})
it('rejects method before database access and declares Allow GET', async () => {
  const deps = {
    ...f.deps,
    database: {
      ...f.database,
      prepare() {
        throw Error('must_not_read')
      }
    } as D1Database
  }
  const response = await handlePromotionalContentHttp(new Request(url, { method: 'POST' }), deps)
  expect(response?.status).toBe(405)
  expect(response?.headers.get('allow')).toBe('GET')
})
it.each([
  'placement=home&path=%2F&preview=secret',
  'placement=home&path=%2F&placement=home',
  'placement=home&path=%2Fcuenta'
])('rejects noncanonical context %s', async (query) => {
  expect((await handlePromotionalContentHttp(new Request(`${url}?${query}`), f.deps))?.status).toBe(400)
})
