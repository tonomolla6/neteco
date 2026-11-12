import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { quarantineMediaUpload, reconcileMediaStorage, type QuarantineUploadInput } from '../../workers/catalog/media'
import { testNow } from '../support/deterministic'

function input(): QuarantineUploadInput {
  return {
    actorId: 'admin-1',
    idempotencyKey: 'upload-1',
    bytes: new TextEncoder().encode('%PDF-1.7 original'),
    declaredType: 'application/pdf',
    filename: '../../manual.pdf',
    alt: 'Manual de producto',
    rights: { owner: 'Proveedor', license: 'Permiso de distribución', source: 'Expediente documental 123' }
  }
}

function privateBucket() {
  const objects = new Map<string, { bytes: Uint8Array; object: R2Object }>()
  const put = vi.fn(async (key: string, bytes: Uint8Array, options: R2PutOptions & { onlyIf: R2Conditional }) => {
    expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' })
    if (objects.has(key)) return null
    const checksum = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
    const object: R2Object = {
      key,
      size: bytes.length,
      etag: 'etag',
      httpEtag: '"etag"',
      version: 'version',
      uploaded: new Date(testNow()),
      storageClass: 'Standard',
      checksums: { sha256: checksum, toJSON: () => ({}) },
      writeHttpMetadata: () => {}
    }
    objects.set(key, { bytes: new Uint8Array(bytes), object })
    return object
  })
  return { objects, put, head: vi.fn(async (key: string) => objects.get(key)?.object ?? null) }
}

describe('D1 media quarantine', () => {
  let sqlite: DatabaseSync
  beforeEach(async () => {
    testNow()
    sqlite = await openMigratedDatabase()
  })
  afterEach(() => {
    sqlite.close()
  })

  it('recovers old R2-success/D1-failure attempts without a client retry', async () => {
    const database = d1OverSqlite(sqlite)
    const bucket = privateBucket()
    sqlite.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON media_uploads BEGIN SELECT RAISE(ABORT, 'crash'); END")
    await expect(quarantineMediaUpload(database, bucket, input())).rejects.toThrow('crash')
    sqlite.exec('DROP TRIGGER fail_receipt')
    expect((await reconcileMediaStorage(database, bucket)).inspected).toBe(0)
    const now = new Date(testNow() + 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect(await reconcileMediaStorage(database, bucket, { now })).toEqual({
      inspected: 1,
      recovered: 1,
      missing: 0,
      mismatch: 0,
      unavailable: 0,
      raced: 0
    })
    expect((await reconcileMediaStorage(database, bucket, { now })).inspected).toBe(0)
    expect(bucket.put).toHaveBeenCalledTimes(1)
    const row = sqlite.prepare('SELECT storage_check_result, rights_status, scan_status FROM media_uploads').get()
    expect(row).toEqual({ storage_check_result: 'recovered', rights_status: 'pending', scan_status: 'pending' })
  })

  it('rotates missing objects fairly and records outages without clearing quarantine', async () => {
    const database = d1OverSqlite(sqlite)
    const bucket = privateBucket()
    for (const key of ['a', 'b']) {
      bucket.put.mockRejectedValueOnce(new Error('offline'))
      await expect(quarantineMediaUpload(database, bucket, { ...input(), idempotencyKey: key })).rejects.toThrow(
        'offline'
      )
    }
    const now = new Date(testNow() + 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect((await reconcileMediaStorage(database, bucket, { now, limit: 1 })).missing).toBe(1)
    bucket.head.mockRejectedValueOnce(new Error('R2 unavailable'))
    expect((await reconcileMediaStorage(database, bucket, { now, limit: 1 })).unavailable).toBe(1)
    const rows = sqlite
      .prepare('SELECT storage_status, storage_check_result FROM media_uploads ORDER BY storage_check_result')
      .all()
    expect(rows).toEqual([
      { storage_status: 'staging', storage_check_result: 'missing' },
      { storage_status: 'staging', storage_check_result: 'unavailable' }
    ])
    expect(bucket.head.mock.calls[0]![0]).not.toBe(bucket.head.mock.calls[1]![0])
  })

  it('does not overwrite a receipt completed while the sweep reads R2', async () => {
    const database = d1OverSqlite(sqlite)
    const bucket = privateBucket()
    sqlite.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON media_uploads BEGIN SELECT RAISE(ABORT, 'crash'); END")
    await expect(quarantineMediaUpload(database, bucket, input())).rejects.toThrow('crash')
    sqlite.exec('DROP TRIGGER fail_receipt')
    bucket.head.mockImplementationOnce(async (key) => {
      await quarantineMediaUpload(database, bucket, input())
      return bucket.objects.get(key)?.object ?? null
    })
    const now = new Date(testNow() + 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect((await reconcileMediaStorage(database, bucket, { now })).raced).toBe(1)
    expect(sqlite.prepare('SELECT storage_status, storage_check_result FROM media_uploads').get()).toEqual({
      storage_status: 'quarantined',
      storage_check_result: null
    })
  })

  it('reports checksum mismatch and validates reconciliation bounds', async () => {
    const database = d1OverSqlite(sqlite)
    const bucket = privateBucket()
    bucket.put.mockRejectedValueOnce(new Error('offline'))
    await expect(quarantineMediaUpload(database, bucket, input())).rejects.toThrow('offline')
    const key = String(sqlite.prepare('SELECT object_key FROM media_uploads').get()?.object_key)
    await bucket.put(key, new Uint8Array(input().bytes.length), { onlyIf: { etagDoesNotMatch: '*' } })
    const now = new Date(testNow() + 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect((await reconcileMediaStorage(database, bucket, { now })).mismatch).toBe(1)
    for (const options of [{ now: 'invalid' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }]) {
      await expect(reconcileMediaStorage(database, bucket, options)).rejects.toThrow('invalid_media')
    }
    expect(sqlite.prepare('SELECT storage_status FROM media_uploads').get()?.storage_status).toBe('staging')
  })

  it('stores originals privately with pending approvals and immutable provenance', async () => {
    const bucket = privateBucket()
    const request = input()
    const result = await quarantineMediaUpload(d1OverSqlite(sqlite), bucket, request)
    expect(result).toEqual({
      id: expect.any(String),
      status: 'quarantined',
      rightsStatus: 'pending',
      scanStatus: 'pending'
    })
    const row = sqlite.prepare('SELECT * FROM media_uploads').get()!
    expect(row.object_key).toBe(`quarantine/${result.id}/${row.checksum}`)
    expect(row.filename).not.toContain('/')
    expect(row.storage_status).toBe('quarantined')
    expect(bucket.objects.get(String(row.object_key))?.bytes).toEqual(request.bytes)
    expect(bucket.put.mock.calls[0]![2].httpMetadata).toEqual({
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
      cacheControl: 'no-store'
    })
    expect(() => sqlite.prepare("UPDATE media_uploads SET rights_status = 'approved'").run()).toThrow()
    expect(() => sqlite.prepare("UPDATE media_uploads SET alt = 'other'").run()).toThrow('immutable')
  })

  it('replays the receipt and rejects payload changes before touching R2', async () => {
    const database = d1OverSqlite(sqlite)
    const bucket = privateBucket()
    const first = await quarantineMediaUpload(database, bucket, input())
    expect(await quarantineMediaUpload(database, bucket, input())).toEqual(first)
    await expect(quarantineMediaUpload(database, bucket, { ...input(), alt: 'different' })).rejects.toThrow(
      'idempotency_conflict'
    )
    expect(bucket.put).toHaveBeenCalledTimes(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM media_uploads').get()?.n).toBe(1)
  })

  it('keeps a resumable intent when R2 fails and does not claim stored bytes', async () => {
    const database = d1OverSqlite(sqlite)
    const bucket = privateBucket()
    bucket.put.mockRejectedValueOnce(new Error('R2 unavailable'))
    await expect(quarantineMediaUpload(database, bucket, input())).rejects.toThrow('R2 unavailable')
    const row = sqlite.prepare('SELECT id, storage_status, r2_etag FROM media_uploads').get()!
    expect(row.storage_status).toBe('staging')
    expect(row.r2_etag).toBeNull()
    expect((await quarantineMediaUpload(database, bucket, input())).id).toBe(row.id)
    expect(bucket.objects.size).toBe(1)
  })

  it('recovers the R2-success/D1-failure window without overwriting the original', async () => {
    const database = d1OverSqlite(sqlite)
    const bucket = privateBucket()
    sqlite.exec(
      "CREATE TRIGGER fail_receipt BEFORE UPDATE ON media_uploads BEGIN SELECT RAISE(ABORT, 'simulated crash'); END"
    )
    await expect(quarantineMediaUpload(database, bucket, input())).rejects.toThrow('simulated crash')
    const original = Array.from(bucket.objects.values())[0]!
    expect(sqlite.prepare('SELECT storage_status FROM media_uploads').get()?.storage_status).toBe('staging')
    sqlite.exec('DROP TRIGGER fail_receipt')
    await quarantineMediaUpload(database, bucket, input())
    expect(bucket.head).toHaveBeenCalledTimes(1)
    expect(Array.from(bucket.objects.values())[0]).toBe(original)
  })

  it('does not accept an existing object with a different server checksum', async () => {
    const database = d1OverSqlite(sqlite)
    const bucket = privateBucket()
    bucket.put.mockRejectedValueOnce(new Error('interrupted'))
    await expect(quarantineMediaUpload(database, bucket, input())).rejects.toThrow('interrupted')
    const key = String(sqlite.prepare('SELECT object_key FROM media_uploads').get()?.object_key)
    await bucket.put(key, new Uint8Array(input().bytes.length), { onlyIf: { etagDoesNotMatch: '*' } })
    await expect(quarantineMediaUpload(database, bucket, input())).rejects.toThrow('integrity_mismatch')
    expect(sqlite.prepare('SELECT storage_status FROM media_uploads').get()?.storage_status).toBe('staging')
  })

  it('rejects unbounded or invalid input before persisting anything', async () => {
    const bucket = privateBucket()
    for (const patch of [
      { bytes: new Uint8Array(10485761) },
      { alt: '' },
      { actorId: '' },
      { declaredType: 'image/png' }
    ]) {
      await expect(quarantineMediaUpload(d1OverSqlite(sqlite), bucket, { ...input(), ...patch })).rejects.toThrow()
    }
    expect(bucket.put).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT count(*) AS n FROM media_uploads').get()?.n).toBe(0)
  })

  it('isolates idempotency keys between administrative actors', async () => {
    const database = d1OverSqlite(sqlite)
    const bucket = privateBucket()
    const first = await quarantineMediaUpload(database, bucket, input())
    const second = await quarantineMediaUpload(database, bucket, { ...input(), actorId: 'admin-2' })
    expect(first.id).not.toBe(second.id)
    expect(bucket.objects.size).toBe(2)
  })
})
