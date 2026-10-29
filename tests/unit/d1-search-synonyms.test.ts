import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  CATEGORY_SESSION,
  CATEGORY_IDENTITY
} from '../support/category-command-fixture'
import {
  createSearchSynonymPreview,
  executeSearchSynonymCommand,
  listSearchSynonyms,
  readSearchSynonymReceipt
} from '../../workers/catalog/search-synonyms'
import { searchSynonymDraftSchema } from '../../shared/search-synonyms'

describe('governed D1 synonym lifecycle acceptance', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='search_synonym_commands'").get())
      sqlite.exec(await readFile(new URL('../../db/d1/migrations/0061_search_synonyms.sql', import.meta.url), 'utf8'))
  })
  afterEach(() => sqlite.close())
  const draft = (extra: Record<string, unknown> = {}) => ({
    id: null,
    expectedVersion: 0,
    sourceTerm: 'Lejía',
    replacements: ['hipoclorito', 'cloro'],
    active: true,
    reason: 'Terminología comercial revisada',
    action: 'save',
    ...extra
  })
  const preview = (extra: Record<string, unknown> = {}) =>
    createSearchSynonymPreview(database, CATEGORY_CLAIMS, { draft: draft(extra), query: 'LEJÍA' })
  const commit = async (p: Awaited<ReturnType<typeof preview>>, key = crypto.randomUUID()) =>
    executeSearchSynonymCommand(
      database,
      CATEGORY_CLAIMS,
      { previewId: p.previewId, previewHash: p.previewHash },
      { idempotencyKey: key }
    )
  it('previews without public mutation, creates, GET-recovers and replays one immutable audited command', async () => {
    const p = await preview()
    expect(p.beforeTerms).toEqual(['lejia'])
    expect(p.afterTerms).toEqual(['lejia', 'hipoclorito', 'cloro'])
    expect((await listSearchSynonyms(database, CATEGORY_CLAIMS)).total).toBe(0)
    const receipt = await commit(p, 'create-one')
    expect(receipt.item).toMatchObject({
      sourceTerm: 'Lejía',
      replacements: ['hipoclorito', 'cloro'],
      version: 1,
      active: true,
      retired: false
    })
    expect(await commit(p, 'create-one')).toEqual(receipt)
    expect(await readSearchSynonymReceipt(database, CATEGORY_CLAIMS, 'create-one')).toEqual(receipt)
    expect(sqlite.prepare('SELECT count(*) n FROM search_synonym_commands').get()).toEqual({ n: 1 })
    expect(() => sqlite.exec("UPDATE search_synonym_commands SET action='retire'")).toThrow()
    expect(() => sqlite.exec('DELETE FROM search_synonym_commands')).toThrow()
  })
  it('edits, pauses and retires with CAS while preserving history; retired entries disappear from listing', async () => {
    const first = await commit(await preview())
    const paused = await commit(await preview({ id: first.item.id, expectedVersion: 1, active: false }))
    expect(paused.item).toMatchObject({ active: false, version: 2 })
    const retired = await commit(
      await preview({ id: first.item.id, expectedVersion: 2, active: false, action: 'retire' })
    )
    expect(retired.item).toMatchObject({ retired: true, version: 3 })
    expect((await listSearchSynonyms(database, CATEGORY_CLAIMS)).items).toEqual([])
    expect(sqlite.prepare('SELECT count(*) n FROM search_synonym_commands').get()).toEqual({ n: 3 })
  })
  it('rejects stale previews after another administrator changes configuration without partial writes', async () => {
    const stale = await preview()
    await commit(await preview({ sourceTerm: 'Detergente', replacements: ['limpiador'] }))
    await expect(commit(stale)).rejects.toMatchObject({ code: 'preview_stale' })
    expect(sqlite.prepare('SELECT count(*) n FROM search_synonym_commands').get()).toEqual({ n: 1 })
  })
  it('rejects changed idempotency payload, invalid hash, missing receipt, normalized duplicate and stale version', async () => {
    const firstPreview = await preview(),
      first = await commit(firstPreview, 'key')
    const next = await preview({ id: first.item.id, expectedVersion: 1, replacements: ['cloro'] })
    await expect(commit(next, 'key')).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(
      executeSearchSynonymCommand(
        database,
        CATEGORY_CLAIMS,
        { previewId: next.previewId, previewHash: '0'.repeat(64) },
        { idempotencyKey: 'bad' }
      )
    ).rejects.toMatchObject({ code: 'preview_invalid' })
    await expect(preview({ sourceTerm: ' LEJIA ' })).rejects.toMatchObject({ code: 'source_conflict' })
    await expect(preview({ id: first.item.id, expectedVersion: 9 })).rejects.toMatchObject({ code: 'version_conflict' })
    expect(await readSearchSynonymReceipt(database, CATEGORY_CLAIMS, 'missing')).toBeNull()
  })
  it.each(['revoke', 'email', 'mfa', 'grant'])(
    'fails closed on current %s authority including historical GET/replay',
    async (cause) => {
      const p = await preview()
      await commit(p, 'receipt')
      if (cause === 'revoke')
        sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CATEGORY_SESSION)
      if (cause === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_SESSION)
      if (cause === 'email')
        sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CATEGORY_IDENTITY)
      if (cause === 'grant') sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
      await expect(readSearchSynonymReceipt(database, CATEGORY_CLAIMS, 'receipt')).rejects.toBeInstanceOf(Error)
      await expect(commit(p, 'receipt')).rejects.toBeInstanceOf(Error)
      await expect(listSearchSynonyms(database, CATEGORY_CLAIMS)).rejects.toBeInstanceOf(Error)
    }
  )
  it.each([
    { replacements: ['lejia'] },
    { replacements: ['cloro', 'CLÓRO'] },
    { replacements: Array(9).fill('x') },
    { sourceTerm: 'a' },
    { sourceTerm: 'é\u0301' },
    { sourceTerm: 'test\u0000x' },
    { sourceTerm: '%_*' },
    { active: 'true' },
    { reason: 'x' },
    { id: null, expectedVersion: 1 },
    { unexpected: true }
  ])('rejects malformed domain input before writes %j', (change) =>
    expect(searchSynonymDraftSchema.safeParse(draft(change)).success).toBe(false)
  )
  it('rejects an expired preview and another actor preview', async () => {
    const p = await preview()
    await expect(
      executeSearchSynonymCommand(
        database,
        CATEGORY_CLAIMS,
        { previewId: p.previewId, previewHash: p.previewHash },
        { idempotencyKey: 'expired', now: p.expiresAt }
      )
    ).rejects.toMatchObject({ code: 'preview_expired' })
  })
  it('keeps receipts/previews actor-private, even for another authorized catalog administrator', async () => {
    const p = await preview()
    await commit(p, 'private-key')
    const other = {
      identityId: '10000000-0000-4000-8000-000000000041',
      sessionId: '20000000-0000-4000-8000-000000000041',
      sessionVersion: 1
    }
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,session_version,created_at,updated_at) SELECT ?, 'other-synonym@example.invalid',password_hash,email_verified_at,status,session_version,created_at,updated_at FROM identities WHERE id=?`
      )
      .run(other.identityId, CATEGORY_IDENTITY)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) SELECT ?,?,session_version,mfa_verified,created_at,expires_at FROM auth_sessions WHERE id=?`
      )
      .run(other.sessionId, other.identityId, CATEGORY_SESSION)
    sqlite
      .prepare(
        `INSERT INTO identity_roles(identity_id,role_code,granted_at) SELECT ?,role_code,granted_at FROM identity_roles WHERE identity_id=?`
      )
      .run(other.identityId, CATEGORY_IDENTITY)
    expect(await readSearchSynonymReceipt(database, other, 'private-key')).toBeNull()
    await expect(
      executeSearchSynonymCommand(
        database,
        other,
        { previewId: p.previewId, previewHash: p.previewHash },
        { idempotencyKey: 'stolen' }
      )
    ).rejects.toMatchObject({ code: 'preview_invalid' })
  })
  it('rejects revocation in the last D1 write and leaves zero command/audit rows', async () => {
    const p = await preview()
    const raced = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            if (sql.startsWith('INSERT INTO search_synonym_commands'))
              sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CATEGORY_SESSION)
            return database.prepare(sql)
          }
        return Reflect.get(target, key, receiver)
      }
    })
    await expect(
      executeSearchSynonymCommand(
        raced,
        CATEGORY_CLAIMS,
        { previewId: p.previewId, previewHash: p.previewHash },
        { idempotencyKey: 'revoked-during-commit' }
      )
    ).rejects.toBeInstanceOf(Error)
    expect(sqlite.prepare('SELECT count(*) n FROM search_synonym_commands').get()).toEqual({ n: 0 })
  })
  it('recovers a committed write whose response is lost and serializes simultaneous exact retries', async () => {
    const p = await preview()
    const lost = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            const statement = database.prepare(sql)
            if (!sql.startsWith('INSERT INTO search_synonym_commands')) return statement
            return {
              ...statement,
              bind(...args: unknown[]) {
                statement.bind(...args)
                return this
              },
              async run() {
                await statement.run()
                throw new Error('synthetic lost response')
              }
            }
          }
        return Reflect.get(target, key, receiver)
      }
    })
    const receipt = await executeSearchSynonymCommand(
      lost,
      CATEGORY_CLAIMS,
      { previewId: p.previewId, previewHash: p.previewHash },
      { idempotencyKey: 'lost-response' }
    )
    expect(await readSearchSynonymReceipt(database, CATEGORY_CLAIMS, 'lost-response')).toEqual(receipt)
    const fresh = await preview({ id: receipt.item.id, expectedVersion: 1, active: false })
    const [a, b] = await Promise.all([commit(fresh, 'same-parallel'), commit(fresh, 'same-parallel')])
    expect(a).toEqual(b)
    expect(sqlite.prepare('SELECT count(*) n FROM search_synonym_commands').get()).toEqual({ n: 2 })
  })
  it('rolls back the complete command if a late SQLite write fails', async () => {
    const p = await preview()
    sqlite.exec(
      "CREATE TRIGGER synthetic_failure AFTER INSERT ON search_synonym_commands BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
    )
    await expect(commit(p)).rejects.toThrow('synthetic failure')
    expect((await listSearchSynonyms(database, CATEGORY_CLAIMS)).total).toBe(0)
    expect(sqlite.prepare('SELECT count(*) n FROM search_synonym_commands').get()).toEqual({ n: 0 })
  })
})
