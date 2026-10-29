import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeD1CmsDraftCommand, getD1CmsPage, listD1CmsPages } from '../../workers/cms/drafts'
import {
  cmsCreateInputSchema,
  cmsUpdateInputSchema,
  cmsRestoreInputSchema,
  cmsArchiveInputSchema
} from '../../shared/cms-commands'
import { cmsFixture, cmsDocument, CMS_CLAIMS, CMS_IDENTITY, CMS_BLOCK, CMS_SESSION, cmsUtc } from './d1-cms-fixture'

describe('CMS D1 adversarial command ownership, live grants and bounded data', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await cmsFixture())
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  const create = (db = database, key = crypto.randomUUID(), extra: Record<string, unknown> = {}) =>
    executeD1CmsDraftCommand(
      db,
      CMS_CLAIMS,
      'create_draft',
      {},
      { ...cmsDocument(extra), expectedVersion: 0 },
      { idempotencyKey: key }
    )
  const update = (id: string, db = database, key = crypto.randomUUID(), version = 1) =>
    executeD1CmsDraftCommand(
      db,
      CMS_CLAIMS,
      'update_draft',
      { pageId: id },
      { ...cmsDocument({ changeSummary: 'Edición adversarial sintética' }), expectedVersion: version },
      { idempotencyKey: key }
    )
  const state = () =>
    [
      'content_pages',
      'content_versions',
      'content_slug_claims',
      'content_draft_commands',
      'content_draft_audit',
      'content_draft_guards'
    ].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  function batchProxy(callback: (statements: D1PreparedStatement[]) => Promise<unknown>) {
    return new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch') return callback
        return Reflect.get(target, key, receiver)
      }
    })
  }
  function serialized() {
    let previous = Promise.resolve()
    return batchProxy(async (statements) => {
      const waiting = previous
      let release!: () => void
      previous = new Promise<void>((resolve) => {
        release = resolve
      })
      await waiting
      try {
        return await database.batch(statements)
      } finally {
        release()
      }
    })
  }
  function afterRead(predicate: (query: string) => boolean, effect: () => void) {
    return new Proxy(database, {
      get(target, key, receiver) {
        if (key !== 'prepare') return Reflect.get(target, key, receiver)
        return (query: string) => {
          function wrapped(statement: D1PreparedStatement): D1PreparedStatement {
            return new Proxy(statement, {
              get(prepared, property, statementReceiver) {
                if (property === 'bind') return (...parameters: unknown[]) => wrapped(prepared.bind(...parameters))
                if (property === 'first')
                  return async (column?: string) => {
                    const result = column === undefined ? await prepared.first() : await prepared.first(column)
                    if (predicate(query)) effect()
                    return result
                  }
                return Reflect.get(prepared, property, statementReceiver)
              }
            })
          }
          return wrapped(target.prepare(query))
        }
      }
    })
  }
  it('simultaneous same-key callers cannot execute an unowned winning claim twice', async () => {
    const db = serialized(),
      results = await Promise.all([create(db, 'same-key'), create(db, 'same-key')])
    expect(results[0]).toEqual(results[1])
    expect(sqlite.prepare('SELECT count(*) AS total FROM content_versions').get()).toEqual({ total: 1 })
    expect(sqlite.prepare('SELECT count(*) AS total FROM content_draft_audit').get()).toEqual({ total: 1 })
  })
  it('simultaneous CAS writers create only one new revision and the loser reports version conflict', async () => {
    const first = await create(),
      db = serialized(),
      results = await Promise.allSettled([update(first.pageId, db, 'cas-one'), update(first.pageId, db, 'cas-two')])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'version_conflict' } })
    expect(sqlite.prepare('SELECT count(*) AS total FROM content_versions').get()).toEqual({ total: 2 })
  })
  it.each(['actor', 'cas', 'state', 'revision', 'audit'])(
    'rolls back the entire command when %s changes inside the batch',
    async (shape) => {
      const first = await create(),
        before = state()
      const change =
        shape === 'actor'
          ? "DELETE FROM role_permissions WHERE permission_code='catalog.write';"
          : shape === 'cas'
            ? `UPDATE content_pages SET page_version=2 WHERE id='${first.pageId}';`
            : shape === 'state'
              ? `UPDATE content_pages SET status='hidden',archived_at=updated_at WHERE id='${first.pageId}';`
              : shape === 'revision'
                ? "SELECT RAISE(ABORT,'cms_version_immutable');"
                : "SELECT RAISE(ABORT,'cms_audit_immutable');"
      const table = shape === 'audit' ? 'content_draft_audit' : 'content_draft_commands'
      sqlite.exec(`CREATE TRIGGER cms_adversarial_inside AFTER INSERT ON ${table} BEGIN ${change} END;`)
      await expect(update(first.pageId)).rejects.toMatchObject({ code: 'conflict' })
      expect(state()).toEqual(before)
    }
  )
  it.each(['success-getter', 'inherited-success', 'result-getter', 'sparse-array', 'wrong-length'])(
    'never trusts an incomplete/accessor batch envelope %s',
    async (shape) => {
      const getter = vi.fn(() => true)
      const db = batchProxy(async (statements) => {
        const results = await database.batch(statements)
        if (shape === 'success-getter') Object.defineProperty(results[0]!, 'success', { enumerable: true, get: getter })
        if (shape === 'inherited-success') {
          Reflect.deleteProperty(results[0]!, 'success')
          Object.setPrototypeOf(results[0]!, { success: true })
        }
        if (shape === 'result-getter') Object.defineProperty(results, '0', { enumerable: true, get: getter })
        if (shape === 'sparse-array') Reflect.deleteProperty(results, '0')
        if (shape === 'wrong-length') results.pop()
        return results
      })
      await expect(create(db, 'ambiguous-envelope')).rejects.toThrow(/unconfirmed/)
      expect(getter).not.toHaveBeenCalled()
      const recovered = await create(database, 'ambiguous-envelope')
      expect(recovered.draftVersion).toBe(1)
      expect(sqlite.prepare('SELECT count(*) AS total FROM content_draft_commands').get()).toEqual({ total: 1 })
    }
  )
  it.each(['list', 'detail'])(
    'does not project private %s data after a live grant is revoked during its source read',
    async (shape) => {
      const first = await create()
      const db = afterRead(
        (query) =>
          shape === 'list' ? query.includes('AS pages FROM actor') : query.includes('AS versions FROM actor'),
        () => {
          sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
        }
      )
      await expect(
        shape === 'list' ? listD1CmsPages(db, CMS_CLAIMS) : getD1CmsPage(db, CMS_CLAIMS, first.pageId)
      ).rejects.toMatchObject({ code: 'forbidden' })
    }
  )
  it('projects restoration and archive capabilities from one final current actor snapshot', async () => {
    await create()
    const db = afterRead(
      (query) => query.includes('AS pages FROM actor'),
      () => {
        sqlite.exec("DELETE FROM role_permissions WHERE permission_code IN ('catalog.publish','administration.manage')")
      }
    )
    expect((await listD1CmsPages(db, CMS_CLAIMS)).capabilities).toMatchObject({
      contentRestore: false,
      contentArchive: false,
      contentCreate: true
    })
  })
  it('requires live permission even to replay an immutable historical receipt', async () => {
    await create(database, 'historical-key')
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(cmsUtc(), CMS_SESSION)
    await expect(create(database, 'historical-key')).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('binds the idempotency namespace to action and target as well as canonical document', async () => {
    const first = await create(database, 'actor-key'),
      before = state()
    await expect(update(first.pageId, database, 'actor-key')).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(state()).toEqual(before)
  })
  it('can save a referenced quarantine image without approving it and prevents deleting an asset in history', async () => {
    const asset = '50000000-0000-4000-8000-000000000044',
      checksum = 'a'.repeat(64),
      stamp = cmsUtc(-1000)
    sqlite
      .prepare(
        `INSERT INTO media_uploads(id,actor_id,idempotency_key,payload_hash,checksum,object_key,filename,content_type,byte_size,width,height,
      alt,rights_owner,rights_license,rights_source,storage_status,r2_etag,created_at,stored_at)
      VALUES (?,?, 'synthetic-image',?,?,?,'synthetic.png','image/png',1,600,600,'Imagen sintética','Synthetic','Synthetic','https://example.invalid','quarantined','synthetic-etag',?,?)`
      )
      .run(asset, CMS_IDENTITY, checksum, checksum, `quarantine/${asset}/${checksum}`, stamp, stamp)
    const first = await create(database, 'image-draft', {
      blocks: [{ id: CMS_BLOCK, type: 'image', assetId: asset, alt: 'Descripción editorial sintética', caption: '' }]
    })
    expect(first.status).toBe('draft')
    expect(sqlite.prepare('SELECT rights_status,scan_status FROM media_uploads WHERE id=?').get(asset)).toEqual({
      rights_status: 'pending',
      scan_status: 'pending'
    })
    expect(() => sqlite.prepare('DELETE FROM media_uploads WHERE id=?').run(asset)).toThrow('cms_media_in_use')
  })
  it.each(['prototype', 'inherited', 'symbol', 'coercion', 'optional-undefined'])(
    'rejects non-JSON command input %s without executing hooks',
    async (shape) => {
      const input = { ...cmsDocument(), expectedVersion: 0 },
        hook = vi.fn(() => 'Guía editorial')
      if (shape === 'prototype') Object.setPrototypeOf(input, { private: true })
      if (shape === 'inherited') {
        Reflect.deleteProperty(input, 'title')
        Object.setPrototypeOf(input, { title: 'Guía editorial' })
      }
      if (shape === 'symbol') Object.defineProperty(input, Symbol('private'), { value: 'private', enumerable: true })
      if (shape === 'coercion') Object.assign(input, { title: { toString: hook } })
      if (shape === 'optional-undefined') Object.assign(input, { extra: undefined })
      await expect(
        executeD1CmsDraftCommand(database, CMS_CLAIMS, 'create_draft', {}, input, { idempotencyKey: 'own-boundary' })
      ).rejects.toMatchObject({ code: 'invalid_input' })
      expect(hook).not.toHaveBeenCalled()
      expect(state().every((rows) => rows.length === 0)).toBe(true)
    }
  )
  it.each([cmsUpdateInputSchema, cmsRestoreInputSchema, cmsArchiveInputSchema])(
    'rejects overflowing expected versions at the command boundary',
    (schema) => {
      expect(
        schema.safeParse({
          ...cmsDocument(),
          expectedVersion: Number.MAX_SAFE_INTEGER - 1,
          versionId: CMS_BLOCK,
          reason: 'Motivo sintético'
        }).success
      ).toBe(false)
    }
  )
  it('counts document limits in UTF8 bytes and rejects upper-case durable block identity', () => {
    const huge = Array.from({ length: 80 }, (_, n) => ({
      id: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      type: 'paragraph',
      text: '😀'.repeat(1000)
    }))
    expect(cmsCreateInputSchema.safeParse({ ...cmsDocument({ blocks: huge }), expectedVersion: 0 }).success).toBe(false)
    expect(
      cmsCreateInputSchema.safeParse({
        ...cmsDocument({
          blocks: [
            { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(), type: 'paragraph', text: 'Texto válido' }
          ]
        }),
        expectedVersion: 0
      }).success
    ).toBe(false)
  })
})
