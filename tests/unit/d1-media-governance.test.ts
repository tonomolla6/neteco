import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { quarantineMediaUpload } from '../../workers/catalog/media'
import {
  createMediaPublication,
  decideMediaRights,
  eligibleMediaPublicationSql,
  ingestMediaScanReceipt,
  listAdministrativeMedia,
  withdrawMediaPublication,
  type MediaScanReceipt
} from '../../workers/media/governance'
import { handleMediaGovernanceHttp } from '../../workers/media/governance-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

const identityId = '10000000-0000-4000-8000-000000000001'
const sessionId = '20000000-0000-4000-8000-000000000001'
const claims = { identityId, sessionId, sessionVersion: 1 }
const now = '2026-09-30T12:00:00Z'
const scanSecret = 'test-scanner-signing-secret-independent-32-bytes'
const configuration = {
  password: 'test-session-signing-secret-independent-32-bytes',
  maxAgeSeconds: 3600,
  origin: 'https://neteco.invalid',
  rateLimitPepper: 'test-edge-limit-pepper-independent-32-bytes'
}

function privateBucket() {
  const objects = new Map<string, R2Object>()
  return {
    head: vi.fn(async (key: string) => objects.get(key) ?? null),
    put: vi.fn(async (key: string, bytes: Uint8Array) => {
      const object: R2Object = {
        key,
        size: bytes.length,
        etag: 'original-private-etag',
        httpEtag: '"original-private-etag"',
        version: 'original-version',
        uploaded: new Date(),
        storageClass: 'Standard',
        checksums: { sha256: await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)), toJSON: () => ({}) },
        writeHttpMetadata: () => {}
      }
      objects.set(key, object)
      return object
    })
  }
}

describe('governed media publication against real SQLite', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let uploadId: string
  let cookie: string
  let mainFixture: { id: string; uploadId: string; scanId: string; rightsId: string }
  const limiter = { limit: vi.fn(async () => ({ success: true })) }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    limiter.limit.mockReset().mockResolvedValue({ success: true })
    sqlite = await openMigratedDatabase()
    // Parent integration owns the common fixture; this fallback keeps the test
    // independently runnable while that shared migration list is being edited.
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'media_scan_receipts'").get())
      sqlite.exec(await readFile(new URL('../../db/d1/migrations/0033_media_publication.sql', import.meta.url), 'utf8'))
    // Only this static fixture has a synthetic execution clock. The separate
    // adversarial suite retains production's real SQLite time and expiry races.
    sqlite.function('synthetic_media_clock', () => {
      const clock = testNow()
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(clock) ||
        new Date(clock).toISOString().replace(/\.\d{3}Z$/, 'Z') !== clock
      )
        throw new Error('invalid_synthetic_media_clock')
      return clock
    })
    const nativeDatabase = d1OverSqlite(sqlite)
    database = new Proxy(
      {
        ...nativeDatabase,
        prepare(sql: string) {
          return nativeDatabase.prepare(sql.replaceAll("'now'", 'synthetic_media_clock()'))
        }
      },
      {}
    )
    seedInventoryFixture(sqlite)
    const evidence = await provisionPublicationValidityFixture(database, {
      productIds: ['p-1'],
      now: '2026-09-29T00:00:00Z',
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
      VALUES (?, 'fixture@example.invalid', 'test-only-not-a-login-hash', '2026-09-01T00:00:00Z', 'active', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`
      )
      .run(identityId)
    sqlite.exec(
      "INSERT INTO roles VALUES ('media_editor', 'Media editor', 'Test-only role'); INSERT INTO permissions VALUES ('catalog.write', 'catalog', 'write', 'Test-only permission'); INSERT INTO permissions VALUES ('catalog.publish', 'catalog', 'publish', 'Test-only permission'); INSERT INTO role_permissions VALUES ('media_editor', 'catalog.write'); INSERT INTO role_permissions VALUES ('media_editor', 'catalog.publish')"
    )
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES (?, 'media_editor', '2026-09-01T00:00:00Z')"
      )
      .run(identityId)
    sqlite
      .prepare(
        "INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES (?, ?, 1, 1, '2026-09-30T11:00:00Z', '2099-09-30T13:00:00Z')"
      )
      .run(sessionId, identityId)
    uploadId = (await upload()).id
    cookie = (await issueD1SessionCookie(database, claims, configuration))!.split(';')[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  function upload(
    source = JSON.stringify({
      kind: 'uploader_declaration',
      authorizedAt: '2026-09-29',
      reference: 'Signed supplier distribution permission / expediente 123'
    })
  ) {
    return quarantineMediaUpload(database, privateBucket(), {
      actorId: identityId,
      idempotencyKey: crypto.randomUUID(),
      bytes: new TextEncoder().encode('%PDF-1.7 original'),
      declaredType: 'application/pdf',
      filename: '../../manual.pdf',
      alt: 'Manual técnico del producto exacto',
      rights: { owner: 'NETECO proveedor autorizado', license: 'Distribución técnica autorizada', source }
    })
  }

  function receipt(patch: Partial<MediaScanReceipt> = {}): MediaScanReceipt {
    const original = sqlite
      .prepare('SELECT checksum, object_key, byte_size FROM media_uploads WHERE id = ?')
      .get(uploadId)!
    return {
      receiptId: crypto.randomUUID(),
      uploadId,
      checksum: String(original.checksum),
      objectKey: String(original.object_key),
      byteSize: Number(original.byte_size),
      verdict: 'clean',
      scannerVersion: 'external-test-scanner/1.0',
      scannedAt: now,
      expiresAt: '2026-10-01T12:00:00Z',
      ...patch
    }
  }

  function signed(value: unknown, secret = scanSecret) {
    const rawBody = new TextEncoder().encode(JSON.stringify(value))
    return { rawBody, signature: `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}` }
  }

  async function scan(value: unknown = receipt()) {
    const { rawBody, signature } = signed(value)
    return ingestMediaScanReceipt(database, rawBody, signature, scanSecret)
  }

  function rights(decision: 'approve' | 'reject' = 'approve', key = crypto.randomUUID()) {
    return decideMediaRights(
      database,
      claims,
      uploadId,
      { decision, reason: 'Human reviewed exact distribution evidence' },
      { idempotencyKey: key, now: testNow() }
    )
  }

  function publication(patch: Record<string, unknown> = {}, key = crypto.randomUUID()) {
    return createMediaPublication(
      database,
      claims,
      uploadId,
      {
        productId: 'p-1',
        variantId: 'v-1-1',
        role: 'datasheet',
        title: 'Ficha técnica Producto 1',
        altText: 'Ficha técnica vigente de Producto 1',
        language: 'es',
        version: 'revision-2026-09',
        validFrom: now,
        ...patch
      },
      { idempotencyKey: key, now: testNow() }
    )
  }

  function eligible(at = now) {
    return sqlite.prepare(`SELECT * FROM (${eligibleMediaPublicationSql('?1')}) WHERE upload_id=?2`).all(at, uploadId)
  }
  function testNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  function sqliteNow() {
    return String(sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', synthetic_media_clock()) AS now").get()!.now)
  }
  function count(table: string) {
    // Exclude only the one known independent main relation, not action rows.
    const fixtureId = new Map([
      ['media_uploads', mainFixture.uploadId],
      ['media_scan_receipts', mainFixture.scanId],
      ['media_rights_decisions', mainFixture.rightsId],
      ['product_media_publications', mainFixture.id]
    ]).get(table)
    if (fixtureId) return Number(sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE id<>?`).get(fixtureId)!.n)
    return Number(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)
  }

  function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return new Request(`${configuration.origin}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        cookie,
        origin: configuration.origin,
        'cf-connecting-ip': '192.0.2.3',
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
        ...headers
      }
    })
  }

  const handle = (req: Request, secret: string | null = scanSecret) =>
    handleMediaGovernanceHttp(req, {
      database,
      edgeLimiter: limiter,
      configuration: () => configuration,
      scanSecret: () => secret
    })

  it('keeps upload, rights and scanner approval independent and original identity immutable', async () => {
    expect(eligible()).toEqual([])
    const decision = await rights()
    expect(decision.rightsStatus).toBe('approved')
    expect(count('media_scan_receipts')).toBe(0)
    await expect(publication()).rejects.toThrow('media_not_publishable')
    expect(
      sqlite.prepare('SELECT rights_status, scan_status, storage_status FROM media_uploads WHERE id=?').get(uploadId)
    ).toEqual({
      rights_status: 'pending',
      scan_status: 'pending',
      storage_status: 'quarantined'
    })
    await scan()
    const created = await publication()
    expect(eligible()).toMatchObject([
      {
        id: created.publication.id,
        upload_id: uploadId,
        content_type: 'application/pdf',
        rights_decision_id: decision.decisionId
      }
    ])
    expect(() =>
      sqlite.prepare("UPDATE media_uploads SET object_key = 'public/fake' WHERE id=?").run(uploadId)
    ).toThrow('immutable')
  })

  it('does not accept clean claims without the independent scanner secret or valid HMAC', async () => {
    const value = signed(receipt())
    for (const secret of [null, '', 'too-short'])
      await expect(ingestMediaScanReceipt(database, value.rawBody, value.signature, secret)).rejects.toThrow(
        'scan_unavailable'
      )
    await expect(
      ingestMediaScanReceipt(database, value.rawBody, `sha256=${'0'.repeat(64)}`, scanSecret)
    ).rejects.toThrow('invalid_scan_signature')
    await expect(
      ingestMediaScanReceipt(database, value.rawBody, value.signature.toUpperCase(), scanSecret)
    ).rejects.toThrow('invalid_scan_signature')
    await expect(
      ingestMediaScanReceipt(
        database,
        new TextEncoder().encode(`${new TextDecoder().decode(value.rawBody)} `),
        value.signature,
        scanSecret
      )
    ).rejects.toThrow('invalid_scan_signature')
    expect(count('media_scan_receipts')).toBe(0)
  })

  it.each([
    { checksum: '0'.repeat(64) },
    { objectKey: 'public/another-object' },
    { byteSize: 5 },
    { scannedAt: '2026-09-30T11:59:59Z' },
    { scannedAt: '2026-09-30T12:00:01Z' },
    { expiresAt: now },
    { expiresAt: '2026-10-08T12:00:01Z' },
    { verdict: 'pending' },
    { browserClean: true }
  ])('rejects signed but stale/mismatched/unbounded receipt %j', async (patch) => {
    await expect(scan({ ...receipt(), ...patch })).rejects.toThrow('invalid_scan_receipt')
    expect(count('media_scan_receipts')).toBe(0)
  })

  it('replays exact signed receipt UUID but rejects conflicting UUID reuse and stale scan order', async () => {
    const value = receipt()
    expect((await scan(value)).replayed).toBe(false)
    expect((await scan(value)).replayed).toBe(true)
    await expect(scan({ ...value, scannerVersion: 'other-version' })).rejects.toThrow('idempotency_conflict')
    await expect(scan(receipt())).rejects.toThrow('invalid_scan_receipt')
    expect(count('media_scan_receipts')).toBe(1)
  })

  it.each([
    'Legacy metadata is not reviewed proof',
    JSON.stringify({ kind: 'uploader_declaration', authorizedAt: '2026-09-29', reference: null }),
    JSON.stringify({ kind: 'uploader_declaration', authorizedAt: '2026-10-01', reference: 'future evidence' }),
    JSON.stringify({ kind: 'uploader_declaration', authorizedAt: '2026-02-31', reference: 'invalid evidence date' })
  ])('blocks incomplete provenance without preventing a human rejection: %s', async (source) => {
    uploadId = (await upload(source)).id
    await expect(rights()).rejects.toThrow('rights_evidence_incomplete')
    expect((await rights('reject')).rightsStatus).toBe('blocked')
    expect(count('media_rights_decisions')).toBe(1)
  })

  it('uses server actor, explicit reason, immutable decisions and CAS versions', async () => {
    const key = crypto.randomUUID()
    const first = await rights('approve', key)
    expect(await rights('approve', key)).toMatchObject({ decisionId: first.decisionId, replayed: true })
    await expect(rights('reject', key)).rejects.toThrow('idempotency_conflict')
    await expect(
      decideMediaRights(
        database,
        claims,
        uploadId,
        { decision: 'reject', reason: 'Revoke distribution evidence' },
        { idempotencyKey: crypto.randomUUID(), expectedVersion: 0, now: testNow() }
      )
    ).rejects.toThrow('conflict')
    await expect(
      decideMediaRights(
        database,
        claims,
        uploadId,
        { decision: 'approve', reason: 'abc', actorId: identityId },
        { idempotencyKey: crypto.randomUUID(), now: testNow() }
      )
    ).rejects.toThrow('invalid_input')
    expect(
      sqlite
        .prepare(
          'SELECT actor_id, evidence_authorized_at, evidence_reference FROM media_rights_decisions WHERE upload_id=?'
        )
        .get(uploadId)
    ).toMatchObject({ actor_id: identityId, evidence_authorized_at: '2026-09-29' })
    for (const table of [
      'media_scan_receipts',
      'media_rights_decisions',
      'product_media_publications',
      'product_media_publication_events'
    ]) {
      // Empty tables still execute the BEFORE trigger only when there is a row.
      if (table === 'media_rights_decisions') {
        expect(() =>
          sqlite.prepare(`UPDATE ${table} SET reason = 'overwrite' WHERE upload_id=?`).run(uploadId)
        ).toThrow('immutable')
        expect(() => sqlite.prepare(`DELETE FROM ${table} WHERE upload_id=?`).run(uploadId)).toThrow('immutable')
      }
    }
  })

  it.each([
    "DELETE FROM role_permissions WHERE permission_code = 'catalog.publish'",
    'UPDATE auth_sessions SET mfa_verified = 0',
    'UPDATE identities SET session_version = 2',
    "UPDATE auth_sessions SET revoked_at = '2026-09-30T12:00:00Z'",
    "UPDATE identity_roles SET expires_at = '2026-09-30T12:00:00Z'"
  ])('rejects revoked live authority inside the atomic decision batch: %s', async (revoke) => {
    const realBatch = database.batch.bind(database)
    vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
      sqlite.exec(revoke)
      return realBatch(statements)
    })
    await expect(rights()).rejects.toThrow()
    expect(count('media_rights_decisions')).toBe(0)
    expect(count('media_governance_guards')).toBe(0)
  })

  it('rolls back a decision if authorization is revoked by an in-batch side effect', async () => {
    sqlite.exec(
      "CREATE TRIGGER revoke_during_media_decision AFTER INSERT ON media_rights_decisions BEGIN DELETE FROM role_permissions WHERE permission_code = 'catalog.publish'; END"
    )
    await expect(rights()).rejects.toThrow('conflict')
    expect(count('media_rights_decisions')).toBe(0)
    expect(count('role_permissions')).toBe(2)
  })

  it.each([
    { variantId: 'v-2-1' },
    { role: 'main' },
    { role: 'image' },
    { productId: 'missing-product' },
    { language: '' },
    { version: '' },
    { altText: '' },
    { validUntil: now },
    { guessedFromFilename: true }
  ])('requires explicit product/variant/role/metadata consistency: %j', async (patch) => {
    await rights()
    await scan()
    await expect(publication(patch)).rejects.toThrow()
    expect(count('product_media_publications')).toBe(0)
  })

  it('allows draft association but requires published product/category/variant for any public read', async () => {
    await rights()
    await scan()
    sqlite.exec(
      "UPDATE products SET status = 'draft' WHERE id = 'p-1'; UPDATE variants SET status = 'draft' WHERE id = 'v-1-1'"
    )
    const created = await publication()
    expect(created.publication.status).toBe('active')
    expect(eligible()).toEqual([])
    sqlite.exec(
      "UPDATE products SET status = 'published' WHERE id = 'p-1'; UPDATE variants SET status = 'published' WHERE id = 'v-1-1'"
    )
    expect(eligible()).toHaveLength(1)
    sqlite.exec("UPDATE categories SET status = 'hidden'")
    expect(eligible()).toEqual([])
  })

  it('rechecks current scan and rights after async publication reads', async () => {
    await rights()
    await scan()
    const realBatch = database.batch.bind(database)
    vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
      sqlite.exec("DELETE FROM role_permissions WHERE permission_code = 'catalog.publish'")
      return realBatch(statements)
    })
    await expect(publication()).rejects.toThrow('forbidden')
    expect(count('product_media_publications')).toBe(0)
  })

  it.each(['scan', 'rights'])('rejects evidence revoked immediately before the association batch: %s', async (gate) => {
    await rights()
    await scan()
    const realBatch = database.batch.bind(database)
    vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
      if (gate === 'rights') await rights('reject')
      else {
        vi.setSystemTime(new Date('2026-09-30T12:00:01Z'))
        await scan(receipt({ verdict: 'infected', scannedAt: '2026-09-30T12:00:01Z' }))
      }
      return realBatch(statements)
    })
    await expect(publication()).rejects.toThrow('conflict')
    expect(count('product_media_publications')).toBe(0)
  })

  it('does not let an older clean scan override a concurrent infected receipt', async () => {
    const clean = signed(receipt())
    const realBatch = database.batch.bind(database)
    vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
      vi.setSystemTime(new Date('2026-09-30T12:00:01Z'))
      await scan(receipt({ verdict: 'infected', scannedAt: '2026-09-30T12:00:01Z' }))
      return realBatch(statements)
    })
    await expect(ingestMediaScanReceipt(database, clean.rawBody, clean.signature, scanSecret)).rejects.toThrow(
      'conflict'
    )
    expect(sqlite.prepare('SELECT verdict FROM media_scan_receipts WHERE upload_id=?').all(uploadId)).toEqual([
      { verdict: 'infected' }
    ])
  })

  it('new infected receipts invalidate previously pinned clean media immediately', async () => {
    await rights()
    await scan()
    await publication()
    expect(eligible()).toHaveLength(1)
    vi.setSystemTime(new Date('2026-09-30T12:00:01Z'))
    await scan(receipt({ verdict: 'infected', scannedAt: '2026-09-30T12:00:01Z' }))
    expect(eligible('2026-09-30T12:00:01Z')).toEqual([])
    expect(count('product_media_publications')).toBe(1)
    expect(() =>
      sqlite.prepare("UPDATE media_scan_receipts SET verdict = 'clean' WHERE upload_id=?").run(uploadId)
    ).toThrow('immutable')
    expect(() => sqlite.prepare('DELETE FROM media_scan_receipts WHERE upload_id=?').run(uploadId)).toThrow('immutable')
  })

  it('gives a signed infected verdict priority over a clean verdict in the same second', async () => {
    await rights()
    const clean = receipt()
    await scan(clean)
    await publication()
    expect(eligible()).toHaveLength(1)
    const infected = receipt({ verdict: 'infected', scannedAt: clean.scannedAt })
    expect((await scan(infected)).replayed).toBe(false)
    expect(eligible()).toEqual([])
    expect((await scan(clean)).replayed).toBe(true)
    expect(eligible()).toEqual([])
    await expect(scan(receipt({ verdict: 'clean', scannedAt: infected.scannedAt }))).rejects.toThrow(
      'invalid_scan_receipt'
    )
    expect(count('media_scan_receipts')).toBe(2)
  })

  it.each(['clean', 'infected'] as const)(
    'enforces infected-first same-second ordering inside a raced scan batch: outer %s',
    async (outerVerdict) => {
      const outer = signed(receipt({ verdict: outerVerdict }))
      const realBatch = database.batch.bind(database)
      vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
        await scan(receipt({ verdict: outerVerdict === 'clean' ? 'infected' : 'clean' }))
        return realBatch(statements)
      })
      const action = ingestMediaScanReceipt(database, outer.rawBody, outer.signature, scanSecret)
      if (outerVerdict === 'clean') await expect(action).rejects.toThrow('conflict')
      else expect((await action).verdict).toBe('infected')
      expect(
        sqlite
          .prepare('SELECT verdict FROM media_scan_receipts WHERE upload_id=? ORDER BY seq DESC LIMIT 1')
          .get(uploadId)
      ).toEqual({
        verdict: 'infected'
      })
    }
  )

  it.each(['rights', 'publication', 'withdrawal'])(
    'returns the persisted exact command when a matching request wins the preflight race: %s',
    async (command) => {
      const key = crypto.randomUUID()
      let run: () => Promise<{ replayed: boolean }>
      let table: string
      if (command === 'rights') {
        run = () => rights('approve', key)
        table = 'media_rights_decisions'
      } else {
        await rights()
        await scan()
        if (command === 'publication') {
          run = () => publication({}, key)
          table = 'product_media_publications'
        } else {
          const created = await publication()
          run = () =>
            withdrawMediaPublication(
              database,
              claims,
              created.publication.id,
              { reason: 'Withdraw exact current revision' },
              { idempotencyKey: key, expectedVersion: 1, now: testNow() }
            )
          table = 'product_media_publication_events'
        }
      }
      let winner: { replayed: boolean } | undefined
      const realBatch = database.batch.bind(database)
      vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
        winner = await run()
        return realBatch(statements)
      })
      const replay = await run()
      expect(replay.replayed).toBe(true)
      expect({ ...replay, replayed: false }).toEqual(winner)
      expect(count(table)).toBe(1)
    }
  )

  it('never uses idempotent-race recovery to return data after the actor loses authority', async () => {
    const key = crypto.randomUUID()
    const realBatch = database.batch.bind(database)
    vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
      await rights('approve', key)
      sqlite.exec("DELETE FROM role_permissions WHERE permission_code = 'catalog.publish'")
      return realBatch(statements)
    })
    await expect(rights('approve', key)).rejects.toThrow('forbidden')
    expect(count('media_rights_decisions')).toBe(1)
    expect(count('media_governance_guards')).toBe(0)
  })

  it('recovers a matching rights winner committed between the absent-key read and the If-Match version read', async () => {
    const key = crypto.randomUUID()
    let winner: Awaited<ReturnType<typeof rights>> | undefined
    let injected = false
    const realPrepare = database.prepare.bind(database)
    vi.spyOn(database, 'prepare').mockImplementation((sql) => {
      const statement = realPrepare(sql)
      if (!injected && sql.includes('SELECT COALESCE(MAX(seq), 0) AS version')) {
        injected = true
        const read = statement.first.bind(statement)
        vi.spyOn(statement, 'first').mockImplementationOnce(async () => {
          winner = await rights('approve', key)
          return (await read()) as never
        })
      }
      return statement
    })
    const replay = await decideMediaRights(
      database,
      claims,
      uploadId,
      { decision: 'approve', reason: 'Human reviewed exact distribution evidence' },
      { idempotencyKey: key, expectedVersion: 0, now: testNow() }
    )
    expect(replay.replayed).toBe(true)
    expect({ ...replay, replayed: false }).toEqual(winner)
    expect(count('media_rights_decisions')).toBe(1)
  })

  it('replays a publication winner even if its evidence is revoked before the competing preflight finishes', async () => {
    await rights()
    await scan()
    const key = crypto.randomUUID()
    let winner: Awaited<ReturnType<typeof publication>> | undefined
    let injected = false
    const realPrepare = database.prepare.bind(database)
    vi.spyOn(database, 'prepare').mockImplementation((sql) => {
      const statement = realPrepare(sql)
      if (!injected && sql.includes('SELECT scan.id AS scan_id, rights.id AS rights_id')) {
        injected = true
        const read = statement.first.bind(statement)
        vi.spyOn(statement, 'first').mockImplementationOnce(async () => {
          winner = await publication({}, key)
          await rights('reject')
          return (await read()) as never
        })
      }
      return statement
    })
    const replay = await publication({}, key)
    expect(replay.replayed).toBe(true)
    expect({ ...replay, replayed: false }).toEqual(winner)
    expect(count('product_media_publications')).toBe(1)
    expect(eligible()).toEqual([])
  })

  it('rights revocation and subsequent reapproval never silently reactivate an old mapping', async () => {
    await rights()
    await scan()
    const first = await publication()
    await rights('reject')
    expect(eligible()).toEqual([])
    await rights('approve')
    expect(eligible()).toEqual([])
    const replacement = await publication()
    expect(eligible()).toMatchObject([{ id: replacement.publication.id }])
    expect(replacement.publication.id).not.toBe(first.publication.id)
  })

  it('validity dates and scan expiration gate every public read', async () => {
    await rights()
    await scan()
    await publication({ validFrom: '2026-09-30T12:01:00Z', validUntil: '2026-09-30T13:00:00Z' })
    expect(eligible()).toEqual([])
    expect(eligible('2026-09-30T12:01:00Z')).toHaveLength(1)
    expect(eligible('2026-09-30T13:00:00Z')).toEqual([])
    expect(eligible('2026-10-01T12:00:00Z')).toEqual([])
  })

  it('records append-only withdrawal and exact idempotent replay without deleting assets', async () => {
    await rights()
    await scan()
    const key = crypto.randomUUID()
    const first = await publication({}, key)
    expect((await publication({}, key)).replayed).toBe(true)
    await expect(publication({ title: 'Changed metadata' }, key)).rejects.toThrow('idempotency_conflict')
    const withdrawalKey = crypto.randomUUID()
    const withdraw = () =>
      withdrawMediaPublication(
        database,
        claims,
        first.publication.id,
        { reason: 'Document replaced by a new revision' },
        { idempotencyKey: withdrawalKey, expectedVersion: 1, now: testNow() }
      )
    expect(await withdraw()).toMatchObject({ publicationVersion: 2, replayed: false })
    expect(await withdraw()).toMatchObject({ publicationVersion: 2, replayed: true })
    expect(eligible()).toEqual([])
    expect(count('product_media_publications')).toBe(1)
    expect(count('media_uploads')).toBe(1)
    expect((await publication({}, key)).publication.status).toBe('withdrawn')
    await expect(
      withdrawMediaPublication(
        database,
        claims,
        first.publication.id,
        { reason: 'Another withdrawal' },
        { idempotencyKey: crypto.randomUUID(), expectedVersion: 1, now: testNow() }
      )
    ).rejects.toThrow('conflict')
    for (const table of ['product_media_publications', 'product_media_publication_events']) {
      const field = table === 'product_media_publications' ? 'id' : 'publication_id'
      expect(() => sqlite.prepare(`DELETE FROM ${table} WHERE ${field}=?`).run(first.publication.id)).toThrow(
        'immutable'
      )
    }
  })

  it('projects current UI metadata without any raw object key or fabricated public URL', async () => {
    const before = await listAdministrativeMedia(database, claims, testNow())
    expect(before.items.map((item) => item.id).sort()).toEqual([mainFixture.uploadId, uploadId].sort())
    expect({ ...before, items: before.items.filter((item) => item.id !== mainFixture.uploadId) }).toMatchObject({
      items: [
        {
          id: uploadId,
          rightsStatus: 'pending',
          quarantineStatus: 'pending',
          sourceUrl: null,
          canApprove: true,
          canPublish: false,
          authorizedAt: '2026-09-29'
        }
      ],
      capabilities: { canUpload: true, canApprove: true, canPublish: true }
    })
    expect(JSON.stringify(before)).not.toContain('quarantine/')
    await rights()
    await scan()
    const created = await publication()
    const after = await listAdministrativeMedia(database, claims, testNow())
    expect(after.items.map((item) => item.id).sort()).toEqual([mainFixture.uploadId, uploadId].sort())
    expect(after.items.find((item) => item.id === uploadId)).toMatchObject({
      rightsStatus: 'approved',
      quarantineStatus: 'clean',
      canPublish: true,
      sourceUrl: null,
      publications: [{ id: created.publication.id }]
    })
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code = 'catalog.publish'")
    expect(
      (await listAdministrativeMedia(database, claims, testNow())).items.find((item) => item.id === uploadId)
    ).toMatchObject({
      canApprove: false,
      canPublish: false
    })
  })

  it('uses exact HTTP routes and passes upload POST to its existing quarantine handler', async () => {
    expect(await handle(request('/api/admin/media', 'POST', {}))).toBeNull()
    expect(await handle(request('/api/media/scan-receipts/extra', 'POST', {}))).toBeNull()
    expect((await handle(request('/api/media/scan-receipts', 'GET')))!.status).toBe(405)
    const list = (await handle(request('/api/admin/media')))!
    expect(list.status).toBe(200)
    const listed = (await list.json()) as Awaited<ReturnType<typeof listAdministrativeMedia>>
    expect(listed.items.map((item) => item.id).sort()).toEqual([mainFixture.uploadId, uploadId].sort())
    expect({ ...listed, items: listed.items.filter((item) => item.id !== mainFixture.uploadId) }).toMatchObject({
      items: [{ id: uploadId, originalName: expect.any(String), mimeType: 'application/pdf', sourceUrl: null }],
      capabilities: { canApprove: true }
    })
    expect(list.headers.get('cache-control')).toBe('private, no-store')
    expect(list.headers.get('vary')).toBe('Cookie')
    expect(list.headers.get('x-content-type-options')).toBe('nosniff')
    expect(list.headers.get('referrer-policy')).toBe('no-referrer')
    expect(list.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
  })

  it('rejects cross-site admin reads but permits the server-side cookie read without Origin', async () => {
    expect(
      (await handle(request('/api/admin/media', 'GET', undefined, { origin: 'https://evil.invalid' })))!.status
    ).toBe(403)
    expect(
      (await handle(request('/api/admin/media', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })))!.status
    ).toBe(403)
    const serverRead = new Request(`${configuration.origin}/api/admin/media`, {
      headers: { cookie, 'cf-connecting-ip': '192.0.2.3' }
    })
    expect((await handle(serverRead))!.status).toBe(200)
  })

  it('enforces HTTP origin, permissions, bounded body and idempotency before deciding rights', async () => {
    const path = `/api/admin/media/${uploadId}`
    const body = { decision: 'approve', reason: 'Human reviewed permission' }
    const nextRightsVersion =
      Number(sqlite.prepare('SELECT seq FROM media_rights_decisions WHERE id=?').get(mainFixture.rightsId)!.seq) + 1
    expect((await handle(request(path, 'PUT', body, { origin: 'https://evil.invalid' })))!.status).toBe(403)
    expect((await handle(request(path, 'PUT', body, { 'sec-fetch-site': 'cross-site' })))!.status).toBe(403)
    expect((await handle(request(path, 'PUT', body, { 'idempotency-key': '' })))!.status).toBe(400)
    expect((await handle(request(path, 'PUT', body, { cookie: '' })))!.status).toBe(401)
    expect((await handle(request(path, 'PUT', { ...body, reason: 'x'.repeat(5000) })))!.status).toBe(413)
    expect((await handle(request(path, 'PUT', { ...body, actorId: identityId })))!.status).toBe(422)
    expect(count('media_rights_decisions')).toBe(0)
    const result = (await handle(request(path, 'PUT', body, { 'if-match': '0' })))!
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ rightsStatus: 'approved', rightsVersion: nextRightsVersion })
  })

  it('requires withdrawal If-Match plus a reason and explicit idempotency key', async () => {
    await rights()
    await scan()
    const created = await publication()
    const path = `/api/admin/media/publications/${created.publication.id}`
    const reason = { reason: 'Withdraw outdated document' }
    expect((await handle(request(path, 'DELETE', reason)))!.status).toBe(428)
    expect((await handle(request(path, 'DELETE', reason, { 'if-match': '2' })))!.status).toBe(409)
    expect((await handle(request(path, 'DELETE', {}, { 'if-match': '1' })))!.status).toBe(422)
    expect(eligible()).toHaveLength(1)
    expect((await handle(request(path, 'DELETE', reason, { 'if-match': '"1"' })))!.status).toBe(200)
    expect(eligible()).toEqual([])
  })

  it('publishes only through the explicit HTTP association, with type-consistent label documents', async () => {
    await rights()
    await scan()
    const path = `/api/admin/media/${uploadId}/publications`
    const body = {
      productId: 'p-1',
      variantId: 'v-1-1',
      role: 'label',
      title: 'Etiqueta vigente Producto 1',
      altText: 'Etiqueta vigente Producto 1',
      language: 'es',
      version: 'label-2026-09',
      validFrom: now
    }
    const key = crypto.randomUUID()
    expect((await handle(request(path, 'POST', body, { 'idempotency-key': key })))!.status).toBe(201)
    expect((await handle(request(path, 'POST', body, { 'idempotency-key': key })))!.status).toBe(200)
    expect(eligible(sqliteNow())).toMatchObject([{ role: 'label', content_type: 'application/pdf' }])
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code = 'catalog.publish'")
    expect((await handle(request(path, 'POST', body)))!.status).toBe(403)
  })

  it('rechecks withdrawal authorization and retains a live mapping if its batch is rejected', async () => {
    await rights()
    await scan()
    const created = await publication()
    const realBatch = database.batch.bind(database)
    vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
      sqlite.exec('UPDATE auth_sessions SET mfa_verified = 0')
      return realBatch(statements)
    })
    await expect(
      withdrawMediaPublication(
        database,
        claims,
        created.publication.id,
        { reason: 'Withdrawal requires live human authority' },
        { idempotencyKey: crypto.randomUUID(), expectedVersion: 1, now: testNow() }
      )
    ).rejects.toThrow('mfa_required')
    expect(count('product_media_publication_events')).toBe(0)
    expect(eligible()).toHaveLength(1)
  })

  it('scanner HTTP endpoint fails closed without a genuine separate secret', async () => {
    const value = receipt()
    const { signature } = signed(value)
    const callback = () =>
      request('/api/media/scan-receipts', 'POST', value, { 'x-media-scan-signature': signature, cookie: '' })
    expect((await handle(callback(), null))!.status).toBe(503)
    expect((await handle(callback(), configuration.password))!.status).toBe(503)
    expect((await handle(callback(), configuration.rateLimitPepper))!.status).toBe(503)
    expect((await handle(request('/api/media/scan-receipts', 'POST', value)))!.status).toBe(403)
    expect(count('media_scan_receipts')).toBe(0)
    expect((await handle(callback()))!.status).toBe(201)
    expect((await handle(callback()))!.status).toBe(200)
    expect(count('media_scan_receipts')).toBe(1)
  })

  it('enforces edge and persisted identity quotas while refusing unavailable controls', async () => {
    limiter.limit.mockResolvedValueOnce({ success: false })
    expect((await handle(request('/api/admin/media')))!.status).toBe(429)
    expect((await handle(request('/api/admin/media', 'GET', undefined, { 'cf-connecting-ip': '' })))!.status).toBe(503)
    sqlite
      .prepare(
        "INSERT INTO identity_rate_limits(identity_id, scope, used, window_started_at, expires_at) VALUES (?, 'admin-media-governance', 40, ?, ?)"
      )
      .run(identityId, Date.now() / 1000, Date.now() / 1000 + 3600)
    expect(
      (await handle(
        request(`/api/admin/media/${uploadId}`, 'PUT', { decision: 'approve', reason: 'Human reviewed evidence' })
      ))!.status
    ).toBe(429)
    expect(count('media_rights_decisions')).toBe(0)
  })
})
