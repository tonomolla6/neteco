import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createHmac } from 'node:crypto'
import {
  createMediaPublication,
  decideMediaRights,
  eligibleMediaPublicationSql,
  ingestMediaScanReceipt,
  withdrawMediaPublication,
  type MediaScanReceipt
} from '../../workers/media/governance'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const IDENTITY = '10000000-0000-4000-8000-000000000001'
const SESSION = '20000000-0000-4000-8000-000000000001'
const UPLOAD = '30000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
// Independent synthetic scanner material only; never account/session secrets.
const SCANNER_SECRET = 'ephemeral-test-independent-scanner-key-at-least-32-bytes'
const CHECKSUM = 'a'.repeat(64)
const OBJECT_KEY = `quarantine/${UPLOAD}/${CHECKSUM}`
const APPROVAL = { decision: 'approve', reason: 'Fixture human reviewed exact rights evidence' }

function utc(milliseconds = Date.now()) {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** These tests intentionally do NOT use fake timers, options.now or scanner
 * nowInput. A real SQLite execution clock exercises production's SQL guards. */
describe('independent media-governance adversarial replay, tie and execution-clock regressions', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let fixtureNow: string
  let mainFixture: { id: string; uploadId: string; scanId: string; rightsId: string }

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    fixtureNow = utc()
    const yesterday = utc(Date.now() - 86400_000)
    const evidence = await provisionPublicationValidityFixture(database, {
      productIds: ['p-1'],
      now: yesterday,
      validUntil: '2099-01-01T00:00:00Z'
    })
    const main = evidence.mainPublications.get('p-1')
    if (!main) throw new Error('missing_synthetic_main_fixture')
    mainFixture = main
    for (const table of [
      'media_uploads',
      'media_scan_receipts',
      'media_rights_decisions',
      'product_media_publications'
    ])
      expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 1 })
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
        VALUES (?, 'fixture@example.invalid', 'synthetic-not-a-login-hash', ?, 'active', ?, ?)`
      )
      .run(IDENTITY, yesterday, yesterday, yesterday)
    sqlite.exec(`
      INSERT INTO roles VALUES ('review_publisher', 'Publisher', 'Test-only role');
      INSERT INTO permissions VALUES ('catalog.publish', 'catalog', 'publish', 'Test-only permission'),
        ('catalog.write', 'catalog', 'write', 'Test-only permission');
      INSERT INTO role_permissions VALUES ('review_publisher', 'catalog.publish'), ('review_publisher', 'catalog.write');
    `)
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES (?, 'review_publisher', ?)")
      .run(IDENTITY, yesterday)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
        VALUES (?, ?, 1, 1, ?, ?)`
      )
      .run(SESSION, IDENTITY, utc(Date.now() - 60_000), utc(Date.now() + 3600_000))
    // Persist the private original's immutable evidence directly in the real
    // migrated schema. No R2/client bytes or real scanner is contacted.
    sqlite
      .prepare(
        `INSERT INTO media_uploads(id, actor_id, idempotency_key, payload_hash, checksum, object_key,
          filename, content_type, byte_size, alt, rights_owner, rights_license, rights_source,
          storage_status, r2_etag, created_at, stored_at)
        VALUES (?, ?, 'fixture-upload', ?, ?, ?, 'fixture.pdf', 'application/pdf', 17,
          'Fixture technical document', 'Fixture owner', 'Fixture distribution license', ?,
          'quarantined', 'fixture-etag', ?, ?)`
      )
      .run(
        UPLOAD,
        IDENTITY,
        CHECKSUM,
        CHECKSUM,
        OBJECT_KEY,
        JSON.stringify({
          kind: 'uploader_declaration',
          authorizedAt: yesterday.slice(0, 10),
          reference: 'Fixture signed distribution evidence'
        }),
        fixtureNow,
        fixtureNow
      )
  })

  afterEach(() => sqlite.close())

  function receipt(verdict: 'clean' | 'infected' = 'clean'): MediaScanReceipt {
    return {
      receiptId: crypto.randomUUID(),
      uploadId: UPLOAD,
      checksum: CHECKSUM,
      objectKey: OBJECT_KEY,
      byteSize: 17,
      verdict,
      scannerVersion: 'fixture-independent-scanner/1',
      scannedAt: fixtureNow,
      expiresAt: utc(Date.now() + 86400_000)
    }
  }

  function signedScan(value: MediaScanReceipt) {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    const signature = `sha256=${createHmac('sha256', SCANNER_SECRET).update(bytes).digest('hex')}`
    return ingestMediaScanReceipt(database, bytes, signature, SCANNER_SECRET)
  }

  function publicationInput() {
    return {
      productId: 'p-1',
      variantId: 'v-1-1',
      role: 'datasheet',
      title: 'Fixture product technical document',
      altText: 'Fixture exact product technical document',
      language: 'es',
      version: 'fixture-review-1',
      validFrom: fixtureNow
    }
  }

  async function preparePublication() {
    await decideMediaRights(database, CLAIMS, UPLOAD, APPROVAL, { idempotencyKey: crypto.randomUUID() })
    await signedScan(receipt())
  }

  function eligibleCount() {
    // Keep production's SQLite clock and count only the exact PDF under test.
    return sqlite.prepare(`SELECT * FROM (${eligibleMediaPublicationSql()}) WHERE upload_id=?`).all(utc(), UPLOAD)
      .length
  }

  function count(
    table:
      | 'media_rights_decisions'
      | 'media_scan_receipts'
      | 'product_media_publications'
      | 'product_media_publication_events'
  ) {
    const fixtureId = new Map([
      ['media_rights_decisions', mainFixture.rightsId],
      ['media_scan_receipts', mainFixture.scanId],
      ['product_media_publications', mainFixture.id]
    ]).get(table)
    if (fixtureId) return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id<>?`).get(fixtureId)!.n)
    return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)
  }

  function raceBeforeBatch<Inner>(inner: () => Promise<Inner>) {
    let injected = false
    let result: Inner | undefined
    const raced = {
      ...database,
      async batch<T>(statements: D1PreparedStatement[]) {
        if (!injected) {
          injected = true
          result = await inner()
        }
        return database.batch<T>(statements)
      }
    } as D1Database
    return { database: raced, inner: () => result }
  }

  it('lets a separately signed infected verdict win an equal-second clean receipt, without allowing clean replay to resurrect it', async () => {
    await decideMediaRights(database, CLAIMS, UPLOAD, APPROVAL, { idempotencyKey: 'review-approval' })
    const clean = receipt()
    await signedScan(clean)
    await createMediaPublication(database, CLAIMS, UPLOAD, publicationInput(), { idempotencyKey: 'review-publication' })
    expect(eligibleCount()).toBe(1)
    const infected = receipt('infected')
    expect(infected.scannedAt).toBe(clean.scannedAt)
    expect((await signedScan(infected)).verdict).toBe('infected')
    expect(count('media_scan_receipts')).toBe(2)
    expect(
      sqlite.prepare('SELECT verdict FROM media_scan_receipts WHERE upload_id=? ORDER BY seq DESC LIMIT 1').get(UPLOAD)
    ).toMatchObject({
      verdict: 'infected'
    })
    expect(eligibleCount()).toBe(0)
    expect((await signedScan(clean)).replayed).toBe(true)
    expect(eligibleCount()).toBe(0)
    await expect(signedScan(receipt())).rejects.toThrow(/invalid_scan_receipt|conflict/)
    expect(count('media_scan_receipts')).toBe(2)
    expect(eligibleCount()).toBe(0)
  })

  it('returns the persisted rights command for two concurrent identical actor/key/payload requests', async () => {
    const key = 'review-concurrent-rights'
    const race = raceBeforeBatch(() =>
      decideMediaRights(database, CLAIMS, UPLOAD, APPROVAL, { idempotencyKey: key, expectedVersion: 0 })
    )
    const outer = await decideMediaRights(race.database, CLAIMS, UPLOAD, APPROVAL, {
      idempotencyKey: key,
      expectedVersion: 0
    })
    const inner = race.inner()!
    expect(outer).toMatchObject({
      decisionId: inner.decisionId,
      rightsVersion: inner.rightsVersion,
      rightsStatus: 'approved',
      replayed: true
    })
    expect(count('media_rights_decisions')).toBe(1)
  })

  it('returns the persisted publication for two concurrent identical actor/key/payload requests', async () => {
    await preparePublication()
    const key = 'review-concurrent-publication'
    const input = publicationInput()
    const race = raceBeforeBatch(() => createMediaPublication(database, CLAIMS, UPLOAD, input, { idempotencyKey: key }))
    const outer = await createMediaPublication(race.database, CLAIMS, UPLOAD, input, { idempotencyKey: key })
    expect(outer).toMatchObject({
      publication: { id: race.inner()!.publication.id, publicationVersion: 1 },
      replayed: true
    })
    expect(count('product_media_publications')).toBe(1)
    expect(eligibleCount()).toBe(1)
  })

  it('returns the persisted withdrawal for two concurrent identical actor/key/payload requests', async () => {
    await preparePublication()
    const publication = await createMediaPublication(database, CLAIMS, UPLOAD, publicationInput(), {
      idempotencyKey: 'review-withdraw-target'
    })
    const key = 'review-concurrent-withdrawal'
    const input = { reason: 'Fixture replacement withdrawn atomically' }
    const options = { idempotencyKey: key, expectedVersion: 1 }
    const race = raceBeforeBatch(() =>
      withdrawMediaPublication(database, CLAIMS, publication.publication.id, input, options)
    )
    const outer = await withdrawMediaPublication(race.database, CLAIMS, publication.publication.id, input, options)
    expect(outer).toMatchObject({
      id: publication.publication.id,
      publicationVersion: 2,
      status: 'withdrawn',
      replayed: true
    })
    expect(count('product_media_publication_events')).toBe(1)
    expect(eligibleCount()).toBe(0)
  })

  it('does not accept a concurrently persisted different payload as an idempotent rights replay', async () => {
    const key = 'review-conflicting-rights'
    const race = raceBeforeBatch(() =>
      decideMediaRights(
        database,
        CLAIMS,
        UPLOAD,
        { decision: 'reject', reason: 'Fixture conflicting human evidence decision' },
        { idempotencyKey: key }
      )
    )
    await expect(decideMediaRights(race.database, CLAIMS, UPLOAD, APPROVAL, { idempotencyKey: key })).rejects.toThrow(
      'idempotency_conflict'
    )
    expect(count('media_rights_decisions')).toBe(1)
    expect(sqlite.prepare('SELECT decision FROM media_rights_decisions WHERE upload_id=?').get(UPLOAD)).toMatchObject({
      decision: 'rejected'
    })
  })

  it.each(['rights', 'publication', 'withdrawal'] as const)(
    'rejects %s when a real grant expires during the awaited D1 batch, with no injected test clock',
    async (operation) => {
      let target: string | undefined
      if (operation !== 'rights') await preparePublication()
      if (operation === 'withdrawal')
        target = (
          await createMediaPublication(database, CLAIMS, UPLOAD, publicationInput(), {
            idempotencyKey: 'review-expiry-target'
          })
        ).publication.id
      const before = {
        rights: count('media_rights_decisions'),
        publication: count('product_media_publications'),
        withdrawal: count('product_media_publication_events')
      }
      const expiresAt = utc(Date.now() + 2500)
      sqlite.prepare("UPDATE identity_roles SET expires_at = ? WHERE role_code = 'review_publisher'").run(expiresAt)
      let reachedBatch = false
      const delayed = {
        ...database,
        async batch<T>(statements: D1PreparedStatement[]) {
          reachedBatch = true
          const untilExpired = Math.max(0, Date.parse(expiresAt) + 150 - Date.now())
          await new Promise<void>((resolve) => setTimeout(resolve, untilExpired))
          expect(Date.now()).toBeGreaterThan(Date.parse(expiresAt))
          return database.batch<T>(statements)
        }
      } as D1Database
      const options = { idempotencyKey: `review-expiry-${operation}` }
      const command =
        operation === 'rights'
          ? decideMediaRights(delayed, CLAIMS, UPLOAD, APPROVAL, options)
          : operation === 'publication'
            ? createMediaPublication(delayed, CLAIMS, UPLOAD, publicationInput(), options)
            : withdrawMediaPublication(
                delayed,
                CLAIMS,
                target!,
                { reason: 'Fixture expired authority must not withdraw' },
                { ...options, expectedVersion: 1 }
              )
      await expect(command).rejects.toThrow('forbidden')
      expect(reachedBatch).toBe(true)
      expect({
        rights: count('media_rights_decisions'),
        publication: count('product_media_publications'),
        withdrawal: count('product_media_publication_events')
      }).toEqual(before)
      if (operation === 'withdrawal') expect(eligibleCount()).toBe(1)
    }
  )
})
