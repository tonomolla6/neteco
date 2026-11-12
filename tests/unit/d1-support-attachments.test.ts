import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { supportFixture, BUYER_CLAIMS, CLAIMS, utc, ORIGIN } from './d1-support-fixture'
import { supportActor, supportClock, readSupportTicket } from '../../workers/support/operations'
import {
  uploadSupportAttachment,
  downloadSupportAttachment,
  receiveSupportScan,
  type SupportPrivateStorage,
  type SupportScanReceipt
} from '../../workers/support/attachments'
import { testNow, testUuid } from '../support/deterministic'

vi.mock('../support/d1-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/d1-sqlite')>()
  return {
    ...original,
    openMigratedDatabase: async (...args: Parameters<typeof original.openMigratedDatabase>) => {
      const sqlite = await original.openMigratedDatabase(...args)
      sqlite.function('synthetic_support_attachment_clock', () => {
        const clock = vi.getMockedSystemTime()
        if (!clock) throw new Error('missing_synthetic_support_attachment_clock')
        return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      const nativeExec = sqlite.exec.bind(sqlite)
      sqlite.exec = (sql: string) => nativeExec(sql.replaceAll("'now'", 'synthetic_support_attachment_clock()'))
      return sqlite
    },
    d1OverSqlite: (sqlite: Parameters<typeof original.d1OverSqlite>[0]) => {
      const database = original.d1OverSqlite(sqlite),
        nativePrepare = database.prepare.bind(database)
      database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_support_attachment_clock()'))
      return database
    }
  }
})

let f: Awaited<ReturnType<typeof supportFixture>>
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(testNow() + 1000)
  f = await supportFixture()
})
afterEach(() => {
  f?.sqlite.close()
  vi.useRealTimers()
})
const bytes = new TextEncoder().encode('%PDF-1.7\nSynthetic local case evidence\n%%EOF')
function privateStorage() {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>()
  const head = vi.fn(async (key: string) => {
    const object = objects.get(key)
    return object ? { size: object.bytes.length, customMetadata: object.customMetadata } : null
  })
  const storage = {
    head,
    get: vi.fn(async (key: string) => {
      const object = objects.get(key)
      return object ? { size: object.bytes.length, arrayBuffer: async () => new Uint8Array(object.bytes).buffer } : null
    }),
    put: vi.fn(async (key: string, value: Uint8Array, options: { customMetadata: Record<string, string> }) => {
      if (objects.has(key)) throw new Error('conditional_conflict')
      objects.set(key, { bytes: new Uint8Array(value), customMetadata: options.customMetadata })
      return { key }
    })
  } as unknown as SupportPrivateStorage
  return { storage, objects, head }
}
async function uploaded(visibility: 'public' | 'internal' = 'public') {
  const ticket = await f.ticket(),
    store = privateStorage(),
    actor = await supportActor(
      f.database,
      visibility === 'internal' ? CLAIMS : BUYER_CLAIMS,
      visibility === 'internal' ? 'admin' : 'customer',
      supportClock()
    )
  const key = testUuid(),
    input = { bytes, declaredType: 'application/pdf', filename: 'private-case.pdf', expectedVersion: 1, visibility }
  const receipt = await uploadSupportAttachment(f.database, store.storage, actor, ticket.publicRef, input, {
    idempotencyKey: key
  })
  const row = f.sqlite.prepare('SELECT * FROM support_attachments').get() as {
    id: string
    checksum: string
    byte_size: number
    object_key: string
  }
  return { ticket, store, actor, key, input, receipt, row }
}
function scan(
  row: { id: string; checksum: string; byte_size: number },
  verdict: 'clean' | 'infected' = 'clean'
): SupportScanReceipt {
  const clock = vi.getMockedSystemTime()
  if (!clock) throw new Error('missing_synthetic_support_attachment_clock')
  return {
    scope: 'support_attachment',
    id: testUuid(),
    attachmentId: row.id,
    checksum: row.checksum,
    byteSize: row.byte_size,
    verdict,
    scannerVersion: 'synthetic-trusted-local-scanner-v1',
    scannedAt: clock.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAt: utc(3600000)
  }
}
async function accept(store: SupportPrivateStorage, receipt: SupportScanReceipt) {
  return receiveSupportScan(
    f.database,
    store,
    new Request(ORIGIN + '/api/support/attachments/scan-receipts', { method: 'POST' }),
    receipt,
    async (_request, body) => body as SupportScanReceipt,
    JSON.stringify(receipt)
  )
}
describe('private support attachment custody', () => {
  it('scanner adapter receives original bounded UTF-8 body once including whitespace', async () => {
    const value = await uploaded(),
      receipt = scan(value.row),
      rawBody = JSON.stringify(receipt, null, 2) + '\n',
      secret = 'synthetic-dedicated-support-scan-secret-0123456789abcdef'
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    )
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode('support_attachment:v1:' + rawBody)
    )
    const encoded = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    f.deps.storage = value.store.storage
    f.deps.scanReceiptVerifier = vi.fn(async (request, body, original) => {
      expect(request.bodyUsed).toBe(true)
      expect(original).toBe(rawBody)
      const supplied = request.headers.get('x-support-scan-signature') ?? ''
      if (!/^[0-9a-f]{64}$/.test(supplied)) return null
      const bytes = new Uint8Array(supplied.match(/../g)!.map((pair) => parseInt(pair, 16)))
      return (await crypto.subtle.verify(
        'HMAC',
        key,
        bytes,
        new TextEncoder().encode('support_attachment:v1:' + original)
      ))
        ? (body as SupportScanReceipt)
        : null
    })
    const response = await f.dispatch(
      new Request(ORIGIN + '/api/support/attachments/scan-receipts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-support-scan-signature': encoded },
        body: rawBody
      })
    )
    expect(response.status).toBe(200)
    expect(f.deps.scanReceiptVerifier).toHaveBeenCalledTimes(1)
    const rejected = await f.dispatch(
      new Request(ORIGIN + '/api/support/attachments/scan-receipts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-support-scan-signature': '0'.repeat(64) },
        body: rawBody
      })
    )
    expect(rejected.status).toBe(403)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_attachment_scans').get()).toEqual({ n: 1 })
  })
  it('quarantines real bounded bytes, no public URL or catalog record, no economics', async () => {
    const before = f.economic(),
      value = await uploaded()
    expect(value.receipt.version).toBe(2)
    expect(value.row.object_key).toMatch(/^support\/quarantine\//)
    expect(f.sqlite.prepare('SELECT state FROM support_attachments').get()).toEqual({ state: 'quarantined' })
    const detail = await readSupportTicket(
      f.database,
      BUYER_CLAIMS,
      'customer',
      value.ticket.publicRef,
      { page: 1, perPage: 25 },
      true
    )
    expect(detail.attachments[0]).toMatchObject({ state: 'quarantined', downloadable: false })
    expect(JSON.stringify(detail)).not.toContain('support/quarantine')
    expect(f.economic()).toEqual(before)
  })
  it('never downloads without separately verified scanner evidence', async () => {
    const value = await uploaded()
    await expect(
      downloadSupportAttachment(f.database, value.store.storage, value.actor, value.ticket.publicRef, value.row.id)
    ).rejects.toMatchObject({ code: 'attachment_unavailable' })
    await expect(
      receiveSupportScan(f.database, value.store.storage, new Request(ORIGIN), scan(value.row), async () => null, '{}')
    ).rejects.toMatchObject({ code: 'invalid_scan_signature' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_attachment_scans').get()).toEqual({ n: 0 })
  })
  it('serves verified clean bytes through current private ownership only', async () => {
    const value = await uploaded(),
      receipt = scan(value.row)
    expect(await accept(value.store.storage, receipt)).toEqual({ outcome: 'stored' })
    expect(await accept(value.store.storage, receipt)).toEqual({ outcome: 'replayed' })
    const response = await downloadSupportAttachment(
      f.database,
      value.store.storage,
      value.actor,
      value.ticket.publicRef,
      value.row.id
    )
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-disposition')).toContain('attachment;')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    f.sqlite.prepare('UPDATE identities SET customer_id=NULL WHERE id=?').run(BUYER_CLAIMS.identityId)
    await expect(
      downloadSupportAttachment(f.database, value.store.storage, value.actor, value.ticket.publicRef, value.row.id)
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('internal attachment never appears or downloads in customer portal', async () => {
    const value = await uploaded('internal')
    await accept(value.store.storage, scan(value.row))
    const detail = await readSupportTicket(
      f.database,
      BUYER_CLAIMS,
      'customer',
      value.ticket.publicRef,
      { page: 1, perPage: 25 },
      true
    )
    expect(detail.attachments).toEqual([])
    const customer = await supportActor(f.database, BUYER_CLAIMS, 'customer', supportClock())
    await expect(
      downloadSupportAttachment(f.database, value.store.storage, customer, value.ticket.publicRef, value.row.id)
    ).rejects.toMatchObject({ code: 'attachment_unavailable' })
  })
  it('same key after version advance returns exact receipt without second R2 put', async () => {
    const value = await uploaded()
    expect(
      await uploadSupportAttachment(f.database, value.store.storage, value.actor, value.ticket.publicRef, value.input, {
        idempotencyKey: value.key
      })
    ).toEqual(value.receipt)
    expect(value.store.storage.put).toHaveBeenCalledTimes(1)
    await expect(
      uploadSupportAttachment(
        f.database,
        value.store.storage,
        value.actor,
        value.ticket.publicRef,
        { ...value.input, filename: 'other.pdf' },
        { idempotencyKey: value.key }
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
  it('ambiguous R2 ack leaves staging, same key resumes without overwrite', async () => {
    const ticket = await f.ticket(),
      store = privateStorage(),
      actor = await supportActor(f.database, BUYER_CLAIMS, 'customer', supportClock())
    const original = store.storage.put,
      key = testUuid(),
      input = {
        bytes,
        declaredType: 'application/pdf',
        filename: 'case.pdf',
        expectedVersion: 1,
        visibility: 'public' as const
      }
    store.storage.put = vi.fn(async (...args: Parameters<typeof original>) => {
      await original(...args)
      throw new Error('lost_R2_ack')
    })
    await expect(
      uploadSupportAttachment(f.database, store.storage, actor, ticket.publicRef, input, { idempotencyKey: key })
    ).rejects.toThrow('lost_R2_ack')
    expect(f.sqlite.prepare('SELECT state FROM support_attachments').get()).toEqual({ state: 'staging' })
    expect(f.sqlite.prepare('SELECT version FROM support_tickets').get()).toEqual({ version: 1 })
    expect(
      (
        await uploadSupportAttachment(f.database, store.storage, actor, ticket.publicRef, input, {
          idempotencyKey: key
        })
      ).version
    ).toBe(2)
    expect(store.storage.put).toHaveBeenCalledTimes(1)
  })
  it('lost customer authority after R2 await cannot promote or leak', async () => {
    const ticket = await f.ticket(),
      store = privateStorage(),
      actor = await supportActor(f.database, BUYER_CLAIMS, 'customer', supportClock())
    const original = store.storage.put
    store.storage.put = vi.fn(async (...args: Parameters<typeof original>) => {
      const result = await original(...args)
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
      return result
    })
    await expect(
      uploadSupportAttachment(
        f.database,
        store.storage,
        actor,
        ticket.publicRef,
        {
          bytes,
          declaredType: 'application/pdf',
          filename: 'case.pdf',
          expectedVersion: 1,
          visibility: 'public'
        },
        { idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(f.sqlite.prepare('SELECT state FROM support_attachments').get()).toEqual({ state: 'staging' })
    expect(f.sqlite.prepare('SELECT version FROM support_tickets').get()).toEqual({ version: 1 })
  })
  it('rejects scanner size/hash mismatch and scan expiry', async () => {
    const value = await uploaded()
    for (const receipt of [
      { ...scan(value.row), checksum: 'a'.repeat(64) },
      { ...scan(value.row), byteSize: 1 },
      { ...scan(value.row), expiresAt: utc(-1000) }
    ]) {
      await expect(accept(value.store.storage, receipt)).rejects.toMatchObject({ code: 'invalid_scan_receipt' })
    }
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_attachment_scans').get()).toEqual({ n: 0 })
  })
  it('infection overrides clean at same instant; later clean cannot override that instant', async () => {
    const value = await uploaded(),
      clean = scan(value.row)
    await accept(value.store.storage, clean)
    await accept(value.store.storage, { ...clean, id: testUuid(), verdict: 'infected' })
    await expect(accept(value.store.storage, { ...clean, id: testUuid() })).rejects.toMatchObject({
      code: 'invalid_scan_receipt'
    })
    await expect(
      downloadSupportAttachment(f.database, value.store.storage, value.actor, value.ticket.publicRef, value.row.id)
    ).rejects.toMatchObject({ code: 'attachment_unavailable' })
  })
  it('infected receipt arriving during R2 get blocks bytes after await', async () => {
    const value = await uploaded(),
      clean = scan(value.row)
    await accept(value.store.storage, clean)
    const get = value.store.storage.get
    value.store.storage.get = vi.fn(async (...args: Parameters<typeof get>) => {
      const result = await get(...args)
      await accept(value.store.storage, { ...clean, id: testUuid(), verdict: 'infected' })
      return result
    })
    await expect(
      downloadSupportAttachment(f.database, value.store.storage, value.actor, value.ticket.publicRef, value.row.id)
    ).rejects.toMatchObject({ code: 'attachment_unavailable' })
  })
  it('corrupted R2 bytes and metadata never count as clean proof', async () => {
    const value = await uploaded()
    await accept(value.store.storage, scan(value.row))
    const object = value.store.objects.get(value.row.object_key)!
    object.bytes = new Uint8Array(object.bytes)
    object.bytes[10] ^= 1
    await expect(
      downloadSupportAttachment(f.database, value.store.storage, value.actor, value.ticket.publicRef, value.row.id)
    ).rejects.toMatchObject({ code: 'storage_unconfirmed' })
  })
  it('customer cannot upload internal file; disallowed MIME never reaches storage', async () => {
    const ticket = await f.ticket(),
      store = privateStorage(),
      actor = await supportActor(f.database, BUYER_CLAIMS, 'customer', supportClock())
    await expect(
      uploadSupportAttachment(
        f.database,
        store.storage,
        actor,
        ticket.publicRef,
        {
          bytes,
          declaredType: 'application/pdf',
          filename: 'case.pdf',
          expectedVersion: 1,
          visibility: 'internal'
        },
        { idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      uploadSupportAttachment(
        f.database,
        store.storage,
        actor,
        ticket.publicRef,
        {
          bytes: new TextEncoder().encode('<script>private</script>'),
          declaredType: 'text/html',
          filename: 'bad.html',
          expectedVersion: 1,
          visibility: 'public'
        },
        { idempotencyKey: testUuid() }
      )
    ).rejects.toMatchObject({ code: 'invalid_file' })
    expect(store.storage.put).not.toHaveBeenCalled()
  })
})
