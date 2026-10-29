import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { categoryCommandFixture, CATEGORY_CLAIMS } from '../support/category-command-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { deterministicTestData } from '../fixtures/deterministic'
import { readD1AdminGlobalSearch } from '../../workers/auth/admin-global-search'
import { adminGlobalSearchResponseSchema } from '../../shared/admin-global-search'

const instant = '2026-10-08T12:00:00Z',
  now = () => instant
let sqlite: DatabaseSync, database: D1Database
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(deterministicTestData('admin-global-search', instant).date())
  ;({ sqlite, database } = await categoryCommandFixture())
  seedInventoryFixture(sqlite)
  sqlite.exec(
    "UPDATE products SET name='ÁCIDO literal %_\\ prueba',status='draft' WHERE id='p-1'; UPDATE variants SET sku='ÁCIDO-%_\\-SKU' WHERE id='v-1-1'"
  )
})
afterEach(() => {
  sqlite.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const read = (query: string, limit = 10) => readD1AdminGlobalSearch(database, CATEGORY_CLAIMS, { query, limit, now })
describe('private global administrative search', () => {
  it('finds actual draft names and SKU with Spanish folding and canonical detail routes, read-only in three reads', async () => {
    const before = sqlite.prepare('SELECT total_changes() n').get(),
      prepare = vi.spyOn(database, 'prepare')
    const result = await read('  acido  ')
    expect(result).toEqual({
      source: 'cloudflare',
      query: 'acido',
      items: [
        {
          kind: 'product',
          id: '1',
          label: 'ÁCIDO literal %_\\ prueba',
          description: 'ÁCIDO-%_\\-SKU',
          to: '/admin/productos/1'
        }
      ]
    })
    expect(prepare).toHaveBeenCalledTimes(3)
    expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
    expect((await read('ÁCIDO-%_\\-SKU')).items).toHaveLength(1)
  })
  it('treats percent, underscore, backslash and SQL metacharacters literally', async () => {
    expect((await read('%_\\')).items.map((item) => item.id)).toEqual(['1'])
    expect((await read("%' OR 1=1 --")).items).toEqual([])
  })
  it('supports literal terms longer than native LIKE limits', async () => {
    const name = 'a'.repeat(70)
    sqlite.prepare("UPDATE products SET name=? WHERE id='p-1'").run(name)
    expect((await read(name)).items).toHaveLength(1)
  })
  it('ranks exact SKU first, bounds results and orders ties deterministically', async () => {
    sqlite.exec("UPDATE variants SET sku='producto' WHERE id='v-6-1'")
    const result = await read('producto', 2)
    expect(result.items.map((item) => item.id)).toEqual(['6', '2'])
    expect(await read('producto', 2)).toEqual(result)
  })
  it('does not return unmapped category/product or SKU absent from the real detail', async () => {
    sqlite.exec("UPDATE categories SET legacy_id=NULL WHERE id='c1'")
    expect((await read('acido')).items).toEqual([])
    sqlite.exec("UPDATE categories SET legacy_id=7 WHERE id='c1'; UPDATE products SET legacy_id=NULL WHERE id='p-1'")
    expect((await read('acido')).items).toEqual([])
    sqlite.exec(
      "UPDATE products SET legacy_id=1,name='Other' WHERE id='p-1'; UPDATE variants SET status='discontinued' WHERE id='v-1-1'"
    )
    expect((await read('acido')).items).toEqual([])
  })
  it('does not convert administration.manage into catalog.write', async () => {
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
    expect((await read('acido')).items).toEqual([])
  })
  it.each([
    ["UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'", 'unauthenticated'],
    ['UPDATE identities SET session_version=2', 'unauthenticated'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ['DELETE FROM identity_roles', 'forbidden']
  ])('rejects lost initial authority %s', async (sql, code) => {
    sqlite.exec(sql)
    await expect(read('acido')).rejects.toMatchObject({ code })
  })
  it.each([
    ["UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'", 'unauthenticated'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ["DELETE FROM role_permissions WHERE permission_code='catalog.write'", 'forbidden']
  ])('rechecks authority after asynchronous data read %s', async (sql, code) => {
    const original = database.prepare.bind(database)
    vi.spyOn(database, 'prepare').mockImplementation((text: string) => {
      const statement = original(text)
      if (!text.includes('FROM products')) return statement
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args)
          return {
            async all() {
              const result = await bound.all()
              sqlite.exec(sql)
              return result
            }
          }
        }
      } as D1PreparedStatement
    })
    await expect(read('acido')).rejects.toMatchObject({ code })
  })
  it('requires a fresh server clock on final authorization', async () => {
    const original = database.prepare.bind(database)
    vi.spyOn(database, 'prepare').mockImplementation((text: string) => {
      const statement = original(text)
      if (!text.includes('FROM products')) return statement
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args)
          return {
            async all() {
              const result = await bound.all()
              vi.advanceTimersByTime(3600000)
              return result
            }
          }
        }
      } as D1PreparedStatement
    })
    await expect(readD1AdminGlobalSearch(database, CATEGORY_CLAIMS, { query: 'acido' })).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it.each(['', 'a', 'x'.repeat(101), 'ab\ncd'])('rejects invalid query %#', async (query) => {
    await expect(read(query)).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it.each([0, 21, 1.5, NaN])('rejects invalid limit %s', async (limit) => {
    await expect(read('acido', limit)).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('rejects an unconfirmed database envelope, not a false empty', async () => {
    const original = database.prepare.bind(database)
    vi.spyOn(database, 'prepare').mockImplementation((text: string) =>
      text.includes('FROM products')
        ? ({
            bind() {
              return { all: async () => ({ success: false, results: [] }) }
            }
          } as unknown as D1PreparedStatement)
        : original(text)
    )
    await expect(read('acido')).rejects.toThrow()
  })
  it('strictly rejects redirected destinations, PII and unsafe IDs in the shared DTO', () => {
    const item = { kind: 'product', id: '1', label: 'Product', description: 'SKU', to: '/admin/productos/1' }
    for (const changed of [
      { ...item, to: '/admin/productos/2' },
      { ...item, id: '9007199254740992' },
      { ...item, email: 'private@example.invalid' }
    ])
      expect(
        adminGlobalSearchResponseSchema.safeParse({ source: 'cloudflare', query: 'ab', items: [changed] }).success
      ).toBe(false)
  })
})
