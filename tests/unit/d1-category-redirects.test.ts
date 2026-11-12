import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleD1CategoryRedirect } from '../../workers/catalog/category-redirects'
import { executeD1CatalogCategoryCommand } from '../../workers/catalog/admin-categories'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  ROOT_CATEGORY,
  CHILD_CATEGORY
} from '../support/category-command-fixture'
import { testUuid } from '../support/deterministic'

describe('direct public category aliases never reveal an ineligible target', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  const request = (path: string, method = 'GET') => new Request('https://categories.neteco.invalid' + path, { method })
  const rename = (name = 'Familia renovada', expectedVersion = 1) =>
    executeD1CatalogCategoryCommand(
      database,
      CATEGORY_CLAIMS,
      'update_category',
      { categoryId: '11' },
      { name, expectedVersion, reason: 'Renombrado público sintético' },
      { idempotencyKey: testUuid() }
    )
  it.each(['GET', 'HEAD'])(
    'returns private301 internal canonical URL on %s, preserving only bounded catalog query',
    async (method) => {
      await rename()
      const result = await handleD1CategoryRedirect(
        request(
          '/categoria/familia-hija?brand=Marca&medida=10%7C20&page=2&next=https%3A%2F%2Fhostile.invalid&token=private',
          method
        ),
        database
      )
      expect(result?.status).toBe(301)
      expect(result!.headers.get('location')).toBe('/categoria/familia-renovada?brand=Marca&medida=10%7C20&page=2')
      expect(result!.headers.get('cache-control')).toBe('private, no-store')
      expect(await result!.text()).toBe('')
    }
  )
  it('resolves every former slug straight to its current UUID slug, including rename reversal without loops', async () => {
    await rename()
    await rename('Familia final', 2)
    for (const slug of ['familia-hija', 'familia-renovada'])
      expect((await handleD1CategoryRedirect(request('/categoria/' + slug), database))!.headers.get('location')).toBe(
        '/categoria/familia-final'
      )
    await rename('Familia hija', 3)
    expect(await handleD1CategoryRedirect(request('/categoria/familia-hija'), database)).toBeNull()
    for (const slug of ['familia-renovada', 'familia-final'])
      expect((await handleD1CategoryRedirect(request('/categoria/' + slug), database))!.headers.get('location')).toBe(
        '/categoria/familia-hija'
      )
  })
  it('retains bounded campaign tracking but never echoes unknown, token or return URLs', async () => {
    await rename()
    const result = await handleD1CategoryRedirect(
      request(
        '/categoria/familia-hija?utm_source=local-audit&utm_medium=email&utm_campaign=verano&utm_term=limpieza&utm_content=boton&token=private&returnurl=https%3A%2F%2Fhostile.invalid&unknown=private'
      ),
      database
    )
    expect(result!.headers.get('location')).toBe(
      '/categoria/familia-renovada?utm_source=local-audit&utm_medium=email&utm_campaign=verano&utm_term=limpieza&utm_content=boton'
    )
    for (const query of ['?utm_source=a&utm_source=b', '?utm_campaign=%0A', '?utm_content=' + 'x'.repeat(2001)])
      expect((await handleD1CategoryRedirect(request('/categoria/familia-hija' + query), database))!.status).toBe(400)
  })
  it('supports one encoded ASCII slug spelling without accepting double encoding or namespaces', async () => {
    await rename()
    expect(
      (await handleD1CategoryRedirect(request('/categoria/familia%2Dhija'), database))!.headers.get('location')
    ).toBe('/categoria/familia-renovada')
    for (const path of [
      '/categoria/familia%252Dhija',
      '/categ%6Fria/familia-hija',
      '/categoria/familia%2Fhija',
      '/categoria/familia%0Dhija',
      '/categoria/%'
    ])
      expect((await handleD1CategoryRedirect(request(path), database))?.status).toBe(400)
  })
  it.each(['/producto/example', '/api/admin/categories', '/categorias/familia-hija'])(
    'does not touch D1 outside namespace %s',
    async (path) => {
      const prepare = vi.spyOn(database, 'prepare')
      expect(await handleD1CategoryRedirect(request(path), database)).toBeNull()
      expect(prepare).not.toHaveBeenCalled()
    }
  )
  it.each(['POST', 'PUT', 'DELETE'])('does not resolve mutation method %s', async (method) => {
    const prepare = vi.spyOn(database, 'prepare')
    expect(await handleD1CategoryRedirect(request('/categoria/familia-hija', method), database)).toBeNull()
    expect(prepare).not.toHaveBeenCalled()
  })
  it('passes canonical current or unknown slug to SSR without manufacturing404', async () => {
    expect(await handleD1CategoryRedirect(request('/categoria/familia-hija'), database)).toBeNull()
    expect(await handleD1CategoryRedirect(request('/categoria/not-an-alias'), database)).toBeNull()
  })
  it.each(['draft', 'review', 'hidden', 'discontinued'])(
    'does not reveal alias target when target is %s',
    async (status) => {
      await rename()
      sqlite.prepare('UPDATE categories SET status=? WHERE id=?').run(status, CHILD_CATEGORY)
      expect(await handleD1CategoryRedirect(request('/categoria/familia-hija'), database)).toBeNull()
    }
  )
  it.each(['draft', 'review', 'hidden', 'discontinued'])(
    'does not reveal alias target when ancestor is %s',
    async (status) => {
      await rename()
      sqlite.prepare('UPDATE categories SET status=? WHERE id=?').run(status, ROOT_CATEGORY)
      expect(await handleD1CategoryRedirect(request('/categoria/familia-hija'), database)).toBeNull()
    }
  )
  it('requires complete mapped root ancestry and rejects cycles rather than looping', async () => {
    await rename()
    sqlite.prepare('UPDATE categories SET legacy_id=NULL WHERE id=?').run(ROOT_CATEGORY)
    expect(await handleD1CategoryRedirect(request('/categoria/familia-hija'), database)).toBeNull()
    sqlite.prepare('UPDATE categories SET legacy_id=10,parent_id=? WHERE id=?').run(CHILD_CATEGORY, ROOT_CATEGORY)
    expect(await handleD1CategoryRedirect(request('/categoria/familia-hija'), database)).toBeNull()
  })
  it.each(['?page=1&page=2', '?brand=%0D%0A', '?brand=' + 'x'.repeat(2001)])(
    'rejects unsafe known query without emitting Location: %s',
    async (query) => {
      await rename()
      const response = await handleD1CategoryRedirect(request('/categoria/familia-hija' + query), database)
      expect(response?.status).toBe(400)
      expect(response!.headers.has('location')).toBe(false)
    }
  )
  it('sanitizes a D1 outage rather than hiding it behind null/404 or exposing raw error', async () => {
    const wrapped = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return () => {
            throw new Error('SQL private_table provider_secret owner@example.invalid')
          }
        return Reflect.get(target, key, receiver)
      }
    })
    await expect(handleD1CategoryRedirect(request('/categoria/familia-hija'), wrapped)).rejects.toThrow(
      /^category_redirect_unavailable$/
    )
  })
})
