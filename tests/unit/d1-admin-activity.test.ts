import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { categoryCommandFixture, CATEGORY_CLAIMS } from '../support/category-command-fixture'
import { executeD1CatalogCategoryCommand } from '../../workers/catalog/admin-categories'
import { deterministicTestData } from '../fixtures/deterministic'
import { readD1AdminActivity } from '../../workers/auth/admin-activity'
import { testNow } from '../support/deterministic'

const data = deterministicTestData('admin-activity', '2026-10-08T12:00:00.000Z')
const now = () => new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
let sqlite: DatabaseSync, database: D1Database
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(data.date())
  ;({ sqlite, database } = await categoryCommandFixture())
})
afterEach(() => {
  sqlite.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function event(offset = 0, claims = CATEGORY_CLAIMS) {
  return executeD1CatalogCategoryCommand(
    database,
    claims,
    'create_category',
    {},
    { name: 'Synthetic confidential category', expectedVersion: 0, reason: 'private reason token@example.invalid' },
    { idempotencyKey: data.uuid(), now: new Date(data.date().getTime() + offset).toISOString().replace('.000Z', 'Z') }
  )
}
function afterEvents(action: () => void): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql)
          if (!sql.includes('catalog_category_audit')) return prepared
          return {
            bind(...parameters: unknown[]) {
              const bound = prepared.bind(...parameters)
              return {
                async all() {
                  const rows = await bound.all()
                  action()
                  return rows
                }
              }
            }
          }
        }
      const value: unknown = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as D1Database
}
describe('bounded read-only audited administrative activity', () => {
  it('returns real immutable events only, without PII or payloads, in exactly three reads', async () => {
    await event()
    const before = sqlite.prepare('SELECT total_changes() AS changes').get()
    const prepare = vi.spyOn(database, 'prepare')
    const result = await readD1AdminActivity(database, CATEGORY_CLAIMS, { limit: 5, now })
    expect(result).toMatchObject({
      source: 'cloudflare',
      nextCursor: null,
      items: [
        {
          kind: 'catalog_category',
          action: 'create_category',
          createdAt: now(),
          to: '/admin/categorias'
        }
      ]
    })
    expect(Object.keys(result.items[0]!).sort()).toEqual(['action', 'createdAt', 'id', 'kind', 'to'])
    expect(JSON.stringify(result)).not.toMatch(
      /confidential|private reason|token@|actor|category_uuid|before_state|response/
    )
    expect(prepare).toHaveBeenCalledTimes(3)
    expect(sqlite.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
  })
  it('paginates timestamp ties without repetition and excludes future events', async () => {
    await event()
    await event()
    await event()
    await event(1000)
    const first = await readD1AdminActivity(database, CATEGORY_CLAIMS, { limit: 2, now })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTypeOf('string')
    const next = await readD1AdminActivity(database, CATEGORY_CLAIMS, { limit: 2, now, cursor: first.nextCursor! })
    expect(next.items).toHaveLength(1)
    expect(next.nextCursor).toBeNull()
    expect(new Set([...first.items, ...next.items].map((item) => item.id)).size).toBe(3)
    expect(first.items.map((item) => item.id)).toEqual([...first.items.map((item) => item.id)].sort().reverse())
  })
  it('does not turn an administration role into permission to read catalogue audits', async () => {
    await event()
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
    expect((await readD1AdminActivity(database, CATEGORY_CLAIMS, { limit: 5, now })).items).toEqual([])
  })
  it('includes authorized audited actions by other staff without exposing their identity', async () => {
    const identityId = data.uuid(),
      sessionId = data.uuid()
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) SELECT ?,'other-private@example.invalid',password_hash,email_verified_at,status,created_at,updated_at FROM identities WHERE id=?"
      )
      .run(identityId, CATEGORY_CLAIMS.identityId)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) SELECT ?,?,session_version,mfa_verified,created_at,expires_at FROM auth_sessions WHERE id=?'
      )
      .run(sessionId, identityId, CATEGORY_CLAIMS.sessionId)
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'category_admin','2026-10-01T00:00:00Z')"
      )
      .run(identityId)
    await event(0, { identityId, sessionId, sessionVersion: 1 })
    const result = await readD1AdminActivity(database, CATEGORY_CLAIMS, { limit: 5, now })
    expect(result.items).toHaveLength(1)
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${identityId}|${sessionId}|other-private`))
  })
  it.each([
    ["UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'", 'unauthenticated'],
    ['UPDATE identities SET session_version=2', 'unauthenticated'],
    ["UPDATE identities SET status='disabled'", 'unauthenticated'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ['DELETE FROM identity_roles', 'forbidden']
  ])('rejects initial authority loss: %s', async (sql, code) => {
    sqlite.exec(sql)
    await expect(readD1AdminActivity(database, CATEGORY_CLAIMS, { limit: 5, now })).rejects.toMatchObject({ code })
  })
  it.each([
    ["UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'", 'unauthenticated'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ["DELETE FROM role_permissions WHERE permission_code='catalog.write'", 'forbidden']
  ])('rechecks after asynchronous audit reads: %s', async (sql, code) => {
    await event()
    await expect(
      readD1AdminActivity(
        afterEvents(() => sqlite.exec(sql)),
        CATEGORY_CLAIMS,
        { limit: 5, now }
      )
    ).rejects.toMatchObject({ code })
  })
  it('uses a fresh server instant when the session expires during the audit read', async () => {
    await event()
    await expect(
      readD1AdminActivity(
        afterEvents(() => vi.advanceTimersByTime(3600000)),
        CATEGORY_CLAIMS,
        { limit: 5, now }
      )
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it.each([0, 21, 1.5, NaN])('rejects invalid limit %s', async (limit) => {
    await expect(readD1AdminActivity(database, CATEGORY_CLAIMS, { limit, now })).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
  it.each(['not-a-cursor', 'x'.repeat(769), btoa('{"v":1,"at":"bad","id":"catalog_category:x"}')])(
    'rejects invalid cursor',
    async (cursor) => {
      await expect(readD1AdminActivity(database, CATEGORY_CLAIMS, { limit: 5, cursor, now })).rejects.toMatchObject({
        code: 'invalid_input'
      })
    }
  )
})
